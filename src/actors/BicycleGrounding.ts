export type SurfaceHeight = (x: number, z: number) => number;

export interface WheelGeometry {
  centerY: number;
  frontZ: number;
  rearZ: number;
  rimRadius: number;
  tireRadius: number;
  frontProfile: ReadonlyArray<readonly [number, number]>;
  rearProfile: ReadonlyArray<readonly [number, number]>;
}

// Axial/radial tire envelopes measured from M_Bike_Rubber in mountain-bike.glb.
// Shoulder tread blocks extend beyond a smooth torus; include them on cambers.
// The simplified profiles deviate from the original support by less than .07 mm.
export const bicycleWheels: WheelGeometry = {
  centerY: .35, frontZ: .58, rearZ: -.58, rimRadius: .319, tireRadius: .031,
  frontProfile: [[-.0310425, .3194433], [-.028504, .3501056], [0, .3502407], [.028504, .3501056], [.0310425, .3194433]],
  rearProfile: [[-.0310761, .3203514], [-.028504, .3501056], [0, .3505990], [.028504, .3501056], [.0310425, .3194433]],
};

export class BicycleGrounding {
  private readonly frontSamples: Float64Array;
  private readonly rearSamples: Float64Array;
  private readonly wheels: WheelGeometry;
  readonly pose = { height: 0, pitch: 0, frontGap: 0, rearGap: 0 };

  constructor(wheels: WheelGeometry = bicycleWheels) {
    this.wheels = wheels;
    const sample = (profile: WheelGeometry['frontProfile']) => {
      const points = new Float64Array(profile.length * 64 * 3);
      let index = 0;
      for (const [x, radius] of profile) for (let i = 0; i < 64; i++) {
        const angle = i * Math.PI * 2 / 64;
        points[index++] = x;
        points[index++] = Math.cos(angle) * radius;
        points[index++] = Math.sin(angle) * radius;
      }
      return points;
    };
    this.frontSamples = sample(wheels.frontProfile);
    this.rearSamples = sample(wheels.rearProfile);
  }

  solve(x: number, z: number, yaw: number, bank: number, heightAt: SurfaceHeight) {
    const { centerY, frontZ, rearZ } = this.wheels;
    const sy = Math.sin(yaw), cy = Math.cos(yaw), sb = Math.sin(bank), cb = Math.cos(bank);
    const wheelbase = frontZ - rearZ;
    // Wheelbase sampling filters single-point slope changes without delaying
    // the pose, which would let the front tire clip through an uphill trail.
    let pitch = -Math.atan2(heightAt(x + sy * frontZ, z + cy * frontZ)
      - heightAt(x + sy * rearZ, z + cy * rearZ), wheelbase);
    const support = (wheelZ: number, angle: number, samples: Float64Array): number => {
      const sp = Math.sin(angle), cp = Math.cos(angle);
      let height = -Infinity;
      for (let i = 0; i < samples.length; i += 3) {
        // Bike lean is about local Z; terrain pitch is about local X, then yaw.
        const localX = samples[i], localY = centerY + samples[i + 1], localZ = wheelZ + samples[i + 2];
        const bx = cb * localX - sb * localY, by = sb * localX + cb * localY;
        const py = cp * by - sp * localZ, pz = sp * by + cp * localZ;
        const wx = x + cy * bx + sy * pz, wz = z - sy * bx + cy * pz;
        // Direct surface samples also handle the ribbon edge without treating
        // the small gap under a transparent decal as a steep terrain gradient.
        height = Math.max(height, heightAt(wx, wz) - py);
      }
      return height;
    };
    let front = 0, rear = 0;
    for (let i = 0; i < 10; i++) {
      front = support(frontZ, pitch, this.frontSamples); rear = support(rearZ, pitch, this.rearSamples);
      const difference = front - rear;
      if (Math.abs(difference) < .0005 || i === 9) break;
      const correction = Math.max(-.2, Math.min(.2, difference * Math.cos(pitch) / wheelbase));
      pitch = Math.max(-1.25, Math.min(1.25, pitch - correction));
    }
    // Two millimeters cover ring discretization and the submillimeter variation
    // in the decimated tire mesh, without a visible floating offset.
    this.pose.height = Math.max(front, rear) + .002;
    this.pose.pitch = pitch;
    this.pose.frontGap = this.pose.height - front;
    this.pose.rearGap = this.pose.height - rear;
    return this.pose;
  }
}
