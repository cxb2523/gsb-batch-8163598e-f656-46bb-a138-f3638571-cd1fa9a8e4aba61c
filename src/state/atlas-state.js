/**
 * Pure filter / selection / observation-side state for the 3D atlas.
 *
 * This module has no DOM or Three.js dependencies so the linkage between
 * filters (meridian / region / query / scope), the selected point and the
 * observation side can be unit-tested with locally constructed state.
 *
 * Visibility contract (the single source of truth shared by the left list,
 * the "N 个 3D 穴位" counter and the scene markers):
 *   - pointMatchesFilters(point, filters) decides whether a point passes the
 *     current filter conditions;
 *   - selectVisiblePoints(points, filters) is exactly the clickable row set;
 *   - every visible modeled point has one active-side marker
 *     (see pickActiveMarker), giving a one-to-one row <-> marker correspondence.
 */

/** Observation side convention: 1 = body-left (+x), -1 = body-right (-x). */
export const VIEW_SIDE = Object.freeze({LEFT: 1, RIGHT: -1});

export const DEFAULT_FILTERS = Object.freeze({
  scope: 'model', // 'model' (三维穴位) | 'catalog' (完整目录)
  region: '全部',
  channel: '全部',
  query: '',
  side: VIEW_SIDE.LEFT
});

/**
 * Normalizes search text: lowercase, strip diacritics / whitespace / hyphens,
 * and map alternative channel prefixes (sj/du/ren) to the canonical codes.
 */
export function normalizeSearch(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ\s-]/g, '') // U+0300..U+036F combining marks, whitespace, hyphens
    .replace(/^sj/, 'te')
    .replace(/^du/, 'gv')
    .replace(/^ren/, 'cv');
}

/**
 * Canonical filter predicate. `filters` may be a plain locally constructed
 * object; omitted fields fall back to the defaults.
 */
export function pointMatchesFilters(point, filters = {}) {
  const f = {...DEFAULT_FILTERS, ...filters};

  // The 3D-only scope hides catalog-only entries entirely.
  if (f.scope !== 'catalog' && !point.modeled) return false;

  // Anatomical region chips only apply in the modeled scope (the region row
  // is hidden while browsing the full catalog).
  if (f.scope !== 'catalog' && f.region && f.region !== '全部' && point.region !== f.region) {
    return false;
  }

  if (f.channel && f.channel !== '全部' && point.meridian !== f.channel) return false;

  const query = normalizeSearch(f.query);
  if (query) {
    // GV26 (水沟) is widely searched by its alias 人中.
    const haystack = normalizeSearch(
      point.name + point.code + point.pinyin + point.meridian + (point.code === 'GV26' ? '人中' : '')
    );
    if (!haystack.includes(query)) return false;
  }

  return true;
}

/**
 * List ordering. Preserves the historical behavior: points of the same
 * meridian are ordered by channel sequence number; cross-meridian ordering
 * falls back to the stable dataset order.
 */
export function compareListOrder(a, b) {
  return a.meridian === b.meridian ? a.order - b.order : 0;
}

/** The exact set of rows rendered in the left list for the filter state. */
export function selectVisiblePoints(points, filters = {}) {
  return points.filter(p => pointMatchesFilters(p, filters)).sort(compareListOrder);
}

/** Number shown in the stage header ("N 个 3D 穴位"). */
export function countVisibleModeledPoints(points, filters = {}) {
  return points.reduce((n, p) => n + (p.modeled && pointMatchesFilters(p, filters) ? 1 : 0), 0);
}

/** First visible point id under the filters, or null for an empty result. */
export function getFirstVisibleId(points, filters = {}) {
  return selectVisiblePoints(points, filters)[0]?.id ?? null;
}

/**
 * Decides which id should be selected after a filter change.
 * Keeps the current selection when it still matches; otherwise falls back to
 * the first visible point; returns null when nothing is visible.
 */
export function reconcileSelectedId(points, filters = {}, selectedId = null) {
  if (selectedId !== null && selectedId !== undefined) {
    const current = points.find(p => p.id === selectedId);
    if (current && pointMatchesFilters(current, filters)) return selectedId;
  }
  return getFirstVisibleId(points, filters);
}

/** Normalizes an arbitrary side value to one of the two supported sides. */
export function normalizeSide(value) {
  return Number(value) === VIEW_SIDE.RIGHT ? VIEW_SIDE.RIGHT : VIEW_SIDE.LEFT;
}

/**
 * Finds the side-correct marker instance for a point.
 * Bilateral points have one marker per side; central (GV/CV) points have a
 * single side-independent marker.
 */
export function pickActiveMarker(markers, pointOrId, side = VIEW_SIDE.LEFT) {
  const id = typeof pointOrId === 'object' && pointOrId !== null ? pointOrId.id : pointOrId;
  if (id === null || id === undefined) return null;
  const s = normalizeSide(side);
  return (
    markers.find(m => m.p.id === id && (!m.p.bilateral || m.side === s)) ??
    // Tolerate marker descriptors that expose the point id directly.
    markers.find(m => m.id === id && (!m.bilateral || m.side === s)) ??
    null
  );
}

/**
 * Meridian light segments that should carry flowing qi particles for the
 * active side. Central (!bilateral) segments are side-independent; paired
 * segments must belong to the active side exactly, so switching sides can
 * never leave the previous side's particles in the rebuilt set.
 */
export function selectQiSegments(segments, meridian, side = VIEW_SIDE.LEFT) {
  if (!meridian) return [];
  const s = normalizeSide(side);
  return segments.filter(seg => seg.meridian === meridian && (!seg.bilateral || seg.side === s));
}

/**
 * Builds local marker descriptors the same way main.js creates scene markers:
 * one instance for central points, mirrored pair for bilateral points.
 * Useful for verifying row <-> marker correspondence without WebGL.
 */
export function buildMarkerDescriptors(points) {
  const markers = [];
  for (const p of points.filter(x => x.modeled)) {
    for (const side of p.bilateral ? [VIEW_SIDE.RIGHT, VIEW_SIDE.LEFT] : [VIEW_SIDE.LEFT]) {
      markers.push({p, side, id: p.id, bilateral: !!p.bilateral});
    }
  }
  return markers;
}

/** The marker subset representing the active observation side. */
export function activeSideMarkers(markers, side = VIEW_SIDE.LEFT) {
  const s = normalizeSide(side);
  return markers.filter(m => {
    const bilateral = m.p ? m.p.bilateral : m.bilateral;
    return !bilateral || m.side === s;
  });
}

/**
 * Stateful convenience wrapper used by the UI and in linkage tests.
 * Every mutating filter action returns the reconciliation result so callers
 * can react when the selected point changes or the result becomes empty.
 */
export class AtlasState {
  constructor(points, initial = {}) {
    this.points = points;
    this.filters = {
      ...DEFAULT_FILTERS,
      ...initial.filters,
      scope: initial.scope ?? initial.filters?.scope ?? DEFAULT_FILTERS.scope,
      region: initial.region ?? initial.filters?.region ?? DEFAULT_FILTERS.region,
      channel: initial.channel ?? initial.filters?.channel ?? DEFAULT_FILTERS.channel,
      query: initial.query ?? initial.filters?.query ?? DEFAULT_FILTERS.query,
      side: normalizeSide(initial.side ?? initial.filters?.side ?? DEFAULT_FILTERS.side)
    };
    const initialSelected = initial.selectedId ?? null;
    this.selectedId = reconcileSelectedId(this.points, this.filters, initialSelected);
  }

  get side() {
    return this.filters.side;
  }

  visiblePoints() {
    return selectVisiblePoints(this.points, this.filters);
  }

  visibleIds() {
    return this.visiblePoints().map(p => p.id);
  }

  visibleModeledCount() {
    return countVisibleModeledPoints(this.points, this.filters);
  }

  isVisible(pointOrId) {
    const p =
      typeof pointOrId === 'object' && pointOrId !== null
        ? pointOrId
        : this.points.find(x => x.id === pointOrId);
    return !!p && pointMatchesFilters(p, this.filters);
  }

  selectedPoint() {
    if (this.selectedId === null) return null;
    return this.points.find(p => p.id === this.selectedId) ?? null;
  }

  /** Explicit user selection (row / marker / label click). */
  select(id) {
    if (id !== null && id !== undefined && this.points.some(p => p.id === id)) {
      this.selectedId = id;
    }
    return this.reconcile();
  }

  /** Applies a partial filter patch and reconciles the selection. */
  setFilters(patch = {}) {
    if (patch.side !== undefined) patch = {...patch, side: normalizeSide(patch.side)};
    Object.assign(this.filters, patch);
    return this.reconcile();
  }

  setChannel(channel) {
    return this.setFilters({channel});
  }

  setRegion(region) {
    return this.setFilters({region});
  }

  setQuery(query) {
    return this.setFilters({query: String(query ?? '')});
  }

  setScope(scope) {
    return this.setFilters({scope});
  }

  setSide(side) {
    this.filters.side = normalizeSide(side);
    return this.side;
  }

  reset(overrides = {}) {
    this.filters = {...DEFAULT_FILTERS, ...overrides, side: normalizeSide(overrides.side)};
    return this.reconcile();
  }

  /** Re-runs selection reconciliation against the current filters. */
  reconcile() {
    const previousId = this.selectedId;
    const selectedId = reconcileSelectedId(this.points, this.filters, previousId);
    this.selectedId = selectedId;
    const visible = this.visiblePoints();
    return {
      previousId,
      selectedId,
      changed: previousId !== selectedId,
      empty: selectedId === null,
      visible
    };
  }

  pickActiveMarker(markers) {
    return pickActiveMarker(markers, this.selectedId, this.filters.side);
  }

  selectQiSegments(segments, meridian = this.selectedPoint()?.meridian) {
    return selectQiSegments(segments, meridian, this.filters.side);
  }
}
