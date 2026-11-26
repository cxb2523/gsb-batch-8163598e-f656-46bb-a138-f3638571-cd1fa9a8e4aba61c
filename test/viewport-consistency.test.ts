// Viewport / data consistency of the drawing runtime:
//  - hit tests always use the screen points of the CURRENT projection, so after a zoom or pan a
//    drawing no longer hits at its old pixel and does hit at its new one;
//  - the hovered drawing is re-validated when the viewport changes without a pointer event;
//  - data-driven tools (regression trend, VWAP, volume profiles) degrade safely after a data
//    reload that removes their bars — no throw, no false hit;
//  - price-line axis labels are reconciled every frame: viewport churn never grows their count
//    and deleting / hiding / clearing a drawing removes its handles;
//  - touch hit tolerance keeps working after the re-projection changes.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OHLC } from "../src/core/coords";
import type { NewDrawing } from "../src/core/types";
import { ptr, setup } from "./pointer-harness";

afterEach(() => vi.unstubAllGlobals());

type Setup = ReturnType<typeof setup>;

/** Move the pointer and read which drawing (if any) is hovered. */
function hover(s: Setup, x: number, y: number): string | null {
  s.el.dispatchEvent(ptr("pointermove", "mouse", x, y, { buttons: 0 }));
  return s.dm.hoveredId();
}

/** Replace the harness series' bars (the default double is typed empty). */
function setBars(s: Setup, bars: OHLC[]): void {
  (s.series as unknown as { data: () => OHLC[] }).data = () => bars;
}

/** Replace the harness time scale with a test double (the subscription
 *  methods are optional at runtime). */
function setTimeScale(s: Setup, scale: Record<string, unknown>): void {
  (s.chart as unknown as { timeScale: () => unknown }).timeScale = () => scale;
}

const noopSubs = {
  subscribeVisibleLogicalRangeChange: () => {},
  unsubscribeVisibleLogicalRangeChange: () => {},
};

describe("hit testing follows the current viewport projection", () => {
  it("after a projection change the old pixel misses and the new pixel hits", () => {
    const s = setup();
    const { dm, el, series } = s;
    // Harness mapping: x = time, y = 500 - price. Anchors at pixels (100,200) and (300,300).
    const id = dm.add({
      kind: "trend-line",
      points: [{ time: 100 as never, price: 300 }, { time: 300 as never, price: 200 }],
    });
    expect(hover(s, 100, 200)).toBe(id);

    // Simulate a zoom + pan: every time shifts +50 px, the price scale inverts (y = price).
    series.priceToCoordinate = (p: number) => p;
    series.coordinateToPrice = (y: number) => y;
    setTimeScale(s, {
      timeToCoordinate: (t: number) => t + 50,
      coordinateToTime: (x: number) => x - 50,
      height: () => 0,
      width: () => 800,
      ...noopSubs,
    });
    // The drawing's first anchor now projects to (150, 300).
    expect(hover(s, 100, 200)).toBeNull(); // old screen position: nothing there anymore
    expect(hover(s, 150, 300)).toBe(id); // re-projected position: hits again
    el.dispatchEvent(ptr("pointerdown", "mouse", 150, 300));
    expect(dm.selection()).toContain(id); // the press at the new position selects it
  });

  it("a rectangle and a horizontal line use the re-projected points too", () => {
    const s = setup();
    const { dm, series } = s;
    const rect = dm.add({
      kind: "rectangle",
      points: [{ time: 100 as never, price: 400 }, { time: 300 as never, price: 200 }],
    });
    const hline = dm.add({ kind: "horizontal-line", points: [{ time: 100 as never, price: 250 }] });
    // Zoom: time x2, prices keep the harness mapping.
    setTimeScale(s, {
      timeToCoordinate: (t: number) => t * 2,
      coordinateToTime: (x: number) => Math.round(x / 2),
      height: () => 0,
      width: () => 800,
      ...noopSubs,
    });
    // Horizontal line at price 250 still projects to y = 250.
    expect(hover(s, 400, 250)).toBe(hline);
    expect(hover(s, 400, 999)).toBeNull();
    // Rectangle border now spans x 200..600, y 100..300: a point on its new right edge hits.
    expect(hover(s, 600, 200)).toBe(rect);
    // Its old corner pixel (100,100) is off the shape now.
    expect(hover(s, 100, 100)).toBeNull();
    expect(series.priceToCoordinate(400)).toBe(100);
  });

  it("a pending placement preview is re-projected after a viewport change", () => {
    const s = setup();
    const { dm } = s;
    dm.setTool("trend-line");
    s.el.dispatchEvent(ptr("pointerdown", "mouse", 100, 200));
    s.win.dispatchEvent(ptr("pointerup", "mouse", 100, 200));
    expect(dm.drawings()).toHaveLength(0);
    // Preview dot currently at (100,200). Pan the time axis.
    setTimeScale(s, {
      timeToCoordinate: (t: number) => t + 80,
      coordinateToTime: (x: number) => x - 80,
      height: () => 0,
      width: () => 800,
      ...noopSubs,
    });
    const before = dm.scenes(800, 500).flatMap((x) => x.scene);
    const circles = before.filter((it) => it.t === "circle");
    expect(circles.length).toBeGreaterThan(0);
    // The pending point (time 100) must paint at x = 180, not the stale 100.
    expect(circles.every((it) => it.t !== "circle" || it.cx === 180)).toBe(true);
  });
});

describe("hover is re-validated on viewport changes", () => {
  it("a pan that moves the drawing away from the cursor clears the hover and cursor", () => {
    const s = setup();
    const { dm } = s;
    const id = dm.add({
      kind: "trend-line",
      points: [{ time: 100 as never, price: 300 }, { time: 300 as never, price: 200 }],
    });
    expect(hover(s, 100, 200)).toBe(id);
    expect(dm.cursorAt()).not.toBeNull();
    // Pan without any pointer event: the line leaves the cursor's pixel.
    setTimeScale(s, {
      timeToCoordinate: (t: number) => t + 200,
      coordinateToTime: (x: number) => x - 200,
      height: () => 0,
      width: () => 800,
      ...noopSubs,
    });
    (s.chart as unknown as { _fireViewport: () => void })._fireViewport();
    expect(dm.hoveredId()).toBeNull();
    expect(dm.cursorAt()).toBeNull();
  });

  it("the hover follows the drawing when the pointer reaches its new position", () => {
    const s = setup();
    const { dm } = s;
    const id = dm.add({
      kind: "trend-line",
      points: [{ time: 100 as never, price: 300 }, { time: 300 as never, price: 200 }],
    });
    // Hover a point on the segment: (200,250).
    expect(hover(s, 200, 250)).toBe(id);
    // Pan the anchor from x=100 to x=200, so the segment now passes (300,250).
    setTimeScale(s, {
      timeToCoordinate: (t: number) => t + 100,
      coordinateToTime: (x: number) => x - 100,
      height: () => 0,
      width: () => 800,
      ...noopSubs,
    });
    (s.chart as unknown as { _fireViewport: () => void })._fireViewport();
    // The cursor stayed at (200,250): the drawing is no longer there.
    expect(dm.hoveredId()).toBeNull();
    // Move the emulated cursor over the new line: it hits again.
    expect(hover(s, 300, 250)).toBe(id);
  });
});

const barsOf = (n: number, t0 = 100): OHLC[] =>
  Array.from({ length: n }, (_, i) => ({
    time: (t0 + i) as never,
    open: 100 + i,
    high: 102 + i,
    low: 98 + i,
    close: 100 + i,
  }));

describe("data reload: data-driven tools degrade safely", () => {
  const dataKinds: [string, NewDrawing][] = [
    ["regression-trend", { kind: "regression-trend", points: [{ time: 105 as never, price: 105 }, { time: 120 as never, price: 120 }] }],
    ["anchored-vwap", { kind: "anchored-vwap", points: [{ time: 105 as never, price: 105 }] }],
    ["fixed-range-volume-profile", { kind: "fixed-range-volume-profile", points: [{ time: 105 as never, price: 105 }, { time: 120 as never, price: 120 }] }],
    ["anchored-volume-profile", { kind: "anchored-volume-profile", points: [{ time: 105 as never, price: 105 }] }],
  ];

  for (const [name, drawing] of dataKinds) {
    it(`${name}: no throw and no false hit once its bars are gone`, () => {
      const s = setup();
      const { dm, chart } = s;
      setBars(s, barsOf(30));
      const id = dm.add(drawing);
      // Works while the bars exist.
      expect(() => {
        dm.scenes(800, 500);
        hover(s, 110, 380);
      }).not.toThrow();

      // Symbol switch: the new series uses a disjoint time domain (9000+) and
      // its time scale can no longer map the old symbol's bar times. The
      // logical axis only covers the loaded bars, so off-domain lookups fail
      // (as a real lightweight-charts does outside its data range).
      const newBars = barsOf(10, 9000);
      setBars(s, newBars);
      (chart as unknown as { _fireViewport?: () => void });
      setTimeScale(s, {
        timeToCoordinate: (t: number) => (t >= 9000 ? t - 9000 : null),
        coordinateToTime: (x: number) => (x >= 0 && x < newBars.length ? x + 9000 : null),
        coordinateToLogical: (x: number) => (x >= 0 && x < newBars.length ? x : null),
        logicalToCoordinate: (l: number) => (l >= 0 && l < newBars.length ? l : null),
        getVisibleRange: () => ({ from: 9000, to: 9010 }),
        height: () => 0,
        width: () => 800,
        ...noopSubs,
      });
      expect(() => {
        // No screen points means the drawing contributes no scene, no hit and
        // no axis label while its data is gone.
        expect(dm.scenes(800, 500)).toEqual([]);
        s.el.dispatchEvent(ptr("pointermove", "mouse", 110, 380, { buttons: 0 }));
        s.el.dispatchEvent(ptr("pointerdown", "mouse", 110, 380));
        s.win.dispatchEvent(ptr("pointerup", "mouse", 110, 380));
        expect(dm.axisViews().price).toEqual([]);
      }).not.toThrow();
      // It must not be hit (and a press on empty space does not select it).
      expect(dm.hoveredId()).toBeNull();
      expect(dm.selection()).not.toContain(id);

      // And once the old data returns it is drawn again without recreating the drawing.
      setTimeScale(s, {
        timeToCoordinate: (t: number) => t,
        coordinateToTime: (x: number) => x,
        getVisibleRange: () => ({ from: 0, to: 1000 }),
        height: () => 0,
        width: () => 800,
        ...noopSubs,
      });
      setBars(s, barsOf(30));
      expect(dm.scenes(800, 500).length).toBeGreaterThan(0);
    });
  }

  it("regression-trend falls back to its stored segment, never indexing an empty range", () => {
    const s = setup();
    const { dm } = s;
    setBars(s, barsOf(30));
    dm.add({
      kind: "regression-trend",
      points: [{ time: 105 as never, price: 105 }, { time: 120 as never, price: 120 }],
    });
    // Same domain, but no bars inside the drawing's range: the fit is skipped
    // and the helper returns null instead of touching an empty array.
    setBars(s, barsOf(5, 5000));
    expect(() => dm.scenes(800, 500)).not.toThrow();
    expect(() => hover(s, 112, 378)).not.toThrow();
  });
});

describe("price-line axis label lifecycle", () => {
  const hline = (price: number): NewDrawing => ({
    kind: "horizontal-line",
    points: [{ time: 100 as never, price }],
    style: { showPriceLabels: true } as never,
  });

  it("creates one handle per visible price label and never stacks them on viewport churn", () => {
    const s = setup({ priceLineLabels: true });
    const { dm, chart, priceLines } = s;
    dm.add(hline(300));
    dm.axisViews();
    expect(priceLines).toHaveLength(1);
    // Repeated chart updates (the primitive's updateAllViews on every pan / zoom frame).
    for (let i = 0; i < 20; i++) {
      (chart as unknown as { _fireViewport: () => void })._fireViewport();
      dm.axisViews();
    }
    expect(priceLines).toHaveLength(1);
  });

  it("moves an existing handle when the price scale changes instead of re-adding", () => {
    const s = setup({ priceLineLabels: true });
    const { dm, priceLines } = s;
    dm.add(hline(300));
    dm.axisViews();
    const handle = priceLines[0];
    expect(handle.options.price).toBe(300);
    // Move the line (a drag): the same handle gets applyOptions, no new handle.
    const d = dm.drawings()[0];
    dm.update({ ...d, points: [{ time: 100 as never, price: 310 }] } as never);
    dm.axisViews();
    expect(priceLines).toHaveLength(1);
    expect(priceLines[0]).toBe(handle);
    expect(handle.options.price).toBe(310);
  });

  it("removes the handle when the drawing is deleted, hidden or cleared, and on destroy", () => {
    const s = setup({ priceLineLabels: true });
    const { dm, priceLines } = s;
    const id = dm.add(hline(300));
    dm.add(hline(200));
    dm.axisViews();
    expect(priceLines).toHaveLength(2);

    dm.remove(id);
    dm.axisViews();
    expect(priceLines).toHaveLength(1);

    dm.setHidden(dm.drawings()[0].id, true);
    dm.axisViews();
    expect(priceLines).toHaveLength(0);

    dm.setHidden(dm.drawings()[0].id, false);
    dm.axisViews();
    expect(priceLines).toHaveLength(1);
    dm.clear();
    dm.axisViews();
    expect(priceLines).toHaveLength(0);

    const id2 = dm.add(hline(300));
    dm.axisViews();
    expect(priceLines).toHaveLength(1);
    dm.destroy();
    expect(priceLines).toHaveLength(0);
    expect(id2).toBeTruthy();
  });

  it("hide-all and a label switched off release the handles", () => {
    const s = setup({ priceLineLabels: true });
    const { dm, priceLines } = s;
    dm.add(hline(300));
    dm.axisViews();
    expect(priceLines).toHaveLength(1);
    dm.setDrawingsVisible(false);
    dm.axisViews();
    expect(priceLines).toHaveLength(0);
    dm.setDrawingsVisible(true);
    dm.axisViews();
    expect(priceLines).toHaveLength(1);
    const d = dm.drawings()[0];
    dm.update({ ...d, style: { ...d.style, showPriceLabels: false } } as never);
    dm.axisViews();
    expect(priceLines).toHaveLength(0);
  });

  it("without the option the manager uses primitive axis views and creates no price lines", () => {
    const s = setup();
    const { dm, priceLines } = s;
    dm.add(hline(300));
    const views = dm.axisViews();
    expect(views.price).toHaveLength(1);
    expect(priceLines).toHaveLength(0);
    // Repeated rebuilds keep returning fresh arrays with the same count.
    for (let i = 0; i < 5; i++) expect(dm.axisViews().price).toHaveLength(1);
  });

  it("a host price-line hook that throws does not break the frame", () => {
    const s = setup({ priceLineLabels: true });
    const { dm, series } = s;
    (series as unknown as { createPriceLine: () => never }).createPriceLine = () => {
      throw new Error("series detached");
    };
    dm.add(hline(300));
    expect(() => dm.axisViews()).not.toThrow();
    // The primitive views are suppressed in this mode, but the frame still
    // renders and every other path keeps working.
    expect(() => dm.scenes(800, 500)).not.toThrow();
    expect(dm.drawings()).toHaveLength(1);
  });
});

describe("touch hit tolerance still applies after viewport changes", () => {
  it("the configured touch slop widens the hit band on the re-projected line", () => {
    const s = setup({ touchHitTolerance: 22 });
    const { dm, chart } = s;
    const id = dm.add({
      kind: "trend-line",
      points: [{ time: 100 as never, price: 300 }, { time: 300 as never, price: 200 }],
    });
    // Pan the line +100 px in x.
    setTimeScale(s, {
      timeToCoordinate: (t: number) => t + 100,
      coordinateToTime: (x: number) => x - 100,
      height: () => 0,
      width: () => 800,
      ...noopSubs,
    });
    // The segment now runs (200,200) -> (400,300); at x=300 its y is 250.
    // A touch 18 px off the line is within the 22 px touch slop but beyond the 6 px mouse slop.
    const tap = (type: string): boolean => {
      s.el.dispatchEvent(ptr("pointerdown", type, 300, 232));
      // Touch selection (tapSelect) commits on the document pointerup.
      s.doc.dispatchEvent(ptr("pointerup", type, 300, 232));
      const picked = dm.selection().includes(id);
      dm.select([]);
      return picked;
    };
    expect(tap("touch")).toBe(true);
    // A mouse at the same offset stays outside the mouse slop.
    s.el.dispatchEvent(ptr("pointerdown", "mouse", 300, 232));
    expect(dm.selection()).not.toContain(id);
    s.win.dispatchEvent(ptr("pointerup", "mouse", 300, 232));
    expect(chart).toBeTruthy();
  });
});
