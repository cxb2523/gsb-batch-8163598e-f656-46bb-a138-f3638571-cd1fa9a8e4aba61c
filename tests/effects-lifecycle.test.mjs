/**
 * Lifecycle tests for createEffects using a real (headless) THREE scene graph
 * and an injected fake DOM. No WebGL context or browser is required.
 *
 * These cover A4 (side rebuild) and A5 (no accumulation / resource disposal).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../src/vendor/three.module.js';

// Install a minimal DOM before exercising createEffects. effects.js resolves
// document through globalThis at call time.
class FakeElement {
  constructor(tagName = 'span') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.className = '';
    this.innerHTML = '';
    this.textContent = '';
    this.parentNode = null;
    this.parentElement = null;
  }
  appendChild(child) {
    child.parentNode = this;
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    child.parentElement = null;
    return child;
  }
  remove() {
    if (this.parentNode && this.parentNode.removeChild) this.parentNode.removeChild(this);
  }
  setAttribute() {}
  getAttribute() {
    return null;
  }
  addEventListener() {}
  removeEventListener() {}
}

const fakeDocument = {
  createElement(tag) {
    const el = new FakeElement(tag);
    if (tag === 'canvas') {
      el.width = 0;
      el.height = 0;
      el.getContext = () =>
        new Proxy(
          {},
          {
            get(target, prop) {
              if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
                return () => ({addColorStop() {}});
              }
              if (prop in target) return target[prop];
              return typeof prop === 'string' ? () => {} : undefined;
            },
            set(target, prop, value) {
              target[prop] = value;
              return true;
            }
          }
        );
    }
    return el;
  }
};

globalThis.document = fakeDocument;
globalThis.matchMedia =
  globalThis.matchMedia ||
  (() => ({matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}}));

const {createEffects, associations} = await import('../src/scene/effects.js');

const li4 = {code: 'LI4'}; // associations keyed by code only inside effects
const pc6 = {code: 'PC6'};
const st36 = {code: 'ST36'};

function makeLayer() {
  const scene = new THREE.Scene();
  const container = new FakeElement('div');
  const api = createEffects(scene, container);
  const group = scene.children.find(c => c.isGroup);
  assert.ok(group, 'createEffects must add its group to the scene');
  return {scene, container, api, group};
}

function inventory(group) {
  const materials = new Set();
  const geometries = new Set();
  group.traverse(o => {
    if (o.material) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
    }
    // Sprites share a module-level quad geometry that clear() must not dispose.
    if (o.geometry && !o.isSprite) geometries.add(o.geometry);
  });
  return {materials: [...materials], geometries: [...geometries]};
}

function disposalTracker(items) {
  const disposed = new Set();
  for (const item of items) item.addEventListener('dispose', () => disposed.add(item));
  return {
    allDisposed: () => items.every(i => disposed.has(i)),
    disposedCount: () => disposed.size
  };
}

test('show builds one label per association target and a non-empty scene group', () => {
  const {container, api, group} = makeLayer();
  const targetCount = associations.LI4.targets.length;
  api.show(li4, new THREE.Vector3(1.76, 4.3, 0.12), 1);

  assert.equal(container.children.length, targetCount);
  assert.equal(api.active, true);
  assert.equal(api.pathCount, targetCount);
  assert.ok(group.children.length > targetCount); // tubes + beads + halos
});

test('A5: repeated show of the same point does not accumulate objects or labels', () => {
  const {container, api, group} = makeLayer();
  api.show(li4, new THREE.Vector3(1.76, 4.3, 0.12), 1);
  const baselineChildren = group.children.length;
  const baselineLabels = container.children.length;

  for (let i = 0; i < 12; i++) {
    api.show(li4, new THREE.Vector3(1.76, 4.3, 0.12), i % 2 ? -1 : 1);
  }

  assert.equal(group.children.length, baselineChildren);
  assert.equal(container.children.length, baselineLabels);
  assert.equal(container.children.length, associations.LI4.targets.length);
});

test('A5: switching points and returning reproduces the first presentation', () => {
  const {container, api, group} = makeLayer();
  api.show(li4, new THREE.Vector3(1.76, 4.3, 0.12), 1);
  const first = {children: group.children.length, labels: container.children.length, paths: api.pathCount};

  for (const p of [pc6, st36, {code: 'NOT_ASSOCIATED'}, li4, pc6, li4]) {
    api.show(p, new THREE.Vector3(1, 4, 0.2), 1);
  }

  api.show(li4, new THREE.Vector3(1.76, 4.3, 0.12), 1);
  assert.equal(group.children.length, first.children);
  assert.equal(container.children.length, first.labels);
  assert.equal(api.pathCount, first.paths);
});

test('A3: show of a point without associations clears all flow objects and labels', () => {
  const {container, api, group} = makeLayer();
  api.show(li4, new THREE.Vector3(1.76, 4.3, 0.12), 1);
  assert.ok(group.children.length > 0);
  assert.ok(container.children.length > 0);

  api.show({code: 'NO_SUCH_CODE'}, new THREE.Vector3(1, 4, 0), 1);
  assert.equal(group.children.length, 0);
  assert.equal(container.children.length, 0);
  assert.equal(api.active, false);

  // clear() on an already-empty layer must stay safe.
  assert.doesNotThrow(() => api.clear());
});

test('A5: replacing a flow disposes every material (incl. sprite materials) and mesh geometry', () => {
  const {api, group} = makeLayer();
  api.show(li4, new THREE.Vector3(1.76, 4.3, 0.12), 1);
  const {materials, geometries} = inventory(group);
  assert.ok(materials.length >= 10, 'expected many per-run materials');
  assert.ok(geometries.length >= 4, 'expected tube/ring geometries');

  const matTracker = disposalTracker(materials);
  const geoTracker = disposalTracker(geometries);

  // Trigger clear via another show.
  api.show(pc6, new THREE.Vector3(1.6, 4.5, 0.2), 1);

  assert.equal(matTracker.allDisposed(), true, 'every previous material must be disposed');
  assert.equal(geoTracker.allDisposed(), true, 'every previous mesh geometry must be disposed');
});

test('A5: explicit clear disposes all materials and empties the group', () => {
  const {container, api, group} = makeLayer();
  api.show(st36, new THREE.Vector3(0.55, 2.72, 0.3), 1);
  const {materials} = inventory(group);
  const tracker = disposalTracker(materials);

  api.clear();
  assert.equal(group.children.length, 0);
  assert.equal(container.children.length, 0);
  assert.equal(tracker.allDisposed(), true);
});

test('A4: side flips curve start and target x signs; repeated flips do not leak', () => {
  const {api, group} = makeLayer();

  const endpointXs = [];
  const startXs = [];
  for (const side of [1, -1, 1, -1]) {
    const startX = li4 && side === 1 ? 1.76 : -1.76;
    api.show(li4, new THREE.Vector3(startX, 4.3, 0.12), side);
    let sawTarget = false;
    group.traverse(o => {
      const path = o.geometry?.parameters?.path;
      if (path && path.isQuadraticBezierCurve3) {
        startXs.push(path.v0.x);
        endpointXs.push(path.v2.x);
        if (Math.abs(path.v2.x) > 0.11) sawTarget = true; // 口齿区域 x=0.12
      }
    });
    assert.equal(sawTarget, true, `expected offset target curve on side ${side}`);
  }

  // Two passes per side (3 targets each). Starts must follow the side input.
  assert.ok(startXs.some(x => x > 1));
  assert.ok(startXs.some(x => x < -1));
  // Mirrored target endpoints must exist on both signs.
  assert.ok(endpointXs.some(x => x > 0.11));
  assert.ok(endpointXs.some(x => x < -0.11));

  const before = group.children.length;
  for (let i = 0; i < 6; i++) api.show(li4, new THREE.Vector3(1.76, 4.3, 0.12), i % 2 ? -1 : 1);
  assert.equal(group.children.length, before);
});

test('update runs headless and returns leader descriptors without throwing', () => {
  const {api} = makeLayer();
  api.show(li4, new THREE.Vector3(1.76, 4.3, 0.12), 1);
  const camera = new THREE.PerspectiveCamera(38, 1000 / 700, 0.1, 100);
  camera.position.set(0, 4.3, 12.6);
  camera.updateMatrixWorld(true);

  let leaders;
  assert.doesNotThrow(() => {
    leaders = api.update(100, camera, 1000, 700, {centerX: 500, halfWidth: 150});
  });
  assert.ok(Array.isArray(leaders));

  assert.doesNotThrow(() => api.setPaused(true));
  assert.doesNotThrow(() => api.setPaused(false));
  assert.doesNotThrow(() => api.setEnabled(false));
  assert.doesNotThrow(() => api.setEnabled(true));
});

test('createEffects works without any global document via headless element fallback', async () => {
  const savedDoc = globalThis.document;
  // @ts-ignore intentional deletion for the fallback path
  delete globalThis.document;
  try {
    const scene = new THREE.Scene();
    const container = {children: [], appendChild(c) { this.children.push(c); return c; }};
    let layer;
    assert.doesNotThrow(() => {
      layer = createEffects(scene, container);
      layer.show(li4, new THREE.Vector3(1, 4, 0.2), 1);
    });
    assert.equal(layer.active, true);
    assert.equal(container.children.length, associations.LI4.targets.length);
    const group = scene.children.find(c => c.isGroup);
    const count = group.children.length;
    layer.show(pc6, new THREE.Vector3(1, 4, 0.2), -1);
    layer.show(li4, new THREE.Vector3(1, 4, 0.2), 1);
    assert.equal(group.children.length, count);
    assert.doesNotThrow(() => layer.dispose());
  } finally {
    globalThis.document = savedDoc;
  }
});
