import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ByteboundAudio } from "./audio";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeAudioElement {
  static instances: FakeAudioElement[] = [];
  src = "";
  loop = false;
  preload = "";
  volume = 1;
  muted = false;
  paused = true;
  playCalls = 0;
  pauseCalls = 0;

  constructor(src?: string) {
    this.src = src ?? "";
    FakeAudioElement.instances.push(this);
  }
  play() {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }
  load() { /* no-op */ }
  removeAttribute() { /* no-op */ }
}

function makeParam(value = 1) {
  return {
    value,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
  };
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0;
  destination = {};
  state: "suspended" | "running" | "closed" = "suspended";
  resume = vi.fn(async () => { this.state = "running"; });
  suspend = vi.fn(async () => { this.state = "suspended"; });
  close = vi.fn(async () => { this.state = "closed"; });
  createGain = vi.fn(() => ({ gain: makeParam(), connect: vi.fn(), disconnect: vi.fn() }));
  createOscillator = vi.fn(() => {
    const oscillator = {
      type: "",
      frequency: makeParam(440),
      connect: vi.fn(() => oscillator),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    return oscillator;
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

describe("ByteboundAudio lifecycle", () => {
  beforeEach(() => {
    FakeAudioElement.instances = [];
    FakeAudioContext.instances = [];
    (globalThis as Record<string, unknown>).window = globalThis;
    (globalThis as Record<string, unknown>).Audio = FakeAudioElement;
    (globalThis as Record<string, unknown>).AudioContext = FakeAudioContext;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).Audio;
    delete (globalThis as Record<string, unknown>).AudioContext;
    delete (globalThis as Record<string, unknown>).window;
    vi.restoreAllMocks();
  });

  it("constructs a single looping music element", () => {
    const audio = new ByteboundAudio();
    expect(audio.isMuted()).toBe(false);
    expect(FakeAudioElement.instances).toHaveLength(1);
    const music = FakeAudioElement.instances[0];
    expect(music.loop).toBe(true);
    expect(music.volume).toBeCloseTo(0.28);
  });

  it("mute silences music and prevents cues from leaking while muted", () => {
    const audio = new ByteboundAudio();
    const music = FakeAudioElement.instances[0];
    // Music is currently audible when the player hits mute.
    music.paused = false;

    audio.setMuted(true);
    expect(audio.isMuted()).toBe(true);
    expect(music.muted).toBe(true);
    expect(music.paused).toBe(true);
    expect(music.pauseCalls).toBeGreaterThan(0);

    // Even after an unlock gesture, muted playback must not start music.
    audio.unlock();
    expect(music.playCalls).toBe(0);

    // Any context unlock creates routes through a zeroed master gain.
    for (const context of FakeAudioContext.instances) {
      const masterGain = context.createGain.mock.results[0].value as { gain: { value: number } };
      expect(masterGain.gain.value).toBe(0);
    }
  });

  it("does not create any audio graph for a cue requested while muted and locked", () => {
    const audio = new ByteboundAudio();
    audio.setMuted(true);
    audio.playCue("jump"); // muted gate returns before ensureContext()
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it("silences already-sounding cue voices and master gain when muted mid-cue", () => {
    const audio = new ByteboundAudio();
    audio.unlock();
    audio.playCue("jump");
    const ctx = FakeAudioContext.instances[0];
    expect(ctx).toBeDefined();
    const oscillator = ctx.createOscillator.mock.results[0].value as { stop: ReturnType<typeof vi.fn> };
    const masterGain = ctx.createGain.mock.results[0].value as { gain: { value: number } };

    audio.setMuted(true);
    expect(masterGain.gain.value).toBe(0);
    expect(oscillator.stop).toHaveBeenCalled();
  });

  it("unlock starts music once; repeated unlock calls never stack playback", async () => {
    const audio = new ByteboundAudio();
    const music = FakeAudioElement.instances[0];

    audio.unlock();
    audio.unlock();
    audio.unlock();
    await flush();
    audio.unlock();
    await flush();

    expect(music.playCalls).toBe(1);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it("coalesces unlock requests while play() promise is still pending", async () => {
    const audio = new ByteboundAudio();
    const music = FakeAudioElement.instances[0];
    // Emulate a browser whose .paused stays true until the play promise resolves.
    let resolvePending: (() => void) | null = null;
    music.play = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePending = () => {
            music.paused = false;
            resolve();
          };
        }),
    );

    audio.unlock();
    audio.unlock();
    expect(music.play).toHaveBeenCalledTimes(1);

    resolvePending?.();
    await flush();
    audio.unlock();
    await flush();
    expect(music.play).toHaveBeenCalledTimes(1);
  });

  it("pause stops music and suspends context; resume restarts exactly once without stacking", async () => {
    const audio = new ByteboundAudio();
    const music = FakeAudioElement.instances[0];

    audio.unlock();
    await flush();
    expect(music.playCalls).toBe(1);
    const ctx = FakeAudioContext.instances[0];

    audio.pause();
    expect(audio.isPaused()).toBe(true);
    expect(music.paused).toBe(true);
    expect(music.pauseCalls).toBeGreaterThanOrEqual(1);
    expect(ctx.suspend).toHaveBeenCalled();

    // Cues fired while paused must be dropped.
    const oscCountBefore = ctx.createOscillator.mock.calls.length;
    audio.playCue("collect");
    expect(ctx.createOscillator.mock.calls.length).toBe(oscCountBefore);

    audio.resume();
    await flush();
    expect(audio.isPaused()).toBe(false);
    expect(music.playCalls).toBe(2);

    // Idempotent resume while already running adds no further play call.
    audio.resume();
    audio.setPaused(false);
    await flush();
    expect(music.playCalls).toBe(2);
  });

  it("keeps music paused on unmute while the game is interrupted, then resumes once", async () => {
    const audio = new ByteboundAudio();
    const music = FakeAudioElement.instances[0];
    audio.unlock();
    await flush();
    expect(music.playCalls).toBe(1);

    audio.pause();
    audio.setMuted(true);
    audio.setMuted(false);
    await flush();
    expect(music.paused).toBe(true);
    expect(music.playCalls).toBe(1);

    audio.resume();
    await flush();
    expect(music.playCalls).toBe(2);
    expect(music.paused).toBe(false);
  });

  it("dispose pauses/clears music and closes the context; later calls never resurrect audio", async () => {
    const audio = new ByteboundAudio();
    const music = FakeAudioElement.instances[0];
    audio.unlock();
    await flush();
    audio.playCue("finish");
    const ctx = FakeAudioContext.instances[0];

    audio.dispose();
    expect(audio.isDisposed()).toBe(true);
    expect(music.pauseCalls).toBeGreaterThan(0);
    expect(music.src).toBe("");
    expect(ctx.close).toHaveBeenCalled();

    const contexts = FakeAudioContext.instances.length;
    const playCalls = music.playCalls;
    // Late callbacks / React effects after unmount must be no-ops.
    audio.unlock();
    audio.playCue("jump");
    audio.pause();
    audio.resume();
    audio.setMuted(false);
    audio.setPaused(true);
    await flush();

    expect(FakeAudioContext.instances.length).toBe(contexts);
    expect(music.playCalls).toBe(playCalls);
  });

  it("dispose while play() is pending settles without throwing or restarting", async () => {
    const audio = new ByteboundAudio();
    const music = FakeAudioElement.instances[0];
    let resolvePending: (() => void) | null = null;
    music.play = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePending = () => resolve();
        }),
    );

    audio.unlock();
    audio.dispose();
    resolvePending?.();
    await flush();
    expect(music.pauseCalls).toBeGreaterThan(0);
  });
});
