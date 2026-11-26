/**
 * The session state machine behind the subtitle-sync worker.
 *
 * It used to live inline in src/workers/subsync.worker.ts, which made the one
 * rule the whole feature rests on — a message belongs to exactly one run, and
 * a run the player has moved on from must not touch anything — untestable
 * outside a browser. Pulling the state (and nothing else) in here lets
 * `node --test` drive begin / pcm / finish / cancel sequences directly, and
 * lets the worker-less fallback in subtitleSync.ts enforce the identical
 * rule on the main thread instead of a weaker, runId-blind copy of it.
 *
 * The boundary guarantees, all in one place:
 *
 *  - every `begin` starts a fresh run with a new runId and a fresh
 *    SpeechAccumulator; a superseded run is told so and dropped;
 *  - a `pcm`, `finish` or `cancel` whose runId is not the active run's is
 *    discarded BEFORE any state is touched, so a late audio window from a
 *    cancelled or superseded run can never be folded into the new run's
 *    reference signal;
 *  - `cancel` releases the run's accumulated reference immediately;
 *  - a run that finishes or errors also leaves nothing behind, and a reply
 *    produced under an old runId can never overwrite a newer run's result
 *    because replies are stamped with the active run's id at send time.
 *
 * DOM-free: the controller talks only through an injected `post` callback.
 */

import { runAlignment } from "./subsyncEngine.ts";
import { SpeechAccumulator } from "./subsyncVad.ts";
import type {
  SubsyncBeginMessage,
  SubsyncRequest,
  SubsyncResponse,
} from "./subsyncWorkerProtocol.ts";

interface ActiveRun {
  begin: SubsyncBeginMessage;
  accumulator: SpeechAccumulator;
}

export type SubsyncPoster = (message: SubsyncResponse) => void;

export class SubsyncRunController {
  private active: ActiveRun | null = null;
  private readonly post: SubsyncPoster;

  constructor(post: SubsyncPoster) {
    this.post = post;
  }

  /** The runId currently accepting messages, or null between runs. */
  get activeRunId(): number | null {
    return this.active ? this.active.begin.runId : null;
  }

  /** Whether this controller holds an unfinished run. */
  get hasActiveRun(): boolean {
    return this.active !== null;
  }

  /** The active run's accumulator. Exposed read-only for session tests. */
  get activeAccumulator(): SpeechAccumulator | null {
    return this.active ? this.active.accumulator : null;
  }

  handle(message: SubsyncRequest): void {
    try {
      this.dispatch(message);
    } catch (error) {
      // A thrown run is finished either way: keeping it active would let its
      // late messages land on the next begin. Stamp the reply with the run
      // the failure happened in; if that run is already gone, no reply can be
      // attributed safely and the message is dropped.
      const runId = this.active?.begin.runId ?? message.runId;
      this.active = null;
      this.post({
        type: "error",
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private dispatch(message: SubsyncRequest): void {
    if (message.type === "begin") {
      this.begin(message);
      return;
    }

    // Session boundary: anything carrying another runId — older OR from a run
    // that never existed on this controller — is discarded silently. This is
    // the point of the runId. Cancelling mid-extraction otherwise leaves
    // windows in flight that would be folded into the NEXT run's reference,
    // and a late finish could otherwise align against the wrong accumulator.
    if (!this.active || this.active.begin.runId !== message.runId) return;

    if (message.type === "cancel") {
      // Release the film-length 100 Hz signal now; a fresh begin allocates a
      // new accumulator rather than reusing this one.
      this.active.accumulator.reset();
      this.active = null;
      return;
    }

    if (message.type === "pcm") {
      const run = this.active;
      run.accumulator.push(new Int16Array(message.buffer), {
        frameRate: message.frameRate,
        startSeconds: message.startSeconds,
      });
      this.post({
        type: "progress",
        runId: run.begin.runId,
        phase: "detecting-speech",
      });
      return;
    }

    if (message.type === "finish") {
      const run = this.active;
      // Detach before the (expensive) alignment: any message arriving while
      // the correlation runs is by definition from a run that has already
      // ended, so it must be dropped rather than racing the result.
      this.active = null;
      this.finish(run);
    }
  }

  private begin(message: SubsyncBeginMessage): void {
    if (this.active) {
      // The previous run is superseded, not ignored: its caller is awaiting a
      // reply that would otherwise never come. The error carries the OLD id,
      // and the new run starts from a clean accumulator regardless of what
      // the old one had collected.
      this.active.accumulator.reset();
      this.post({
        type: "error",
        runId: this.active.begin.runId,
        message: "Superseded by a newer subtitle sync.",
      });
    }
    this.active = {
      begin: message,
      accumulator: new SpeechAccumulator(),
    };
  }

  private finish(run: ActiveRun): void {
    const { begin } = run;
    this.post({ type: "progress", runId: begin.runId, phase: "finding-alignment" });

    const reference = begin.referenceSpeech ?? run.accumulator.finish();
    if (reference.length === 0) {
      this.post({
        type: "error",
        runId: begin.runId,
        message:
          "No speech was detected in this video, so there is nothing to line the subtitles up with.",
      });
      return;
    }

    const result = runAlignment(
      reference,
      begin.cues,
      begin.reference,
      begin.processingMode,
      begin.engine,
      { ...begin.options, referenceNumFrames: begin.referenceNumFrames ?? null },
    );
    this.post({ type: "result", runId: begin.runId, result });
  }
}
