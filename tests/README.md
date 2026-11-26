# Qwerty Hancock tests

These tests verify that **each note produces exactly one press and one
release, regardless of how the input sources (mouse, physical keyboard,
touch) are interleaved**, and that the JZZ MIDI port emits exactly one
Note On (`0x90`) and one Note Off (`0x80`) per note.

## What is covered

- Mouse and keyboard pressing the **same note** → one `keyDown`; the note
  ends only after **both** sources release → one `keyUp`.
- Keyboard-first then mouse, and mouse-first then keyboard (both orders).
- Mouse pressed and **dragged out of the key** while the button is held;
  releasing the button outside the keyboard leaves no lit key.
- Glissando (drag across keys while holding the button).
- Physical-key **auto-repeat** (`keydown` firing continuously) and spurious
  `keyup` with no matching `keydown`.
- Two physical keys mapped to the same note (`Y`/`Z` → `G#`).
- **Two keyboard instances on one page** keep fully independent state.
- Touch: single touch, duplicate `touchstart`, `touchcancel`, multitouch and
  a dragged finger (`touchmove`).
- `destroy()`: releases held notes, restores key colours, removes the
  generated DOM and removes every `window`/`document` listener.
- JZZ port: one Note On / one Note Off per note, balancing Note Off when the
  port is closed while a note is held, silence after close, and no leftover
  listeners when opening fails or when the port is closed.

## Running

### Automated (Node + jsdom)

```sh
npm test
# or: node tests/run-node.js
```

The runner loads the real, unmodified browser scripts
(`node_modules/jzz/javascript/JZZ.js`, `javascript/qwerty-hancock.js`,
`javascript/JZZ.input.Qwerty.js`) inside a jsdom window and drives them with
synthetic DOM events — the same code paths as the page.

### In a real browser

Open `tests/qwerty-test.html` (it runs automatically on load, or press
**Run tests**). The page renders PASS/FAIL/SKIP per check and exposes the
result array on `window.__testResults`.

Headless example (touch events need the extra flag in headless Chrome):

```sh
chrome --headless=new --touch-events --virtual-time-budget=10000 \
       --dump-dom tests/qwerty-test.html
```

When the browser does not support touch events, the touch checks are
reported as **SKIP** rather than failures.

### Manual interaction

`html/qwerty.html` contains two independent keyboards
(`JZZ.input.Qwerty(...)` and `JZZ.input.Qwerty.register(...)`). Open it and
try overlapping mouse/keyboard presses on the same key; each key should
light once and return to its original colour once, and no key should stay
lit after every input source has been released.

## Layout

| File | Role |
| --- | --- |
| `scenarios.js` | Shared scenarios; environment-agnostic, runs in jsdom and the browser |
| `run-node.js`  | Node + jsdom runner (`npm test`) |
| `qwerty-test.html` | Browser runner for the same scenarios |
