/**
 * Linkage tests for the filter -> list -> scene marker -> selection -> side
 * state machine. Runs entirely in Node against locally constructed state and
 * the real atlas dataset; no DOM or WebGL is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {atlasPoints} from '../src/data/atlas-data.js';
import {
  AtlasState,
  VIEW_SIDE,
  activeSideMarkers,
  buildMarkerDescriptors,
  countVisibleModeledPoints,
  getFirstVisibleId,
  normalizeSearch,
  pickActiveMarker,
  pointMatchesFilters,
  reconcileSelectedId,
  selectQiSegments,
  selectVisiblePoints
} from '../src/state/atlas-state.js';

const li4 = atlasPoints.find(p => p.code === 'LI4');
const gv20 = atlasPoints.find(p => p.code === 'GV20');

test('dataset exposes stable ids and known fixture points', () => {
  assert.ok(li4, 'LI4 (合谷) must exist');
  assert.equal(li4.modeled, true);
  assert.equal(li4.bilateral, true);
  assert.ok(gv20, 'GV20 (百会) must exist');
  assert.equal(gv20.bilateral, false);
  assert.equal(new Set(atlasPoints.map(p => p.id)).size, atlasPoints.length);
});

test('normalizeSearch mirrors pinyin, alias and channel-prefix rules', () => {
  assert.equal(normalizeSearch('Hé Gǔ'), 'hegu');
  assert.equal(normalizeSearch('DU20'), 'gv20');
  assert.equal(normalizeSearch('ren 12'), 'cv12');
  assert.equal(normalizeSearch('sj5'), 'te5');
  assert.equal(normalizeSearch('合-谷'), '合谷');
});

test('default filter lists every point and selects a visible point', () => {
  const filters = {scope: 'model'};
  const rows = selectVisiblePoints(atlasPoints, filters);
  assert.ok(rows.length > 100);
  assert.equal(rows.every(p => p.modeled), true);
  assert.equal(pointMatchesFilters(li4, filters), true);
  assert.equal(reconcileSelectedId(atlasPoints, filters, li4.id), li4.id);
});

test('meridian filter narrows rows to that meridian', () => {
  const filters = {scope: 'model', channel: '督脉'};
  const rows = selectVisiblePoints(atlasPoints, filters);
  assert.ok(rows.length >= 2);
  assert.equal(rows.every(p => p.meridian === '督脉'), true);
  // Channel order is ascending within one meridian.
  const orders = rows.map(p => p.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
});

test('region + query filters compose', () => {
  const filters = {scope: 'model', region: '手部', query: 'LI'};
  const rows = selectVisiblePoints(atlasPoints, filters);
  assert.ok(rows.some(p => p.code === 'LI4'));
  assert.equal(rows.every(p => p.region === '手部'), true);
  assert.equal(rows.every(p => p.code.startsWith('LI')), true);
});

test('GV26 is searchable by the 人中 alias', () => {
  const gv26 = atlasPoints.find(p => p.code === 'GV26');
  assert.ok(gv26);
  assert.equal(pointMatchesFilters(gv26, {scope: 'catalog', query: '人中'}), true);
});

test('impossible query yields zero rows and a null selection', () => {
  const filters = {scope: 'model', query: 'zzz-no-such-point-xyz'};
  assert.deepEqual(selectVisiblePoints(atlasPoints, filters), []);
  assert.equal(getFirstVisibleId(atlasPoints, filters), null);
  assert.equal(reconcileSelectedId(atlasPoints, filters, li4.id), null);
  assert.equal(countVisibleModeledPoints(atlasPoints, filters), 0);
});

test('A2: selected point filtered out falls back to first visible row', () => {
  // LI4 belongs to 手阳明大肠经; switch to 督脉 so it is excluded.
  const filters = {scope: 'model', channel: '督脉'};
  const nextId = reconcileSelectedId(atlasPoints, filters, li4.id);
  const firstRow = selectVisiblePoints(atlasPoints, filters)[0];
  assert.equal(nextId, firstRow.id);
  assert.notEqual(nextId, li4.id);
  assert.equal(pointMatchesFilters(atlasPoints.find(p => p.id === nextId), filters), true);
});

test('selection is kept when it still matches the new filter', () => {
  const filters = {scope: 'model', channel: '手阳明大肠经'};
  assert.equal(reconcileSelectedId(atlasPoints, filters, li4.id), li4.id);
});

test('A3: empty result reconciles to null; relaxing filter recovers selection', () => {
  const state = new AtlasState(atlasPoints, {selectedId: li4.id});
  assert.equal(state.selectedId, li4.id);

  let result = state.setQuery('不存在的穴位名称xyz');
  assert.equal(result.empty, true);
  assert.equal(state.selectedId, null);
  assert.equal(state.selectedPoint(), null);
  assert.equal(state.pickActiveMarker(buildMarkerDescriptors(atlasPoints)), null);
  assert.deepEqual(state.selectQiSegments([{meridian: 'x'}]), []);

  result = state.setQuery('');
  assert.equal(result.empty, false);
  assert.equal(state.selectedId, getFirstVisibleId(atlasPoints, state.filters));
  assert.notEqual(state.selectedId, null);
});

test('catalog scope includes catalog-only points but model scope excludes them', () => {
  const catalogOnly = atlasPoints.find(p => !p.modeled);
  assert.ok(catalogOnly, 'fixture should contain a catalog-only point');
  assert.equal(pointMatchesFilters(catalogOnly, {scope: 'model'}), false);
  assert.equal(pointMatchesFilters(catalogOnly, {scope: 'catalog'}), true);
  // Region chips do not hide entries while browsing the full catalog.
  assert.equal(
    pointMatchesFilters(catalogOnly, {scope: 'catalog', region: '手部'}),
    true
  );
});

test('A1: list rows correspond one-to-one with visible marker ids (model scope)', () => {
  const markers = buildMarkerDescriptors(atlasPoints);
  const scenarios = [
    {scope: 'model'},
    {scope: 'model', channel: '督脉'},
    {scope: 'model', channel: '手阳明大肠经'},
    {scope: 'model', region: '手部'},
    {scope: 'model', region: '足部'},
    {scope: 'model', query: '合谷'},
    {scope: 'model', query: 'ST36'},
    {scope: 'model', channel: '足太阳膀胱经', region: '背部'}
  ];

  for (const filters of scenarios) {
    const rows = selectVisiblePoints(atlasPoints, filters);
    const rowIds = new Set(rows.map(p => p.id));

    // Every row in model scope is modeled and therefore has scene marker(s).
    assert.equal(rows.every(p => p.modeled), true, `all rows modeled for ${JSON.stringify(filters)}`);

    // Filter-visible marker instances map back to exactly the row id set.
    const visibleMarkerIds = new Set(
      markers.filter(m => pointMatchesFilters(m.p, filters)).map(m => m.p.id)
    );
    assert.deepEqual(visibleMarkerIds, rowIds, `marker ids mismatch for ${JSON.stringify(filters)}`);

    // The stage counter agrees with the unique visible marker id count.
    assert.equal(countVisibleModeledPoints(atlasPoints, filters), visibleMarkerIds.size);

    // On the active side each row has exactly one clickable active marker.
    const side = VIEW_SIDE.LEFT;
    const active = activeSideMarkers(markers, side).filter(m => pointMatchesFilters(m.p, filters));
    assert.equal(active.length, rows.length, `active marker count for ${JSON.stringify(filters)}`);
    const activeIds = active.map(m => m.p.id).sort((a, b) => a - b);
    assert.deepEqual(activeIds, [...rowIds].sort((a, b) => a - b));
    for (const row of rows) {
      assert.ok(pickActiveMarker(markers, row.id, side), `missing active marker for ${row.code}`);
    }
  }
});

test('A1 catalog scope: modeled rows and marker ids still agree', () => {
  const filters = {scope: 'catalog', channel: '手阳明大肠经'};
  const rows = selectVisiblePoints(atlasPoints, filters);
  const modeledRows = rows.filter(p => p.modeled);
  const markers = buildMarkerDescriptors(atlasPoints);
  const visibleMarkerIds = new Set(
    markers.filter(m => pointMatchesFilters(m.p, filters)).map(m => m.p.id)
  );
  assert.equal(visibleMarkerIds.size, modeledRows.length);
  assert.equal(countVisibleModeledPoints(atlasPoints, filters), modeledRows.length);
  // Catalog-only rows are legitimately clickable but have no 3D marker.
  assert.ok(rows.some(p => !p.modeled));
});

test('A4: active marker follows observation side for bilateral points', () => {
  const markers = buildMarkerDescriptors(atlasPoints);
  const left = pickActiveMarker(markers, li4.id, VIEW_SIDE.LEFT);
  const right = pickActiveMarker(markers, li4.id, VIEW_SIDE.RIGHT);
  assert.ok(left && right);
  assert.equal(left.side, VIEW_SIDE.LEFT);
  assert.equal(right.side, VIEW_SIDE.RIGHT);
  assert.ok(left.p.pos[0] > 0);
  // Scene construction mirrors x by side.
  assert.equal(left.p.pos[0] * left.side, li4.pos[0]);
  assert.equal(right.p.pos[0] * right.side, -li4.pos[0]);
  assert.notEqual(left, right);
});

test('A4: central points share one side-independent marker', () => {
  const markers = buildMarkerDescriptors(atlasPoints);
  const left = pickActiveMarker(markers, gv20.id, VIEW_SIDE.LEFT);
  const right = pickActiveMarker(markers, gv20.id, VIEW_SIDE.RIGHT);
  assert.ok(left && right);
  assert.equal(left, right);
  assert.equal(left.side, VIEW_SIDE.LEFT);
});

test('A4: qi segments rebuild strictly for the requested side', () => {
  const segments = [
    {meridian: '手阳明大肠经', side: 1, bilateral: true},
    {meridian: '手阳明大肠经', side: -1, bilateral: true},
    {meridian: '手阳明大肠经', side: 1, bilateral: true},
    {meridian: '督脉', side: 1, bilateral: false},
    {meridian: '足阳明胃经', side: 1, bilateral: true}
  ];

  const leftSegs = selectQiSegments(segments, '手阳明大肠经', 1);
  assert.equal(leftSegs.length, 2);
  assert.equal(leftSegs.every(s => s.side === 1), true);

  const rightSegs = selectQiSegments(segments, '手阳明大肠经', -1);
  assert.equal(rightSegs.length, 1);
  assert.equal(rightSegs[0].side, -1);

  // Central segments are included on either side.
  assert.equal(selectQiSegments(segments, '督脉', -1).length, 1);
  assert.equal(selectQiSegments(segments, '督脉', 1).length, 1);
  assert.deepEqual(selectQiSegments(segments, undefined, 1), []);
});

test('AtlasState drives filter, selection and side from one object', () => {
  const state = new AtlasState(atlasPoints, {selectedId: li4.id});
  assert.equal(state.side, 1);

  state.setSide(-1);
  assert.equal(state.side, -1);
  assert.equal(state.pickActiveMarker(buildMarkerDescriptors(atlasPoints)).side, -1);

  const result = state.setChannel('督脉');
  assert.equal(result.empty, false);
  assert.equal(state.selectedPoint().meridian, '督脉');
  assert.equal(state.visiblePoints().every(p => p.meridian === '督脉'), true);

  // Side survives filter changes (independent axis).
  assert.equal(state.side, -1);
});

test('A5 invariant: repeated deterministic filter/side toggles never corrupt state', () => {
  const state = new AtlasState(atlasPoints, {selectedId: li4.id});
  const markers = buildMarkerDescriptors(atlasPoints);
  const channels = ['全部', '督脉', '手阳明大肠经', '足阳明胃经', '不存在经'];
  const queries = ['', '合', 'LI', 'zzz'];
  const regions = ['全部', '手部', '足部', '头颈'];

  let tick = 0;
  for (let i = 0; i < 200; i++) {
    state.setChannel(channels[i % channels.length]);
    state.setRegion(regions[(i >> 1) % regions.length]);
    state.setQuery(queries[(i >> 2) % queries.length]);
    state.setSide(i % 2 === 0 ? 1 : -1);
    tick++;

    const rows = state.visiblePoints();
    if (rows.length === 0) {
      assert.equal(state.selectedId, null, `tick ${tick}`);
      assert.equal(state.pickActiveMarker(markers), null);
    } else {
      assert.ok(state.selectedId !== null, `tick ${tick} should auto-select`);
      assert.ok(state.isVisible(state.selectedId), `tick ${tick} selected must be visible`);
      const mark = state.pickActiveMarker(markers);
      // Selected point may be catalog-only in catalog scope; here scope=model,
      // so an active marker must always exist.
      assert.ok(mark, `tick ${tick} active marker expected`);
      assert.equal(mark.p.id, state.selectedId);
    }
  }

  state.reset();
  assert.equal(state.filters.channel, '全部');
  assert.equal(state.filters.query, '');
  assert.equal(state.filters.region, '全部');
  assert.equal(state.selectedId, getFirstVisibleId(atlasPoints, state.filters));
});
