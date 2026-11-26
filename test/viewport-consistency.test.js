// test/viewport-consistency.test.js
//
// Headless-capable consistency tests for the Vexel canvas/viewport sync.
// Runs in Node with a minimal DOM + instrumented Canvas2D shim, so it does
// not require a browser or external dependencies.
//
// Covers:
//   1. zoom + pan keeps selection overlay aligned with shapes
//   2. two resizes keep shapes unshifted and DPR transforms un-accumulated
//   3. export reflects the current viewport without needing a painted frame
//   4. forced WebGL init failure falls back to Canvas2D cleanly
//   5. rotation is honoured by screen<->world mapping

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', 'src');

/* ------------------------------------------------------------------ */
/* A minimal, instrumented canvas 2D context.                          */
/* ------------------------------------------------------------------ */

class FakeGradient {
    addColorStop() {}
}

class FakeContext {
    constructor(canvas) {
        this.canvas = canvas;
        this.calls = [];
        this.transform = [1, 0, 0, 1, 0, 0];
        this.stack = [];
        this.fillStyle = '#000';
        this.strokeStyle = '#000';
        this.lineWidth = 1;
        this.globalAlpha = 1;
        this.imageSmoothingEnabled = true;
        this.imageSmoothingQuality = 'low';
        this.font = '10px sans-serif';
        this.textAlign = 'left';
        this.textBaseline = 'alphabetic';
        this.lineCap = 'butt';
        this.lineDash = [];
    }

    _record(name, args) {
        this.calls.push({ name, args, transform: this.transform.slice() });
    }

    save() { this.stack.push({ transform: this.transform.slice(), props: this._props() }); this._record('save', []); }
    restore() {
        const s = this.stack.pop();
        if (s) { this.transform = s.transform.slice(); this._applyProps(s.props); }
        this._record('restore', []);
    }
    _props() {
        return {
            fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth,
            globalAlpha: this.globalAlpha, imageSmoothingEnabled: this.imageSmoothingEnabled,
            imageSmoothingQuality: this.imageSmoothingQuality, font: this.font,
            textAlign: this.textAlign, textBaseline: this.textBaseline,
            lineCap: this.lineCap, lineDash: this.lineDash.slice()
        };
    }
    _applyProps(p) { Object.assign(this, p); }

    // transform primitives (Canvas2D semantics; multiply like ctx does)
    setTransform(a, b, c, d, e, f) { this.transform = [a, b, c, d, e, f]; this._record('setTransform', [a, b, c, d, e, f]); }
    resetTransform() { this.setTransform(1, 0, 0, 1, 0, 0); }
    translate(x, y) {
        const m = this.transform;
        this.transform = [m[0], m[1], m[2], m[3], m[4] + m[0] * x + m[2] * y, m[5] + m[1] * x + m[3] * y];
        this._record('translate', [x, y]);
    }
    scale(x, y) {
        const m = this.transform;
        this.transform = [m[0] * x, m[1] * x, m[2] * y, m[3] * y, m[4], m[5]];
        this._record('scale', [x, y]);
    }
    rotate(theta) {
        const m = this.transform;
        const cos = Math.cos(theta), sin = Math.sin(theta);
        const a = m[0] * cos + m[2] * sin;
        const b = m[1] * cos + m[3] * sin;
        const c = m[0] * -sin + m[2] * cos;
        const d = m[1] * -sin + m[3] * cos;
        this.transform = [a, b, c, d, m[4], m[5]];
        this._record('rotate', [theta]);
    }

    clearRect(x, y, w, h) { this._record('clearRect', [x, y, w, h]); }
    fillRect(x, y, w, h) { this._record('fillRect', [x, y, w, h]); }
    strokeRect(x, y, w, h) { this._record('strokeRect', [x, y, w, h]); }
    beginPath() { this._record('beginPath', []); }
    closePath() { this._record('closePath', []); }
    moveTo(x, y) { this._record('moveTo', [x, y]); }
    lineTo(x, y) { this._record('lineTo', [x, y]); }
    rect(x, y, w, h) { this._record('rect', [x, y, w, h]); }
    roundRect(x, y, w, h, r) { this._record('roundRect', [x, y, w, h, r]); }
    arc(x, y, r, s, e) { this._record('arc', [x, y, r, s, e]); }
    ellipse(x, y, rx, ry, rot, s, e) { this._record('ellipse', [x, y, rx, ry, rot, s, e]); }
    fill() { this._record('fill', []); }
    stroke() { this._record('stroke', []); }
    fillText(t, x, y) { this._record('fillText', [t, x, y]); }
    setLineDash(d) { this.lineDash = d || []; this._record('setLineDash', [d]); }
    getLineDash() { return this.lineDash; }
    drawImage(img, ...args) { this._record('drawImage', [img, ...args]); }
    createLinearGradient() { return new FakeGradient(); }
    createRadialGradient() { return new FakeGradient(); }
    createPattern() { return {}; }
    measureText(t) { return { width: (t ? t.length : 0) * 6 }; }

    /** World point -> device pixel, using the context's current transform. */
    mapPoint(x, y) {
        const m = this.transform;
        return {
            x: m[0] * x + m[2] * y + m[4],
            y: m[1] * x + m[3] * y + m[5]
        };
    }
}

let canvasCounter = 0;
class FakeCanvas {
    constructor() {
        this._width = 1;
        this._height = 1;
        this.style = {};
        this.dataset = {};
        this.width = 1;
        this.height = 1;
        this.id = 'fake-canvas-' + (canvasCounter++);
        this._ctx = null;
        // A detached DOM-like parent link managed by the fake container.
        this.parentNode = null;
        this.nodeType = 1;
        this.classList = { add() {}, remove() {}, toggle() {} };
        this._listeners = new Map();
    }
    get width() { return this._width; }
    set width(v) {
        this._width = v;
        // Assigning width resets the drawing state, matching real canvases.
        if (this._ctx) this._ctx.transform = [1, 0, 0, 1, 0, 0];
    }
    get height() { return this._height; }
    set height(v) { this._height = v; if (this._ctx) this._ctx.transform = [1, 0, 0, 1, 0, 0]; }
    getContext(type) {
        if (type === '2d') {
            if (!this._ctx) this._ctx = new FakeContext(this);
            return this._ctx;
        }
        return null;
    }
    toBlob(cb) { cb({ __fakeBlob: true, size: this.width * this.height }); }
    toDataURL() { return 'data:image/png;base64,AAAA'; }
    addEventListener() {}
    removeEventListener() {}
}

class FakeContainer {
    constructor() {
        this.children = [];
        this.style = {};
        this.nodeType = 1;
        this.clientWidth = 0;
        this.clientHeight = 0;
        this._rect = { left: 0, top: 0, width: 0, height: 0 };
    }
    setBoundingClientRect(rect) {
        this._rect = rect;
        this.clientWidth = rect.width;
        this.clientHeight = rect.height;
    }
    getBoundingClientRect() { return this._rect; }
    appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
        return child;
    }
    removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
        child.parentNode = null;
        return child;
    }
    replaceChild(next, prev) {
        const i = this.children.indexOf(prev);
        if (i >= 0) {
            this.children[i] = next;
            next.parentNode = this;
            prev.parentNode = null;
        }
        return prev;
    }
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return true; }
    querySelector() { return null; }
}

/* ------------------------------------------------------------------ */
/* Sandbox                                                             */
/* ------------------------------------------------------------------ */

function makeDocument() {
    return {
        body: new FakeContainer(),
        createElement(tag) {
            if (String(tag).toLowerCase() === 'canvas') return new FakeCanvas();
            const el = new FakeContainer();
            el.tagName = String(tag).toUpperCase();
            return el;
        },
        querySelector() { return null; },
        addEventListener() {},
        removeEventListener() {}
    };
}

function makeSandbox(opts = {}) {
    const dpr = opts.dpr || 2;
    const CustomEventShim = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
    const windowObj = {
        devicePixelRatio: dpr,
        requestAnimationFrame: () => 1,
        cancelAnimationFrame: () => {},
        addEventListener() {},
        removeEventListener() {},
        CustomEvent: CustomEventShim
    };

    const documentObj = makeDocument();
    const sandbox = {
        console,
        Date,
        Math,
        JSON,
        Number,
        Object,
        Array,
        String,
        Error,
        Promise,
        setTimeout,
        Float32Array,
        performance: { now: () => 0 },
        document: documentObj,
        window: windowObj,
        navigator: { userAgent: 'node-test' },
        module: { exports: {} },
        Image: class { constructor() { this.onload = null; } },
        CustomEvent: CustomEventShim,
        requestAnimationFrame: windowObj.requestAnimationFrame,
        cancelAnimationFrame: windowObj.cancelAnimationFrame
    };
    sandbox.globalThis = sandbox;
    // window must also expose globals the engine reads via bare names.
    windowObj.document = documentObj;
    return vm.createContext(sandbox);
}

function loadSource(ctx, relativePath) {
    const full = path.join(ROOT, relativePath);
    const code = fs.readFileSync(full, 'utf8');
    vm.runInContext(code, ctx, { filename: relativePath });
}

function loadAll(ctx, files) {
    for (const f of files) loadSource(ctx, f);
}

const CORE_FILES = [
    'utils/color.js',
    'core/vexel.js',
    'core/viewport.js',
    'core/canvas.js',
    'core/renderer.js',
    'core/engine.js',
    'core/coordinate.js',
    'tools/select.js',
    'renderer/webgl.js'
];

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/** Compute the world-space rect that selection overlay draws for a shape. */
function overlayDrawnRect(vexel, shape) {
    const calls = vexel.overlayCtx.calls;
    const bounds = shape.getBounds();
    // The selection outline is the strokeRect whose size equals the shape
    // bounds; handles are small square strokeRects.
    let outline = null;
    for (const c of calls) {
        if (c.name === 'strokeRect' && c.args.length === 4 &&
            Math.abs(c.args[2] - bounds.width) < 1e-9 &&
            Math.abs(c.args[3] - bounds.height) < 1e-9) {
            outline = c;
        }
    }
    if (!outline) return null;
    const transform = outline.transform; // world -> device px, DPR applied
    const [x, y, w, h] = outline.args;
    return {
        x, y, w, h,
        // Map to screen CSS px by dividing by the DPR baked into the transform.
        screen: {
            x0: (transform[0] * x + transform[2] * y + transform[4]) / vexel.pixelRatio,
            y0: (transform[1] * x + transform[3] * y + transform[5]) / vexel.pixelRatio,
            x1: (transform[0] * (x + w) + transform[2] * (y + h) + transform[4]) / vexel.pixelRatio,
            y1: (transform[1] * (x + w) + transform[3] * (y + h) + transform[5]) / vexel.pixelRatio
        }
    };
}

function shapeScreenRect(vexel, shape) {
    const b = shape.getBounds();
    const topLeft = vexel.worldToScreen(b.x, b.y);
    const bottomRight = vexel.worldToScreen(b.x + b.width, b.y + b.height);
    return {
        x0: Math.min(topLeft.x, bottomRight.x),
        y0: Math.min(topLeft.y, bottomRight.y),
        x1: Math.max(topLeft.x, bottomRight.x),
        y1: Math.max(topLeft.y, bottomRight.y)
    };
}

test('zoom + pan keeps selection overlay aligned with shape bounds', () => {
    const ctx = makeSandbox({ dpr: 2 });
    loadAll(ctx, CORE_FILES);

    const Vexel = ctx.window.Vexel;
    const container = new FakeContainer();
    container.setBoundingClientRect({ left: 0, top: 0, width: 400, height: 300 });
    const vexel = new Vexel({ container, width: 400, height: 300, autoRender: false });

    const rect = vexel.rectangle(50, 40, 120, 90, { fill: '#FF0000' });
    vexel.select(rect);

    // Zoom about a non-centre anchor, then pan.
    vexel.setZoom(2.5, 120, 100);
    vexel.panBy(37, -21);
    vexel.render();

    const overlay = overlayDrawnRect(vexel, rect);
    assert.ok(overlay, 'selection overlay should be drawn');
    const expected = shapeScreenRect(vexel, rect);

    assert.ok(Math.abs(overlay.screen.x0 - expected.x0) < 0.5, `left edge aligned: ${overlay.screen.x0} vs ${expected.x0}`);
    assert.ok(Math.abs(overlay.screen.y0 - expected.y0) < 0.5, `top edge aligned: ${overlay.screen.y0} vs ${expected.y0}`);
    assert.ok(Math.abs(overlay.screen.x1 - expected.x1) < 0.5, `right edge aligned: ${overlay.screen.x1} vs ${expected.x1}`);
    assert.ok(Math.abs(overlay.screen.y1 - expected.y1) < 0.5, `bottom edge aligned: ${overlay.screen.y1} vs ${expected.y1}`);
});

test('main canvas and overlay share the identical view transform', () => {
    const ctx = makeSandbox({ dpr: 2 });
    loadAll(ctx, CORE_FILES);

    const Vexel = ctx.window.Vexel;
    const container = new FakeContainer();
    container.setBoundingClientRect({ left: 0, top: 0, width: 400, height: 300 });
    const vexel = new Vexel({ container, width: 400, height: 300, autoRender: false });
    const rect = vexel.rectangle(10, 20, 100, 80, { fill: '#0F0' });
    vexel.select(rect);
    vexel.setZoom(1.7, 50, 60);
    vexel.panBy(15, 25);
    vexel.render();

    const stageTransformOf = (contextObj, names) => {
        // Record the transform right after the scale() call that applies zoom.
        for (const c of contextObj.calls) {
            if (c.name === 'scale' && Math.abs(c.args[0] - vexel.viewport.zoom) < 1e-9) {
                return c.transform.slice();
            }
        }
        return null;
    };
    const mainT = stageTransformOf(vexel.ctx, ['scale']);
    const overlayT = stageTransformOf(vexel.overlayCtx, ['scale']);
    assert.ok(mainT && overlayT, 'both contexts apply the view zoom scale');
    // The device-space (post-DPR) transform must match exactly.
    assert.deepStrictEqual(mainT, overlayT, 'main and overlay transforms differ');
});

test('resizing twice does not shift shapes or accumulate DPR scale', () => {
    const ctx = makeSandbox({ dpr: 2 });
    loadAll(ctx, CORE_FILES);

    const Vexel = ctx.window.Vexel;
    const container = new FakeContainer();
    container.setBoundingClientRect({ left: 0, top: 0, width: 400, height: 300 });
    const vexel = new Vexel({ container, width: 400, height: 300, autoRender: false });
    const rect = vexel.rectangle(40, 30, 90, 70, { fill: '#00F' });
    vexel.select(rect);
    vexel.setZoom(1.5, 100, 100);
    vexel.panBy(10, 20);
    vexel.render();

    const before = shapeScreenRect(vexel, rect);
    const ctxTransformBefore = vexel.ctx.transform.slice();

    // Two resizes in a row (identical and different sizes), as a
    // ResizeObserver / window resize would do.
    vexel.resize(400, 300);
    vexel.render();
    vexel.resize(512, 384);
    vexel.render();

    // Back to original size to compare screen position at the same viewport.
    vexel.resize(400, 300);
    vexel.render();

    const after = shapeScreenRect(vexel, rect);
    assert.ok(Math.abs(after.x0 - before.x0) < 0.001, `x unchanged after resize: ${after.x0} vs ${before.x0}`);
    assert.ok(Math.abs(after.y0 - before.y0) < 0.001, `y unchanged after resize: ${after.y0} vs ${before.y0}`);

    // The DPR transform must be exactly dpr (not dpr^2 / dpr^3).
    assert.deepStrictEqual(
        vexel.ctx.transform,
        ctxTransformBefore,
        `ctx transform accumulated: ${vexel.ctx.transform} vs ${ctxTransformBefore}`
    );

    // Backing store must be width*dpr x height*dpr.
    assert.strictEqual(vexel.canvas.width, 400 * 2, 'main canvas pixel width');
    assert.strictEqual(vexel.canvas.height, 300 * 2, 'main canvas pixel height');
    assert.strictEqual(vexel.overlayCanvas.width, 400 * 2, 'overlay canvas pixel width');
    assert.strictEqual(vexel.overlayCanvas.height, 300 * 2, 'overlay canvas pixel height');
});

test('export reflects the current viewport without a prior painted frame', () => {
    const ctx = makeSandbox({ dpr: 2 });
    loadAll(ctx, CORE_FILES);

    const Vexel = ctx.window.Vexel;
    const container = new FakeContainer();
    container.setBoundingClientRect({ left: 0, top: 0, width: 400, height: 300 });
    const vexel = new Vexel({ container, width: 400, height: 300, autoRender: false });
    vexel.rectangle(20, 20, 100, 60, { fill: '#123456' });
    vexel.setZoom(3, 200, 150);
    vexel.panBy(-40, 70);
    // Intentionally do NOT call vexel.render() — the on-screen canvas is stale.

    const canvas = vexel.renderToCanvas({ scale: 2 });
    assert.strictEqual(canvas.width, 800, 'export canvas pixel width (scale 2)');
    assert.strictEqual(canvas.height, 600, 'export canvas pixel height (scale 2)');

    const exportCtx = canvas.getContext('2d');
    // Find the transform right after the view-zoom scale() was applied (the
    // shape's own translate happens later, so this is the view origin).
    let viewTransform = null;
    for (const c of exportCtx.calls) {
        if (c.name === 'scale' && Math.abs(Math.abs(c.args[0]) - vexel.viewport.zoom) < 1e-9) {
            viewTransform = c.transform.slice();
        }
    }
    assert.ok(viewTransform, 'export applied the viewport zoom');

    const originDevice = { x: viewTransform[4], y: viewTransform[5] };
    const expectedOrigin = {
        x: vexel.viewport.x * 2,
        y: vexel.viewport.y * 2
    };
    assert.ok(Math.abs(originDevice.x - expectedOrigin.x) < 0.001, `export origin x ${originDevice.x} vs ${expectedOrigin.x}`);
    assert.ok(Math.abs(originDevice.y - expectedOrigin.y) < 0.001, `export origin y ${originDevice.y} vs ${expectedOrigin.y}`);

    // The effective world->device scale must be scale * zoom.
    const effectiveScale = Math.hypot(viewTransform[0], viewTransform[1]);
    assert.ok(
        Math.abs(effectiveScale - 2 * vexel.viewport.zoom) < 1e-6,
        `export world scale ${effectiveScale} vs ${2 * vexel.viewport.zoom}`
    );
});

test('forced WebGL init failure falls back to Canvas2D without leftovers', () => {
    const ctx = makeSandbox({ dpr: 1 });
    loadAll(ctx, CORE_FILES);

    // Force WebGL to fail at the context-acquisition step.
    let initCalls = 0;
    class BrokenWebGL {
        constructor(vexel) { this.vexel = vexel; this.canvas = null; }
        init() { initCalls++; throw new Error('forced WebGL failure'); }
        destroy() { this.destroyed = true; }
        getStats() { return {}; }
    }
    ctx.window.VexelWebGLRenderer = BrokenWebGL;

    const Vexel = ctx.window.Vexel;
    const container = new FakeContainer();
    container.setBoundingClientRect({ left: 0, top: 0, width: 320, height: 240 });
    const vexel = new Vexel({ container, width: 320, height: 240, autoRender: false });

    const before = {
        canvas: vexel.canvas,
        overlay: vexel.overlayCanvas,
        children: container.children.length,
        ctx: vexel.ctx
    };

    const result = vexel.setBackend('webgl');
    assert.strictEqual(result, 'canvas2d', 'setBackend should report the Canvas2D fallback');
    assert.strictEqual(vexel.backend, 'canvas2d', 'backend should be canvas2d');
    assert.strictEqual(vexel.webglRenderer, null, 'no WebGL renderer should be retained');
    assert.ok(initCalls >= 1, 'WebGL init was attempted');
    assert.strictEqual(vexel.canvas, before.canvas, 'main canvas must not be replaced');
    assert.strictEqual(vexel.overlayCanvas, before.overlay, 'overlay canvas must not be replaced');
    assert.strictEqual(vexel.ctx, before.ctx, '2D context must be preserved');
    assert.strictEqual(container.children.length, before.children, 'no stray canvases left behind');

    // Drawing still works after the failure.
    vexel.rectangle(10, 10, 50, 50, { fill: '#abc' });
    vexel.render();
    assert.strictEqual(vexel.backend, 'canvas2d');
    assert.ok(vexel.ctx.calls.some(c => c.name === 'rect' || c.name === 'roundRect'), 'shape drawn after fallback');
});

test('switching to a working WebGL backend and back leaves a clean state', () => {
    const ctx = makeSandbox({ dpr: 1 });
    loadAll(ctx, CORE_FILES);

    let destroyed = 0;
    class WorkingWebGL {
        constructor(vexel) { this.vexel = vexel; this.canvas = new FakeCanvas(); }
        init() { return true; }
        begin() { this.canvas.getContext('2d'); }
        end() {}
        supportsShape() { return false; } // forces mixed-scene handling
        drawShape() {}
        resize() {}
        getStats() { return {}; }
        destroy() { destroyed++; }
    }
    ctx.window.VexelWebGLRenderer = WorkingWebGL;

    const Vexel = ctx.window.Vexel;
    const container = new FakeContainer();
    container.setBoundingClientRect({ left: 0, top: 0, width: 200, height: 200 });
    const vexel = new Vexel({ container, width: 200, height: 200, autoRender: false });
    vexel.rectangle(10, 10, 40, 40, { fill: '#000' });

    const originalCanvas = vexel.canvas;
    const result = vexel.setBackend('webgl');
    assert.strictEqual(result, 'webgl');
    assert.ok(vexel.webglRenderer, 'webgl renderer attached');
    assert.strictEqual(vexel.canvas, originalCanvas, 'DOM canvas still the 2D one');
    assert.strictEqual(container.children.length, 2, 'still exactly two canvases in the container');

    // Rendering via WebGL path with an unsupported shape falls back to 2D
    // drawing for that frame rather than throwing.
    vexel.render();
    assert.strictEqual(vexel.backend, 'webgl');

    const back = vexel.setBackend('canvas2d');
    assert.strictEqual(back, 'canvas2d');
    assert.strictEqual(vexel.webglRenderer, null, 'renderer released');
    assert.ok(destroyed >= 1, 'WebGL renderer destroyed on switch back');
    assert.strictEqual(container.children.length, 2, 'no leftover canvases after switching back');
});

test('rotation is honoured by screen<->world mapping and first render', () => {
    const ctx = makeSandbox({ dpr: 1 });
    loadAll(ctx, CORE_FILES);

    const Vexel = ctx.window.Vexel;
    const container = new FakeContainer();
    container.setBoundingClientRect({ left: 0, top: 0, width: 400, height: 400 });
    const vexel = new Vexel({ container, width: 400, height: 400, autoRender: false });
    vexel.setViewport({ x: 100, y: 50, zoom: 2, rotation: Math.PI / 2 });

    const p = vexel.screenToWorld(100, 50); // viewport origin maps to world (0,0)
    assert.ok(Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9, 'viewport origin maps to world origin');

    const s = vexel.worldToScreen(10, 0);
    // With +90deg rotation (canvas convention, y grows downward), +x world
    // maps to +y screen direction.
    assert.ok(Math.abs(s.x - 100) < 1e-9, 'rotated x stays on anchor');
    assert.ok(Math.abs(s.y - (50 + 20)) < 1e-9, `rotated y: ${s.y}`);

    // Round-trip.
    const back = vexel.worldToScreen(p.x, p.y);
    assert.ok(Math.abs(back.x - 100) < 1e-9 && Math.abs(back.y - 50) < 1e-9, 'round trip');
});

test('viewport/canvas facades share the engine viewport (no duplicate state)', () => {
    const ctx = makeSandbox({ dpr: 1 });
    loadAll(ctx, CORE_FILES);

    const Vexel = ctx.window.Vexel;
    const VexelViewport = ctx.window.VexelViewport;
    const VexelCanvas = ctx.window.VexelCanvas;

    const container = new FakeContainer();
    container.setBoundingClientRect({ left: 0, top: 0, width: 400, height: 300 });
    const vexel = new Vexel({ container, width: 400, height: 300, autoRender: false });

    const vp = new VexelViewport(vexel);
    vp.smoothZoom = false;
    vp.smoothPan = false;
    const canvas = new VexelCanvas(vexel);

    // Changing via the adapter writes straight into the engine state.
    vp.zoomAt(2, 100, 100);
    assert.strictEqual(vexel.viewport.zoom, 2, 'viewport.zoomAt writes engine zoom');
    assert.strictEqual(vp.zoom, 2, 'adapter reads engine zoom');

    vp.pan(30, -10);
    assert.strictEqual(vexel.viewport.x, vp.x, 'adapter pan writes engine x');
    assert.strictEqual(vexel.viewport.y, vp.y, 'adapter pan writes engine y');

    // Canvas controller delegates too.
    canvas.setZoom(3, 50, 50);
    assert.strictEqual(vexel.viewport.zoom, 3, 'canvas.setZoom writes engine zoom');
    assert.strictEqual(canvas.zoom, 3, 'canvas reads engine zoom');

    // Mutating engine state is visible through both facades.
    vexel.viewport.x = 123;
    assert.strictEqual(vp.x, 123, 'viewport adapter sees engine x change');
    assert.strictEqual(canvas.panX, 123, 'canvas controller sees engine x change');

    // Reset keeps object identity (adapters stay valid).
    const vpRef = vexel.viewport;
    vexel.resetView();
    assert.strictEqual(vexel.viewport, vpRef, 'resetView mutates in place');
    assert.strictEqual(vp.x, 0, 'adapter sees reset x');
    assert.strictEqual(canvas.zoom, 1, 'canvas sees reset zoom');

    vp.destroy();
});

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
for (const t of tests) {
    try {
        t.fn();
        passed++;
        console.log(`  PASS  ${t.name}`);
    } catch (error) {
        failures.push({ name: t.name, error });
        console.log(`  FAIL  ${t.name}`);
        console.log('        ' + (error && error.message ? error.message : String(error)));
    }
}

console.log(`\n${passed}/${tests.length} tests passed`);
if (failures.length > 0) {
    for (const f of failures) {
        console.error('\n--- ' + f.name + ' ---');
        console.error(f.error && f.error.stack ? f.error.stack : f.error);
    }
    process.exit(1);
}
