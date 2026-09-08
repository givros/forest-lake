import type * as THREE from 'three';
import type { Heightfield } from './Heightfield';

const CELL_SIZE = 4;
const GRID_MIN = -760;
const GRID_SIDE = 380;
const EDGE_EPSILON = 1e-8;

/** Visual contact surface near the player, where terrain uses its full LOD.
 * The physics heightfield and all rendered geometry remain unchanged.
 */
export class SurfaceHeight {
  private triangles = new Float64Array(0);
  private readonly cells = new Map<number, number[]>();

  constructor(private readonly field: Heightfield) {}

  /** Index the final Float32 ribbon geometry once, including its real offset. */
  indexTrail(geometry: THREE.BufferGeometry): void {
    this.cells.clear();
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const index = geometry.getIndex();
    if (!index) { this.triangles = new Float64Array(0); return; }
    const rows: number[] = [];
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
      const x = position.getX(a), z = position.getZ(a), y = position.getY(a);
      const bx = position.getX(b) - x, bz = position.getZ(b) - z;
      const cx = position.getX(c) - x, cz = position.getZ(c) - z;
      const determinant = bx * cz - bz * cx;
      if (Math.abs(determinant) < 1e-12) continue;
      const inverse = 1 / determinant, row = rows.length;
      rows.push(x, z, cz * inverse, -cx * inverse, -bz * inverse, bx * inverse,
        y, position.getY(b) - y, position.getY(c) - y,
        uv.getX(a), uv.getX(b) - uv.getX(a), uv.getX(c) - uv.getX(a));
      const minX = Math.max(0, Math.floor((Math.min(x, x + bx, x + cx) - GRID_MIN) / CELL_SIZE));
      const maxX = Math.min(GRID_SIDE - 1, Math.floor((Math.max(x, x + bx, x + cx) - GRID_MIN) / CELL_SIZE));
      const minZ = Math.max(0, Math.floor((Math.min(z, z + bz, z + cz) - GRID_MIN) / CELL_SIZE));
      const maxZ = Math.min(GRID_SIDE - 1, Math.floor((Math.max(z, z + bz, z + cz) - GRID_MIN) / CELL_SIZE));
      for (let iz = minZ; iz <= maxZ; iz++) for (let ix = minX; ix <= maxX; ix++) {
        const key = ix + iz * GRID_SIDE;
        let cell = this.cells.get(key);
        if (!cell) { cell = []; this.cells.set(key, cell); }
        cell.push(row);
      }
    }
    this.triangles = Float64Array.from(rows);
  }

  private nativeTriangleHeight(x: number, z: number): number {
    const m = this.field.metadata, n = m.heightSize;
    if (Math.max(Math.abs(x), Math.abs(z)) > m.nativeHalfWidth) return this.field.getHeight(x, z);
    let u = (x + m.nativeHalfWidth) / m.heightStep;
    let v = (-z + m.nativeHalfWidth) / m.heightStep;
    const ix = Math.min(n - 2, Math.max(0, Math.floor(u)));
    const iz = Math.min(n - 2, Math.max(0, Math.floor(v)));
    u -= ix; v -= iz;
    const i = iz * n + ix, heights = this.field.native;
    const a = heights[i], b = heights[i + 1], c = heights[i + n], d = heights[i + n + 1];
    // Terrain.makeTile uses (a,b,c), then (b,d,c), including the same diagonal.
    const raw = u + v <= 1 ? a + (b - a) * u + (c - a) * v
      : d + (c - d) * (1 - u) + (b - d) * (1 - v);
    return m.heightOrigin + (raw - m.heightBias) * m.heightScale - m.altitudeOffset;
  }

  getHeight = (x: number, z: number): number => {
    let height = this.nativeTriangleHeight(x, z);
    const ix = Math.floor((x - GRID_MIN) / CELL_SIZE), iz = Math.floor((z - GRID_MIN) / CELL_SIZE);
    if (ix < 0 || iz < 0 || ix >= GRID_SIDE || iz >= GRID_SIDE) return height;
    const candidates = this.cells.get(ix + iz * GRID_SIDE);
    if (!candidates) return height;
    const data = this.triangles;
    for (let i = 0; i < candidates.length; i++) {
      const row = candidates[i], dx = x - data[row], dz = z - data[row + 1];
      const b = dx * data[row + 2] + dz * data[row + 3];
      if (b < -EDGE_EPSILON || b > 1 + EDGE_EPSILON) continue;
      const c = dx * data[row + 4] + dz * data[row + 5];
      if (c < -EDGE_EPSILON || b + c > 1 + EDGE_EPSILON) continue;
      const u = data[row + 9] + b * data[row + 10] + c * data[row + 11];
      // The ribbon's two outside edges have zero material opacity.
      if (u <= EDGE_EPSILON || u >= 1 - EDGE_EPSILON) continue;
      const ribbon = data[row + 6] + b * data[row + 7] + c * data[row + 8];
      if (ribbon > height) height = ribbon;
    }
    return height;
  };

  dispose(): void {
    this.cells.clear();
    this.triangles = new Float64Array(0);
  }
}
