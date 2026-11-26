# Synthesizer deletion verification

Local verification samples for the instrument-deletion chain. They cover:

- deleting a **middle** instrument (layer indexes remapped or nulled out)
- deleting the **first** instrument (all later indexes shift down)
- deleting an instrument referenced by **multiple patterns and song sections**
- rejecting the deletion of the **last** instrument
- `sends` alignment: the removed instrument's send is dropped, the other
  sends keep their own effect slot, stale/out-of-range sends are cleaned,
  and effect slots are never rewired to another instrument
- `synthFill` collision table rebuilt with the new instrument count
- **song length recalculation** and **conflict detection** after deletion
- destroyed audio nodes leaving **no residual connections**

## Files

| File | Purpose |
| --- | --- |
| `delete-synth-tests.js` | Shared scenario definitions, run in both environments |
| `run-delete-synth-tests.js` | Node runner with a recording Tone.js stub |
| `delete-synth-tests.html` | Browser runner using the real Tone.js engine |
| `console-live-checks.js` | Snippet to paste into the console of the running app |

## Run in Node (headless, no browser needed)

From the repository root:

```sh
node tests/run-delete-synth-tests.js
```

The Node runner loads the real application sources in a VM context with a
lightweight Tone.js stub. The stub records every audio node, its connections
and its disposal, so the "no residual connections after deletion" assertion is
verified deterministically. A non-zero exit code is returned on any failure.

## Run in a browser (real Web Audio engine)

Serve the repository root with any static server, for example:

```sh
npx serve .
```

then open `tests/delete-synth-tests.html` and press **Run verification
scenarios**. The same scenarios run against the real `Tone` engine (the
audio-node registry assertion is Node-only and is skipped here).

## Run against the live application from the console

1. Open `index.html` and create or load a song.
2. Open the browser developer console.
3. Paste the contents of `console-live-checks.js` and run
   `runLiveDeleteSynthChecks()`.

The snippet mutates the live `songObject` (exposed as `window.songObject`),
prints PASS/FAIL lines, and restores the original instruments, sends and
pattern-layer assignments before returning.
