import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

export function createLighting(scene: THREE.Scene) {
  const sky = new Sky(); sky.scale.setScalar(18000); sky.frustumCulled = false;
  const u = sky.material.uniforms;
  u.turbidity.value = 3.2; u.rayleigh.value = 2.1;
  u.mieCoefficient.value = .004; u.mieDirectionalG.value = .78;
  const sunDirection = new THREE.Vector3(.45, .68, .36).normalize();
  u.sunPosition.value.copy(sunDirection);
  scene.add(sky);
  scene.fog = new THREE.Fog(0xb4cbd2, 2700, 11200);
  scene.add(new THREE.HemisphereLight(0xc1ddeb, 0x666441, 2.1));
  const sunlight = new THREE.DirectionalLight(0xfff0d2, 3.25);
  sunlight.castShadow = true; sunlight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunlight.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 650 });
  sunlight.shadow.bias = -.00012; sunlight.shadow.normalBias = .22;
  scene.add(sunlight, sunlight.target);
  const offset = sunDirection.multiplyScalar(310);
  const lastShadowTarget = new THREE.Vector3(Infinity, Infinity, Infinity);
  return {
    update(position: THREE.Vector3) {
      sky.position.copy(position);
      if (lastShadowTarget.distanceToSquared(position) > .25) {
        sunlight.position.copy(position).add(offset); sunlight.target.position.copy(position);
        sunlight.target.updateMatrixWorld(); lastShadowTarget.copy(position);
      }
    }
  };
}
