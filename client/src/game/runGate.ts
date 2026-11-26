// Signal Meadow style: one framework-agnostic authority for "should the game be advancing?".
// Named interruption reasons (manual pause, settings panel, hidden tab, blurred window) compose:
// any single reason blocks the simulation and audio. The frame clock drops time accumulated
// while blocked and re-baselines on resume, so returning never triggers catch-up frames or jumps.

export type GateListener = (blocked: boolean) => void;
export type Unsubscribe = () => void;

export class RunGate {
  private readonly reasons = new Set<string>();
  private readonly listeners = new Set<GateListener>();
  private blocked = false;
  private lastNow: number | null = null;
  private readonly maxDeltaSeconds: number;

  constructor(maxDeltaSeconds = 0.05) {
    this.maxDeltaSeconds = maxDeltaSeconds;
  }

  isBlocked(): boolean {
    return this.blocked;
  }

  hasReason(reason: string): boolean {
    return this.reasons.has(reason);
  }

  /**
   * Add or remove one interruption reason. Returns true only when the effective
   * blocked state (reasons.size > 0) changed, and notifies subscribers of that edge.
   */
  setReason(reason: string, active: boolean): boolean {
    if (active) this.reasons.add(reason);
    else this.reasons.delete(reason);
    const nextBlocked = this.reasons.size > 0;
    if (nextBlocked === this.blocked) return false;
    this.blocked = nextBlocked;
    // Drop any elapsed time on the edge so a long suspension cannot become a big delta.
    this.lastNow = null;
    this.listeners.forEach((listener) => listener(this.blocked));
    return true;
  }

  subscribe(listener: GateListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Forget the time baseline; the next sample reports zero and re-baselines. */
  reset(): void {
    this.lastNow = null;
  }

  /**
   * Consume one animation-frame timestamp.
   * Returns the finite, clamped delta in seconds to simulate with:
   * - 0 while blocked,
   * - 0 on the first sample after (re)acquiring a baseline,
   * - otherwise the elapsed time clamped to maxDeltaSeconds.
   */
  sample(nowMs: number): number {
    if (this.blocked) {
      this.lastNow = null;
      return 0;
    }
    if (this.lastNow === null || !Number.isFinite(nowMs)) {
      this.lastNow = Number.isFinite(nowMs) ? nowMs : null;
      return 0;
    }
    const delta = (nowMs - this.lastNow) / 1000;
    if (!Number.isFinite(delta) || delta < 0) {
      // Non-monotonic clock: drop the baseline so the next sample re-baselines instead
      // of producing a clamped-but-still-large rebound delta.
      this.lastNow = null;
      return 0;
    }
    this.lastNow = nowMs;
    if (delta > this.maxDeltaSeconds) return this.maxDeltaSeconds;
    return delta;
  }
}

/** Reason keys shared by GameCanvas/scene wiring and tests. */
export const BLOCK_REASONS = {
  pause: "pause",
  settings: "settings",
  hidden: "hidden",
  blurred: "blurred",
} as const;

export type PageLifecycleOptions = {
  /** Fired when the tab becomes hidden or the window loses focus (missed key/pointer releases). */
  onInterrupt?: (source: "hidden" | "blurred") => void;
};

/**
 * Wire document visibility and window focus/blur to a RunGate.
 * Returns a disposer that removes every listener. Safe to call with real
 * Document/Window objects; tests can pass EventTarget-shaped fakes cast through unknown.
 */
export function bindPageLifecycle(gate: RunGate, doc: Document, win: Window, options: PageLifecycleOptions = {}): Unsubscribe {
  const onVisibilityChange = () => {
    const hidden = doc.visibilityState === "hidden";
    gate.setReason(BLOCK_REASONS.hidden, hidden);
    if (hidden) options.onInterrupt?.("hidden");
  };
  const onBlur = () => {
    gate.setReason(BLOCK_REASONS.blurred, true);
    options.onInterrupt?.("blurred");
  };
  const onFocus = () => {
    gate.setReason(BLOCK_REASONS.blurred, false);
  };
  doc.addEventListener("visibilitychange", onVisibilityChange);
  win.addEventListener("blur", onBlur);
  win.addEventListener("focus", onFocus);
  // Reflect the state present at bind time (e.g. a backgrounded or unfocused launch).
  onVisibilityChange();
  if (typeof doc.hasFocus === "function" && !doc.hasFocus()) onBlur();
  return () => {
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    win.removeEventListener("blur", onBlur);
    win.removeEventListener("focus", onFocus);
  };
}
