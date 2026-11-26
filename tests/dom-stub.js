'use strict';
// Minimal browser surface for running src/game.js under Node.
// Only what the game touches is implemented; drawing calls are no-ops.

function makeCtx() {
  const noop = () => {};
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'getImageData') return () => ({ data: [0, 0, 0, 0] });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop: noop });
      if (typeof k === 'string') return noop;
      return undefined;
    },
    set() { return true; }
  });
  return ctx;
}

function makeElement(id) {
  const el = {
    id: id || '',
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    clientWidth: 1280,
    clientHeight: 800,
    offsetHeight: 40,
    target: {},
    setAttribute() {},
    getAttribute() { return null; },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    closest() { return null; },
    focus() {},
    getContext: () => makeCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture() {},
    releasePointerCapture() {},
    get isContextLost() { return () => false; }
  };
  return el;
}

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
    _store: store
  };
}

// A sandbox object carrying every global the game script expects.
function makeSandbox(D) {
  const sandbox = {};
  // Node built-ins the game uses
  sandbox.console = console;
  sandbox.setTimeout = (fn) => 0;          // game timeers never need to fire in tests
  sandbox.clearTimeout = () => {};
  sandbox.setInterval = () => 0;
  sandbox.clearInterval = () => {};
  sandbox.requestAnimationFrame = () => 0;
  sandbox.performance = { now: () => Date.now() };
  sandbox.localStorage = makeLocalStorage();
  sandbox.navigator = { vibrate() {} };
  sandbox.innerWidth = 1280;
  sandbox.innerHeight = 800;
  sandbox.devicePixelRatio = 1;
  sandbox.matchMedia = () => ({ matches: false });
  sandbox.document = {
    documentElement: { style: { setProperty() {} } },
    body: { classList: { add() {}, remove() {}, toggle() {} } },
    getElementById: id => makeElement(id),
    createElement: () => makeElement(),
    addEventListener() {},
    querySelectorAll: () => [],
    fonts: { ready: Promise.resolve() }
  };
  sandbox.Path2D = class Path2D {
    constructor() { this.ops = []; }
    moveTo(...a) { this.ops.push(['m', a]); }
    lineTo(...a) { this.ops.push(['l', a]); }
    closePath() { this.ops.push(['c']); }
  };
  sandbox.ImageData = class ImageData {};
  // Deterministic "randomness": rnd() then always returns ~0.5/0.25
  const Math2 = Object.create(Math);
  Math2.random = () => 0.5;
  sandbox.Math = Math2;
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.D = D;
  // The game probes for an optional harness hook; its absence makes it boot normally.
  sandbox.claude = undefined;
  return sandbox;
}

module.exports = { makeSandbox };
