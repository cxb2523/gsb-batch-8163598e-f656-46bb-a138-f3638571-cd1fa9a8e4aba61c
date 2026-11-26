/*! CursorFX lifecycle checks — zero dependencies, runs under plain Node (no DOM build required).
 * It shims just enough of the browser (DOM nodes, canvas 2D, AudioContext, rAF) to load the
 * real src/ files, then drives CursorFX.init/set/destroy and asserts plugin lifecycle rules:
 *   - switching a layer destroys the old instance and never calls its update/render again
 *   - plugin-owned fields on shared state are rolled back on destroy
 *   - DOM nodes plugins create are removed on destroy (and never duplicated)
 *   - re-applying the same config recreates nothing; destroy() then init() works again
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------- browser shims ----------

const liveNodes = new Set();

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.attrs = {};
    this.parentNode = null;
    liveNodes.add(this);
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttributeNS(_ns, k, v) { this.attrs[k] = String(v); }
  removeAttributeNS() {}
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
      this.parentNode = null;
    }
  }
  addEventListener() {} removeEventListener() {}
  closest() { return null; }
  querySelector() { return null; }
}

function makeGradient() { return { addColorStop() {} }; }
function make2dContext(canvasEl) {
  return new Proxy({ canvas: canvasEl }, {
    get(_t, prop) {
      if (prop === 'measureText') return () => ({ width: 12, actualBoundingBoxAscent: 8 });
      if (prop === 'createImageData' || prop === 'getImageData') {
        return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      }
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient' || prop === 'createPattern') {
        return makeGradient;
      }
      if (prop === 'getTransform') return () => new DOMMatrixShim();
      return typeof prop === 'string' ? () => {} : undefined;
    },
    set() { return true; },
  });
}

class DOMMatrixShim {
  translateSelf() { return this; }
  rotateSelf() { return this; }
  scaleSelf() { return this; }
  multiply() { return new DOMMatrixShim(); }
  transformPoint(p) { return { x: p.x, y: p.y }; }
}
class Path2DShim {}
['moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'arc', 'ellipse', 'rect', 'closePath'].forEach((m) => {
  Path2DShim.prototype[m] = function () { return this; };
});

class AudioParamShim {
  setValueAtTime() {} exponentialRampToValueAtTime() {} setTargetAtTime() {} linearRampToValueAtTime() {}
}
class AudioNodeShim {
  constructor(ctx) { this.ctx = ctx; this.gain = new AudioParamShim(); this.frequency = new AudioParamShim(); this.detune = new AudioParamShim(); this.Q = new AudioParamShim(); this.threshold = new AudioParamShim(); this.ratio = new AudioParamShim(); }
  connect(d) { return d; }
  disconnect() {}
  start() { this.ctx.startedSources.push(this); }
  stop() { this.ctx.stoppedSources.push(this); }
}
const audioContexts = [];
class AudioContextShim {
  constructor() {
    this.state = 'running';
    this.currentTime = 1;
    this.sampleRate = 44100;
    this.destination = new AudioNodeShim(this);
    this.startedSources = [];
    this.stoppedSources = [];
    audioContexts.push(this);
  }
  createGain() { return new AudioNodeShim(this); }
  createDynamicsCompressor() { return new AudioNodeShim(this); }
  createBiquadFilter() { return new AudioNodeShim(this); }
  createWaveShaper() { return new AudioNodeShim(this); }
  createConvolver() { return new AudioNodeShim(this); }
  createOscillator() { const n = new AudioNodeShim(this); n.setPeriodicWave = () => {}; n.type = ''; return n; }
  createBufferSource() { const n = new AudioNodeShim(this); n.loop = false; n.buffer = null; return n; }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len), numberOfChannels: ch, length: len }; }
  createPeriodicWave() { return {}; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

const rafMap = new Map();
let rafId = 0, clock = 0;
const listeners = { add: 0, remove: 0 };

const documentShim = {
  body: new El('body'),
  head: new El('head'),
  hidden: false,
  createElement(tag) {
    const e = new El(tag);
    if (tag === 'canvas') {
      e.width = 0; e.height = 0;
      e.getContext = () => make2dContext(e);
      e.toDataURL = () => 'data:image/png;base64,SHIM';
    }
    return e;
  },
  createElementNS(_ns, tag) { return new El(tag); },
  addEventListener() {}, removeEventListener() {},
};

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, Promise,
  Math, JSON, Map, Set, Object, Array, String, Number, Boolean, Error, Symbol, Float32Array, Uint8ClampedArray,
  document: documentShim,
  AudioContext: AudioContextShim,
  DOMMatrix: DOMMatrixShim,
  Path2D: Path2DShim,
  CSS: { supports: () => true },
  matchMedia: () => ({ matches: false }),
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
  addEventListener() { listeners.add++; },
  removeEventListener() { listeners.remove++; },
  requestAnimationFrame(cb) { rafMap.set(++rafId, cb); return rafId; },
  cancelAnimationFrame(id) { rafMap.delete(id); },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// ---------- load the real sources in build order ----------

const root = path.join(__dirname, '..', 'src');
function load(rel) {
  vm.runInContext(fs.readFileSync(path.join(root, rel), 'utf8'), sandbox, { filename: rel });
}
load('core.js');
load('util.js');
['cursors', 'trails', 'clicks'].forEach((dir) => {
  fs.readdirSync(path.join(root, dir)).sort().forEach((f) => load(dir + '/' + f));
});
const CursorFX = sandbox.window.CursorFX;

// ---------- tiny test framework ----------

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failures.push({ name, e }); console.log('  FAIL - ' + name + ': ' + e.message); }
}
function frames(n) {
  for (let i = 0; i < n; i++) {
    const cbs = Array.from(rafMap.values());
    rafMap.clear();
    clock += 16;
    cbs.forEach((cb) => cb(clock));
  }
}
function descendants(el) {
  const out = [];
  (function walk(n) { n.children.forEach((c) => { out.push(c); walk(c); }); })(el);
  return out;
}
function bodyDivsWithData() {
  return descendants(documentShim.body).filter((e) => e.tagName === 'DIV' && e.attrs['data-cursorfx'] !== undefined);
}
function bodyCanvases() {
  return descendants(documentShim.body).filter((e) => e.tagName === 'CANVAS');
}

// Spy plugins: they write shared state, create a DOM node each, and record every lifecycle call.
const calls = {
  cur: { create: 0, destroy: 0, update: 0, render: 0, afterDeath: 0 },
  trail: { create: 0, destroy: 0, update: 0, render: 0, afterDeath: 0 },
  click: { create: 0, destroy: 0, update: 0, render: 0, afterDeath: 0 },
};
function spyDef(kind, field) {
  return {
    label: 'spy ' + kind,
    create(_opts, api) {
      calls[kind].create++;
      const node = documentShim.createElement('div');
      node.setAttribute('data-spy', kind);
      documentShim.body.appendChild(node);
      let dead = false;
      return {
        update() {
          if (dead) { calls[kind].afterDeath++; return; }
          calls[kind].update++;
          api.state[field] = (api.state[field] || 0) + 1;
        },
        render() { if (dead) calls[kind].afterDeath++; else calls[kind].render++; },
        destroy() {
          dead = true;
          calls[kind].destroy++;
          node.remove();
        },
      };
    },
  };
}
CursorFX.registerCursor('spy-cur', spyDef('cur', 'spyCurField'));
CursorFX.registerTrail('spy-trail', spyDef('trail', 'spyTrailField'));
CursorFX.registerClick('spy-click', spyDef('click', 'spyClickField'));

const base = { cursor: 'spy-cur', trail: 'spy-trail', click: 'spy-click', sound: false };

(async function run() {
  await test('init creates exactly one instance per layer', () => {
    CursorFX.init(Object.assign({}, base));
    assert.strictEqual(calls.cur.create, 1);
    assert.strictEqual(calls.trail.create, 1);
    assert.strictEqual(calls.click.create, 1);
    assert.strictEqual(bodyCanvases().length, 1, 'overlay canvas exists');
    assert.strictEqual(descendants(documentShim.body).filter((e) => e.attrs['data-spy']).length, 3);
  });

  await test('frame loop drives update/render of live instances', () => {
    frames(5);
    assert.ok(calls.cur.update > 0 && calls.cur.render > 0);
    assert.ok(calls.trail.update > 0 && calls.click.update > 0);
    assert.ok(CursorFX.state.spyCurField > 0, 'plugin wrote its shared state field');
  });

  await test('repeated set of the same config creates nothing new', () => {
    for (let i = 0; i < 5; i++) CursorFX.set(Object.assign({}, base));
    assert.deepStrictEqual({ c: calls.cur.create, t: calls.trail.create, k: calls.click.create }, { c: 1, t: 1, k: 1 });
    assert.strictEqual(calls.cur.destroy + calls.trail.destroy + calls.click.destroy, 0);
    assert.strictEqual(descendants(documentShim.body).filter((e) => e.attrs['data-spy']).length, 3);
  });

  await test('partial set touching no layer (sound only) keeps every instance', () => {
    CursorFX.set({ sound: true });
    assert.deepStrictEqual({ c: calls.cur.create, t: calls.trail.create, k: calls.click.create }, { c: 1, t: 1, k: 1 });
    CursorFX.set({ sound: false });
  });

  await test('switching cursor destroys old instance, rolls state back, freezes its update/render', () => {
    const updatesBefore = calls.cur.update, rendersBefore = calls.cur.render;
    CursorFX.set({ cursor: 'ring' });
    assert.strictEqual(calls.cur.destroy, 1);
    assert.ok(!('spyCurField' in CursorFX.state), 'shared field removed on destroy');
    frames(4);
    assert.strictEqual(calls.cur.update, updatesBefore, 'destroyed instance never updates again');
    assert.strictEqual(calls.cur.render, rendersBefore, 'destroyed instance never renders again');
    assert.strictEqual(calls.cur.afterDeath, 0);
    assert.strictEqual(calls.trail.create, 1, 'other layers are untouched');
    assert.strictEqual(calls.click.create, 1);
    assert.strictEqual(CursorFX.getConfig().cursor, 'ring');
  });

  await test('switching back starts a fresh instance with no inherited state', () => {
    CursorFX.set({ cursor: 'spy-cur' });
    assert.strictEqual(calls.cur.create, 2);
    assert.ok(!('spyCurField' in CursorFX.state), 'new instance does not inherit old field');
    frames(2);
    assert.strictEqual(CursorFX.state.spyCurField, 2, 'field starts counting from scratch');
  });

  await test('setting a layer to null destroys it and removes its DOM nodes; re-set re-inits', () => {
    CursorFX.set({ click: null });
    assert.strictEqual(calls.click.destroy, 1);
    assert.ok(!('spyClickField' in CursorFX.state));
    assert.strictEqual(descendants(documentShim.body).filter((e) => e.attrs['data-spy'] === 'click').length, 0);
    frames(2);
    assert.strictEqual(calls.click.afterDeath, 0);
    CursorFX.set({ click: 'spy-click' });
    assert.strictEqual(calls.click.create, 2);
  });

  await test('gunshot shared shot counter is rolled back when the click layer leaves', () => {
    CursorFX.set({ click: 'gunshot' });
    CursorFX.trigger(12, 12);
    CursorFX.trigger(12, 12);
    assert.strictEqual(CursorFX.state.shots, 2);
    CursorFX.set({ click: 'ripple' });
    assert.ok(!('shots' in CursorFX.state), 'state.shots must not leak into the next plugin');
    frames(2);
  });

  await test('waves click removes its SVG/filter DOM container on destroy (and never duplicates it)', () => {
    CursorFX.set({ click: 'waves' });
    CursorFX.trigger(40, 40);
    CursorFX.trigger(60, 60);
    const roots = bodyDivsWithData();
    assert.strictEqual(roots.length, 1, 'one filter container no matter how many clicks');
    assert.ok(roots[0].children.length >= 1, 'container holds the svg/filter nodes');
    CursorFX.set({ click: 'ripple' });
    assert.strictEqual(bodyDivsWithData().length, 0, 'filter container removed with the instance');
  });

  await test('f1car telemetry and engine are torn down on switch', async () => {
    CursorFX.set({ cursor: 'f1car', sound: true });
    frames(12);
    assert.ok(CursorFX.state.meta && typeof CursorFX.state.meta.kmh === 'number', 'f1car publishes telemetry');
    assert.strictEqual(audioContexts.length, 1, 'a single shared AudioContext is reused');
    const ctx = audioContexts[0];
    assert.ok(ctx.startedSources.length > 0, 'engine nodes started');
    CursorFX.set({ cursor: 'orb' });
    assert.ok(!('meta' in CursorFX.state), 'telemetry removed when f1car dies');
    frames(8);
    // The delayed node cleanup runs on real timers; give it a tick.
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(ctx.stoppedSources.length > 0, 'old engine nodes were stopped, not leaked');
    CursorFX.set({ sound: false });
  });

  await test('gun cursor does not fire when the shot counter is rolled back', () => {
    CursorFX.set({ cursor: 'gun-rifle', click: 'gunshot' });
    frames(2);
    CursorFX.trigger(90, 90);
    frames(2);
    assert.strictEqual(CursorFX.state.shots, 1);
    CursorFX.set({ click: null });
    assert.ok(!('shots' in CursorFX.state));
    frames(4); // would throw/spam fire() under the old !== comparison
    assert.strictEqual(CursorFX.getConfig().cursor, 'gun-rifle', 'gun cursor survives the click swap');
    CursorFX.set({ cursor: 'spy-cur' });
  });

  await test('changing a plugin option recreates only that layer, once', () => {
    const before = calls.cur.create;
    CursorFX.set({ options: Object.assign({}, CursorFX.getConfig().options, { 'spy-cur': { livery: '#abc' } }) });
    assert.strictEqual(calls.cur.create, before + 1, 'option change recreates the cursor once');
    assert.strictEqual(calls.trail.create, 1, 'trail unaffected by cursor option change');
    CursorFX.set({ options: Object.assign({}, CursorFX.getConfig().options, { 'spy-cur': { livery: '#abc' } }) });
    assert.strictEqual(calls.cur.create, before + 1, 'same effective options do not recreate again');
  });

  await test('destroy() tears everything down and is safe to call twice', () => {
    CursorFX.destroy();
    CursorFX.destroy();
    assert.strictEqual(rafMap.size, 0, 'animation frame cancelled');
    assert.strictEqual(bodyCanvases().length, 0, 'canvas removed');
    assert.strictEqual(bodyDivsWithData().length, 0);
    assert.strictEqual(descendants(documentShim.body).filter((e) => e.attrs['data-spy']).length, 0);
    ['cur', 'trail', 'click'].forEach((k) => assert.strictEqual(calls[k].destroy, calls[k].create, k + ' all instances destroyed'));
    assert.ok(!('spyCurField' in CursorFX.state) && !('spyTrailField' in CursorFX.state) && !('shots' in CursorFX.state));
    assert.strictEqual(audioContexts[audioContexts.length - 1].state, 'closed');
  });

  await test('init() after destroy() boots a clean, working engine', () => {
    const createsBefore = calls.cur.create;
    CursorFX.init({ cursor: 'spy-cur', trail: null, click: null });
    assert.strictEqual(calls.cur.create, createsBefore + 1);
    assert.strictEqual(bodyCanvases().length, 1, 'new overlay canvas');
    frames(4);
    assert.ok(calls.cur.update > 0, 'new instance is driven by the new frame loop');
    CursorFX.destroy();
    assert.strictEqual(rafMap.size, 0);
  });

  await test('no leaked DOM nodes remain after the whole sequence', () => {
    // Canvas/style/spy/wave nodes are all created through document shim; body and head must be empty.
    assert.strictEqual(descendants(documentShim.body).length, 0);
    assert.strictEqual(descendants(documentShim.head).length, 0);
  });

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    failures.forEach((f) => { console.error('\n' + f.name); console.error(f.e.stack); });
    process.exit(1);
  }
})();
