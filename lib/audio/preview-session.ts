import type { PlayHandle } from "./synth";

export type PreviewStart = () => PlayHandle | void | Promise<PlayHandle | void>;

const DEFAULT_FADE = 0.05;
const LATE_FADE = 0.02;

function safeStop(handle: PlayHandle, fade: number): void {
  try {
    handle.stop(fade);
  } catch {}
}

function isThenable(value: unknown): value is Promise<PlayHandle | void> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/*
 * One audition at a time. Every play() supersedes the previous one: the previous handle
 * is faded out before the new start runs. A handle that arrives late from a superseded
 * async start is stopped on arrival, never adopted, so it cannot replace the session the
 * user actually asked for. stop() bumps the same token, which is what makes unmount and
 * category switches cancel in-flight starts as well.
 */
export class PreviewSession {
  private current: PlayHandle | null = null;
  private token = 0;

  play(start: PreviewStart, fade = DEFAULT_FADE): void {
    const token = ++this.token;
    this.stopCurrent(fade);

    let result: ReturnType<PreviewStart>;
    try {
      result = start();
    } catch {
      return;
    }

    if (isThenable(result)) {
      void result.then(
        (handle) => this.adopt(token, handle),
        () => {},
      );
      return;
    }
    this.adopt(token, result);
  }

  stop(fade = DEFAULT_FADE): void {
    this.token += 1;
    this.stopCurrent(fade);
  }

  private adopt(token: number, handle: PlayHandle | void): void {
    if (!handle) return;
    if (token !== this.token) {
      safeStop(handle, LATE_FADE);
      return;
    }
    this.current = handle;
  }

  private stopCurrent(fade: number): void {
    const handle = this.current;
    this.current = null;
    if (handle) safeStop(handle, fade);
  }
}
