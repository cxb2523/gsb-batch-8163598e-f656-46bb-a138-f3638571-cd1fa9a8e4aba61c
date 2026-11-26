export interface Ray {
  origin: Float32Array;    // vec3 [x, y, z]
  direction: Float32Array; // vec3 [x, y, z]
}

export interface RaycastHit {
  splatIndex: number;
  distance: number;
  position: Float32Array;
  /** Present when the hit came from resident tile data published by BVHBuilder. */
  tileId?: number;
}

/**
 * CPU-side snapshot of the currently resident splat set, published by
 * BVHBuilder after a successful rebuild. `tileIds[i]` is the owning tile of
 * splat `i`, so evicted tiles can never appear in query results.
 */
export interface ResidentSplatData {
  positions: Float32Array; // xyz interleaved
  tileIds: Uint32Array;    // one tileId per splat
  splatCount: number;
}

export class SplatRaycaster {
  private residentData: ResidentSplatData | null = null;
  private destroyed = false;

  constructor(private device?: any, private bvhBuffer?: any) {}

  /**
   * Publishes (or clears, with `null`) the resident splat snapshot used by
   * queries that don't pass explicit positions. Called by BVHBuilder when a
   * rebuild commits, starts, or fails. No-op after destroy().
   */
  public setResidentData(data: ResidentSplatData | null): void {
    if (this.destroyed) return;
    this.residentData = data;
  }

  public getResidentData(): ResidentSplatData | null {
    return this.residentData;
  }

  /**
   * Ray-AABB Slab intersection test.
   */
  public intersectBox(
    ray: Ray,
    boxMin: [number, number, number],
    boxMax: [number, number, number]
  ): number | null {
    let tmin = -Infinity;
    let tmax = Infinity;

    for (let i = 0; i < 3; i++) {
      const dir = ray.direction[i];
      if (Math.abs(dir) < 1e-8) {
        // Ray is parallel to slab; if origin is outside slab bounds, no intersection
        if (ray.origin[i] < boxMin[i] || ray.origin[i] > boxMax[i]) {
          return null;
        }
        continue;
      }

      const invD = 1.0 / dir;
      let t0 = (boxMin[i] - ray.origin[i]) * invD;
      let t1 = (boxMax[i] - ray.origin[i]) * invD;

      if (invD < 0.0) {
        const tmp = t0;
        t0 = t1;
        t1 = tmp;
      }

      tmin = Math.max(tmin, t0);
      tmax = Math.min(tmax, t1);

      if (tmax < tmin) return null;
    }

    return tmin >= 0 ? tmin : (tmax >= 0 ? tmax : null);
  }

  /**
   * Intersects a ray against the splat set.
   *
   * When `splatPositions` is provided explicitly it is used as-is (legacy
   * behaviour). Otherwise the most recently committed resident tile data is
   * used; if no rebuild has completed successfully yet, the latest rebuild
   * failed, or the raycaster has been destroyed, this returns `null` rather
   * than serving stale data or throwing.
   */
  public async intersectRay(ray: Ray, splatPositions?: Float32Array): Promise<RaycastHit | null> {
    if (this.destroyed) {
      return null;
    }

    let positions: Float32Array;
    let tileIds: Uint32Array | null = null;

    if (splatPositions !== undefined) {
      if (splatPositions.length === 0) return null;
      positions = splatPositions;
    } else {
      if (!this.residentData || this.residentData.splatCount === 0) {
        return null;
      }
      positions = this.residentData.positions;
      tileIds = this.residentData.tileIds;
    }

    let closestDist = Infinity;
    let hitIndex = -1;
    const numSplats = positions.length / 3;

    for (let i = 0; i < numSplats; i++) {
      const px = positions[i * 3];
      const py = positions[i * 3 + 1];
      const pz = positions[i * 3 + 2];
      const radius = 0.5;

      const dist = this.intersectBox(
        ray,
        [px - radius, py - radius, pz - radius],
        [px + radius, py + radius, pz + radius]
      );

      if (dist !== null && dist < closestDist) {
        closestDist = dist;
        hitIndex = i;
      }
    }

    if (hitIndex === -1) return null;

    const hitPos = new Float32Array([
      ray.origin[0] + ray.direction[0] * closestDist,
      ray.origin[1] + ray.direction[1] * closestDist,
      ray.origin[2] + ray.direction[2] * closestDist
    ]);

    const hit: RaycastHit = {
      splatIndex: hitIndex,
      distance: closestDist,
      position: hitPos
    };
    if (tileIds) {
      hit.tileId = tileIds[hitIndex];
    }
    return hit;
  }

  public destroy(): void {
    this.destroyed = true;
    this.residentData = null;
    if (this.bvhBuffer && typeof this.bvhBuffer.destroy === 'function') {
      this.bvhBuffer.destroy();
    }
  }
}
