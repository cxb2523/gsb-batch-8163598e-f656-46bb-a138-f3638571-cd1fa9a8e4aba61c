/* Runtime lifecycle coverage for looping cues.

   The core is browser-first, but it is plain ESM and only reaches for
   window/AudioContext/document inside calls. This file stands up a small mock
   Web Audio graph and a VisibilityEvent target, then uses Node's fake clocks to
   prove scheduling and release behavior without real-time flakes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as foley from "../src/foley.js";

const PERIOD_MS = 1060; // play(name, { every: 1 }) => every + the built-in 60ms gap

class AudioParamMock {
  constructor(value = 1) {
    this.value = value;
    this.calls = [];
  }
  setValueAtTime(value, at) { this.calls.push(["setValueAtTime", value, at]); this.value = value; return this; }
  linearRampToValueAtTime(value, at) { this.calls.push(["linearRampToValueAtTime", value, at]); this.value = value; return this; }
  exponentialRampToValueAtTime(value, at) { this.calls.push(["exponentialRampToValueAtTime", value, at]); this.value = value; return this; }
  setTargetAtTime(value, at, tau) { this.calls.push(["setTargetAtTime", value, at, tau]); this.value = value; return this; }
  cancelScheduledValues(at) { this.calls.push(["cancelScheduledValues", at]); return this; }
}

class AudioNodeMock {
  constructor(ctx, kind) {
    this.context = ctx;
    this.kind = kind;
    this.gain = new AudioParamMock(1);
    this.frequency = new AudioParamMock(440);
    this.pan = new AudioParamMock(0);
    this.Q = new AudioParamMock(1);
    this.threshold = new AudioParamMock(-24);
    this.knee = new AudioParamMock(30);
    this.ratio = new AudioParamMock(12);
    this.attack = new AudioParamMock(0.003);
    this.release = new AudioParamMock(0.25);
    this.positionX = new AudioParamMock(0);
    this.positionY = new AudioParamMock(0);
    this.positionZ = new AudioParamMock(0);
    this.connections = [];
    this.disconnectCalls = 0;
    this.disconnected = false;
    this.startCalls = 0;
    this.stopCalls = 0;
    this.onended = null;
  }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnectCalls++; this.disconnected = true; }
  start() { this.startCalls++; this.context.startedNodes.push(this); }
  stop() { this.stopCalls++; }
  setPosition() {}
  getChannelData(length) { return new Float32Array(length); }
}

class AudioContextMock {
  constructor() {
    if (AudioContextMock._instance) return AudioContextMock._instance;
    AudioContextMock._instance = this;
    this.state = "running";
    this.currentTime = 0;
    this.sampleRate = 44100;
    this.destination = new AudioNodeMock(this, "destination");
    this.startedNodes = [];
    this.gainNodes = [];
    this.resumeCalls = 0;
  }
  resume() { this.resumeCalls++; }
  createGain() {
    const node = new AudioNodeMock(this, "gain");
    this.gainNodes.push(node);
    return node;
  }
  createOscillator() { return new AudioNodeMock(this, "oscillator"); }
  createBufferSource() { return new AudioNodeMock(this, "buffer-source"); }
  createBiquadFilter() { return new AudioNodeMock(this, "filter"); }
  createDynamicsCompressor() { return new AudioNodeMock(this, "compressor"); }
  createAnalyser() { return new AudioNodeMock(this, "analyser"); }
  createConvolver() { return new AudioNodeMock(this, "convolver"); }
  createStereoPanner() { return new AudioNodeMock(this, "stereo-panner"); }
  createPanner() { return new AudioNodeMock(this, "panner"); }
  createBuffer(channels, length, rate) {
    return { numberOfChannels: channels, length, sampleRate: rate, getChannelData: (n) => new Float32Array(n || length) };
  }
}

const ctx = new AudioContextMock();
const visibilityListeners = [];
globalThis.window = { AudioContext: AudioContextMock };
globalThis.AudioContext = AudioContextMock;
globalThis.document = {
  hidden: false,
  addEventListener(type, cb) {
    if (type === "visibilitychange") visibilityListeners.push(cb);
  },
  removeEventListener(type, cb) {
    if (type !== "visibilitychange") return;
    const i = visibilityListeners.indexOf(cb);
    if (i >= 0) visibilityListeners.splice(i, 1);
  },
};

function setVisibility(hidden) {
  globalThis.document.hidden = hidden;
  for (const cb of [...visibilityListeners]) cb();
}

function startedCount() {
  return ctx.startedNodes.length;
}

test.before(() => {
  foley.set({ muted: false });
  foley.unlock();
});

test.beforeEach(() => {
  globalThis.document.hidden = false;
  visibilityListeners.length = 0;
  ctx.startedNodes.length = 0;
});

test("manual pause freezes a loop; resume continues its period once and idempotently", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });

  const handle = foley.play("loading", { loop: true, every: 1 });
  assert.ok(handle, "play() returned a handle");
  assert.equal(typeof handle.pause, "function");
  assert.equal(typeof handle.resume, "function");
  assert.equal(startedCount(), 3, "the first performance fires immediately");

  t.mock.timers.tick(PERIOD_MS);
  assert.equal(startedCount(), 6, "the first repetition fires on schedule");

  t.mock.timers.tick(300);
  handle.pause();
  handle.pause(); // idempotent
  const pausedAt = startedCount();

  t.mock.timers.tick(10_000);
  assert.equal(startedCount(), pausedAt, "a paused loop creates no new voices");

  handle.resume();
  handle.resume(); // idempotent: must not arm a second scheduler

  // 300ms of the 1060ms period had elapsed before pause; 760ms remains.
  t.mock.timers.tick(759);
  assert.equal(startedCount(), pausedAt, "resume preserves the remaining period");
  t.mock.timers.tick(2);
  assert.equal(startedCount(), pausedAt + 3, "the next repetition lands at the original deadline");

  handle.resume();
  t.mock.timers.tick(PERIOD_MS - 1);
  assert.equal(startedCount(), pausedAt + 3, "the periodic scheduler owns later repetitions");
  t.mock.timers.tick(2);
  assert.equal(startedCount(), pausedAt + 6, "exactly one interval is running after resume");

  handle.stop();
  t.mock.timers.tick(300);
});

test("visibilitychange automatically pauses and resumes a loop", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });

  const handle = foley.play("tick", { loop: true, every: 1 });
  assert.ok(handle);
  assert.equal(startedCount(), 2);

  t.mock.timers.tick(PERIOD_MS);
  assert.equal(startedCount(), 4);

  setVisibility(true);
  const hiddenAt = startedCount();
  t.mock.timers.tick(10_000);
  assert.equal(startedCount(), hiddenAt, "hidden tabs do not schedule repetitions");

  setVisibility(false);
  t.mock.timers.tick(PERIOD_MS - 1);
  assert.equal(startedCount(), hiddenAt, "resume waits for the remaining period");
  t.mock.timers.tick(2);
  assert.equal(startedCount(), hiddenAt + 2, "visible tabs resume the loop");

  handle.stop();
  t.mock.timers.tick(300);
});

test("a manually paused loop is not resumed by a visibilitychange", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });

  const handle = foley.play("hover", { loop: true, every: 1 });
  assert.ok(handle);
  assert.equal(startedCount(), 1);

  handle.pause();
  const pausedAt = startedCount();

  setVisibility(true);
  t.mock.timers.tick(5_000);
  setVisibility(false);
  t.mock.timers.tick(5_000);
  assert.equal(startedCount(), pausedAt, "visibility must not override manual pause");

  handle.resume();
  t.mock.timers.tick(PERIOD_MS);
  assert.equal(startedCount(), pausedAt + 1, "explicit resume starts repetitions again");

  handle.stop();
  t.mock.timers.tick(300);
});

test("muted pauses loops; unmuting resumes unless a manual pause is sticky", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });

  const handle = foley.play("pop", { loop: true, every: 1 });
  assert.ok(handle);
  assert.equal(startedCount(), 2);

  foley.set({ muted: true });
  const mutedAt = startedCount();
  t.mock.timers.tick(10_000);
  assert.equal(startedCount(), mutedAt, "muting pauses loop scheduling");

  foley.set({ muted: false });
  t.mock.timers.tick(PERIOD_MS);
  assert.equal(startedCount(), mutedAt + 2, "unmuting resumes an automatically paused loop");

  handle.pause();
  const manualAt = startedCount();
  foley.set({ muted: true });
  foley.set({ muted: false });
  t.mock.timers.tick(10_000);
  assert.equal(startedCount(), manualAt, "unmuting must not override a manual pause");

  handle.resume();
  handle.stop();
  t.mock.timers.tick(300);
});

test("visibility and mute reasons combine: returning visible while muted stays paused", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });

  const handle = foley.play("denied", { loop: true, every: 1 });
  assert.ok(handle);
  assert.equal(startedCount(), 2);

  setVisibility(true);
  foley.set({ muted: true });
  const pausedAt = startedCount();

  t.mock.timers.tick(5_000);
  setVisibility(false);
  t.mock.timers.tick(5_000);
  assert.equal(startedCount(), pausedAt, "visible + muted must not resume");

  foley.set({ muted: false });
  t.mock.timers.tick(PERIOD_MS);
  assert.equal(startedCount(), pausedAt + 2, "clearing the final block resumes");

  handle.stop();
  t.mock.timers.tick(300);
});

test("one-shot handles expose safe pause/resume no-ops", () => {
  foley.set({ muted: true });
  const before = startedCount();
  const handle = foley.play("success");
  assert.ok(handle);
  assert.equal(startedCount() - before, 3, "the one-shot is still performed/scheduled");
  assert.doesNotThrow(() => {
    handle.pause();
    handle.pause();
    handle.resume();
    handle.resume();
  });
  assert.equal(startedCount() - before, 3, "pause/resume do not alter a one-shot");
  handle.stop();
  foley.set({ muted: false });
});

test("stop makes pause/resume inert and releases timer, listener, bus, and send", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });

  const gainIndex = ctx.gainNodes.length;
  const handle = foley.play("press", { loop: true, every: 1 });
  assert.ok(handle);
  const bus = ctx.gainNodes[gainIndex];
  const sendBus = ctx.gainNodes[gainIndex + 1];
  assert.ok(bus, "performance bus was created");
  assert.ok(sendBus, "reverb send bus was created");
  assert.equal(visibilityListeners.length, 1);

  t.mock.timers.tick(PERIOD_MS);
  const stoppedAt = startedCount();

  handle.stop();
  assert.equal(bus.disconnectCalls, 1, "the performance bus is released immediately");
  assert.equal(sendBus.disconnectCalls, 1, "the send bus is released immediately");
  assert.equal(bus.disconnected, true);
  assert.equal(sendBus.disconnected, true);

  handle.stop(); // idempotent
  handle.pause();
  handle.resume();
  t.mock.timers.tick(10_000);
  assert.equal(startedCount(), stoppedAt, "no timer may schedule another voice after stop");
  assert.equal(visibilityListeners.length, 0, "the visibility listener is removed");
  assert.equal(bus.disconnectCalls, 1, "idempotent stop must not disconnect twice");
  assert.equal(sendBus.disconnectCalls, 1, "idempotent stop must not disconnect twice");
});
