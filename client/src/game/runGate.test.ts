import { describe, expect, it, vi } from "vitest";
import { RunGate, bindPageLifecycle, BLOCK_REASONS } from "./runGate";

describe("RunGate reason composition", () => {
  it("starts unblocked and only emits on effective edges", () => {
    const gate = new RunGate();
    const events: boolean[] = [];
    gate.subscribe((blocked) => events.push(blocked));

    expect(gate.isBlocked()).toBe(false);
    expect(gate.setReason("pause", true)).toBe(true);
    expect(gate.isBlocked()).toBe(true);
    // Re-asserting the same reason is not an edge.
    expect(gate.setReason("pause", true)).toBe(false);
    // A second reason keeps the gate blocked; no effective edge event.
    expect(gate.setReason("settings", true)).toBe(false);
    expect(events).toEqual([true]);
    // Clearing one reason while another remains does not unblock.
    expect(gate.setReason("pause", false)).toBe(false);
    expect(gate.isBlocked()).toBe(true);
    expect(events).toEqual([true]);
    // Clearing the last reason emits the unblock edge.
    expect(gate.setReason("settings", false)).toBe(true);
    expect(gate.isBlocked()).toBe(false);
    expect(events).toEqual([true, false]);
  });

  it("unsubscribe stops notifications", () => {
    const gate = new RunGate();
    const listener = vi.fn();
    const off = gate.subscribe(listener);
    gate.setReason("hidden", true);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    gate.setReason("hidden", false);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("RunGate.sample timing", () => {
  it("re-baselines the first sample and passes normal frame deltas", () => {
    const gate = new RunGate();
    expect(gate.sample(1000)).toBe(0); // first sample establishes baseline
    expect(gate.sample(1016.6667)).toBeCloseTo(1 / 60, 4);
    expect(gate.sample(1033.3334)).toBeCloseTo(1 / 60, 4);
  });

  it("returns 0 for every blocked sample regardless of elapsed wall time", () => {
    const gate = new RunGate();
    gate.sample(0);
    gate.sample(16.7);
    gate.setReason(BLOCK_REASONS.blurred, true);
    expect(gate.sample(33.4)).toBe(0);
    // User is away for ten minutes.
    expect(gate.sample(600_000)).toBe(0);
    expect(gate.sample(1_200_000)).toBe(0);
  });

  it("does not produce a catch-up delta on resume: first frame is zero, then real deltas", () => {
    const gate = new RunGate();
    gate.sample(0);
    gate.sample(16.7);
    gate.setReason(BLOCK_REASONS.hidden, true);
    gate.sample(33.4);
    gate.sample(999_999);
    gate.setReason(BLOCK_REASONS.hidden, false);
    // First sample after resume re-baselines and advances nothing.
    expect(gate.sample(1_000_016)).toBe(0);
    // Following frame is a normal delta, not the huge accumulated gap.
    const dt = gate.sample(1_000_032.7);
    expect(dt).toBeGreaterThan(0);
    expect(dt).toBeLessThan(0.05);
    expect(dt).toBeCloseTo(0.0167, 3);
  });

  it("clamps oversized deltas and ignores non-finite/negative timestamps", () => {
    const gate = new RunGate();
    gate.sample(0);
    expect(gate.sample(10_000)).toBe(0.05); // clamped to the 50ms ceiling
    gate.reset();
    expect(gate.sample(20_000)).toBe(0); // reset re-baselines
    expect(gate.sample(19_000)).toBe(0); // negative delta -> 0 and drops baseline
    expect(gate.sample(20_016.7)).toBe(0); // next sample re-baselines rather than rebounding
    expect(gate.sample(20_033.4)).toBeCloseTo(0.0167, 3);
    gate.reset();
    expect(gate.sample(Number.NaN)).toBe(0);
  });
});

class FakeEventTarget {
  private readonly map = new Map<string, Array<() => void>>();
  addEventListener(type: string, listener: () => void) {
    const list = this.map.get(type) ?? [];
    list.push(listener);
    this.map.set(type, list);
  }
  removeEventListener(type: string, listener: () => void) {
    const list = (this.map.get(type) ?? []).filter((fn) => fn !== listener);
    this.map.set(type, list);
  }
  emit(type: string) {
    (this.map.get(type) ?? []).forEach((fn) => fn());
  }
  listenerCount(type: string) {
    return (this.map.get(type) ?? []).length;
  }
}

function makeFakeDocument(hasFocus = true, visibility: DocumentVisibilityState = "visible") {
  const target = new FakeEventTarget();
  return Object.assign(target, {
    visibilityState: visibility,
    hasFocus: () => hasFocus,
  }) as unknown as Document & FakeEventTarget;
}

describe("bindPageLifecycle blur / visibility stop-go", () => {
  it("maps visibility and focus events onto gate reasons and fires onInterrupt", () => {
    const gate = new RunGate();
    const doc = makeFakeDocument(true, "visible");
    const win = new FakeEventTarget() as unknown as Window & FakeEventTarget;
    const onInterrupt = vi.fn();
    const unbind = bindPageLifecycle(gate, doc, win as unknown as Window, { onInterrupt });

    expect(gate.isBlocked()).toBe(false);

    (doc as unknown as { visibilityState: string }).visibilityState = "hidden";
    doc.emit("visibilitychange");
    expect(gate.hasReason(BLOCK_REASONS.hidden)).toBe(true);
    expect(gate.isBlocked()).toBe(true);
    expect(onInterrupt).toHaveBeenCalledWith("hidden");

    win.emit("blur");
    expect(gate.hasReason(BLOCK_REASONS.blurred)).toBe(true);
    expect(onInterrupt).toHaveBeenCalledWith("blurred");

    // Returning to the tab while the window is still blurred stays blocked.
    (doc as unknown as { visibilityState: string }).visibilityState = "visible";
    doc.emit("visibilitychange");
    expect(gate.hasReason(BLOCK_REASONS.hidden)).toBe(false);
    expect(gate.isBlocked()).toBe(true);

    win.emit("focus");
    expect(gate.hasReason(BLOCK_REASONS.blurred)).toBe(false);
    expect(gate.isBlocked()).toBe(false);

    unbind();
    expect(doc.listenerCount("visibilitychange")).toBe(0);
    expect(win.listenerCount("blur")).toBe(0);
    expect(win.listenerCount("focus")).toBe(0);
  });

  it("blocks immediately when bound into an already-unfocused document", () => {
    const gate = new RunGate();
    const doc = makeFakeDocument(false, "visible");
    const win = new FakeEventTarget() as unknown as Window & FakeEventTarget;
    const onInterrupt = vi.fn();
    bindPageLifecycle(gate, doc, win as unknown as Window, { onInterrupt });
    expect(gate.hasReason(BLOCK_REASONS.blurred)).toBe(true);
    expect(onInterrupt).toHaveBeenCalledWith("blurred");
  });

  it("stops reacting after disposal", () => {
    const gate = new RunGate();
    const doc = makeFakeDocument(true, "visible");
    const win = new FakeEventTarget() as unknown as Window & FakeEventTarget;
    const unbind = bindPageLifecycle(gate, doc, win as unknown as Window);
    unbind();
    win.emit("blur");
    expect(gate.isBlocked()).toBe(false);
  });
});
