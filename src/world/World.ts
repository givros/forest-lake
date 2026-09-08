import * as THREE from 'three';
import { fetchBinary, Heightfield, worldURL, type WorldMetadata } from './Heightfield';
import { Terrain } from './Terrain';
import { Vegetation } from './Vegetation';

/** Coordinates are meters, Y up, with world Y=0 at 1,500 m altitude. */
export interface AlpineWorld {
  readonly route: THREE.Vector3[];
  readonly start: THREE.Vector3;
  readonly lakeArrival: THREE.Vector3;
  readonly lakeCenter: THREE.Vector3;
  readonly waterLevel: number;
  readonly routeLength: number;
  readonly elevationGain: number;
  getHeight(x: number, z: number): number;
  /** Full-detail terrain triangles plus the visible trail ribbon near the player. */
  getSurfaceHeight(x: number, z: number): number;
  isWalkable(x: number, z: number): boolean;
  resolveMovement(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3;
  update(dt: number, playerPosition: THREE.Vector3, camera: THREE.Camera): void;
  dispose(): void;
}

export async function createWorld(scene: THREE.Scene, onProgress?: (text: string) => void, mobile = false): Promise<AlpineWorld> {
  onProgress?.('Reading the alpine heightfield');
  const response = await fetch(worldURL('world.json'));
  if (!response.ok) throw new Error('Unable to load the alpine world manifest');
  const metadata = await response.json() as WorldMetadata;
  const [native, outer, road, routeBuffer, massif, forest, rocks] = await Promise.all([
    fetchBinary('height.r16'), fetchBinary('outer-height.r16'), fetchBinary('road-distance.r8'),
    fetchBinary('route.bin'), fetchBinary('massif.bin'), fetchBinary('forest.bin'), fetchBinary('rocks.bin'),
  ]);
  const field = new Heightfield(metadata, new Uint16Array(native), new Uint16Array(outer), new Uint8Array(road));
  const routeData = new Float32Array(routeBuffer), route: THREE.Vector3[] = [];
  for (let i = 0; i < routeData.length; i += 3) route.push(new THREE.Vector3(routeData[i], routeData[i + 1], routeData[i + 2]));
  const terrain = new Terrain(field, mobile), vegetation = new Vegetation(field, new Float32Array(forest), new Float32Array(rocks), mobile);
  onProgress?.('Shaping the connected mountains and lake');
  await terrain.build(massif, route);
  await vegetation.build(onProgress);
  scene.add(terrain.root, vegetation.root);
  const start = new THREE.Vector3().fromArray(metadata.start);
  const lakeArrival = new THREE.Vector3().fromArray(metadata.lakeArrival);
  const lakeCenter = new THREE.Vector3().fromArray(metadata.lakeCenter);
  terrain.update(0, start); vegetation.update(0, start);
  let disposed = false;
  return {
    route, start, lakeArrival, lakeCenter, waterLevel: metadata.waterLevel,
    routeLength: metadata.routeLength, elevationGain: metadata.elevationGain,
    getHeight: field.getHeight, getSurfaceHeight: terrain.getSurfaceHeight, isWalkable: field.isWalkable,
    resolveMovement(from, to) {
      const point = vegetation.resolveTrunks(from, to);
      if (!field.isWalkable(point.x, point.z)) {
        if (field.isWalkable(point.x, from.z)) point.z = from.z;
        else if (field.isWalkable(from.x, point.z)) point.x = from.x;
        else point.copy(from);
      }
      point.y = field.getHeight(point.x, point.z);
      return point;
    },
    update(dt, playerPosition, _camera) {
      if (disposed) return;
      terrain.update(Math.min(dt, .1), playerPosition); vegetation.update(Math.min(dt, .1), playerPosition);
    },
    dispose() { if (disposed) return; disposed = true; terrain.dispose(); vegetation.dispose(); },
  };
}
