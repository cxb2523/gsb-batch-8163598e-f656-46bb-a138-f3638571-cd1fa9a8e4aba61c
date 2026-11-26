#!/usr/bin/env node
// Standalone acceptance tests for cancellable battle animations.
//
// Run from the repo root (or any cwd):
//   node tools/test_anim_cancel.js
//
// Covers:
//   A1 cancelling a running animation restores every transient sc field to neutral
//   A2 the cancelled generator ends normally; queued fx never draw again
//   A3 two animations played back to back do not pollute each other
//   A4 normal full playback keeps the original frame counts / end state
//   A5 cancelling at the finishing edge / twice / with no anim is safe
//
// The canonical cancellation protocol is the standard generator one:
//   const gen = G.vfx.move(sc, 'THUNDER', 'p', 0);
//   gen.next(); ... ; gen.return();      // runs unified try/finally cleanup
// or the scene handle API:
//   const h = sc.playAnim('THUNDER', 'p'); h.step(6); h.cancel();
// or, for engine-driven tasks, task.cancel() / G.engine.cancel(task).
'use strict';
const H = require('./headless.js');
const G = H.loadGame({ search: '?map=Route1&x=10&y=20' }).G;
G.boot();

let failures = 0, checks = 0;
function ok(cond, msg) { checks++; if (cond) { console.log('  ok - ' + msg); } else { failures++; console.error('  FAIL - ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ' (expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a) + ')'); }

// Deterministic pseudo-random source so two runs can be compared exactly.
let seed = 123456789;
function lcg() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function resetSeed(s) { seed = s || 987654321; }
const realRandom = Math.random;
Math.random = lcg;

function freshSc() {
  resetSeed();
  G.state.party = [new G.Mon('CHARIZARD', 40)];
  const b = new G.Battle({ type: 'wild', enemyParty: [new G.Mon('BLASTOISE', 40)] });
  const sc = new G.BattleScene({ bg: 'grass' });
  sc.b = b; b.ui = sc;
  sc.show.p = sc.show.e = true;
  sc.disp.p = b.mon(b.p).hp; sc.disp.e = b.mon(b.e).hp;
  sc.platformSlide = 1;
  G.engine.scenes.length = 0;
  G.engine.push(sc);
  return sc;
}
function neutralProblems(sc) {
  const bad = [];
  for (const k of ['p', 'e']) {
    if (!sc.offs[k] || sc.offs[k].x !== 0 || sc.offs[k].y !== 0) bad.push('offs.' + k);
    if (sc.vis[k] !== 1) bad.push('vis.' + k + '=' + sc.vis[k]);
    if (sc.scale[k] !== 1) bad.push('scale.' + k + '=' + sc.scale[k]);
    if (sc.clip[k] !== 1) bad.push('clip.' + k + '=' + sc.clip[k]);
    if (sc.tint[k] !== null) bad.push('tint.' + k);
  }
  if (!Array.isArray(sc.fx) || sc.fx.length !== 0) bad.push('fx.length=' + (sc.fx && sc.fx.length));
  if (sc.screenFx !== null) bad.push('screenFx');
  if (sc.flash !== 0) bad.push('flash=' + sc.flash);
  if (sc.shake !== 0) bad.push('shake=' + sc.shake);
  if (sc.overlay !== null) bad.push('overlay');
  return bad;
}
function assertNeutral(sc, msg) { eq(neutralProblems(sc).length, 0, msg + (neutralProblems(sc).length ? ' [' + neutralProblems(sc).join(',') + ']' : '')); }
// Full state signature for no-pollution comparisons.
function sig(sc) {
  return JSON.stringify({
    offs: sc.offs, vis: sc.vis, scale: sc.scale, clip: sc.clip,
    tint: { p: sc.tint.p, e: sc.tint.e }, screenFx: sc.screenFx !== null,
    flash: sc.flash, shake: sc.shake, fx: sc.fx.length, overlay: sc.overlay !== null,
  });
}
function runToEnd(gen, cap) { let n = 0, r; do { r = gen.next(); n++; } while (!r.done && n < (cap || 5000)); return { n, r }; }

// ---------------------------------------------------------------------------
console.log('A1/A2: resetAnimState and immediate cancellation');
{
  const sc = freshSc();
  // deliberately dirty every field
  sc.offs.p.x = 9; sc.offs.e.y = -7; sc.vis.p = 0.3; sc.vis.e = 0; sc.scale.p = 0.4; sc.scale.e = 2;
  sc.clip.p = 0.2; sc.clip.e = 0.9; sc.tint.p = [1, 0.5]; sc.tint.e = [2, 0.5];
  sc.fx.push({ draw() { return true; } }, { draw() { return true; } });
  sc.screenFx = () => {}; sc.flash = 0.8; sc.shake = 6; sc.overlay = () => {}; sc.flashColor = 123;
  sc.resetAnimState();
  assertNeutral(sc, 'resetAnimState restores the full neutral state');
  eq(sc.flashColor, G.PAL.white, 'flashColor returns to the constructor default');
  // aliases point at the same cleanup contract
  const sc2 = freshSc(); sc2.flash = 1; sc2.clearFx ? sc2.resetFx() : null; eq(sc2.flash, 0, 'resetFx alias resets all state');
  ok(typeof sc2.cancelAnim === 'function' && typeof G.vfx.cancel === 'function', 'sc.cancelAnim / G.vfx.cancel exist');
}

// Every shipped move recipe, cancelled at two early points, must end neutral.
console.log('A1: cancel every one of the', Object.keys(G.vfx.MOVES).length, 'move recipes mid-flight');
{
  let n = 0; const badMoves = [];
  for (const id of Object.keys(G.vfx.MOVES)) {
    for (const at of [1, 4]) {
      const sc = freshSc();
      const gen = G.vfx.move(sc, id, 'p', 0);
      let endedEarly = false;
      for (let i = 0; i < at; i++) { const r = gen.next(); if (r.done) { endedEarly = true; break; } }
      if (!endedEarly) {
        const ret = gen.return(undefined);
        if (!ret || ret.done !== true) badMoves.push(id + '@' + at + ':return-not-done');
        const again = gen.next();
        if (!again.done) badMoves.push(id + '@' + at + ':lingering-wait');
        const bad = neutralProblems(sc);
        if (bad.length) badMoves.push(id + '@' + at + ':' + bad.join('|'));
        n++;
      }
    }
  }
  eq(badMoves.length, 0, 'all ' + n + ' mid-flight cancellations are neutral and closed' + (badMoves.length ? '; e.g. ' + badMoves.slice(0, 5).join(' ;; ') : ''));
}

// Representative categories from the prompt: multi-hit, charge, projectile, screen fx.
const REPS = [
  ['TACKLE', 19], ['WRAP', 33], ['EMBER', 51], ['THUNDERBOLT', 35], ['THUNDER', 47],
  ['PSYCHIC_M', 65], ['EARTHQUAKE', 45], ['METRONOME', 25], ['DOUBLE_TEAM', 21],
  ['MINIMIZE', 23], ['DIG_CHARGE', 13], ['BLIZZARD', 71], ['ROCK_SLIDE', 57], ['SURF', 51],
];
console.log('A1/A2: representative categories cancel cleanly and stay clean under draw/step');
for (const [id] of REPS) {
  const sc = freshSc();
  const gen = G.vfx.move(sc, id, 'p', 0);
  gen.next(); gen.next(); gen.next();
  gen.return(undefined);
  assertNeutral(sc, id + ' neutral right after gen.return()');
  // drawing frames must not resurrect anything (fx queue is empty, flash/shake are 0)
  let drewFine = true;
  try { for (let i = 0; i < 12; i++) sc.draw(G.gfx.screen); } catch (e) { drewFine = false; console.error(e); }
  ok(drewFine, id + ' draws after cancel without throwing');
  assertNeutral(sc, id + ' stays neutral after 12 draw frames');
  eq(gen.next().done, true, id + ' generator has no dangling wait');
}

// status / stat entry points too
for (const [label, factory] of [
  ['status PSN', sc => G.vfx.status(sc, 'e', 'PSN')],
  ['status SLP', sc => G.vfx.status(sc, 'p', 'SLP')],
  ['stat up', sc => G.vfx.stat(sc, 'p', true)],
]) {
  const sc = freshSc(); const gen = factory(sc);
  gen.next(); gen.next(); gen.return(undefined);
  assertNeutral(sc, label + ' cancels neutral');
}

// A plain-object sc (no BattleScene instance) must also be cleanable via G.vfx.cancel.
{
  const fake = { fx: [], offs: { p: { x: 0, y: 0 }, e: { x: 0, y: 0 } }, vis: { p: 1, e: 1 }, scale: { p: 1, e: 1 }, clip: { p: 1, e: 1 }, tint: { p: null, e: null } };
  const gen = G.vfx.move(fake, 'THUNDER', 'p', 0);
  gen.next(); gen.next();
  G.vfx.cancel(fake, gen);
  eq(fake.fx.length, 0, 'G.vfx.cancel clears a plain sc fx queue');
  eq(fake.screenFx, null, 'G.vfx.cancel clears screenFx');
  eq(fake.flash, 0, 'G.vfx.cancel zeroes flash');
}

// ---------------------------------------------------------------------------
console.log('A3: consecutive animations do not pollute each other');
{
  // cancel A midway through the scene handle API, then play B fully
  const sc = freshSc();
  const ha = sc.playAnim('THUNDER', 'p');
  ha.step(12);
  ok(!ha.done, 'handle A is mid-animation before cancel');
  ha.cancel();
  assertNeutral(sc, 'handle A cancelled to neutral');
  resetSeed();
  const hb = sc.playAnim('PSYCHIC_M', 'p');
  hb.finish();
  eq(hb.done, true, 'handle B plays to completion');
  resetSeed();
  const fresh = freshSc();
  resetSeed();
  const ref = G.vfx.move(fresh, 'PSYCHIC_M', 'p', 0); runToEnd(ref);
  eq(sig(sc), sig(fresh), 'B end state identical to a fresh standalone play');
  eq(hb.frames, 65, 'B frame count identical to standalone baseline');
  sc.cancelAnim();
  assertNeutral(sc, 'cancel after B restores neutral');

  // starting a second playAnim automatically supersedes the first
  const sc2 = freshSc();
  const h1 = sc2.playAnim('EARTHQUAKE', 'p'); h1.step(5);
  const h2 = sc2.playAnim('TACKLE', 'p');
  eq(h1.cancelled, true, 'starting a new anim cancels the previous handle');
  h2.finish();
  eq(h2.frames, 19, 'second anim keeps its own frame count');
}

// ---------------------------------------------------------------------------
console.log('A4: normal full playback matches the pre-change frame counts');
for (const [id, frames] of REPS) {
  const sc = freshSc();
  resetSeed();
  const { n } = runToEnd(G.vfx.move(sc, id, 'p', 0));
  eq(n, frames, id + ' full playback frame count');
}
{
  const sc = freshSc();
  const { n } = runToEnd(G.vfx.status(sc, 'p', 'PSN'));
  eq(n, 25, 'status PSN frame count');
}
{
  const sc = freshSc();
  const { n } = runToEnd(G.vfx.stat(sc, 'p', true));
  eq(n, 25, 'stat frame count');
}
// after a completed animation, ordinary draw frames drain fx/shake and switch flash off.
// (legacy flash decay subtracts 0.12 and can overshoot to a small negative number, which
// the renderer treats exactly like 0; cancellation itself always restores exact 0)
{
  const sc = freshSc();
  const gen = G.vfx.move(sc, 'THUNDER', 'p', 0);
  runToEnd(gen);
  for (let i = 0; i < 260; i++) sc.draw(G.gfx.screen);
  eq(sc.fx.length, 0, 'completed THUNDER fx drain away through drawing');
  eq(sc.screenFx, null, 'completed THUNDER screenFx cleared');
  eq(sc.shake, 0, 'completed THUNDER shake drains to 0');
  ok(sc.flash <= 0 && sc.flash > -0.13, 'completed THUNDER flash is off (legacy decay rest=' + sc.flash.toFixed(3) + ')');
  sc.cancelAnim();
  eq(sc.flash, 0, 'a final cancel/reset makes flash exactly 0');
  assertNeutral(sc, 'fully drained + reset scene is neutral');
}

// ---------------------------------------------------------------------------
console.log('A5: edge timing and idempotent cancellation');
{
  const sc = freshSc();
  sc.cancelAnim(); // no active animation
  assertNeutral(sc, 'cancelAnim with no animation is neutral and does not throw');
  const h = sc.playAnim('TACKLE', 'p'); h.finish();
  sc.cancelAnim(); // after normal completion
  assertNeutral(sc, 'cancel after normal completion is neutral');
  sc.cancelAnim(); sc.cancelAnim();
  assertNeutral(sc, 'repeated cancel is idempotent');
  h.cancel();
  assertNeutral(sc, 'cancelling an already-finished handle stays neutral');
}

// engine task handles cancel through the scheduler
console.log('A2: G.engine task cancellation');
{
  const sc = freshSc();
  const task = G.engine.spawn(G.vfx.move(sc, 'THUNDER', 'p', 0), 'test-anim');
  for (let i = 0; i < 4; i++) G.engine.step();
  task.cancel();
  eq(task.done, true, 'engine task marked done by cancel');
  assertNeutral(sc, 'engine task cancel restores neutral state');
  G.engine.step();
  ok(!G.engine.tasks.includes(task), 'cancelled task is removed from the scheduler');

  // engine-driven scene handle
  const sc2 = freshSc();
  const h = sc2.playAnim('BLIZZARD', 'p', 0, { engine: true });
  for (let i = 0; i < 6; i++) G.engine.step();
  sc2.cancelAnim();
  eq(h.done && h.cancelled, true, 'engine-driven handle cancelled via sc.cancelAnim');
  assertNeutral(sc2, 'engine-driven handle cancel restores neutral');
  G.engine.step();
}

// sc.anim (the ui method battle.js yields through) cancellation closes cleanly
console.log('battle ui.anim yield*-path cancellation');
{
  const sc = freshSc();
  const uiGen = sc.anim('THUNDER', { isPlayer: true }, 0);
  for (let i = 0; i < 5; i++) uiGen.next();
  ok(!!sc.activeAnimGen, 'sc tracks the active ui animation generator');
  sc.cancelAnim();
  assertNeutral(sc, 'cancel during ui.anim restores neutral');
  let finished = true;
  try { for (let i = 0; i < 200; i++) { const r = uiGen.next(); if (r.done) break; } } catch (e) { finished = false; console.error(e); }
  ok(finished, 'the suspended ui.anim generator resumes and ends normally');
  eq(sc.activeAnimGen, null, 'activeAnimGen cleared after finish');
}

// other transient BattleScene presentation generators are cancellable wholes too
console.log('A1: hitFlash/faint/ball/transform ui generators cancel neutral');
{
  const methods = [
    ['hitFlash', s => s.hitFlash({ isPlayer: false })],
    ['faint', s => s.faint({ isPlayer: false })],
    ['substitute', s => s.substitute({ isPlayer: true }, true)],
    ['transform', s => s.transform({ isPlayer: true }, 'MEW')],
    ['ballThrow', s => s.ballThrow('POKE_BALL', 2, false)],
    ['shinyBounce', s => s.shinyBounce('e')],
  ];
  for (const [name, make] of methods) {
    const sc = freshSc(); sc.show.p = sc.show.e = true;
    const g = make(sc);
    g.next(); g.next(); g.next();
    const r = g.return(undefined);
    ok(r.done === true && g.next().done === true, name + ' closes on .return() with no dangling wait');
    assertNeutral(sc, name + ' cancels to neutral');
  }
}

// cancel before the first .next() must also be safe and neutralize
{
  const sc = freshSc();
  const h = sc.playAnim('THUNDER', 'p');
  h.cancel();
  eq(h.done, true, 'zero-next handle is done after cancel');
  assertNeutral(sc, 'zero-next cancel is neutral');
}

Math.random = realRandom;
console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL TESTS PASSED') + ' — ' + checks + ' checks');
process.exit(failures ? 1 : 0);
