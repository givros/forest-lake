import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const source = fs.readFileSync(new URL('../src/actors/BicycleGrounding.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { BicycleGrounding } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

// Independent dimensions measured from the published GLB, not imported from
// the solver. Its lateral tread blocks extend beyond an ideal torus shoulder.
const centers = { FrontWheel: new THREE.Vector3(0, .35, .58), RearWheel: new THREE.Vector3(0, .35, -.58) };
const rad = degrees => degrees * Math.PI / 180;
const headings = [0, rad(45), rad(90), rad(180), rad(-75)];
const banks = [-.12, 0, .12];

function profilesFromAsset() {
  const bytes = fs.readFileSync(new URL('../public/assets/models/mountain-bike.glb', import.meta.url));
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
  const binaryOffset = 28 + jsonLength;
  return Object.fromEntries(gltf.nodes.filter(node => centers[node.name]).map(node => {
    const primitive = gltf.meshes[node.mesh].primitives.find(part => gltf.materials[part.material].name === 'M_Bike_Rubber');
    assert.ok(primitive, `${node.name} has no rubber material`);
    const accessor = gltf.accessors[primitive.attributes.POSITION], view = gltf.bufferViews[accessor.bufferView];
    assert.equal(accessor.componentType, 5126); assert.equal(accessor.type, 'VEC3');
    const offset = binaryOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0), stride = view.byteStride ?? 12;
    const rotation = new THREE.Quaternion().fromArray(node.rotation);
    const point = new THREE.Vector3(), points = [];
    for (let i = 0; i < accessor.count; i++) {
      point.set(bytes.readFloatLE(offset + i * stride), bytes.readFloatLE(offset + i * stride + 4), bytes.readFloatLE(offset + i * stride + 8)).applyQuaternion(rotation);
      points.push([point.x, Math.hypot(point.y, point.z)]);
    }
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const hull = [];
    for (const point of points) {
      while (hull.length > 1) {
        const a = hull[hull.length - 2], b = hull[hull.length - 1];
        if ((b[0] - a[0]) * (point[1] - b[1]) - (b[1] - a[1]) * (point[0] - b[0]) < 0) break;
        hull.pop();
      }
      hull.push(point);
    }
    return [node.name, hull];
  }));
}
const tireProfiles = profilesFromAsset();

function fixture(longitudinal, cross, yaw, bank, x = 37.4, z = -26.8, offset = 53.25) {
  const along = Math.tan(rad(longitudinal)), across = Math.tan(rad(cross));
  const gx = along * Math.sin(yaw) + across * Math.cos(yaw);
  const gz = along * Math.cos(yaw) - across * Math.sin(yaw);
  const normal = new THREE.Vector3(-gx, 1, -gz).normalize();
  return { longitudinal, cross, yaw, bank, x, z, offset, normal,
    heightAt: (px, pz) => offset + gx * px + gz * pz,
    label: `long=${longitudinal} cross=${cross} yaw=${yaw} bank=${bank}` };
}

function orientation(pose, f) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(pose.pitch, f.yaw, 0, 'YXZ'))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), f.bank));
}

function signedPlaneDistance(point, f) {
  return point.dot(f.normal) - f.offset * f.normal.y;
}

function analyticContacts(pose, f) {
  const rotation = orientation(pose, f);
  const axle = new THREE.Vector3(1, 0, 0).applyQuaternion(rotation);
  const axialDot = f.normal.dot(axle), radialDot = Math.sqrt(Math.max(0, 1 - axialDot * axialDot));
  const origin = new THREE.Vector3(f.x, pose.height, f.z);
  return Object.fromEntries(Object.entries(centers).map(([name, center]) => {
    const worldCenter = center.clone().applyQuaternion(rotation).add(origin);
    // Analytic support of every ring in the exact convex axial/radial profile.
    // This oracle does not reuse the solver's constants or angular sampling.
    const support = Math.max(...tireProfiles[name].map(([axial, radius]) => radius * radialDot - axial * axialDot));
    return [name, signedPlaneDistance(worldCenter, f) - support];
  }));
}

function checkAnalytic(solver, f) {
  const pose = solver.solve(f.x, f.z, f.yaw, f.bank, f.heightAt);
  assert.ok(Object.values(pose).every(Number.isFinite), `Non-finite pose: ${f.label}`);
  const gaps = analyticContacts(pose, f);
  for (const [name, gap] of Object.entries(gaps))
    assert.ok(Math.abs(gap) < .003, `${name} analytic plane gap ${gap} m: ${f.label}`);
  const rotation = orientation(pose, f);
  const front = centers.FrontWheel.clone().applyQuaternion(rotation);
  const rear = centers.RearWheel.clone().applyQuaternion(rotation);
  assert.ok(Math.abs(front.distanceTo(rear) - 1.16) < 1e-10, `Wheelbase changed: ${f.label}`);
  return Math.max(...Object.values(gaps).map(Math.abs));
}

test('both analytic tires contact flat planes at different world heights and headings', t => {
  const solver = new BicycleGrounding(); let worst = 0;
  for (const offset of [-100, 0, 800]) for (const yaw of headings) for (const bank of banks)
    worst = Math.max(worst, checkAnalytic(solver, fixture(0, 0, yaw, bank, -214.6, 418.3, offset)));
  t.diagnostic(`45 poses; maximum absolute signed contact gap ${(worst * 1000).toFixed(3)} mm`);
});

test('both analytic tires contact uphill and downhill planes at every tested heading and bank', t => {
  const solver = new BicycleGrounding(); let worst = 0, count = 0;
  for (const slope of [-30, -20, -10, 0, 10, 20, 30]) for (const yaw of headings) for (const bank of banks) {
    worst = Math.max(worst, checkAnalytic(solver, fixture(slope, 0, yaw, bank))); count++;
  }
  t.diagnostic(`${count} poses; maximum absolute signed contact gap ${(worst * 1000).toFixed(3)} mm`);
});

test('cross-slopes and combined gradients preserve contact of both analytic tires', t => {
  const solver = new BicycleGrounding(); let worst = 0, count = 0;
  for (const cross of [-30, -20, -10, 10, 20, 30]) for (const slope of [-15, 0, 15])
    for (const yaw of headings) for (const bank of banks) {
      worst = Math.max(worst, checkAnalytic(solver, fixture(slope, cross, yaw, bank))); count++;
    }
  t.diagnostic(`${count} poses; maximum absolute signed contact gap ${(worst * 1000).toFixed(3)} mm`);
});

test('actual GLB tire vertices remain in contact through wheel rotation, slopes and bank', async t => {
  const bytes = fs.readFileSync(new URL('../public/assets/models/mountain-bike.glb', import.meta.url));
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const root = new THREE.Group(); root.add(gltf.scene);
  const wheels = Object.keys(centers).map(name => {
    const node = gltf.scene.getObjectByName(name); assert.ok(node, `Missing actual wheel: ${name}`);
    assert.ok(node.position.distanceTo(centers[name]) < 1e-6, `Unexpected ${name} center`);
    const rubber = [];
    node.traverse(part => {
      if (part instanceof THREE.Mesh && part.material.name === 'M_Bike_Rubber') rubber.push(part);
    });
    assert.ok(rubber.length, `Missing actual rubber vertices: ${name}`);
    return { name, node, rest: node.quaternion.clone(), rubber };
  });
  const solver = new BicycleGrounding(), vertex = new THREE.Vector3(), spin = new THREE.Quaternion();
  let minimumGap = Infinity, maximumGap = -Infinity, maximumPhaseVariation = 0, count = 0;
  const failures = [];
  for (const slope of [-30, 0, 30]) for (const cross of [-20, 0, 20])
    for (const yaw of [0, rad(37), rad(90)]) for (const bank of banks) {
      const f = fixture(slope, cross, yaw, bank), pose = solver.solve(f.x, f.z, yaw, bank, f.heightAt);
      root.position.set(f.x, pose.height, f.z); root.rotation.set(pose.pitch, yaw, 0, 'YXZ');
      gltf.scene.rotation.set(0, 0, bank);
      const phaseGaps = wheels.map(() => []);
      for (const phase of [0, .37, Math.PI / 2, Math.PI, 4.63]) {
        spin.setFromAxisAngle(new THREE.Vector3(1, 0, 0), phase);
        for (const wheel of wheels) wheel.node.quaternion.copy(spin).multiply(wheel.rest);
        root.updateMatrixWorld(true);
        for (let index = 0; index < wheels.length; index++) {
          const wheel = wheels[index]; let gap = Infinity;
          for (const mesh of wheel.rubber) {
            const positions = mesh.geometry.getAttribute('position');
            for (let i = 0; i < positions.count; i++) {
              vertex.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
              gap = Math.min(gap, signedPlaneDistance(vertex, f));
            }
          }
          if (!(gap > -.002 && gap < .004)) failures.push({ gap, wheel: wheel.name, phase, fixture: f.label });
          phaseGaps[index].push(gap); minimumGap = Math.min(minimumGap, gap); maximumGap = Math.max(maximumGap, gap); count++;
        }
      }
      for (const gaps of phaseGaps) maximumPhaseVariation = Math.max(maximumPhaseVariation, Math.max(...gaps) - Math.min(...gaps));
    }
  t.diagnostic(`${count} real tire/pose/phase checks; signed contact gap ${(minimumGap * 1000).toFixed(3)} to ${(maximumGap * 1000).toFixed(3)} mm; maximum wheel-phase variation ${(maximumPhaseVariation * 1000).toFixed(3)} mm`);
  assert.equal(failures.length, 0, `${failures.length} real tire contacts outside [-2,+4] mm: ${JSON.stringify(failures.sort((a, b) => a.gap - b.gap).slice(0, 4))}`);
});
