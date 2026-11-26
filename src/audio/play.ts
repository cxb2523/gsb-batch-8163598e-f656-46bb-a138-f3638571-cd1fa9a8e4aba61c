import { Track } from "@/audio/track";
import { durationToSeconds } from "@/audio/util";

/**
 * Playback scheduling states.
 *
 * - `stopped`: playback has never started or has been torn down.
 * - `playing`: the lookahead scheduler is actively (re)scheduling steps.
 * - `paused`: the scheduler is cancelled while step phase is retained.
 */
export type PlayerState = "stopped" | "playing" | "paused";

/**
 * Manages playback and scheduling of tracks through a web audio context.
 *
 * The player is an explicit state machine. Every scheduled callback captures a
 * generation token that is invalidated on pause/teardown, so stale callbacks
 * from a previous scheduling chain can never wake up after a pause. Pausing
 * only cancels pending scheduler timers; `index` and `timer` are preserved so
 * resuming continues from the paused step phase without jumping.
 */
export default class Player {
  /** Internal position counter. */
  index: number;

  length: number;

  lookahead: number;

  step: number;

  tempo: number;

  /** Next audio step time, expressed on the audio context clock. */
  timer: number;

  tick: number;

  /** Current scheduling state of the state machine. */
  private state: PlayerState;

  /** Handle of the pending lookahead timer, or null when none is scheduled. */
  private timerHandle: ReturnType<typeof setTimeout> | null;

  /**
   * Bumped every time the scheduling chain is cancelled. Pending callbacks
   * capture the generation active when they were scheduled and bail out when
   * it no longer matches, which prevents an old chain from rescheduling.
   */
  private generation: number;

  constructor(
    length: number,
    lookahead: number,
    step: number,
    tempo: number,
    tick: number
  ) {
    this.generation = 0;
    this.index = -1;
    this.length = length;
    this.lookahead = lookahead;
    this.state = "stopped";
    this.step = step;
    this.tempo = tempo;
    this.tick = tick;
    this.timer = 0;
    this.timerHandle = null;
  }

  /** Whether the lookahead scheduler is currently running. */
  get isPlaying(): boolean {
    return this.state === "playing";
  }

  /** Whether playback is paused and can be resumed from its current phase. */
  get isPaused(): boolean {
    return this.state === "paused";
  }

  /**
   * Check if next audio step is within the current schedular lookahead range.
   *
   * @param stepDuration  Size of next audio step.
   * @param stop  End of lookahead range.
   * @returns Whether step is within the current schedular lookahead range.
   */
  next(stepDuration: number, lookaheadStop: number): boolean {
    // The lookahead window is shorter than a single step, so the candidate step
    // time is compared against the window edge before the timer is advanced.
    // This keeps the opening step schedulable when the timer is anchored to the
    // current audio clock at (re)start, while later ticks skip ahead until the
    // window catches up to the next due step.
    if (this.timer >= lookaheadStop) {
      return false;
    }

    this.timer += stepDuration;
    this.index = (this.index + 1) % this.length;
    return true;
  }

  /**
   * Begins playback. When resuming from a pause the retained step phase is
   * rebased onto the current audio context clock so the next scheduled step
   * follows the paused position instead of restarting or jumping.
   *
   * Starting while already playing is a no-op, which makes rapid play/pause
   * toggling unable to spawn a second scheduling chain.
   *
   * @param context  Associated audio context.
   * @param destination  Node the tracks are routed through.
   * @param tracks  Tracks to play.
   */
  start(
    context: AudioContext,
    destination: AudioNode,
    tracks: Array<Track>
  ): void {
    if (this.state === "playing") {
      return;
    }

    this.state = "playing";
    // Anchor the retained phase to the current audio clock. After `next()` the
    // opening step lands at `currentTime + stepDuration`. The step index is
    // untouched, so a resumed chain continues with the next unpaused step
    // instead of restarting at zero or retriggering the last scheduled step.
    this.timer = context.currentTime;
    this.playTick(context, destination, tracks);
  }

  /**
   * Pauses playback by cancelling the pending lookahead timer and invalidating
   * the current scheduling generation. The step index and phase are retained so
   * `start` can resume from the same position. Pausing while not playing is a
   * no-op.
   */
  pause(): void {
    if (this.state !== "playing") {
      return;
    }

    this.state = "paused";
    this.generation += 1;
    this.clearTimer();
  }

  /**
   * Releases every timer handle and permanently stops the player. Safe to call
   * on component unmount; afterwards the player may be started again, which
   * begins a fresh chain.
   */
  dispose(): void {
    this.state = "stopped";
    this.generation += 1;
    this.clearTimer();
  }

  /**
   * Schedules audio playback for tracks within the current lookahead window and
   * arms the next lookahead timer. Only runs while playing and only reschedules
   * when the captured generation is still current, so a cancelled chain can
   * never wake back up.
   *
   * @param context  Associated audio context.
   * @param destination  Node the tracks are routed through.
   * @param tracks  Tracks to play.
   */
  playTick(
    context: AudioContext,
    destination: AudioNode,
    tracks: Array<Track>
  ): void {
    if (this.state !== "playing") {
      return;
    }

    const generation = this.generation;
    const stepDuration = durationToSeconds(this.tempo, this.step);
    const lookaheadStop = context.currentTime + this.lookahead;

    while (this.next(stepDuration, lookaheadStop)) {
      tracks.forEach((track) =>
        track.play(context, destination, this.index, this.timer)
      );
    }

    if (this.state === "playing" && generation === this.generation) {
      this.timerHandle = setTimeout(
        () => this.playTick(context, destination, tracks),
        1000 * this.tick
      );
    }
  }

  /** Cancels the pending lookahead timer, if one exists. */
  private clearTimer(): void {
    if (this.timerHandle !== null) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }
}
