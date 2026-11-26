export interface SettlementTimerApi {
  clearTimeout: (handle: number) => void;
  setTimeout: (callback: () => void, delayMs: number) => number;
}

export interface SettlementScheduler {
  cancel: () => void;
  schedule: (callback: () => void, delayMs: number) => void;
}

/**
 * Tracks delayed, one-shot settlements (challenge completion or game over) so
 * they can all be revoked at once when the player exits, returns home, or
 * restarts a run. Every scheduled callback is bound to the scheduler epoch it
 * was created in; calling {@link SettlementScheduler.cancel} bumps the epoch
 * and clears pending timers, so any callback that has already been queued can
 * no longer mutate score, storage, or session state.
 */
export function createSettlementScheduler(
  timerApi: SettlementTimerApi
): SettlementScheduler {
  let epoch = 0;
  let handles: number[] = [];

  return {
    cancel() {
      epoch += 1;
      for (const handle of handles) {
        timerApi.clearTimeout(handle);
      }
      handles = [];
    },
    schedule(callback, delayMs) {
      const scheduledEpoch = epoch;
      const handle = timerApi.setTimeout(() => {
        handles = handles.filter((pending) => pending !== handle);
        if (epoch !== scheduledEpoch) return;
        callback();
      }, delayMs);
      handles.push(handle);
    },
  };
}
