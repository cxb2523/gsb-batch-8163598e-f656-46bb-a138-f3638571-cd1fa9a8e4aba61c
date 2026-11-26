# Movement ledger tests

Local, dependency-free verification for the march / instant-reinforcement /
order accounting in `src/game.js`. No browser is needed: the game runs inside a
Node `vm` sandbox against a tiny deterministic world (`mini-data.js`) with stubbed
DOM and canvas (`dom-stub.js`).

## Run

```sh
node tests/run.js
```

(or `npm test` from this folder). Node 18+ is enough; there are no npm
dependencies to install.

## What is covered

`scenarios.js` drives the real game functions and asserts the single-ledger
rule at every step:

> available(i) = garrison(i) − every unsettled claim on i, never negative.

1. **Normal march** — one deduction per turn, one province per hop, nothing
   after arrival, total soldiers conserved.
2. **Two-phase war turn** — `updateMarches()` is idempotent when called twice
   per turn, so a force is never deducted twice or skipped.
3. **Instant reinforcement** — only into an adjacent, genuinely front-line
   province; it can never spend soldiers already reserved by a march or order;
   it still works in the enemy phase.
4. **Cancellation** — cancelling a march removes its pending order, releases
   the reserved men and refunds the action point exactly once; free
   continuation hops are not refunded.
5. **Save / load round-trip** — marches, orders, phase and reservations match
   the pre-save state; legacy/corrupt saves (orphan hop orders, dead-nation
   orders, stale `sent` flags) are normalized without inventing soldiers.
6. **Enemy phase (phase 1)** — cross-border marches/attacks are refused by the
   core; same-realm marches and front reinforcement still work; the attack
   becomes legal again at the next End move.
7. **Gather all armies** — adjacent front armies reinforce instantly, the rest
   march, and no soldiers are duplicated or lost.
8. **24-turn stress** — interleaved marches, gathers and cancellations keep
   the ledger exact with no negative garrisons.
9. **Shared-province pool** — two marches from one province can never reserve
   more men than it holds.
10. **Regressions** — march vs. instant-reinforcement overlap, a zero-man hop
    that must be retried rather than doubled, and an orphan order on load.
11. **UI click path** — `clickProv` enforces the same phase and availability
    rules as the core.

## Files

| File | Role |
| --- | --- |
| `run.js` | Entry point. |
| `harness.js` | Loads `src/game.js` in a vm sandbox and provides assertions. |
| `dom-stub.js` | Minimal `window`/`document`/canvas/localStorage stubs. |
| `mini-data.js` | The eight-province, two-country deterministic test world. |
| `scenarios.js` | The scenarios above. |
