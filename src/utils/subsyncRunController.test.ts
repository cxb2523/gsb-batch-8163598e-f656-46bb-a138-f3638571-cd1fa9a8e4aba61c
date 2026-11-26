import test from "node:test";
import assert from "node:assert/strict";
import { SubsyncRunController } from "./subsyncRunController.ts";
import { cuesToSpeech, SAMPLE_RATE } from "./subsyncSpeech.ts";
import type { SubtitleCue } from "./subtitles.ts";
import type {
  SubsyncBeginMessage,
  SubsyncPcmMessage,
  SubsyncRequest,
  SubsyncResponse,
} from "./subsyncWorkerProtocol.ts";

const FRAME_RATE = 16000;
const SAMPLES_PER_WINDOW = FRAME_RATE / SAMPLE_RATE;

const cue = (start: number, end: number): SubtitleCue => ({ start, end, text: "hello there" });

/** Cues spread over a long baseline, as the engine tests use. */
const dialogue = (count = 20, spacing = 30): SubtitleCue[] =>
  Array.from({ length: count }, (_, i) => cue(5 + i * spacing, 8 + i * spacing));

/** Shifted copy of cues, rasterized into a reference speech signal. */
const shiftedReference = (cues: readonly SubtitleCue[], shiftSeconds: number) => {
  const shifted = cues.map((c) => ({ ...c, start: c.start + shiftSeconds, end: c.end + shiftSeconds }));
  return cuesToSpeech(shifted, {});
};

const beginMessage = (runId: number, overrides: Partial<SubsyncBeginMessage> = {}): SubsyncBeginMessage => ({
  type: "begin",
  runId,
  cues: dialogue(),
  reference: "audio-vad",
  processingMode: "web",
  engine: "web",
  options: {},
  ...overrides,
});

/** Loud PCM for `windows` 10 ms frames; silence elsewhere is zero samples. */
const loudPcm = (windows: number): Int16Array => {
  const out = new Int16Array(windows * SAMPLES_PER_WINDOW);
  for (let i = 0; i < out.length; i += 1) out[i] = i % 2 === 0 ? 6000 : -6000;
  return out;
};

const silentPcm = (windows: number): Int16Array => new Int16Array(windows * SAMPLES_PER_WINDOW);

const pcmMessage = (runId: number, pcm: Int16Array, startSeconds: number): SubsyncPcmMessage => ({
  type: "pcm",
  runId,
  buffer: pcm.buffer,
  frameRate: FRAME_RATE,
  startSeconds,
});

/** A controller that records every reply for later assertions. */
const harness = () => {
  const replies: SubsyncResponse[] = [];
  const controller = new SubsyncRunController((message) => replies.push(message));
  return { controller, replies };
};

const results = (replies: SubsyncResponse[]) => replies.filter((m) => m.type === "result");
const errors = (replies: SubsyncResponse[]) => replies.filter((m) => m.type === "error");

test("SubsyncRunController: a normal single run reports the correct offset", () => {
  const { controller, replies } = harness();
  const cues = dialogue();
  const shift = 4.2;
  const reference = shiftedReference(cues, shift);

  controller.handle(
    beginMessage(1, {
      cues,
      reference: "subtitle-track",
      referenceSpeech: reference.samples,
      referenceNumFrames: reference.numFrames,
    }),
  );
  controller.handle({ type: "finish", runId: 1 });

  assert.equal(results(replies).length, 1);
  const reply = replies.find((m) => m.type === "result");
  assert.ok(reply && reply.type === "result");
  assert.equal(reply.runId, 1);
  assert.equal(reply.result.applied, true);
  assert.deepEqual(reply.result.qualityReasons, []);
  // Positive offset: the speech really is 4.2 s later than the cues.
  assert.ok(Math.abs(reply.result.offsetMs / 1000 - shift) < 0.02, `offset ${reply.result.offsetMs}`);
  assert.equal(controller.hasActiveRun, false, "a finished run leaves no active state");
});

test("SubsyncRunController: cancel drops late blocks and releases the reference", () => {
  const { controller, replies } = harness();

  // Run 1 starts and collects half a second of speech.
  controller.handle(beginMessage(1));
  controller.handle(pcmMessage(1, loudPcm(50), 0));
  assert.equal(controller.activeRunId, 1);
  assert.ok(controller.activeAccumulator);
  assert.equal(controller.activeAccumulator?.processedSeconds, 0.5);

  // The user cancels. The accumulated reference must be released immediately.
  controller.handle({ type: "cancel", runId: 1 });
  assert.equal(controller.activeRunId, null);
  assert.equal(controller.activeAccumulator, null);

  // Everything the old run still has in flight must be discarded, not folded
  // into the run that follows. (The one progress reply above was produced by
  // the pcm while run 1 was still active; nothing may be produced after.)
  replies.length = 0;
  controller.handle(pcmMessage(1, loudPcm(50), 0));
  controller.handle({ type: "finish", runId: 1 });
  controller.handle({ type: "cancel", runId: 1 });
  assert.equal(controller.activeRunId, null);
  assert.deepEqual(replies, [], "stale messages produce no replies");

  // A fresh begin starts from a genuinely empty accumulator.
  const cues = dialogue();
  const reference = shiftedReference(cues, 2);
  controller.handle(
    beginMessage(2, {
      cues,
      reference: "subtitle-track",
      referenceSpeech: reference.samples,
      referenceNumFrames: reference.numFrames,
    }),
  );
  assert.equal(controller.activeRunId, 2);
  assert.equal(controller.activeAccumulator?.processedSeconds, 0);

  // Run 2's own block, placed at 2 s: leaves a declared 2 s gap in front.
  controller.handle(pcmMessage(2, loudPcm(50), 2));
  assert.equal(controller.activeAccumulator?.processedSeconds, 0.5);

  // A late block from the cancelled run landing at 0 s must not pollute run 2.
  controller.handle(pcmMessage(1, loudPcm(50), 0));
  assert.equal(
    controller.activeAccumulator?.processedSeconds,
    0.5,
    "a stale run's pcm was counted into the active accumulator",
  );

  // Peek at the actual timeline: the gap the stale block would have filled is
  // still explicit non-speech, and the length matches run 2's coverage only.
  const peek = controller.activeAccumulator?.finish();
  assert.ok(peek);
  assert.equal(peek!.length, 250, "timeline runs to run 2's block end, not further");
  // The stale block's speech lived in 0..50; none of it survived. A 100-window
  // gap is far past the 25-window silence the tokenizer absorbs into a token.
  for (let i = 0; i < 200; i += 1) {
    assert.equal(peek![i], 0, `gap sample ${i} was polluted by the cancelled run`);
  }
  assert.equal(peek![225], 1);

  // Rebuild run 2's block (the peek consumed it) and finish: only run 2 can
  // answer, and the answer is run 2's alignment.
  controller.handle(pcmMessage(2, loudPcm(50), 2));
  controller.handle({ type: "finish", runId: 2 });
  assert.equal(results(replies).length, 1);
  assert.equal(results(replies)[0]?.runId, 2);
  assert.equal(controller.hasActiveRun, false);
});

test("SubsyncRunController: a new begin supersedes the old run and old replies cannot overwrite", () => {
  const { controller, replies } = harness();

  const cues1 = dialogue();
  controller.handle(
    beginMessage(1, {
      cues: cues1,
      reference: "subtitle-track",
      referenceSpeech: shiftedReference(cues1, 4.2).samples,
    }),
  );

  // The user starts another sync before run 1 finishes.
  const cues2 = dialogue();
  const reference2 = shiftedReference(cues2, -3);
  controller.handle(
    beginMessage(2, {
      cues: cues2,
      reference: "subtitle-track",
      referenceSpeech: reference2.samples,
      referenceNumFrames: reference2.numFrames,
    }),
  );

  // The superseded run is told exactly once, with its OWN runId; its
  // accumulator was released rather than handed to run 2.
  assert.equal(errors(replies).length, 1);
  assert.equal(errors(replies)[0]?.runId, 1);
  assert.equal(controller.activeRunId, 2);
  assert.equal(controller.activeAccumulator?.processedSeconds, 0);

  // Run 1's late finish (and pcm) are stale now and must be dropped.
  controller.handle(pcmMessage(1, loudPcm(50), 0));
  controller.handle({ type: "finish", runId: 1 });
  assert.equal(controller.activeRunId, 2, "a stale finish ended the current run");
  assert.equal(results(replies).length, 0, "the superseded run posted a result anyway");

  // Run 2 finishes normally and its result is the only result that exists.
  controller.handle({ type: "finish", runId: 2 });
  assert.equal(results(replies).length, 1);
  const reply = results(replies)[0];
  assert.ok(reply && reply.type === "result");
  assert.equal(reply.runId, 2);
  assert.ok(Math.abs(reply.result.offsetMs / 1000 - -3) < 0.02, `offset ${reply.result.offsetMs}`);
  assert.equal(controller.hasActiveRun, false);
});

test("SubsyncRunController: pcm blocks with a gap keep non-speech in the gap", () => {
  const { controller } = harness();
  controller.handle(beginMessage(7));

  // Block at 0 s (0.3 s) then one at 1 s: windows 30..99 are uncovered. The
  // gap is 70 windows, well past the tokenizer's 25-window trailing-silence
  // absorption, so it cannot be mistaken for part of either speech token.
  controller.handle(pcmMessage(7, loudPcm(30), 0));
  controller.handle(pcmMessage(7, loudPcm(40), 1));

  const signal = controller.activeAccumulator?.finish();
  assert.ok(signal);
  assert.equal(signal!.length, 140, "length matches the covered timeline, gap included");
  assert.equal(signal![15], 1, "the first block's speech survived");
  for (let i = 30; i < 100; i += 1) {
    assert.equal(signal![i], 0, `gap sample ${i} was not non-speech`);
  }
  assert.equal(signal![115], 1, "the placed block's speech is at its real timeline position");

  // Clean shutdown rather than leaving the run active.
  controller.handle({ type: "cancel", runId: 7 });
  assert.equal(controller.activeRunId, null);
});

test("SubsyncRunController: an unalignable run still ends the session and goes idle", () => {
  // All-silent audio yields a non-empty all-zero reference: the aligner can run
  // (nothing throws), but the quality gate must refuse to apply the guess. The
  // session boundary property under test is that either way the run ends and
  // its runId can never post again.
  const { controller, replies } = harness();
  controller.handle(beginMessage(9));
  controller.handle(pcmMessage(9, silentPcm(50), 0));
  controller.handle({ type: "finish", runId: 9 });

  // Progress replies aside, the session ends with exactly one terminal reply.
  const terminal = replies.filter((m) => m.type === "result" || m.type === "error");
  assert.equal(terminal.length, 1);
  const reply = terminal[0];
  assert.ok(reply);
  assert.equal(reply.runId, 9);
  if (reply.type === "result") {
    assert.equal(reply.result.applied, false);
    assert.ok(reply.result.qualityReasons.length > 0);
  }
  assert.equal(controller.activeRunId, null);

  // Nothing after the end can revive or impersonate that run.
  const stale: SubsyncRequest[] = [
    pcmMessage(9, loudPcm(50), 0),
    { type: "finish", runId: 9 },
    { type: "cancel", runId: 9 },
  ];
  const before = replies.length;
  for (const message of stale) controller.handle(message);
  assert.equal(replies.length, before);
  assert.equal(controller.activeRunId, null);
});

test("SubsyncRunController: a genuinely empty reference reports an error with the run's id", () => {
  // No pcm at all before finish: the accumulator hands back an empty signal,
  // which the controller rejects explicitly rather than aligning nothing.
  const { controller, replies } = harness();
  controller.handle(beginMessage(4));
  controller.handle({ type: "finish", runId: 4 });

  assert.equal(results(replies).length, 0);
  assert.equal(errors(replies).length, 1);
  assert.equal(errors(replies)[0]?.runId, 4);
  assert.equal(controller.activeRunId, null);
});
