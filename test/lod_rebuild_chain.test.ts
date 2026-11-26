import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BVHBuilder } from '../src/core/BVHBuilder';
import { SplatLODTileManager, SplatTileDescriptor } from '../src/core/SplatLODTileManager';

// Mock WebGPU globals in Node
(globalThis as any).GPUBufferUsage = {
  STORAGE: 128,
  COPY_SRC: 4,
  COPY_DST: 8,
  UNIFORM: 64
};

type WorkDoneMode = 'immediate' | 'manual' | 'fail';

function createMockDevice() {
  const createdBuffers: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  const state = {
    mode: 'immediate' as WorkDoneMode,
    workDoneResolvers: [] as Array<() => void>
  };

  const mockPass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    dispatchWorkgroups: vi.fn(),
    end: vi.fn()
  };

  const mockEncoder = {
    beginComputePass: vi.fn().mockReturnValue(mockPass),
    finish: vi.fn().mockReturnValue({})
  };

  const device = {
    createShaderModule: vi.fn().mockReturnValue({}),
    createComputePipeline: vi.fn().mockReturnValue({ getBindGroupLayout: vi.fn().mockReturnValue({}) }),
    createBuffer: vi.fn().mockImplementation(() => {
      const buffer = { destroy: vi.fn() };
      createdBuffers.push(buffer);
      return buffer;
    }),
    createBindGroup: vi.fn().mockReturnValue({}),
    createCommandEncoder: vi.fn().mockReturnValue(mockEncoder),
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
      onSubmittedWorkDone: vi.fn().mockImplementation(() => {
        if (state.mode === 'fail') {
          return Promise.reject(new Error('simulated GPU failure'));
        }
        if (state.mode === 'manual') {
          return new Promise<void>((resolve) => state.workDoneResolvers.push(resolve));
        }
        return Promise.resolve();
      })
    }
  } as unknown as GPUDevice;

  return { device, createdBuffers, state };
}

function makeTile(
  tileId: number,
  z: number,
  isResidentInVRAM = false
): SplatTileDescriptor {
  return {
    tileId,
    mortonStart: tileId * 100,
    mortonEnd: tileId * 100 + 99,
    center: [0, 0, z],
    splatCount: 1,
    lodLevel: 0,
    isResidentInVRAM,
    positions: new Float32Array([0, 0, z])
  };
}

const rayDownZ = (zOrigin: number) => ({
  origin: new Float32Array([0, 0, zOrigin]),
  direction: new Float32Array([0, 0, 1])
});

describe('LOD → BVH rebuild → raycast chain', () => {
  let mock: ReturnType<typeof createMockDevice>;

  beforeEach(() => {
    mock = createMockDevice();
  });

  it('makes tiles resident after updateLOD and raycasts the rebuilt resident set', async () => {
    const manager = new SplatLODTileManager(10);
    manager.registerTile(makeTile(1, 5));
    manager.registerTile(makeTile(2, 50));

    const builder = new BVHBuilder(mock.device);
    const update = await builder.rebuildFromTileManager(manager, [0, 0, 0], 10, 30);

    // LOD levels assigned by distance
    expect(manager.getTile(1)?.lodLevel).toBe(0);
    expect(manager.getTile(2)?.lodLevel).toBe(2);

    // Both tiles fit under capacity → all resident, none evicted
    expect(update.resident.map((t) => t.tileId).sort()).toEqual([1, 2]);
    expect(update.toResident.map((t) => t.tileId).sort()).toEqual([1, 2]);
    expect(update.toEvict).toEqual([]);
    expect(manager.getTile(1)?.isResidentInVRAM).toBe(true);
    expect(manager.getTile(2)?.isResidentInVRAM).toBe(true);

    // Raycast uses the committed resident data — nearest splat belongs to tile 1
    const hit = await builder.query(rayDownZ(0));
    expect(hit).not.toBeNull();
    expect(hit?.tileId).toBe(1);
    expect(hit?.distance).toBeCloseTo(4.5);
  });

  it('evicts the farthest tiles first when residency exceeds maxTileCapacity', async () => {
    const manager = new SplatLODTileManager(2);
    // All three tiles start resident in VRAM
    manager.registerTile(makeTile(1, 5, true));
    manager.registerTile(makeTile(2, 20, true));
    manager.registerTile(makeTile(3, 50, true));

    const builder = new BVHBuilder(mock.device);
    const update = await builder.rebuildFromTileManager(manager, [0, 0, 0], 10, 30);

    // Capacity 2 → closest two stay resident, farthest (tile 3) is evicted
    expect(update.resident.map((t) => t.tileId).sort()).toEqual([1, 2]);
    expect(update.toEvict.map((t) => t.tileId)).toEqual([3]);
    expect(manager.getTile(3)?.isResidentInVRAM).toBe(false);

    // A ray that would only hit the evicted tile's splat (at z=50) must miss
    const miss = await builder.query(rayDownZ(40));
    expect(miss).toBeNull();

    // Resident tiles are still queryable and report their tileId
    const hit = await builder.query(rayDownZ(0));
    expect(hit?.tileId).toBe(1);
  });

  it('returns null instead of stale data when a rebuild fails', async () => {
    const manager = new SplatLODTileManager(10);
    manager.registerTile(makeTile(1, 5, true));

    const builder = new BVHBuilder(mock.device);
    await builder.rebuildFromTileManager(manager, [0, 0, 0], 10, 30);
    expect(await builder.query(rayDownZ(0))).not.toBeNull();

    // Next rebuild fails on the GPU queue
    mock.state.mode = 'fail';
    const result = await builder.rebuildForTiles(manager.getAllTiles());

    expect(result).toBeNull();
    expect(builder.getLastRebuildError()).toBeInstanceOf(Error);
    // Query must return null, not the previously committed data, and not throw
    await expect(builder.query(rayDownZ(0))).resolves.toBeNull();
  });

  it('coalesces concurrent rebuild requests and commits only the latest result', async () => {
    const builder = new BVHBuilder(mock.device);
    const tileA = makeTile(1, 5, true);
    const tileB = makeTile(2, 10, true);
    const tileC = makeTile(3, 15, true);

    // First rebuild blocks on the GPU queue
    mock.state.mode = 'manual';
    const pA = builder.rebuildForTiles([tileA]);
    // Two more requests arrive while the first is still in flight
    const pB = builder.rebuildForTiles([tileB]);
    const pC = builder.rebuildForTiles([tileC]);

    expect(mock.device.queue.submit).toHaveBeenCalledTimes(1);

    // Let the in-flight build finish; subsequent builds complete immediately
    mock.state.mode = 'immediate';
    mock.state.workDoneResolvers.forEach((resolve) => resolve());

    const [rA, rB, rC] = await Promise.all([pA, pB, pC]);

    // B was superseded by C → exactly two GPU builds, never three
    expect(mock.device.queue.submit).toHaveBeenCalledTimes(2);
    // All callers observe the final committed rebuild
    expect(rA).toBe(rC);
    expect(rB).toBe(rC);

    // Same splat count → scratch buffers reused, no reallocation
    expect(mock.device.createBuffer).toHaveBeenCalledTimes(8);

    // Only the latest tile set (C) is visible to queries
    const hit = await builder.query(rayDownZ(0));
    expect(hit?.tileId).toBe(3);
    expect(hit?.distance).toBeCloseTo(14.5);
  });

  it('releases retired buffers only after GPU work completes when scratch grows', async () => {
    const builder = new BVHBuilder(mock.device);

    const smallTile = makeTile(1, 5, true);
    await builder.rebuildForTiles([smallTile]);
    const firstGenBuffers = [...mock.createdBuffers];
    expect(firstGenBuffers.length).toBe(8);
    firstGenBuffers.forEach((b) => expect(b.destroy).not.toHaveBeenCalled());

    // Grow to 300 splats → new scratch set allocated, old one retired
    const bigTile: SplatTileDescriptor = {
      ...makeTile(2, 5, true),
      splatCount: 300,
      positions: new Float32Array(300 * 3)
    };
    await builder.rebuildForTiles([bigTile]);

    expect(mock.device.createBuffer).toHaveBeenCalledTimes(16);
    expect(mock.device.queue.onSubmittedWorkDone).toHaveBeenCalled();
    // After completion the retired buffers were destroyed
    firstGenBuffers.forEach((b) => expect(b.destroy).toHaveBeenCalledTimes(1));
  });

  it('stops rebuilding and querying after destroy()', async () => {
    const builder = new BVHBuilder(mock.device);
    await builder.rebuildForTiles([makeTile(1, 5, true)]);
    expect(await builder.query(rayDownZ(0))).not.toBeNull();

    builder.destroy();

    const submitsBefore = (mock.device.queue.submit as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(await builder.rebuildForTiles([makeTile(2, 10, true)])).toBeNull();
    expect((mock.device.queue.submit as ReturnType<typeof vi.fn>).mock.calls.length).toBe(submitsBefore);
    await expect(builder.query(rayDownZ(0))).resolves.toBeNull();
  });
});
