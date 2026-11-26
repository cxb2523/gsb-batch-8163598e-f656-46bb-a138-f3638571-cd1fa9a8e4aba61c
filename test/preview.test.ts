import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FakeAudioContext, installFakeAudio } from "./fake-audio";
import { PreviewSession } from "../lib/audio/preview-session";
import type { PlayHandle } from "../lib/audio/synth";
import type { Patch } from "../lib/audio/patch";

let restore = () => {};

beforeEach(() => {
  restore = installFakeAudio();
  FakeAudioContext.instances = [];
});

afterEach(() => restore());

const dry: Patch = {
  source: { type: "sine", frequency: 880 },
  envelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0 },
  gain: 0.5,
};

const wet: Patch = {
  source: { type: "sine", frequency: 440 },
  envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.1 },
  gain: 0.5,
  effects: [
    { type: "delay", delay: 0.05, feedback: 0.8, wet: 0.4 },
    { type: "reverb", decay: 0.4, mix: 0.3 },
  ],
};

async function loadSynth() {
  // Imported lazily so the fake AudioContext is installed first: context.ts holds no
  // globals at module load, but synth.ts references them when a patch is rendered.
  return import("../lib/audio/synth");
}

function ctxOf(fake: FakeAudioContext): BaseAudioContext {
  return fake as unknown as BaseAudioContext;
}

describe("renderPatch lifecycle", () => {
  it("stop marks the handle ended and is idempotent", async () => {
    const { renderPatch } = await loadSynth();
    const ctx = new FakeAudioContext();
    const handle = renderPatch(ctxOf(ctx), dry, undefined, 0, ctx.destination as never);

    assert.equal(handle.ended, false);
    handle.stop();
    assert.equal(handle.ended, true);
    assert.doesNotThrow(() => handle.stop());
    assert.doesNotThrow(() => handle.stop(0.2));
    assert.equal(handle.ended, true);
  });

  it("stop cancels scheduled sources and tears the effect chain down", async () => {
    const { renderPatch } = await loadSynth();
    const ctx = new FakeAudioContext();
    const handle = renderPatch(ctxOf(ctx), wet, undefined, 0, ctx.destination as never);

    // One oscillator plus the feedback delay, plus the reverb's convolver.
    assert.ok(ctx.nodes.some((n) => n.kind === "delay"));
    assert.ok(ctx.nodes.some((n) => n.kind === "convolver"));

    // A zero fade skips the deferred teardown, so disconnection is observable synchronously.
    handle.stop(0);

    const stops = ctx.stops.map((s) => s.kind);
    assert.ok(stops.includes("oscillator"), "the source node was stopped");
    for (const n of ctx.nodes) {
      if (n.kind === "destination") continue;
      assert.equal(n.disconnected, true, `${n.kind} #${n.id} stayed on the graph`);
    }
  });

  it("mutes the wet path so a delay tail cannot outlive the source", async () => {
    const { renderPatch } = await loadSynth();
    const ctx = new FakeAudioContext();
    const handle = renderPatch(ctxOf(ctx), wet, undefined, 0, ctx.destination as never);
    handle.stop();

    const delays = ctx.nodes.filter((n) => n.kind === "delay");
    assert.ok(delays.length > 0);
    // The feedback gain is the delay node whose param was faded to zero.
    const faded = ctx.nodes
      .filter((n) => n.kind === "gain")
      .some((g) => {
        const param = (g as unknown as { gain: { calls: { method: string; args: unknown[] }[] } }).gain;
        return param.calls.some((c) => c.method === "setTargetAtTime" && c.args[0] === 0);
      });
    assert.ok(faded, "no gain was faded to zero on stop");
  });

  it("reports ended when the source plays out naturally", async () => {
    const { renderPatch } = await loadSynth();
    const ctx = new FakeAudioContext();
    const handle = renderPatch(ctxOf(ctx), dry, undefined, 0, ctx.destination as never);
    const source = ctx.nodes.find((n) => n.kind === "oscillator")!;
    source.onended?.();
    assert.equal(handle.ended, true);
  });

  it("playPatch builds and starts inside the gesture without awaiting resume", async () => {
    const { playPatch } = await loadSynth();
    const handle = playPatch(dry);

    // A promise here would mean the start was pushed behind an await, past the tap.
    assert.equal(typeof (handle as unknown as { then?: unknown }).then, "undefined");
    assert.ok(handle.duration > 0);
    assert.equal(handle.ended, false);
    handle.stop(0);
    assert.equal(handle.ended, true);
  });
});

describe("PreviewSession", () => {
  function fakeHandle(): PlayHandle & { stopCalls: number[] } {
    const h = {
      duration: 0.2,
      ended: false,
      stopCalls: [] as number[],
      stop(fade?: number) {
        h.stopCalls.push(fade ?? -1);
        h.ended = true;
      },
    };
    return h;
  }

  it("stopping a session stops its current handle", () => {
    const session = new PreviewSession();
    const h = fakeHandle();
    session.play(() => h);
    session.stop();
    assert.deepEqual(h.stopCalls, [0.05]);
  });

  it("a second play fades the first out before starting the second", () => {
    const session = new PreviewSession();
    const first = fakeHandle();
    const second = fakeHandle();
    const order: string[] = [];

    session.play(() => {
      order.push("start:first");
      return first;
    });
    session.play(() => {
      order.push("start:second");
      return second;
    });

    session.stop();
    assert.ok(order.includes("start:second"));
    assert.equal(first.ended, true, "the superseded handle was stopped");
    assert.equal(second.ended, true, "the surviving handle stops with the session");
  });

  it("stops a late handle from a superseded async start instead of adopting it", async () => {
    const session = new PreviewSession();
    const stale = fakeHandle();
    const fresh = fakeHandle();
    let resolveStale: (h: ReturnType<typeof fakeHandle>) => void = () => {};
    const stalePromise = new Promise<ReturnType<typeof fakeHandle>>((r) => (resolveStale = r));

    session.play(() => stalePromise);
    session.play(() => fresh);

    resolveStale(stale);
    await stalePromise;
    await Promise.resolve();

    assert.equal(stale.ended, true, "the stale handle was stopped on arrival");
    assert.equal(fresh.ended, false, "the live handle survived");
    session.stop();
    assert.equal(fresh.ended, true);
  });

  it("stop cancels a start still in flight", async () => {
    const session = new PreviewSession();
    const late = fakeHandle();
    let resolve: (h: ReturnType<typeof fakeHandle>) => void = () => {};
    const pending = new Promise<ReturnType<typeof fakeHandle>>((r) => (resolve = r));
    session.play(() => pending);
    session.stop();
    resolve(late);
    await pending;
    await Promise.resolve();
    assert.equal(late.ended, true);
  });

  it("a restart after stop is not refused (StrictMode remount safe)", () => {
    const session = new PreviewSession();
    const first = fakeHandle();
    session.play(() => first);
    session.stop();
    assert.equal(first.ended, true);

    const second = fakeHandle();
    session.play(() => second);
    assert.equal(second.ended, false);
    session.stop();
    assert.equal(second.ended, true);
  });
});
