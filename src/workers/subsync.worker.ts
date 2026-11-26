/// <reference lib="webworker" />
/**
 * The subtitle-sync worker.
 *
 * Everything expensive lives here: voice activity detection over the decoded
 * audio, and the FFT cross-correlation that can run to 2^21 points seven times
 * over. On the main thread that is seconds of frozen UI in the middle of
 * playback; here the video keeps playing.
 *
 * Deliberately thin — it owns no algorithm and no session state of its own.
 * Every line of the actual work is in src/utils/subsync*.ts, and the runId
 * boundary (which messages belong to which run, what happens to a cancelled
 * run's late audio) is SubsyncRunController in subsyncRunController.ts, which
 * is what lets `node --test` exercise all of it without a DOM. The worker is
 * just the controller plus a postMessage adapter.
 *
 * Audio is streamed in as windows and detected as it arrives, so the worker
 * holds one window of PCM plus the 100 Hz signal (~8 MB for a 3-hour film)
 * and never the film.
 */

import { SubsyncRunController } from "../utils/subsyncRunController.ts";
import type {
  SubsyncRequest,
  SubsyncResponse,
} from "../utils/subsyncWorkerProtocol.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;

const post = (message: SubsyncResponse): void => scope.postMessage(message);

const controller = new SubsyncRunController(post);

scope.onmessage = (event: MessageEvent<SubsyncRequest>) => {
  controller.handle(event.data);
};
