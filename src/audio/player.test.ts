import Note from "@/audio/note";
import Player from "@/audio/play";
import { Track } from "@/audio/track";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

/** Track stub that records every scheduled `(index, time)` pair. */
class MockTrack implements Track {
  name: string;

  notes: Array<Note>;

  record: Array<[number, number]>;

  constructor() {
    this.name = "MockTrack";
    this.notes = [];
    this.record = [];
  }

  play(
    _context: AudioContext,
    _destination: AudioNode,
    index: number,
    time: number
  ): void {
    this.record.push([index, time]);
  }

  /** Indices of scheduled steps in scheduling order. */
  get indices(): Array<number> {
    return this.record.map(([index]) => index);
  }
}

/**
 * Audio context stub with a controllable clock. The real scheduler reads
 * `currentTime` for its lookahead window, so tests advance it in lockstep with
 * the fake timers.
 */
class MockContext {
  currentTime: number;

  constructor(start = 0.1) {
    this.currentTime = start;
  }
}

const tickSeconds = 0.025;
const tickMilliseconds = tickSeconds * 1000;
const initialTempo = 120;
const startClock = 0.1;
// A 16th note at 120 bpm: 4 * 0.075 * (60 / 120) = 0.15 seconds per step.
const stepDurationAtInitialTempo = 0.15;
// Six lookahead ticks cover one full step at the initial tempo.
const ticksPerStep = Math.round(stepDurationAtInitialTempo / tickSeconds);

function makePlayer(): Player {
  return new Player(16, 1 / 16, 0.075, initialTempo, tickSeconds);
}

/**
 * Advances one lookahead tick at a time, keeping the mocked audio clock
 * synchronized before each scheduler callback (bulk fake-timer advances would
 * fire intermediate callbacks against a stale clock).
 */
function advanceTicks(context: MockContext, ticks: number): void {
  for (let i = 0; i < ticks; i += 1) {
    vi.advanceTimersByTime(tickMilliseconds);
    context.currentTime += tickSeconds;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

test("start schedules the first step and reports a playing state", () => {
  const context = new MockContext(startClock);
  const track = new MockTrack();
  const player = makePlayer();

  player.start(context as unknown as AudioContext, {} as AudioNode, [track]);

  expect(player.isPlaying).toBe(true);
  expect(player.isPaused).toBe(false);
  expect(track.record).toEqual([[0, startClock + stepDurationAtInitialTempo]]);
  expect(vi.getTimerCount()).toBe(1);
});

test("pause cancels pending scheduler timers and stops further scheduling", () => {
  const context = new MockContext(startClock);
  const track = new MockTrack();
  const player = makePlayer();
  player.start(context as unknown as AudioContext, {} as AudioNode, [track]);

  player.pause();
  expect(player.isPlaying).toBe(false);
  expect(player.isPaused).toBe(true);
  const scheduledAtPause = track.record.length;

  // No scheduler timer may survive the pause, so advancing time schedules
  // nothing and no old chain wakes back up.
  advanceTicks(context, 20);

  expect(track.record.length).toBe(scheduledAtPause);
  expect(vi.getTimerCount()).toBe(0);
});

test("resume continues from the paused step phase instead of restarting", () => {
  const context = new MockContext(startClock);
  const track = new MockTrack();
  const player = makePlayer();
  player.start(context as unknown as AudioContext, {} as AudioNode, [track]);

  // Let the scheduler reach steps 1 and 2, then pause.
  advanceTicks(context, ticksPerStep * 2);
  expect(track.indices).toEqual([0, 1, 2]);
  const pausedIndex = player.index;
  player.pause();
  expect(vi.getTimerCount()).toBe(0);

  // Time passes while paused; resuming must not jump the phase or retrigger
  // the paused step.
  advanceTicks(context, 40);
  expect(track.indices).toEqual([0, 1, 2]);

  player.start(context as unknown as AudioContext, {} as AudioNode, [track]);
  expect(player.isPlaying).toBe(true);
  // Resuming schedules the next unpaused step immediately, advancing the
  // retained phase by exactly one without restarting at zero.
  expect(track.indices).toEqual([0, 1, 2, 3]);
  expect(player.index).toBe(pausedIndex + 1);

  // Subsequent lookahead ticks continue the phase from the resumed position.
  advanceTicks(context, ticksPerStep);
  expect(track.indices).toEqual([0, 1, 2, 3, 4]);
});

test("rapid start/pause toggles never create parallel scheduling chains", () => {
  const context = new MockContext(startClock);
  const track = new MockTrack();
  const player = makePlayer();

  for (let toggles = 0; toggles < 5; toggles += 1) {
    player.start(context as unknown as AudioContext, {} as AudioNode, [track]);
    // A start while already playing is a guarded no-op, so a double click in
    // the same frame cannot spawn a second chain.
    player.start(context as unknown as AudioContext, {} as AudioNode, [track]);
    player.pause();
  }
  // Every pause clears the single pending timer; no parallel chains survive.
  expect(vi.getTimerCount()).toBe(0);
  // Each resume advances the phase by one step; no step is scheduled twice.
  expect(track.indices).toEqual([0, 1, 2, 3, 4]);
  expect(new Set(track.indices).size).toBe(track.indices.length);

  player.start(context as unknown as AudioContext, {} as AudioNode, [track]);
  expect(vi.getTimerCount()).toBe(1);
  advanceTicks(context, ticksPerStep);
  expect(track.indices).toEqual([0, 1, 2, 3, 4, 5, 6]);
});

test("a paused chain never reschedules after its generation is invalidated", () => {
  const context = new MockContext(startClock);
  const track = new MockTrack();
  const player = makePlayer();
  player.start(context as unknown as AudioContext, {} as AudioNode, [track]);

  // Pause immediately, before any lookahead timer has fired.
  player.pause();
  const recordAtPause = track.record.length;

  vi.advanceTimersByTime(tickMilliseconds * 20);
  expect(track.record.length).toBe(recordAtPause);
  expect(player.isPaused).toBe(true);

  // Resuming starts a fresh chain that owns the new generation.
  player.start(context as unknown as AudioContext, {} as AudioNode, [track]);
  expect(player.isPlaying).toBe(true);
  vi.advanceTimersByTime(tickMilliseconds);
  expect(player.isPlaying).toBe(true);
});

test("changing tempo mid-playback applies to later steps without retriggering", () => {
  const context = new MockContext(startClock);
  const track = new MockTrack();
  const player = makePlayer();
  player.start(context as unknown as AudioContext, {} as AudioNode, [track]);

  advanceTicks(context, ticksPerStep);
  expect(track.indices).toEqual([0, 1]);
  const recordBeforeTempoChange = track.record.length;

  // Updating tempo must not restart the chain or retrigger the current step.
  player.tempo = 240;
  expect(track.record.length).toBe(recordBeforeTempoChange);

  // At 240 bpm subsequent steps take 0.075 seconds. The lookahead window first
  // has to catch up to the already-queued step time, so advance ticks until the
  // new tempo produces the next step: it must keep advancing the phase and
  // never repeat an index.
  const ticksUntilNextStep = 12;
  for (let tick = 0; tick < ticksUntilNextStep; tick += 1) {
    advanceTicks(context, 1);
    if (track.indices.length === 3) {
      break;
    }
  }
  expect(track.indices).toEqual([0, 1, 2]);
  expect(new Set(track.indices).size).toBe(track.indices.length);
  // Once caught up, steps now follow the faster 0.075 second spacing.
  advanceTicks(context, 3);
  expect(track.indices).toEqual([0, 1, 2, 3]);
});

test("dispose releases timer handles and permanently stops the scheduler", () => {
  const context = new MockContext(startClock);
  const track = new MockTrack();
  const player = makePlayer();
  player.start(context as unknown as AudioContext, {} as AudioNode, [track]);
  expect(vi.getTimerCount()).toBe(1);

  player.dispose();
  expect(vi.getTimerCount()).toBe(0);
  expect(player.isPlaying).toBe(false);

  const recorded = track.record.length;
  advanceTicks(context, 20);
  expect(track.record.length).toBe(recorded);

  // Disposing while stopped is a safe no-op.
  expect(() => player.dispose()).not.toThrow();
});

test("pausing while stopped and ticking while stopped are safe no-ops", () => {
  const context = new MockContext(startClock);
  const track = new MockTrack();
  const player = makePlayer();

  expect(() => player.pause()).not.toThrow();
  player.playTick(context as unknown as AudioContext, {} as AudioNode, [track]);
  expect(track.record.length).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
