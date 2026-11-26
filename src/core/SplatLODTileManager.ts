import { calculateMortonCode } from './morton';

export interface SplatTileDescriptor {
  tileId: number;
  mortonStart: number;
  mortonEnd: number;
  center: [number, number, number];
  splatCount: number;
  lodLevel: number; // 0 = Full detail, 1 = 50%, 2 = 25%
  isResidentInVRAM: boolean;
  /**
   * Optional CPU-side splat positions owned by this tile (xyz interleaved).
   * Consumed by BVHBuilder.rebuildForTiles when (re)building the resident set.
   */
  positions?: Float32Array;
}

/**
 * Result of a LOD/residency evaluation pass.
 * - `resident`:   every tile that must be resident in VRAM after the update.
 * - `toResident`: tiles that newly became resident (need to be paged in).
 * - `toEvict`:    tiles that lost residency (their GPU memory can be released).
 */
export interface LODResidencyUpdate {
  resident: SplatTileDescriptor[];
  toResident: SplatTileDescriptor[];
  toEvict: SplatTileDescriptor[];
}

export class SplatLODTileManager {
  private tiles: Map<number, SplatTileDescriptor> = new Map();
  private maxTileCapacity: number;

  constructor(maxTileCapacity: number = 65536) {
    this.maxTileCapacity = maxTileCapacity;
  }

  getMaxTileCapacity(): number {
    return this.maxTileCapacity;
  }

  registerTile(descriptor: SplatTileDescriptor): void {
    this.tiles.set(descriptor.tileId, descriptor);
  }

  getTile(tileId: number): SplatTileDescriptor | undefined {
    return this.tiles.get(tileId);
  }

  getAllTiles(): SplatTileDescriptor[] {
    return Array.from(this.tiles.values());
  }

  /**
   * Evaluates camera distance to each tile center, assigns dynamic LoD level
   * and resolves the residency set under the maxTileCapacity budget.
   *
   * Tiles closer than nearDist get LOD 0 (100% density).
   * Tiles between nearDist and farDist get LOD 1 (50% density).
   * Tiles beyond farDist get LOD 2 (25% density).
   *
   * Residency: tiles are ranked nearest-first; the closest `maxTileCapacity`
   * tiles stay/become resident, all others are evicted (farthest tiles are
   * evicted first). The descriptor's `isResidentInVRAM` flag is updated in
   * place and the delta is returned so callers can page tiles in/out and
   * trigger a BVH rebuild for the new resident set.
   */
  updateLOD(cameraPos: [number, number, number], nearDist: number, farDist: number): LODResidencyUpdate {
    for (const tile of this.tiles.values()) {
      const dx = tile.center[0] - cameraPos[0];
      const dy = tile.center[1] - cameraPos[1];
      const dz = tile.center[2] - cameraPos[2];
      const dist = Math.hypot(dx, dy, dz);

      if (dist <= nearDist) {
        tile.lodLevel = 0;
      } else if (dist <= farDist) {
        tile.lodLevel = 1;
      } else {
        tile.lodLevel = 2;
      }
    }

    const ranked = this.prioritizeTiles(cameraPos);
    const residentIds = new Set<number>();
    for (let i = 0; i < ranked.length && i < this.maxTileCapacity; i++) {
      residentIds.add(ranked[i].tileId);
    }

    const resident: SplatTileDescriptor[] = [];
    const toResident: SplatTileDescriptor[] = [];
    const toEvict: SplatTileDescriptor[] = [];

    for (const tile of this.tiles.values()) {
      const shouldReside = residentIds.has(tile.tileId);
      if (shouldReside) {
        resident.push(tile);
        if (!tile.isResidentInVRAM) {
          toResident.push(tile);
        }
      } else if (tile.isResidentInVRAM) {
        toEvict.push(tile);
      }
      tile.isResidentInVRAM = shouldReside;
    }

    return { resident, toResident, toEvict };
  }

  /**
   * Sorts tiles by camera proximity for prioritised streaming/paging.
   * Ties are broken by tileId so the ordering is deterministic.
   */
  prioritizeTiles(cameraPos: [number, number, number]): SplatTileDescriptor[] {
    return Array.from(this.tiles.values()).sort((a, b) => {
      const distA = Math.hypot(a.center[0] - cameraPos[0], a.center[1] - cameraPos[1], a.center[2] - cameraPos[2]);
      const distB = Math.hypot(b.center[0] - cameraPos[0], b.center[1] - cameraPos[1], b.center[2] - cameraPos[2]);
      if (distA !== distB) return distA - distB;
      return a.tileId - b.tileId;
    });
  }
}
