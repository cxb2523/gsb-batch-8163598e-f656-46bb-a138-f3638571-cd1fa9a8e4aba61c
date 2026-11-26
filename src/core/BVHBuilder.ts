import { BVHOptions, BVHNode } from './types';
import { mortonShader } from '../shaders/morton.wgsl';
import { radixSortShader } from '../shaders/radixSort.wgsl';
import { bvhBuildShader } from '../shaders/bvhBuild.wgsl';
import { SplatRaycaster, Ray, RaycastHit } from '../raycast/SplatRaycaster';
import { SplatLODTileManager, SplatTileDescriptor, LODResidencyUpdate } from './SplatLODTileManager';

/**
 * Reusable GPU scratch buffers for one build pass. Allocated once per
 * capacity tier and reused across rebuilds; buffers from a retired scratch
 * set are destroyed only after the GPU work that referenced them finished.
 */
interface BuildScratch {
  capacity: number;
  morton: GPUBuffer;
  indices: GPUBuffer;
  mortonOut: GPUBuffer;
  indicesOut: GPUBuffer;
  stepUniforms: GPUBuffer;
  bvhNodes: GPUBuffer;
  /** Owned input buffers — only present on the persistent rebuild scratch. */
  splatCenter?: GPUBuffer;
  bounds?: GPUBuffer;
}

interface CollectedTileData {
  positions: Float32Array;
  tileIds: Uint32Array;
  splatCount: number;
}

export class BVHBuilder {
  private device: GPUDevice;
  private mortonPipeline!: GPUComputePipeline;
  private radixSortPipeline!: GPUComputePipeline;
  private bvhPipeline!: GPUComputePipeline;
  private raycaster: SplatRaycaster;

  private rebuildScratch: BuildScratch | null = null;
  private pendingTiles: SplatTileDescriptor[] | null = null;
  private rebuildChain: Promise<GPUBuffer | null> | null = null;
  private lastRebuildError: unknown = null;
  private destroyed = false;

  constructor(device: GPUDevice, private options: BVHOptions = {}) {
    this.device = device;
    this.raycaster = new SplatRaycaster(device);
    this.initPipelines();
  }

  private initPipelines(): void {
    this.mortonPipeline = this.device.createComputePipeline({
      label: 'Morton Code Generator Pipeline',
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({ code: mortonShader }),
        entryPoint: 'main'
      }
    });

    this.radixSortPipeline = this.device.createComputePipeline({
      label: 'Bitonic Radix Sort Pipeline',
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({ code: radixSortShader }),
        entryPoint: 'main'
      }
    });

    this.bvhPipeline = this.device.createComputePipeline({
      label: 'Radix Tree BVH Construction Pipeline',
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({ code: bvhBuildShader }),
        entryPoint: 'main'
      }
    });
  }

  private allocateScratch(numSplats: number, includeInputs: boolean): BuildScratch {
    const scratch: BuildScratch = {
      capacity: numSplats,
      morton: this.device.createBuffer({
        size: numSplats * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      }),
      indices: this.device.createBuffer({
        size: numSplats * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      }),
      mortonOut: this.device.createBuffer({
        size: numSplats * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      }),
      indicesOut: this.device.createBuffer({
        size: numSplats * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      }),
      stepUniforms: this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }),
      bvhNodes: this.device.createBuffer({
        size: Math.max(numSplats - 1, 1) * 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      })
    };

    if (includeInputs) {
      scratch.splatCenter = this.device.createBuffer({
        size: numSplats * 12,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      scratch.bounds = this.device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
    }

    return scratch;
  }

  private scratchBufferList(scratch: BuildScratch): GPUBuffer[] {
    const buffers: GPUBuffer[] = [
      scratch.morton,
      scratch.indices,
      scratch.mortonOut,
      scratch.indicesOut,
      scratch.stepUniforms,
      scratch.bvhNodes
    ];
    if (scratch.splatCenter) buffers.push(scratch.splatCenter);
    if (scratch.bounds) buffers.push(scratch.bounds);
    return buffers;
  }

  private destroyScratch(scratch: BuildScratch, keepBvhNodes: boolean): void {
    for (const buffer of this.scratchBufferList(scratch)) {
      if (keepBvhNodes && buffer === scratch.bvhNodes) continue;
      (buffer as any)?.destroy?.();
    }
  }

  /**
   * Encodes and submits the morton/sort/BVH compute passes against the given
   * scratch buffers, then waits for the GPU to finish. Resolves with the BVH
   * node buffer (owned by the scratch set — do not destroy it separately).
   */
  private async runBuild(
    splatCenterBuffer: GPUBuffer,
    numSplats: number,
    boundsBuffer: GPUBuffer,
    scratch: BuildScratch
  ): Promise<GPUBuffer> {
    const commandEncoder = this.device.createCommandEncoder();

    const mortonBindGroup = this.device.createBindGroup({
      layout: this.mortonPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: splatCenterBuffer } },
        { binding: 1, resource: { buffer: scratch.morton } },
        { binding: 2, resource: { buffer: scratch.indices } },
        { binding: 3, resource: { buffer: boundsBuffer } }
      ]
    });

    const workgroups = Math.ceil(numSplats / 256);
    const mortonPass = commandEncoder.beginComputePass({ label: 'Morton Compute Pass' });
    mortonPass.setPipeline(this.mortonPipeline);
    mortonPass.setBindGroup(0, mortonBindGroup);
    mortonPass.dispatchWorkgroups(workgroups);
    mortonPass.end();

    let nextPow2 = 1;
    while (nextPow2 < numSplats) {
      nextPow2 <<= 1;
    }

    let currentInMorton = scratch.morton;
    let currentInIndices = scratch.indices;
    let currentOutMorton = scratch.mortonOut;
    let currentOutIndices = scratch.indicesOut;

    for (let stage = 2; stage <= nextPow2; stage <<= 1) {
      for (let step = stage >> 1; step > 0; step >>= 1) {
        this.device.queue.writeBuffer(scratch.stepUniforms, 0, new Uint32Array([numSplats, stage, step, 1]));

        const sortBindGroup = this.device.createBindGroup({
          layout: this.radixSortPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: currentInMorton } },
            { binding: 1, resource: { buffer: currentInIndices } },
            { binding: 2, resource: { buffer: currentOutMorton } },
            { binding: 3, resource: { buffer: currentOutIndices } },
            { binding: 4, resource: { buffer: scratch.stepUniforms } }
          ]
        });

        const sortPass = commandEncoder.beginComputePass({ label: `Bitonic Sort Pass stage ${stage} step ${step}` });
        sortPass.setPipeline(this.radixSortPipeline);
        sortPass.setBindGroup(0, sortBindGroup);
        sortPass.dispatchWorkgroups(workgroups);
        sortPass.end();

        const tempM = currentInMorton;
        currentInMorton = currentOutMorton;
        currentOutMorton = tempM;

        const tempI = currentInIndices;
        currentInIndices = currentOutIndices;
        currentOutIndices = tempI;
      }
    }

    const finalSortedMortonBuffer = currentInMorton;

    const bvhBindGroup = this.device.createBindGroup({
      layout: this.bvhPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: finalSortedMortonBuffer } },
        { binding: 1, resource: { buffer: scratch.bvhNodes } }
      ]
    });

    const bvhPass = commandEncoder.beginComputePass({ label: 'BVH Compute Pass' });
    bvhPass.setPipeline(this.bvhPipeline);
    bvhPass.setBindGroup(0, bvhBindGroup);
    bvhPass.dispatchWorkgroups(workgroups);
    bvhPass.end();

    this.device.queue.submit([commandEncoder.finish()]);

    if (typeof (this.device.queue as any).onSubmittedWorkDone === 'function') {
      await (this.device.queue as any).onSubmittedWorkDone();
    }

    return scratch.bvhNodes;
  }

  public async buildHierarchy(splatCenterBuffer: GPUBuffer, numSplats: number, boundsBuffer: GPUBuffer): Promise<GPUBuffer> {
    if (!Number.isInteger(numSplats) || numSplats <= 0) {
      throw new RangeError(`Invalid splat count: ${numSplats}. Expected positive integer.`);
    }

    // One-shot build: allocate a fresh scratch set and release the temporary
    // buffers once the GPU work has completed.
    const scratch = this.allocateScratch(numSplats, false);
    try {
      return await this.runBuild(splatCenterBuffer, numSplats, boundsBuffer, scratch);
    } finally {
      this.destroyScratch(scratch, /* keepBvhNodes */ true);
    }
  }

  public async build(splats: { centerBuffer: GPUBuffer, count: number, boundsBuffer: GPUBuffer }): Promise<GPUBuffer> {
    return this.buildHierarchy(splats.centerBuffer, splats.count, splats.boundsBuffer);
  }

  /**
   * Collects the splat positions of all resident tiles into a flat snapshot
   * together with a per-splat tileId mapping.
   */
  private collectTileData(tiles: SplatTileDescriptor[]): CollectedTileData {
    const resident = tiles.filter(
      (tile) => tile.isResidentInVRAM && tile.positions && tile.positions.length >= 3
    );

    let splatCount = 0;
    for (const tile of resident) {
      splatCount += tile.positions!.length / 3;
    }

    const positions = new Float32Array(splatCount * 3);
    const tileIds = new Uint32Array(splatCount);
    let offset = 0;
    for (const tile of resident) {
      const tilePositions = tile.positions!;
      positions.set(tilePositions, offset * 3);
      tileIds.fill(tile.tileId, offset, offset + tilePositions.length / 3);
      offset += tilePositions.length / 3;
    }

    return { positions, tileIds, splatCount };
  }

  private computeBounds(positions: Float32Array): Float32Array {
    const bounds = new Float32Array([
      Infinity, Infinity, Infinity, 0,
      -Infinity, -Infinity, -Infinity, 0
    ]);
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const v = positions[i + axis];
        if (v < bounds[axis]) bounds[axis] = v;
        if (v > bounds[4 + axis]) bounds[4 + axis] = v;
      }
    }
    return bounds;
  }

  /**
   * Runs one rebuild for the given resident tile set. Reuses the persistent
   * scratch buffers when they are large enough; when they must grow, the
   * retired buffers are destroyed only after the new GPU work completed.
   */
  private async performRebuild(tiles: SplatTileDescriptor[]): Promise<{
    data: CollectedTileData;
    bvh: GPUBuffer | null;
  }> {
    const data = this.collectTileData(tiles);

    if (data.splatCount === 0) {
      return { data, bvh: null };
    }

    const retired: GPUBuffer[] = [];
    if (!this.rebuildScratch || this.rebuildScratch.capacity < data.splatCount) {
      if (this.rebuildScratch) {
        retired.push(...this.scratchBufferList(this.rebuildScratch));
      }
      this.rebuildScratch = this.allocateScratch(data.splatCount, true);
    }
    const scratch = this.rebuildScratch;

    this.device.queue.writeBuffer(scratch.splatCenter!, 0, data.positions as unknown as GPUAllowSharedBufferSource);
    this.device.queue.writeBuffer(scratch.bounds!, 0, this.computeBounds(data.positions) as unknown as GPUAllowSharedBufferSource);

    const bvh = await this.runBuild(scratch.splatCenter!, data.splatCount, scratch.bounds!, scratch);

    // GPU work referencing the retired buffers has finished — safe to release.
    for (const buffer of retired) {
      (buffer as any)?.destroy?.();
    }

    return { data, bvh };
  }

  /**
   * Serializes rebuild requests. Requests issued while a rebuild is in flight
   * are coalesced: only the most recent tile set is rebuilt afterwards, and
   * intermediate results are never committed to the raycaster.
   */
  private async drainRebuilds(): Promise<GPUBuffer | null> {
    let lastCommittedBvh: GPUBuffer | null = null;

    while (this.pendingTiles !== null && !this.destroyed) {
      const tiles = this.pendingTiles;
      this.pendingTiles = null;

      // A rebuild is now in flight — queries must not serve stale data.
      this.raycaster.setResidentData(null);

      try {
        const { data, bvh } = await this.performRebuild(tiles);
        // Commit only if no newer request superseded this one while building.
        if (this.pendingTiles === null && !this.destroyed) {
          this.lastRebuildError = null;
          this.raycaster.setResidentData({
            positions: data.positions,
            tileIds: data.tileIds,
            splatCount: data.splatCount
          });
          lastCommittedBvh = bvh;
        }
      } catch (err) {
        if (this.pendingTiles === null) {
          // Rebuild failed: keep the cleared state so queries return null
          // instead of stale data.
          this.lastRebuildError = err;
          this.raycaster.setResidentData(null);
          lastCommittedBvh = null;
        }
      }
    }

    return lastCommittedBvh;
  }

  /**
   * Rebuilds the BVH for the given resident tile set. Concurrent calls are
   * merged — only the latest request's result is committed. Resolves with the
   * BVH buffer of the last committed rebuild, or `null` if the rebuild
   * failed, was superseded before committing anything, or the builder has
   * been destroyed. Never rejects.
   */
  public async rebuildForTiles(tiles: SplatTileDescriptor[]): Promise<GPUBuffer | null> {
    if (this.destroyed) {
      return null;
    }

    this.pendingTiles = tiles;

    if (!this.rebuildChain) {
      const chain = this.drainRebuilds();
      this.rebuildChain = chain;
      chain.finally(() => {
        if (this.rebuildChain === chain) {
          this.rebuildChain = null;
        }
      }).catch(() => { /* drainRebuilds never rejects; guard anyway */ });
    }

    return this.rebuildChain;
  }

  /**
   * Convenience link between the LOD tile manager and the BVH: evaluates the
   * LOD/residency update for the given camera and rebuilds the BVH for the
   * resulting resident set. Resolves with the residency update so callers can
   * page tiles in/out accordingly.
   */
  public async rebuildFromTileManager(
    manager: SplatLODTileManager,
    cameraPos: [number, number, number],
    nearDist: number,
    farDist: number
  ): Promise<LODResidencyUpdate> {
    const update = manager.updateLOD(cameraPos, nearDist, farDist);
    await this.rebuildForTiles(update.resident);
    return update;
  }

  /** Error thrown by the most recent rebuild attempt, or null if it succeeded. */
  public getLastRebuildError(): unknown {
    return this.lastRebuildError;
  }

  public isRebuilding(): boolean {
    return this.rebuildChain !== null;
  }

  public async query(ray: Ray, splatPositions?: Float32Array): Promise<RaycastHit | null> {
    if (this.destroyed) {
      return null;
    }
    return this.raycaster.intersectRay(ray, splatPositions);
  }

  public async frustumCull(
    camera: { projectionMatrix: Float32Array; viewMatrix: Float32Array },
    splatPositions?: Float32Array
  ): Promise<Uint32Array> {
    if (!splatPositions || splatPositions.length === 0) {
      return new Uint32Array(0);
    }
    const numSplats = splatPositions.length / 3;
    const visible: number[] = [];

    // Simple bounding sphere test in view-space
    for (let i = 0; i < numSplats; i++) {
      const x = splatPositions[i * 3];
      const y = splatPositions[i * 3 + 1];
      const z = splatPositions[i * 3 + 2];

      // Transform by viewMatrix (assuming row-major 4x4)
      const vz = camera.viewMatrix[2] * x + camera.viewMatrix[6] * y + camera.viewMatrix[10] * z + camera.viewMatrix[14];

      // Near and far plane test
      if (vz < 0.1 && vz > -1000.0) {
        visible.push(i);
      }
    }

    return new Uint32Array(visible);
  }

  public destroy(): void {
    this.destroyed = true;
    this.pendingTiles = null;
    if (this.rebuildScratch) {
      this.destroyScratch(this.rebuildScratch, /* keepBvhNodes */ false);
      this.rebuildScratch = null;
    }
    this.raycaster?.destroy?.();
  }
}
