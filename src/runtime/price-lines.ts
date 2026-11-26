/*
 * Price-line registry for the drawings' price-axis labels.
 *
 * A lightweight-charts price line (body hidden, axis pill shown) is one way to
 * put a label on the price scale; the primitive also returns axis views.
 * Whichever path renders a label, its lifecycle is the same: the set of labels
 * is recomputed on every chart update (a pan, zoom, price-scale change or data
 * reload calls `sync`), so handles must follow the current viewport instead of
 * accumulating.
 *
 * The registry keeps one handle per key (a drawing id + label role). A sync
 * reuses the surviving handles (applyOptions moves the pill, no add/remove
 * churn), updates their colour / text and removes every handle whose label
 * disappeared — a deleted, hidden or filtered drawing, a label switched off,
 * a price that left the scale, or a manager teardown. Repeated viewport changes
 * therefore never grow the series' price-line count.
 *
 * Everything is defensive: a host Coords without the price-line hooks, or a
 * hook that throws, must not break a frame after a data reload.
 */
import type { IPriceLine } from "lightweight-charts";
import type { Coords } from "../core/coords";

/** One label the chart should show on the price scale this frame. The pill
 *  text is the price line's own price (formatted by the series), so only the
 *  value and colours are carried. */
export type PriceLineLabel = {
  /** Stable identity across frames: `${drawingId}:${role}`. */
  key: string;
  price: number;
  back: string;
  color: string;
};

type Entry = { key: string; line: IPriceLine; price: number };

export class PriceLineRegistry {
  private readonly coords: Coords;
  private readonly entries = new Map<string, Entry>();

  constructor(coords: Coords) {
    this.coords = coords;
  }

  /** Reconcile the live price lines with `labels` (the current viewport):
   *  create new ones, move / restyle surviving ones, drop the rest. Safe to
   *  call with no price-line support (then it only releases old handles). */
  sync(labels: readonly PriceLineLabel[]): void {
    const add = this.coords.addPriceLine;
    const remove = this.coords.removePriceLine;
    const wanted = new Set(labels.map((l) => l.key));
    // Handles whose label disappeared this frame (or that can no longer be
    // supported) are released first, so the count can only shrink or stay.
    for (const [key, entry] of this.entries) {
      if (wanted.has(key) && typeof add === "function") continue;
      this.removeEntry(key, entry, remove);
    }
    if (typeof add !== "function") return;
    for (const l of labels) {
      if (!Number.isFinite(l.price)) continue;
      const existing = this.entries.get(l.key);
      if (existing) {
        if (existing.price !== l.price) {
          // applyOptions keeps the same handle while the pill follows the
          // price across zoom / scale changes (no remove + re-add).
          try {
            existing.line.applyOptions({ price: l.price });
            existing.price = l.price;
          } catch {
            // A stale handle from a replaced series: drop it, recreate below.
            this.removeEntry(l.key, existing, remove);
          }
        }
        if (!this.entries.has(l.key)) this.create(l, add);
        continue;
      }
      this.create(l, add);
    }
  }

  /** Release every handle (setDrawingsVisible(false), clear(), destroy()). */
  clear(): void {
    for (const [key, entry] of this.entries) this.removeEntry(key, entry, this.coords.removePriceLine);
  }

  /** Number of live handles — the label-leak invariant in tests. */
  get size(): number {
    return this.entries.size;
  }

  private create(l: PriceLineLabel, add: Coords["addPriceLine"]): void {
    let line: IPriceLine;
    try {
      line = add({
        price: l.price,
        color: "transparent",
        lineVisible: false,
        axisLabelVisible: true,
        axisLabelColor: l.back,
        axisLabelTextColor: l.color,
      });
    } catch {
      // A host hook failure must not break the frame; the primitive axis view
      // still carries the label.
      return;
    }
    if (line) this.entries.set(l.key, { key: l.key, line, price: l.price });
  }

  private removeEntry(key: string, entry: Entry, remove: Coords["removePriceLine"] | undefined): void {
    this.entries.delete(key);
    if (typeof remove !== "function") return;
    try {
      remove(entry.line);
    } catch {
      // The series may already be gone (detach / teardown): nothing to release.
    }
  }
}
