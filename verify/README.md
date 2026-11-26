# Audio lifecycle verification

Reproduces the mute × page-visibility × window-focus lifecycle for the
ferro-toggle page, including the bug where muting then hiding/restoring the tab
left the magnet hum or flow bed inconsistent with the muted UI state.

## Run

```bash
node verify/audio-lifecycle.mjs
# or
npm run verify
```

Requirements:

- Node.js ≥ 22 (global `WebSocket`/`fetch`; no packages are installed).
- An installed Chromium-family browser. Chrome / Edge / Chromium are discovered
  in standard install paths and in Playwright/Puppeteer caches. Override with
  `FERRO_BROWSER_BIN=/path/to/chrome node verify/audio-lifecycle.mjs`.

The script starts a throwaway static server for the repo, launches headless
Chrome with a temporary profile, and drives the real `index.html?debug` page
over the DevTools Protocol. It exits non-zero if any check fails.

## What is covered

| Check | Scenario | Acceptance |
| --- | --- | --- |
| A1 | Space turns the switch on, `m` mutes, `m` unmutes | after unmute `humG.gain` returns to ≈ 0.022 and `out.gain` to ≈ 0.85 |
| A2 | mute → `visibilitychange` hidden → visible | `out`/`humG`/`flowG` stay zero; the hum is not resurrected while muted |
| A3 | toggle visibility/blur/focus before any interaction | `Au.ctx` stays `null`, `info().audio === 'none'`, no exceptions, no context creation |
| A4 | push one-shot events into `S.events` while hidden / muted / blurred and call `flushAudio` | queue is emptied and an `AudioNode.start` spy records **zero** new voices; an open-gate control plays; events queued but never flushed are purged atomically when the gate reopens |
| A5 | `await __ferro.soundCheck([...], 2)` | numeric finite `peak`/`rms` with signal, live `AudioContext`/master restored afterwards |
| F1 | window `blur` / `focus` | blur hard-stops master, hum and flow; focus rebuilds the hum from `S.on` and flow from simulation velocity |
| X1 | whole run | no uncaught page exceptions |

Gains are asserted two ways: the logical ramp targets exposed at
`__ferro.Au.targets` (synchronous, deterministic) and the real
`AudioParam.value` after the ramps converge in headless Chrome.

## Debug surface used by the checks (`index.html?debug` only)

In addition to the pre-existing `pause / play / toggle / set / soundCheck /
focusRing / cursor / step / info` hooks, `window.__ferro` exposes the live
internals the acceptance criteria name:

- `__ferro.Au` — audio graph state (`Au.ctx`, `Au.out`, `Au.humG`, `Au.flowG`, `Au.muted`, `Au.targets`, …)
- `__ferro.S` — simulation state including `S.events`
- `__ferro.flushAudio(dt)`, `__ferro.setMuted(m)`, `__ferro.audioInit()`, `__ferro.reconcileAudio()`
- `__ferro.audioState()` — plain snapshot `{ muted, visible, focused, enabled, on, hasContext, contextState, events, targets, master, hum, flow }`
- `__ferro.simulateVisibility(bool)` / `__ferro.simulateFocus(bool)` — define the
  `document.hidden` stub where needed and dispatch the real
  `visibilitychange` / `blur` / `focus` listeners

The production (non-`?debug`) page does not install this object.
