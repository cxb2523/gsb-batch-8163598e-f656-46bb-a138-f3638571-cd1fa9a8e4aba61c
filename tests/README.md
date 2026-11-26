# Tests for the random-continuation state machine in `music.js`

Zero-dependency tests using Node's built-in test runner (`node:test`) and the
`vm` module. `harness.js` loads the real `music.js` inside a sandbox with
lightweight stubs for browser/DOM/PHP globals — the production code is
exercised as-is, nothing is imported from it in a module sense.

## Run

Node 18+ is required (no `npm install` needed):

```sh
node --test tests/music.test.js
```

If Node is installed but not on `PATH` (e.g. Windows with the default
install location), use the full path:

```sh
"C:\Program Files\nodejs\node.exe" --test tests/music.test.js
```

## What is covered

- **Scope consistency**: `played` (full library) vs. `playedFiltered`
  (filtered results) stay aligned with their candidate sets; ids are always
  strings and never duplicated.
- **Filter changes**: candidates are rebuilt and the played set pruned to the
  new scope, including narrowing to an empty result.
- **Library reload / playlist clear**: both played scopes reset, cursor
  returns to `-1`, no references to removed songs survive.
- **Item removal**: non-playing, currently-playing and last-item removal keep
  the cursor, the `playing` highlight and continuation position consistent;
  removed songs leave the played sets and become eligible again.
- **Drag reordering**: the cursor follows the same song in both directions.
- **Skipped artists**: skipped songs are never selected and are recorded as
  consumed; a fully skipped library terminates (no infinite loop).
- **Exhaustion / empty candidates**: the played set resets for one more round;
  if no eligible song remains, `getRandom()` returns `null`, `prepNext()`
  leaves the audio un-prepped and `playNext()` stops safely instead of
  throwing or looping.
- **Bounds**: `load()` rejects out-of-range indices.

Deterministic randomness comes from a seeded PRNG assigned to `Math.random`
inside the sandbox.
