// The cart canvas's lifecycle: reconfigure and resize, frame reads, draws and
// what the release tracker does with a texture the ring drops
// (src/wgpu/host.js, src/wgpu/release.js).
//
// A WebGPU cart configures its surface once in wc_init (docs/webgpu.md,
// "Resize"), but a host canvas may be reconfigured under a running cart: a
// new size or format, a configure/unconfigure pair, or a resize of the
// host's canvas object. Everything the host cached or started for the old
// configuration is then stale: the texture ring (built for the old size and
// format), the blitter pipelines (built per target format) and their bind
// groups (built for textures the old ring handed out, which the reconfigure
// destroys), and a frame read still in flight.
//
// Nothing here needs a fixture: the canvas is the host-owned one the WebGPU
// session makes (createTextureCanvas), and the session is driven over a real
// webgpu-node device, as the Node host does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTextureCanvas } from '../src/wgpu/host.js';
import { createReleaseTracker } from '../src/wgpu/release.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

// A texture stand-in for the canvas alone: an object with the size/format the
// canvas hands out, a createTexture() behind the device, and a destroy() that
// fails if it runs twice (the bug the dropper wiring fixes).
function fakeDevice() {
  const made = [];
  const device = {
    createTexture(desc) {
      const t = {
        label: desc.label, width: desc.size[0], height: desc.size[1], format: desc.format,
        destroyed: 0, destroyCount: 0,
        destroy() { this.destroyCount++; if (this.destroyCount > 1) throw new Error('double destroy'); this.destroyed = 1; },
      };
      made.push(t);
      return t;
    },
  };
  return { device, made };
}

test('a reconfigure drops the ring, so the next frame is the new size and format', () => {
  const { device, made } = fakeDevice();
  const canvas = createTextureCanvas(64, 48);
  const ctx = canvas.getContext('webgpu');
  ctx.configure({ device, format: 'bgra8unorm', usage: 0x10 });

  const first = ctx.getCurrentTexture();
  assert.deepEqual([first.width, first.height, first.format], [64, 48, 'bgra8unorm']);
  ctx.present();

  // As the glue does for a wgpuSurfaceConfigure with a size: the canvas is
  // resized, then the context configured (a browser's configure alone does
  // not resize the canvas either).
  canvas.width = 96;
  canvas.height = 72;
  ctx.configure({ device, format: 'rgba8unorm', usage: 0x10 });
  const next = ctx.getCurrentTexture();
  assert.deepEqual([next.width, next.height, next.format], [96, 72, 'rgba8unorm'],
    'the ring from before the reconfigure is gone: no old texture is handed out');
  // The one flushed texture (the one taken and presented) is destroyed; a
  // spare from the ring is destroyed too. Every texture made died at most once.
  assert.ok(made.length >= 2);
  for (const t of made) assert.ok(t.destroyCount <= 1, 'a dropped texture is never destroyed twice');
});

test('a resize drops the ring, and the next frame is the new size', () => {
  const { device } = fakeDevice();
  const canvas = createTextureCanvas(64, 48);
  const ctx = canvas.getContext('webgpu');
  ctx.configure({ device, format: 'bgra8unorm', usage: 0x10 });
  assert.equal(ctx.getCurrentTexture().width, 64);
  ctx.present();
  canvas.width = 128;
  canvas.height = 100;
  const t = ctx.getCurrentTexture();
  assert.deepEqual([t.width, t.height], [128, 100]);
});

test('an unconfigured or destroyed canvas throws no frame out of getCurrentTexture', () => {
  const { device } = fakeDevice();
  const canvas = createTextureCanvas(8, 8);
  const ctx = canvas.getContext('webgpu');
  assert.throws(() => ctx.getCurrentTexture(), /not configured/);
  ctx.configure({ device, format: 'bgra8unorm', usage: 0x10 });
  assert.equal(ctx.getCurrentTexture().width, 8);
  ctx.unconfigure();
  assert.throws(() => ctx.getCurrentTexture(), /not configured/);
  assert.equal(ctx.getConfiguration(), null);
  ctx.configure({ device, format: 'bgra8unorm', usage: 0x10 });
  assert.equal(ctx.getCurrentTexture().width, 8, 'configure after unconfigure works');
  // context.destroy() unconfigures it for good
  ctx.destroy();
  assert.throws(() => ctx.getCurrentTexture(), /not configured/);
});

test('a texture the canvas drops is retired into the release tracker: destroyed once, after its holder goes', () => {
  // The release tracker over class stand-ins (release.js only needs the
  // WebGPU classes to recognise what an object is). A surface texture the
  // cart still holds through a view, dropped by a reconfigure, must survive
  // until the view is released, and then be destroyed exactly once.
  class GPUTexture { constructor() { this.destroyed = 0; this.isTexture = true; } destroy() { this.destroyed++; } }
  class GPUBuffer {}
  class GPUTextureView { constructor(tex) { this.tex = tex; } }
  class GPUBindGroup {}
  class GPURenderBundle {}
  class GPURenderBundleEncoder {}
  class GPUCommandEncoder {}
  class GPUCommandBuffer {}
  const globals = { GPUTexture, GPUBuffer, GPUTextureView, GPUBindGroup, GPURenderBundle, GPURenderBundleEncoder, GPUCommandEncoder, GPUCommandBuffer };

  let recorded = null;
  const tex = new GPUTexture();
  const view = new GPUTextureView(tex);
  // The glue's handle table, keyed by the cart's pointers: the tracked calls
  // read it directly for the texture a view or bind group is made from.
  const handles = new Map([[1, tex]]);
  const tracker = createReleaseTracker(globals, ptr => handles.get(ptr), fn => { recorded = fn; });
  // The cart takes the surface texture (the canvas's, never tracked by a
  // release of its own) and makes a view of it, kept.
  tracker.surfaceTexture(() => { tracker.made(tex); });
  // A view holds its texture (the tracked call's lookup recorder).
  tracker.view(1, () => { tracker.made(view); });
  assert.equal(recorded, null, 'the recorder is removed after the call');

  // The cart releases its run of the surface texture (the view still holds it).
  tracker.released(tex);
  assert.equal(tracker.retire(tex), true, 'retiring a surface texture hands it to the tracker');
  tracker.frameEnd();
  assert.equal(tex.destroyed, 0, 'the view still holds it: not destroyed');

  // The view goes: now nothing reaches the texture.
  tracker.released(view);
  tracker.frameEnd();
  assert.equal(tex.destroyed, 1, 'destroyed once, when the last holder lets go');
  assert.equal(tracker.stats().destroyed, 1);
  tracker.dispose();
});

test('retire() leaves a texture the cart never had to the canvas (it was not tracked)', () => {
  class GPUTexture { destroy() {} }
  class GPUBuffer {}
  class GPUTextureView {}
  class GPUBindGroup {}
  class GPURenderBundle {}
  class GPURenderBundleEncoder {}
  class GPUCommandEncoder {}
  class GPUCommandBuffer {}
  const globals = { GPUTexture, GPUBuffer, GPUTextureView, GPUBindGroup, GPURenderBundle, GPURenderBundleEncoder, GPUCommandEncoder, GPUCommandBuffer };
  const tracker = createReleaseTracker(globals, () => undefined, () => {});
  const tex = new GPUTexture();
  assert.equal(tracker.retire(tex), false, 'a texture the tracker never saw stays the canvas\'s to destroy');
  tracker.dispose();
});

test('a pinned texture under an in-flight frame read survives a retire, then is destroyed once as it unpins', () => {
  class GPUTexture { constructor() { this.destroyed = 0; } destroy() { this.destroyed++; } }
  class GPUBuffer {}
  class GPUTextureView {}
  class GPUBindGroup {}
  class GPURenderBundle {}
  class GPURenderBundleEncoder {}
  class GPUCommandEncoder {}
  class GPUCommandBuffer {}
  const globals = { GPUTexture, GPUBuffer, GPUTextureView, GPUBindGroup, GPURenderBundle, GPURenderBundleEncoder, GPUCommandEncoder, GPUCommandBuffer };
  const tracker = createReleaseTracker(globals, () => undefined, () => {});
  const tex = new GPUTexture();
  tracker.surfaceTexture(() => { tracker.made(tex); });
  tracker.released(tex);          // the cart releases its handle right after the copy
  tracker.pin(tex);               // the in-flight read keeps it
  assert.equal(tracker.retire(tex), true, 'the ring dropped it');
  tracker.frameEnd();
  assert.equal(tex.destroyed, 0, 'pinned: the copy may not have run yet');
  tracker.unpin(tex);
  tracker.frameEnd();
  assert.equal(tex.destroyed, 1, 'unpinned and nothing holds it: destroyed once');
});

test('the tracker with a missing class is inert: retire/pin/unpin do not throw', () => {
  const tracker = createReleaseTracker({}, () => undefined, () => {});
  assert.equal(tracker.stats(), null);
  assert.equal(tracker.retire({}), false);
  tracker.pin({}); tracker.unpin({});
  tracker.frameEnd();
  tracker.dispose();
});

// ─── the session, over a real device (the Node host's webgpu-node) ──────────
// wgpuedges.wasc reconfigures its surface from 128x96 to 160x120 at frame 10
// and writes the new size into wc_info_t: the host must read the new size and
// draw the blue frame that follows from then on (the normal reconfigure), and
// must not let a frame read started before it collapse into a frame of the
// wrong size or a crash.
const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = name => join(HERE, 'fixtures', name);
const px = (f, x, y) => { const i = (y * f.width + x) * 4; return [...f.data.slice(i, i + 4)]; };

async function edgesHost() {
  const { CartHost } = await import('../index.js');
  const host = new CartHost();
  // compatibility mode, so the cart's request for a device above the floor
  // gets its own device (the edges fixture asks for one); the reconfigure is
  // what this exercises, not the second device.
  await host.load(fixture('wgpuedges.wasc'), { adapterOptions: { featureLevel: 'compatibility' } });
  return host;
}

test('a normal reconfigure: the host reads and draws the new size and format from the frame it takes effect', async () => {
  const host = await edgesHost();
  try {
    const session = host._wgpu;
    for (let i = 0; i < 9; i++) { host.runFrame(); await tick(); }
    const green = await host.readGpuFrame();
    assert.deepEqual([green.width, green.height, ...px(green, 4, 4)], [128, 96, 0, 255, 0, 255], 'green at 128x96');
    const genBefore = session.generation;
    for (let i = 0; i < 6; i++) { host.runFrame(); await tick(); }
    const blue = await host.readGpuFrame();
    assert.deepEqual([blue.width, blue.height, ...px(blue, 4, 4)], [160, 120, 0, 0, 255, 255],
      'blue at the size the reconfigure set');
    assert.ok(session.generation > genBefore, 'the reconfigure bumped the generation');
    assert.deepEqual([host.getInfo().width, host.getInfo().height], [160, 120], 'wc_info_t\'s new size is adopted');
  } finally {
    host.destroy();
  }
});

test('a reconfigure during a frame read: the read still returns the frame it captured (right size and format), and the texture is destroyed once', async () => {
  const host = await edgesHost();
  try {
    const session = host._wgpu;
    for (let i = 0; i < 9; i++) { host.runFrame(); await tick(); }
    const destroyedBefore = session.released.destroyed;
    const read = host.readGpuFrame();                 // captures the 128x96 green frame
    for (let i = 0; i < 6; i++) { host.runFrame(); await tick(); }  // frame 10: reconfigure to 160x120
    const frame = await read;
    assert.deepEqual([frame.width, frame.height, ...px(frame, 4, 4)], [128, 96, 0, 255, 0, 255],
      'the in-flight read is the frame it captured, not the reconfigured one');
    for (let i = 0; i < 6; i++) await tick();
    // The ring the reconfigure flushed retired the captured texture; it was
    // destroyed once (no second destroy of an already destroyed texture), and
    // the session is still reading the new configuration.
    assert.ok(session.released.destroyed > destroyedBefore, 'the flushed ring texture was destroyed');
    assert.equal(session.lost, null, 'no validation error or device loss: nothing was copied from a destroyed texture');
    const after = await host.readGpuFrame();
    assert.deepEqual([after.width, after.height, ...px(after, 4, 4)], [160, 120, 0, 0, 255, 255], 'reads the new frame after');
  } finally {
    host.destroy();
  }
});

test('a frame read in flight at destroy resolves null, and a read or draw after destroy returns null/false, never throws', async () => {
  const host = await edgesHost();
  const session = host._wgpu;
  for (let i = 0; i < 3; i++) { host.runFrame(); await tick(); }
  const read = host.readGpuFrame();
  await host.destroy();
  assert.equal(await read, null, 'the in-flight read resolves to null');
  assert.equal(await session.readFrame(), null, 'a read after destroy is null');
  assert.equal(session.drawTo({ getCurrentTexture: () => null }), false, 'a draw after destroy is false');
});

test('a reconfigure and destroy in the same task as a frame read: the read is null, nothing throws, nothing is destroyed twice', async () => {
  const host = await edgesHost();
  const session = host._wgpu;
  for (let i = 0; i < 5; i++) { host.runFrame(); await tick(); }
  const read = host.readGpuFrame();
  // A reconfigure flushes the ring (retiring the captured texture), then the
  // host is destroyed before the copy's map can return.
  session.context.unconfigure();
  await host.destroy();
  assert.equal(await read, null, 'a frame read across a reconfigure and destroy resolves null');
  const strays = [];
  const onRej = e => strays.push(e);
  process.on('unhandledRejection', onRej);
  try { for (let i = 0; i < 10; i++) await tick(); } finally { process.off('unhandledRejection', onRej); }
  assert.deepEqual(strays, [], 'no unhandled rejection from the in-flight read');
});
