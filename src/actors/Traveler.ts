import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

export interface Traveler {
  root: THREE.Group;
  update(dt: number, speed: number, isBoosting: boolean, turnRate?: number): void;
  dispose(): void;
}

const X = new THREE.Vector3(1, 0, 0);
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const clamp = THREE.MathUtils.clamp;

/** Meter-scale, +Z-forward cyclist. The caller owns root position and yaw. */
export async function createTraveler(
  scene: THREE.Scene | THREE.Group,
  onProgress?: (message: string) => void,
): Promise<Traveler> {
  const loader = new GLTFLoader();
  const base = `${import.meta.env.BASE_URL}assets/models/`;
  const load = async (name: string): Promise<GLTF> => {
    onProgress?.(`Loading ${name.replaceAll('-', ' ')}…`);
    return loader.loadAsync(`${base}${name}.glb`);
  };
  const [human, bicycle] = await Promise.all([load('hiker'), load('mountain-bike')]);
  const root = new THREE.Group(); root.name = 'AlpineTraveler';
  scene.add(root); root.add(human.scene, bicycle.scene);
  for (const model of [human.scene, bicycle.scene]) {
    model.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true; object.receiveShadow = true;
        // Stable PBR cutouts are retained if future clothing adds alpha details.
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) if (material instanceof THREE.MeshStandardMaterial) {
          if (material.transparent) { material.alphaTest = .45; material.transparent = false; }
        }
      }
    });
  }
  const humanMixer = new THREE.AnimationMixer(human.scene);
  const pedalClip = human.animations.find((clip) => clip.name === 'Pedal');
  if (!pedalClip) throw new Error('Cyclist animation is missing: Pedal');
  const pedalAction = humanMixer.clipAction(pedalClip).play();
  const bones = new Map<string, THREE.Bone>();
  human.scene.traverse((object) => { if (object instanceof THREE.Bone) bones.set(object.name, object); });
  const bone = (name: string) => {
    const result = bones.get(name); if (!result) throw new Error(`Hiker bone is missing: ${name}`);
    return result;
  };
  root.updateMatrixWorld(true);
  const restWorld = new Map<string, THREE.Quaternion>();
  for (const [name, item] of bones) restWorld.set(name, item.getWorldQuaternion(new THREE.Quaternion()));
  const rootRotation = new THREE.Quaternion();
  const localPosition = (object: THREE.Object3D) => root.worldToLocal(object.getWorldPosition(new THREE.Vector3()));
  const setPosition = (item: THREE.Object3D, position: THREE.Vector3) => {
    const world = root.localToWorld(position.clone());
    item.position.copy(item.parent ? item.parent.worldToLocal(world) : world);
    item.updateMatrixWorld(true);
  };
  const setOrientation = (item: THREE.Object3D, relative: THREE.Quaternion) => {
    root.getWorldQuaternion(rootRotation);
    const world = rootRotation.clone().multiply(relative);
    if (item.parent) world.premultiply(item.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
    item.quaternion.copy(world); item.updateMatrixWorld(true);
  };
  const orientRest = (name: string, angleX = 0) => {
    const orientation = new THREE.Quaternion().setFromAxisAngle(X, angleX).multiply(restWorld.get(name)!);
    setOrientation(bone(name), orientation);
  };
  const aim = (item: THREE.Bone, child: THREE.Bone, target: THREE.Vector3) => {
    const origin = item.getWorldPosition(new THREE.Vector3());
    const current = child.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
    const desired = root.localToWorld(target.clone()).sub(origin).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(current, desired)
      .multiply(item.getWorldQuaternion(new THREE.Quaternion()));
    if (item.parent) q.premultiply(item.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
    item.quaternion.copy(q); item.updateMatrixWorld(true);
  };
  const solveLimb = (upperName: string, middleName: string, endName: string, target: THREE.Vector3, pole: THREE.Vector3) => {
    const upper = bone(upperName), middle = bone(middleName), end = bone(endName);
    const start = localPosition(upper), elbow = localPosition(middle), hand = localPosition(end);
    const a = start.distanceTo(elbow), b = elbow.distanceTo(hand);
    const toward = target.clone().sub(start);
    const distance = clamp(toward.length(), Math.abs(a - b) + .0001, a + b - .0002);
    toward.normalize();
    const perpendicular = pole.clone().sub(start);
    perpendicular.addScaledVector(toward, -perpendicular.dot(toward)).normalize();
    const projection = (a * a + distance * distance - b * b) / (2 * distance);
    const bend = Math.sqrt(Math.max(0, a * a - projection * projection));
    const joint = start.clone().addScaledVector(toward, projection).addScaledVector(perpendicular, bend);
    const reachable = start.clone().addScaledVector(toward, distance);
    aim(upper, middle, joint); aim(middle, end, reachable);
  };
  const parts = Object.fromEntries(['FrontWheel', 'RearWheel', 'Crank', 'LeftPedal', 'RightPedal'].map((name) => {
    const item = bicycle.scene.getObjectByName(name); if (!item) throw new Error(`Bicycle part is missing: ${name}`);
    return [name, item];
  })) as Record<string, THREE.Object3D>;
  const originalRotations = Object.fromEntries(Object.entries(parts).map(([name, part]) => [name, part.quaternion.clone()]));
  const bikeAnchor = (point: THREE.Vector3) => root.worldToLocal(bicycle.scene.localToWorld(point.clone()));
  let pedal = 0, wheel = 0;

  const traveler: Traveler = {
    root,
    update(dt, speed, isBoosting, turnRate = 0) {
      dt = clamp(dt, 0, .10); const movement = Math.abs(speed);
      root.updateMatrixWorld(true);
      // One complete crank revolution per five traveled meters. Sampling the
      // same phase keeps the authored pose and both IK pedal contacts in sync.
      wheel += speed * dt / .35; pedal += speed * dt / 5.0 * Math.PI * 2;
      pedalAction.time = THREE.MathUtils.euclideanModulo(pedal / (Math.PI * 2), 1) * pedalClip.duration;
      humanMixer.update(0);
      bicycle.scene.rotation.z = -clamp(turnRate * movement * .012, -.12, .12);
      for (const name of ['FrontWheel', 'RearWheel']) parts[name].quaternion.copy(new THREE.Quaternion().setFromAxisAngle(X, wheel).multiply(originalRotations[name]));
      parts.Crank.quaternion.copy(new THREE.Quaternion().setFromAxisAngle(X, pedal).multiply(originalRotations.Crank));
      parts.LeftPedal.position.set(-.17, .33 - .175 * Math.cos(pedal), -.10 - .175 * Math.sin(pedal));
      parts.RightPedal.position.set(.17, .33 + .175 * Math.cos(pedal), -.10 + .175 * Math.sin(pedal));
      root.updateMatrixWorld(true);
      const seat = bikeAnchor(v(0, 1.05, -.27));
      const hands = [bikeAnchor(v(-.33, 1.08, .405)), bikeAnchor(v(.33, 1.08, .405))];
      const feet = ['LeftPedal', 'RightPedal'].map((name) => localPosition(parts[name]).add(v(0, .075, -.05)));
      setPosition(bone('Hips'), seat); orientRest('Hips'); orientRest('Spine', isBoosting ? .68 : .64);
      orientRest('Head', isBoosting ? -.30 : -.26);
      for (const [index, side, sign] of [[0, 'L', -1], [1, 'R', 1]] as const) {
        const knee = seat.clone().add(v(sign * .19, -.43, .60));
        solveLimb(`Thigh${side}`, `Shin${side}`, `Foot${side}`, feet[index], knee);
        orientRest(`Foot${side}`);
        solveLimb(`UpperArm${side}`, `Forearm${side}`, `Hand${side}`, hands[index], seat.clone().add(v(sign * .58, .17, .25)));
        orientRest(`Hand${side}`, -Math.PI / 2);
      }
    },
    dispose() {
      humanMixer.stopAllAction();
      humanMixer.uncacheRoot(human.scene);
      const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        geometries.add(object.geometry);
        for (const mat of Array.isArray(object.material) ? object.material : [object.material]) {
          materials.add(mat);
          for (const value of Object.values(mat)) if (value instanceof THREE.Texture) textures.add(value);
        }
      });
      geometries.forEach((geometry) => geometry.dispose()); materials.forEach((mat) => mat.dispose()); textures.forEach((texture) => texture.dispose());
      root.removeFromParent();
    },
  };
  traveler.update(0, 0, false);
  return traveler;
}
