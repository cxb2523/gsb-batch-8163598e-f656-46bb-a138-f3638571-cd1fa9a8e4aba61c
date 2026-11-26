import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GameBlockColor } from '../../src/components/game/game-engine';
import {
  ACTIVE_GAME_SESSION_KEY,
  readActiveGameSession,
  writeActiveGameSession,
} from '../../src/components/game/game-session';
import {
  createSettlementScheduler,
  type SettlementTimerApi,
} from '../../src/components/game/game-settlement';

const D = '2026-07-17';
const D_NEXT = '2026-07-18';

/**
 * Minimal in-memory sessionStorage replacement so the session helpers can run
 * under Node without a DOM.
 */
function installSessionStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => {
        store.delete(key);
      },
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
  };
  return {
    get: (key: string) => store.get(key) ?? null,
    restore: () => {
      (globalThis as { window?: unknown }).window = previousWindow;
    },
  };
}

function board(): Array<Array<GameBlockColor | null>> {
  const colors: GameBlockColor[] = ['red', 'blue', 'green'];
  return Array.from({ length: 8 }, (_, row) =>
    Array.from({ length: 8 }, (_, column) =>
      (row + column) % 9 === 0 ? colors[(row + column) % colors.length] : null
    )
  );
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    board: board(),
    challengeComplete: false,
    combo: 1,
    dailyDate: D,
    elapsedSeconds: 12,
    gameOver: false,
    generation: 2,
    mode: 'daily' as const,
    movesWithoutClear: 0,
    pieces: [null, null, null],
    score: 42,
    seed: 123,
    version: 4 as const,
    ...overrides,
  };
}

describe('daily session date binding', () => {
  it('rejects and drops a daily session from a previous local day', () => {
    const storage = installSessionStorage({
      [ACTIVE_GAME_SESSION_KEY]: JSON.stringify(makeSession({ dailyDate: D })),
    });
    try {
      assert.equal(readActiveGameSession(D_NEXT), null);
      assert.equal(storage.get(ACTIVE_GAME_SESSION_KEY), null);
    } finally {
      storage.restore();
    }
  });

  it('restores a daily session that matches the current local day', () => {
    const storage = installSessionStorage({
      [ACTIVE_GAME_SESSION_KEY]: JSON.stringify(makeSession({ dailyDate: D })),
    });
    try {
      const restored = readActiveGameSession(D);
      assert.ok(restored);
      assert.equal(restored?.score, 42);
      assert.equal(restored?.dailyDate, D);
    } finally {
      storage.restore();
    }
  });

  it('refuses to write a daily session whose date is no longer today', () => {
    const storage = installSessionStorage();
    try {
      // Simulate the player crossing midnight: a yesterday session is being
      // persisted while the current local day is already the next one.
      writeActiveGameSession(makeSession({ dailyDate: D }), D_NEXT);
      assert.equal(storage.get(ACTIVE_GAME_SESSION_KEY), null);
    } finally {
      storage.restore();
    }
  });

  it('drops a stale daily write even if a previous one was already stored', () => {
    const storage = installSessionStorage();
    try {
      writeActiveGameSession(makeSession({ dailyDate: D }), D);
      assert.ok(storage.get(ACTIVE_GAME_SESSION_KEY));

      // Cross midnight, then a stale daily write arrives; it must not leave the
      // yesterday board behind for the next restore.
      writeActiveGameSession(makeSession({ dailyDate: D }), D_NEXT);
      assert.equal(storage.get(ACTIVE_GAME_SESSION_KEY), null);
    } finally {
      storage.restore();
    }
  });

  it('writes a matching daily session and never blocks classic sessions', () => {
    const storage = installSessionStorage();
    try {
      writeActiveGameSession(makeSession({ dailyDate: D }), D);
      assert.ok(storage.get(ACTIVE_GAME_SESSION_KEY));

      // Classic runs are not bound to a daily date, so a date rollover must not
      // affect them.
      storage.restore();
      const classicStorage = installSessionStorage();
      try {
        writeActiveGameSession(
          makeSession({ dailyDate: null, mode: 'classic' }),
          D_NEXT
        );
        const stored = classicStorage.get(ACTIVE_GAME_SESSION_KEY);
        assert.ok(stored);
        assert.equal(JSON.parse(stored ?? '{}').mode, 'classic');
      } finally {
        classicStorage.restore();
      }
    } finally {
      storage.restore();
    }
  });
});

/**
 * Manual timer harness so the settlement scheduler can be tested without
 * relying on real wall-clock delays.
 */
function createFakeTimers() {
  let nextHandle = 1;
  const timers = new Map<number, () => void>();
  const api: SettlementTimerApi = {
    clearTimeout: (handle) => {
      timers.delete(handle);
    },
    setTimeout: (callback) => {
      const handle = nextHandle++;
      timers.set(handle, callback);
      return handle;
    },
  };
  return {
    api,
    fireAll: () => {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    pendingCount: () => timers.size,
  };
}

describe('settlement scheduler cancellation', () => {
  it('runs a scheduled settlement when it is not cancelled', () => {
    const timers = createFakeTimers();
    const scheduler = createSettlementScheduler(timers.api);
    const calls: string[] = [];

    scheduler.schedule(() => calls.push('challengeComplete'), 860);
    assert.equal(timers.pendingCount(), 1);
    timers.fireAll();

    assert.deepEqual(calls, ['challengeComplete']);
  });

  it('cancels pending challenge and game-over settlements on exit', () => {
    const timers = createFakeTimers();
    const scheduler = createSettlementScheduler(timers.api);
    const calls: string[] = [];

    scheduler.schedule(() => calls.push('challengeComplete'), 860);
    scheduler.schedule(() => calls.push('gameOver'), 220);
    scheduler.cancel();

    assert.equal(timers.pendingCount(), 0);
    timers.fireAll();
    assert.deepEqual(calls, []);
  });

  it('ignores a callback dispatched after the scheduler was cancelled', () => {
    // Some hosts may hand back a callback even after clearTimeout; the epoch
    // guard must still stop it from mutating state once cancelled.
    const timers = createFakeTimers();
    const scheduler = createSettlementScheduler(timers.api);
    const calls: string[] = [];

    scheduler.schedule(() => calls.push('late'), 860);
    scheduler.cancel();
    timers.fireAll();

    assert.deepEqual(calls, []);
  });

  it('lets settlements scheduled after a cancel settle the next run', () => {
    const timers = createFakeTimers();
    const scheduler = createSettlementScheduler(timers.api);
    const calls: string[] = [];

    scheduler.schedule(() => calls.push('stale'), 860);
    scheduler.cancel(); // player restarts; a new run begins
    scheduler.schedule(() => calls.push('fresh'), 860);
    timers.fireAll();

    assert.deepEqual(calls, ['fresh']);
  });
});
