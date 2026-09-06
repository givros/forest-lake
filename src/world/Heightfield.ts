import * as THREE from 'three';

export interface WorldMetadata {
  name: string;
  heightSize: number;
  heightStep: number;
  nativeHalfWidth: number;
  heightOrigin: number;
  heightScale: number;
  heightBias: number;
  altitudeOffset: number;
  start: number[];
  lakeArrival: number[];
  lakeCenter: number[];
  waterLevel: number;
  lakeOutline: number[][];
  routeLength: number;
  elevationGain: number;
  routePoints: number;
  trees: number;
  rocks: number;
  props: { model: string; position: number[]; yaw: number; scale: number }[];
  massif: { vertices: number; triangles: number; outerHeightSize: number;
    outerHeightOrigin: number; outerHeightScale: number };
}

export const worldURL = (path: string): string => `${import.meta.env.BASE_URL}assets/world/${path}`;
export const modelURL = (path: string): string => `${import.meta.env.BASE_URL}assets/models/${path}`;

export async function fetchBinary(path: string): Promise<ArrayBuffer> {
  const response = await fetch(worldURL(path));
  if (!response.ok) throw new Error(`Unable to load world asset ${path} (${response.status})`);
  return response.arrayBuffer();
}

export class Heightfield {
  constructor(public readonly metadata: WorldMetadata,
    public readonly native: Uint16Array,
    private readonly outer: Uint16Array,
    public readonly road: Uint8Array) {}

  private interpolate(data: Uint16Array | Uint8Array, n: number, u: number, v: number): number {
    u = THREE.MathUtils.clamp(u, 0, n - 1.000001);
    v = THREE.MathUtils.clamp(v, 0, n - 1.000001);
    const x = Math.floor(u), y = Math.floor(v), fx = u - x, fy = v - y;
    const i = y * n + x;
    return (data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy)
      + (data[i + n] * (1 - fx) + data[i + n + 1] * fx) * fy;
  }

  getHeight = (x: number, z: number): number => {
    const m = this.metadata;
    if (Math.max(Math.abs(x), Math.abs(z)) <= m.nativeHalfWidth) {
      const value = this.interpolate(this.native, m.heightSize,
        (x + m.nativeHalfWidth) / m.heightStep, (-z + m.nativeHalfWidth) / m.heightStep);
      return m.heightOrigin + (value - m.heightBias) * m.heightScale - m.altitudeOffset;
    }
    const n = m.massif.outerHeightSize;
    return this.interpolate(this.outer, n, (x + 4406) * (n - 1) / 8812,
      (-z + 4406) * (n - 1) / 8812) * m.massif.outerHeightScale
      + m.massif.outerHeightOrigin - m.altitudeOffset;
  };

  getRoadDistance(x: number, z: number): number {
    if (Math.max(Math.abs(x), Math.abs(z)) > 756) return 1000;
    return this.interpolate(this.road, 1009, (x + 756) / 1.5, (-z + 756) / 1.5) * .25;
  }

  getSlope(x: number, z: number): number {
    return Math.hypot(this.getHeight(x + 1, z) - this.getHeight(x - 1, z),
      this.getHeight(x, z + 1) - this.getHeight(x, z - 1)) * .5;
  }

  getLakeRadius(x: number, z: number): number {
    const lx = (x - 300) / 170, ly = (-z - 350) / 108, a = Math.atan2(ly, lx);
    return Math.hypot(lx, ly) / (1 + .075 * Math.sin(3 * a + .8)
      + .04 * Math.cos(5 * a - .5) + .025 * Math.sin(7 * a));
  }

  isWalkable = (x: number, z: number): boolean => {
    if (Math.max(Math.abs(x), Math.abs(z)) > 741) return false;
    if (this.getLakeRadius(x, z) < 1.01 && this.getHeight(x, z) < 800.15) return false;
    return this.getSlope(x, z) < 1.19;
  };
}
