'use strict';
// Local verification for the single-ledger movement model:
//   available(i) == garrison(i) - unsettled claims on i
// Covers normal marches, instant reinforcement, cancellation, save round-trip,
// the two-part war turn and enemy-phase cross-border rejection.
const { loadGame, check, eq, report } = require('./harness');

const A = 0, B = 1;             // country ids
const P0 = 0, P1 = 1, P2 = 2, P3 = 3, P4 = 4, P5 = 5, P6 = 6, P7 = 7;
const h = loadGame();

function freshGame() {
  h.newGame(A);
  const G = h.G;
  h.UI.picking = false; h.UI.busy = false; h.UI.sel = -1; h.UI.move = null;
  for (let i = 0; i < 8; i++) { G.army[i] = 0; G.pend[i] = 0; G.recd[i] = 0; G.fleet[i] = 0; G.pendF[i] = 0; }
  G.gold[A] = 10000; G.gold[B] = 0;     // rich player, broke enemy: the AI cannot recruit
  G.mp = h.maxMP(A);
  return G;
}
const playerProvinces = G => { const out = []; for (let i = 0; i < 8; i++) if (G.owner[i] === A) out.push(i); return out; };
const playerArmy = G => playerProvinces(G).reduce((s, i) => s + G.army[i], 0);
const ledgerHolds = G => playerProvinces(G).every(i => h.availAt(i) >= 0 && h.availAt(i) === G.army[i] - h.reservedAt(i));
const noNegatives = G => { for (let i = 0; i < 8; i++) if (G.army[i] < 0) return false; return true; };

// ============================================================ 1. normal march
console.log('1. Normal march: one deduction per turn, none after arrival');
{
  const G = freshGame();
  G.army[P0] = 1000; G.army[P1] = 500; G.army[P5] = 600;
  const total = playerArmy(G);
  const path = h.pathTo(P0, P5, A);
  eq(path.join(','), [P0, P1, P5].join(','), 'shortest route 0->1->5');
  eq(h.startMarch(P0, P5, 400, path), true, 'march started');
  eq(G.marches.length, 1, 'one march booked');
  eq(h.availAt(P0), 600, '400 reserved at the source immediately');
  eq(h.reservedAt(P0), 400, 'reservation equals the march claim');
  eq(G.army[P0], 1000, 'garrison itself is untouched until resolution');

  h.endTurn();   // peace time: one press resolves, reconciles and replans the next hop
  eq(G.turn, 2, 'turn advanced');
  eq(G.army[P0], 600, 'first hop deducted the source exactly once');
  eq(G.army[P1], 900, 'first hop arrived at the waypoint');
  eq(G.marches[0].at, P1, 'march advanced to the waypoint');
  eq(G.orders.length, 1, 'next hop order planned for the following turn');
  eq(h.availAt(P1), 500, 'the 400 waiting at the waypoint stay reserved (900-400)');
  check(ledgerHolds(G), 'ledger holds after hop 1');

  h.endTurn();
  eq(G.marches.length, 0, 'march removed on arrival');
  eq(G.orders.length, 0, 'no leftover orders after arrival');
  eq(G.army[P5], 1000, 'all 400 reached the destination (600+400)');
  eq(playerArmy(G), total, 'no soldiers created or destroyed by marching');
  check(noNegatives(G), 'no negative garrisons');
  check(ledgerHolds(G), 'ledger holds after arrival');
}

// ============================================== 2. updateMarches called twice
console.log('2. updateMarches is safe to run twice per war turn');
{
  const G = freshGame();
  G.army[P0] = 1000; G.army[P1] = 500; G.army[P5] = 600;
  h.declareWar(A, B);
  const total = playerArmy(G);
  h.startMarch(P0, P5, 400, h.pathTo(P0, P5, A));
  h.endTurn();                       // End move: resolveMoves + updateMarches, phase -> 1
  eq(G.phase, 1, 'war turn enters the enemy phase');
  eq(G.army[P0], 600, 'source deducted once at End move');
  eq(G.marches[0].at, P1, 'march sits at the waypoint during the enemy phase');
  const snapshot = JSON.stringify(G.marches);
  h.updateMarches(); h.updateMarches();   // extra reconciliations must be no-ops
  eq(JSON.stringify(G.marches), snapshot, 'repeated updateMarches changes nothing');
  eq(G.army[P1], 900, 'waypoint garrison not touched again');
  h.endTurn();                       // Enemy moves: AI answers, then planMarches
  eq(G.phase, 0, 'back to the player phase');
  eq(G.turn, 2, 'full war turn completed');
  check(playerArmy(G) <= total, 'war never invents soldiers for the player');
  check(noNegatives(G), 'no negative garrisons through both phases');
  check(ledgerHolds(G), 'ledger holds across the two-phase turn');
}

// ====================================== 3. instant reinforcement accounting
console.log('3. Instant reinforcement only reaches a genuine adjacent front province and respects reservations');
{
  const G = freshGame();
  G.army[P4] = 1000; G.army[P5] = 600; G.army[P1] = 500; G.army[P0] = 400;
  h.declareWar(A, B);
  eq(h.isFront(P5), true, 'province 5 is front line (borders B at 6)');
  eq(h.isFront(P4), false, 'province 4 is inland');
  eq(h.instantOK(P4, P5), true, '4->5 is an adjacent front reinforcement');
  eq(h.instantOK(P4, P1), false, '4->1 does not reach a front province');
  eq(h.instantOK(P0, P5), false, '0 and 5 are not adjacent');

  // first claim 300 of province 4 with a march; they must not be reusable
  h.startMarch(P4, P1, 300, h.pathTo(P4, P1, A));
  eq(h.availAt(P4), 700, 'march reserves 300 of the 1000 in province 4');
  const moved = h.instantMove(P4, P5, 1000);
  eq(moved, true, 'instant reinforcement accepted');
  eq(G.army[P4], 300, 'only the 700 free soldiers could move (1000-700 left = the reserved 300)');
  eq(G.army[P5], 1300, '700 arrived at the front at once');
  eq(h.availAt(P4), 0, 'nothing free remains in province 4');
  check(ledgerHolds(G), 'ledger holds after instant reinforcement');

  // it still works during the enemy phase, but only inside our own land
  G.phase = 1;
  eq(h.instantOK(P1, P5), true, '1->5 reinforcement remains legal in phase 1');
  eq(h.instantMove(P1, P5, 200), true, 'reinforcement happens in the enemy phase');
  eq(G.army[P1], 300, '200 left province 1');
  eq(G.army[P5], 1500, 'front grew to 1500');
  check(noNegatives(G), 'no negative garrisons');
}

// ========================== 4. cancelling marches and orders refunds actions
console.log('4. Cancellation clears pending orders, releases the claim and gives the action point back once');
{
  const G = freshGame();
  G.army[P0] = 1000; G.army[P1] = 500; G.army[P5] = 600;
  const mp0 = G.mp;
  h.startMarch(P0, P5, 400, h.pathTo(P0, P5, A));   // paid first hop
  eq(G.mp, mp0 - 1, 'the initial march costs one action');
  eq(h.availAt(P0), 600, 'source has 600 free while the march is pending');
  const id = G.marches[0].id;
  h.cancelMarch(id);
  eq(G.marches.length, 0, 'march removed');
  eq(G.orders.length, 0, 'its pending order removed as well');
  eq(G.mp, mp0, 'action point refunded');
  eq(h.availAt(P0), 1000, 'the claim is released: all 1000 are free again');
  check(ledgerHolds(G), 'ledger holds after cancelling the march');

  // a plain (one-hop) move cancelled through its order
  const mp1 = G.mp;
  h.startMarch(P0, P1, 200, [P0, P1]);
  eq(G.orders.length, 1, 'one-hop move is a plain order');
  eq(G.marches.length, 0, 'one-hop move creates no march record');
  h.cancelOrder(0);
  eq(G.orders.length, 0, 'plain order removed');
  eq(G.mp, mp1, 'plain order action refunded');
  eq(h.availAt(P0), 1000, 'soldiers free again');

  // cancelling an already-hop march (free hop) must NOT refund an action
  h.startMarch(P0, P5, 400, h.pathTo(P0, P5, A));
  h.resolveMoves(); h.updateMarches(); h.planMarches();
  eq(G.marches.length, 1, 'march continues past the first hop');
  const mp2 = G.mp;
  h.cancelMarch(G.marches[0].id);
  eq(G.mp, mp2, 'no refund for a free continuation hop');
  eq(G.orders.length, 0, 'continuation order cleared');
  check(ledgerHolds(G), 'ledger holds after late cancellation');
}

// ====================================== 5. save / load round-trip fidelity
console.log('5. Save then load restores marches, orders, reservations and phase');
{
  const G = freshGame();
  G.army[P0] = 1000; G.army[P1] = 500; G.army[P5] = 600;
  h.declareWar(A, B);
  h.startMarch(P0, P5, 400, h.pathTo(P0, P5, A));
  h.endTurn();                          // End move -> enemy phase, march at P1, no live order yet
  eq(G.phase, 1, 'saved mid war turn');
  eq(G.marches[0].at, P1, 'march rests at the waypoint');
  const snap = h.serialize();
  const ok = h.restore(JSON.parse(JSON.stringify(snap)), G.slot);
  eq(ok, true, 'save object accepted');
  const G2 = h.G;
  eq(G2.phase, 1, 'phase restored');
  eq(G2.turn, G.turn, 'turn restored');
  eq(G2.marches.length, 1, 'march restored');
  eq(G2.marches[0].at, P1, 'march position restored');
  eq(G2.marches[0].n, 400, 'march strength restored');
  eq(h.availAt(P1), G2.army[P1] - 400, 'the restored march still reserves its men');
  check(noNegatives(G2), 'no negatives after load');
  check(ledgerHolds(G2), 'ledger holds immediately after load');
  h.endTurn();                          // Enemy moves can continue from the loaded state
  check(noNegatives(h.G), 'no negatives after continuing a loaded game');
  check(ledgerHolds(h.G), 'ledger holds after continuing a loaded game');

  // corrupt/legacy input must be normalized, not crash or invent soldiers
  const legacy = JSON.parse(JSON.stringify(snap));
  legacy.marches[0].sent = true;        // old field, should be ignored
  legacy.orders.push({ c: A, from: P0, to: P1, n: 250, m: 99999 });   // orphan hop order
  legacy.orders.push({ c: 77, from: P2, to: P3, n: 100 });            // dead nation order
  h.restore(legacy, G.slot);
  const G3 = h.G;
  check(!G3.orders.some(o => o.m === 99999 || o.c === 77), 'orphan and dead-nation orders dropped on load');
  check(!('sent' in G3.marches[0]), 'stale sent flag removed');
  check(noNegatives(G3) && ledgerHolds(G3), 'ledger sound after normalizing a legacy save');
}

// ====================== 6. enemy phase: cross-border marches are refused
console.log('6. In phase 1 ordinary marches stay inside the realm; attacks wait for End move');
{
  const G = freshGame();
  G.army[P1] = 1000; G.army[P5] = 600; G.army[P0] = 400;
  h.declareWar(A, B);
  G.phase = 1;
  // a march aimed at enemy province 2 (reachable in war through 1->2)
  const hostilePath = h.pathTo(P1, P2, A);
  eq(Array.isArray(hostilePath), true, 'a wartime route into enemy land exists in phase 0');
  eq(h.startMarch(P1, P2, 500, hostilePath), false, 'core rejects a cross-border march in phase 1');
  eq(G.orders.length, 0, 'no order booked for the rejected march');
  eq(G.marches.length, 0, 'no march booked for the rejected march');
  eq(h.availAt(P1), 1000, 'rejected march reserved nothing');

  // a same-realm march still goes through, on an own-land-only route
  const ownPath = h.ownPath(P0, P5);
  eq(Array.isArray(ownPath), true, 'an own-land route exists');
  check(ownPath.every(i => G.owner[i] === A), 'the phase-1 route never leaves the realm');
  eq(h.startMarch(P0, P5, 200, ownPath, true), true, 'internal march accepted in phase 1');
  eq(G.orders.length, 1, 'internal march booked');
  check(ledgerHolds(G), 'ledger holds in the enemy phase');

  // back in phase 0 the very same cross-border march is allowed (it will attack)
  G.phase = 0;
  eq(h.startMarch(P1, P2, 500, h.pathTo(P1, P2, A)), true, 'cross-border march accepted once the player phase returns');
  eq(G.marches.length >= 1, true, 'attacking march registered for the next End move');
}

// ====================================== 7. gather: instant front, marches rest
console.log('7. Gather all armies uses instant reinforcement on the front and reservations everywhere else');
{
  const G = freshGame();
  G.army[P4] = 800; G.army[P0] = 700; G.army[P1] = 300; G.army[P5] = 200;
  h.declareWar(A, B);
  const before = playerArmy(G);
  const r = h.gatherAll(P5);           // 4 and 1 both neighbour the front province 5; 0 marches
  check(r.cnt >= 1, 'gather found armies to send');
  eq(G.army[P4], 0, 'the adjacent inland army reinforced the front at once');
  eq(G.army[P1], 0, 'the other adjacent army reinforced the front at once too');
  eq(G.army[P5], 1300, 'front holds 200 + 800 + 300 instant reinforcements');
  check(ledgerHolds(G), 'ledger holds right after gather');
  eq(playerArmy(G), before, 'gather neither creates nor loses soldiers');
  for (let t = 0; t < 6; t++) { h.endTurn(); if (G.over) break; }
  check(noNegatives(G), 'no negatives after the gathered marches play out');
  check(ledgerHolds(G), 'ledger holds after the gathered marches play out');
}

// ========================== 8. long randomized stress run: ledger invariant
console.log('8. Stress: many turns of marches, gathers, cancels and war keep the ledger exact');
{
  const G = freshGame();
  G.army[P0] = 2000; G.army[P1] = 1500; G.army[P4] = 1200; G.army[P5] = 900;
  h.declareWar(A, B);
  const owned = [P0, P1, P4, P5];
  let problems = 0;
  for (let t = 0; t < 24; t++) {
    // issue a couple of marches / instant moves / cancellations each turn
    for (let k = 0; k < 3; k++) {
      const src = owned[(t + k) % owned.length];
      if (h.availAt(src) < 100) continue;
      const dest = owned[(k + t + 1) % owned.length];
      if (dest === src) continue;
      const path = G.phase === 1 ? h.ownPath(src, dest) : h.pathTo(src, dest, A);
      if (path) h.startMarch(src, dest, Math.min(300, h.availAt(src)), path, k === 0);
      if (G.marches.length && (t + k) % 4 === 0) h.cancelMarch(G.marches[0].id);
      if (G.orders.length && (t + k) % 5 === 0) h.cancelOrder(G.orders.length - 1);
    }
    h.endTurn();
    if (!noNegatives(G)) { problems++; console.error('  negative garrison on turn', t); }
    if (!ledgerHolds(G)) { problems++; console.error('  ledger broken on turn', t); }
    // the AI may legitimately recruit, so here we only assert the movement
    // ledger itself: every reserved man exists as a garrison or a live order
    const over = playerProvinces(G).filter(i => h.reservedAt(i) > G.army[i]).length;
    if (over) { problems++; console.error('  reservations exceed garrison on turn', t); }
  }
  eq(problems, 0, '24 stress turns kept the ledger exact with no negatives');
  // final exhaustive check over every province and every claim
  let claims = 0;
  for (const i of playerProvinces(G)) {
    check(h.availAt(i) >= 0, 'final availAt non-negative at ' + i);
    claims += h.reservedAt(i);
  }
  check(claims >= 0, 'all reservations non-negative');
}

// ========================== 9. multiple marches share one province pool
console.log('9. Two marches from one province can never reserve more men than it holds');
{
  const G = freshGame();
  G.army[P0] = 1000; G.army[P1] = 200; G.army[P5] = 200;
  h.startMarch(P0, P1, 600, h.pathTo(P0, P1, A));
  eq(h.availAt(P0), 400, 'first march leaves 400 free');
  const ok = h.startMarch(P0, P5, 400, h.pathTo(P0, P5, A));
  eq(ok, true, 'second march takes the remaining 400');
  eq(h.availAt(P0), 0, 'nothing free left in the shared province');
  eq(h.startMarch(P0, P5, 100, h.pathTo(P0, P5, A)), false, 'a third claim is refused, not allowed to go negative');
  h.resolveMoves(); h.updateMarches(); h.planMarches();
  check(noNegatives(G), 'pooled marches resolve without negatives');
  check(ledgerHolds(G), 'pooled marches keep the ledger exact');
}

// ================================== 10. regressions from the original bug list
console.log('10. Regression: the specific double-count / phantom-soldier paths');
{
  // 10a. a waiting march and an instant reinforcement from the same province never overlap
  const G = freshGame();
  G.army[P4] = 1000; G.army[P5] = 400;
  h.declareWar(A, B);
  h.startMarch(P4, P0, 300, h.ownPath(P4, P0), true);   // 300 locked into a march
  eq(h.availAt(P4), 700, 'only 700 are free beside the waiting march');
  h.instantMove(P4, P5, 1000);                            // asks for more than free
  eq(G.army[P4], 300, 'instant move cannot touch the 300 reserved men');
  eq(G.army[P5], 1100, 'exactly the 700 free men reinforced the front');
  h.resolveMoves(); h.updateMarches();
  eq(G.army[P4], 0, 'the reserved 300 then leave with their march, nothing duplicated');
  check(noNegatives(G) && ledgerHolds(G), 'no overlap between march and instant reinforcement');

  // 10b. a hop order that resolves to zero men leaves the march claim intact (no phantom loss/gain)
  const G2 = freshGame();
  G2.army[P0] = 400; G2.army[P1] = 100; G2.army[P5] = 100;
  h.startMarch(P0, P5, 400, h.pathTo(P0, P5, A));
  eq(h.availAt(P0), 0, 'the whole garrison is claimed by the march');
  G2.army[P0] = 0;                                     // garrison wiped before resolution
  h.resolveMoves(); h.updateMarches();
  check(noNegatives(G2), 'a zero-man hop cannot create a negative garrison');
  eq(G2.marches.length, 1, 'the march survives its skipped hop');
  eq(G2.marches[0].n, 400, 'its claim is remembered for a retry, not doubled or lost');
  G2.army[P0] = 400;                                   // men return next turn
  h.planMarches();
  eq(G2.orders.length, 1, 'the skipped march is re-planned once, not twice');
  check(ledgerHolds(G2), 're-planned march keeps the ledger exact');

  // 10c. a saved game whose orders reference a deleted march loads cleanly
  const G3 = freshGame();
  G3.army[P0] = 1000; G3.army[P1] = 500; G3.army[P5] = 500;
  h.startMarch(P0, P5, 400, h.pathTo(P0, P5, A));
  const s = h.serialize();
  s.marches = [];                                      // march dropped, orphan order left behind
  h.restore(s, G3.slot);
  eq(h.G.orders.length, 0, 'orphan hop order removed on load');
  check(ledgerHolds(h.G) && noNegatives(h.G), 'load with an orphan order stays sound');
}

// ====================================== 11. UI click path honours the same rules
console.log('11. The map click path (clickProv) enforces phase and availability too');
{
  const G = freshGame();
  G.army[P1] = 1000; G.army[P5] = 500; G.army[P0] = 300;
  h.declareWar(A, B);
  // phase 0: clicking the enemy neighbour P2 from front P1 prepares an attack
  h.UI.sel = P1; h.UI.move = null;
  h.clickProv(P2);
  check(h.UI.move && h.UI.move.to === P2, 'phase 0 click on an enemy neighbour prepares an attack');
  h.UI.move = null;
  // phase 1: the same click must not prepare a cross-border attack
  G.phase = 1;
  h.UI.sel = P1;
  h.clickProv(P2);
  check(!h.UI.move || h.UI.move.to !== P2, 'phase 1 click cannot prepare a cross-border attack');
  // phase 1: clicking an own neighbour still works for internal moves
  h.UI.sel = P0;
  h.clickProv(P4);
  check(h.UI.move && h.UI.move.to === P4, 'phase 1 click on an own neighbour prepares an internal move');
  check(noNegatives(G) && ledgerHolds(G), 'UI path keeps the ledger sound');
}

report();
