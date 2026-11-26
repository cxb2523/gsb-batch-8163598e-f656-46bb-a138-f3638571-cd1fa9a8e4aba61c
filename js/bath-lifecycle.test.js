// Sound-bath lifecycle checks for js/bowls.js.
//
// A local, browser-only test sample: no audio device, no real waiting. A fake
// clock stands in for setTimeout/setInterval/Date.now/requestAnimationFrame,
// and a silent voice recorder stands in for Web Audio, so the schedule and the
// voice lifecycle can be inspected directly.
//
// How to run:
//   - add <script src="js/bath-lifecycle.test.js"></script> after js/bowls.js
//     (the page must have run initBowls first), or
//   - open the page, then paste this file into the console.
// Results are printed to the console and to a panel at the bottom of the page.
// They are also stored on window.bathLifecycleTestResult and can be re-run
// with window.bathLifecycleTests.run().
//
// The tests use window.bowlsTestHooks, the small seam at the end of bowls.js.
// That hook is installed only for a run and restored afterwards, so the
// normal page (real clock, real Web Audio) is unaffected.

(() => {
  "use strict";

  // ------------------------------------------------------------- fake clock

  // A controllable clock. advance(ms) runs every timer that comes due inside
  // the window, in order, and then moves the clock to the window's end. All
  // ids in one clock are unique and always set, so a real handle and a fake
  // handle can never be confused.
  const createClock = (start = 0) => {
    let now = start;
    let nextId = 1;
    let nextSeq = 1;
    // id -> { fn, at, period, seq }. period is 0 for a one-shot timeout and
    // the repeat interval in ms for an interval.
    const timers = new Map();

    const add = (fn, ms, isInterval) => {
      const id = nextId++;
      const delay = Math.max(0, Number(ms) || 0);
      // An interval repeats every `delay`; a timeout fires once, after delay.
      const period = isInterval ? Math.max(1, delay) : 0;
      timers.set(id, { fn, at: now + delay, period, seq: nextSeq++ });
      return id;
    };
    const clear = (id) => {
      timers.delete(id);
    };

    const clock = {
      now: () => now,
      setTimeout: (fn, ms) => add(fn, ms, 0),
      setInterval: (fn, ms) => add(fn, ms, 1),
      clearTimeout: clear,
      clearInterval: clear,
      // The page's frame loop is disabled during a run, but keep the API
      // shape so a stray call can't crash.
      requestAnimationFrame: (fn) => add(() => fn(now), 16, 0),
      cancelAnimationFrame: clear,
      advance: (ms) => {
        const target = now + Math.max(0, ms);
        let steps = 0;
        while (steps++ < 2000000) {
          let due = null;
          for (const [id, t] of timers) {
            if (t.at <= target && (!due || t.at < due.t.at || (t.at === due.t.at && t.seq < due.t.seq))) {
              due = { id, t };
            }
          }
          if (!due) break;
          now = due.t.at;
          if (due.t.period) {
            due.t.seq = nextSeq++;
            due.t.at = now + due.t.period;
          } else {
            timers.delete(due.id);
          }
          due.t.fn();
        }
        // A silent truncation would look just like "still running"; surface it
        // instead so a scheduling loop can't hide behind the guard.
        if (steps >= 2000000) throw new Error("fake clock advance exceeded its step budget (possible runaway timer)");
        now = target;
      },
      pending: () => timers.size,
      pendingTimeouts: () => [...timers.values()].filter((t) => !t.period).length,
      pendingIntervals: () => [...timers.values()].filter((t) => t.period > 0).length,
    };
    return clock;
  };

  // Deterministic pseudo-random source, so a run always schedules the same
  // bowls and gaps. (Math.random would make the tests flaky.)
  const createRandom = (seed = 0x2545f491) => {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };

  // A silent stand-in for the Web Audio backend. It records every voice made,
  // whether it was a struck or sustained ("sing") voice, and whether it was
  // released. `now()` reads the fake clock, matching what the page's visual
  // loop would use.
  const createSynth = (clock) => {
    const made = [];
    const releasedFreqs = [];
    const api = {
      ready: () => true,
      now: () => clock.now(),
      voice: (freq, opts = {}) => {
        const v = {
          freq,
          sing: !!opts.sing,
          released: false,
          release() {
            if (v.released) return;
            v.released = true;
            releasedFreqs.push(freq);
          },
        };
        made.push(v);
        return v;
      },
    };
    return {
      api,
      made,
      releasedFreqs,
      struck: () => made.filter((v) => !v.sing),
      sustained: () => made.filter((v) => v.sing && !v.released),
    };
  };

  // ------------------------------------------------------------- assertions

  const results = [];

  const makeChecker = () => {
    const failures = [];
    const expect = (ok, label, detail) => {
      if (!ok) failures.push(detail ? label + " (" + detail + ")" : label);
    };
    return { failures, expect };
  };

  // ------------------------------------------------------------- helpers

  const H = () => window.bowlsTestHooks;

  const makeHarness = (t) => {
    const clock = createClock(1000); // start at a nonzero time, like Date.now()
    const synth = createSynth(clock);
    H().install({ newClock: clock, newRandom: createRandom(), newSynth: synth.api });
    H().reset();
    return { clock, synth, expect: (ok, label, detail) => t.expect(ok, label, detail) };
  };

  const teardown = (t, saved) => {
    const h = H();
    h.reset(); // cancels fake timers while the fake clock is still installed
    h.restore();
    if (saved) {
      for (const key of ["set", "octave", "pitch", "bath", "mode"]) {
        if (saved[key] !== undefined) h.setSetting(key, saved[key]);
      }
    }
  };

  const LIVE_TIMER_LEAK = (clock, label, expect) => {
    expect(clock.pending() === 0, label + ": no timers left", "pending=" + clock.pending());
  };

  // ------------------------------------------------------------- tests

  // 1. Stopping the bath cancels every queued automatic strike -- both the
  //    main steps and the 700 ms "echo" strikes -- while manual playing keeps
  //    working and the ringing bowls fade out on their own.
  const testStopCancelsAutoStrikes = (t) => {
    const { clock, synth, expect } = makeHarness(t);
    H().resetStats();

    expect(H().startBath() === true, "bath starts");
    const started = H().state();
    expect(started.bath !== null, "bath session exists after start");
    expect(started.buttonText === "Stop sound bath", "button says stop while running", started.buttonText);

    // Let a few rounds play so there are queued strikes to lose.
    clock.advance(45000);
    const before = H().state();
    expect(before.stats.autoStrikes > 0, "automatic strikes happened", "strikes=" + before.stats.autoStrikes);
    expect(before.bathTimers > 0, "automatic strikes are queued ahead", "timers=" + before.bathTimers);

    // Stop from the button path, exactly as the page does.
    expect(H().toggleBath() === true, "toggle stops a running bath");
    const stopped = H().state();
    expect(stopped.bath === null, "no session after stop");
    expect(stopped.bathTimers === 0, "all queued auto strikes cancelled", "timers=" + stopped.bathTimers);
    expect(stopped.buttonText === "Start sound bath", "button says start after stop", stopped.buttonText);
    expect(stopped.leftText === "", "countdown cleared after stop", stopped.leftText);
    LIVE_TIMER_LEAK(clock, "after stop", expect);

    const strikesAtStop = stopped.stats.autoStrikes;
    const voicesAtStop = synth.made.length;
    const ringingAtStop = stopped.ringing;

    // Well past several would-be strike intervals. Nothing new may sound, and
    // the voice already ringing is left to decay rather than cut off.
    clock.advance(5 * 60000);
    const later = H().state();
    expect(later.stats.autoStrikes === strikesAtStop, "no new auto strike after stop", "before=" + strikesAtStop + " after=" + later.stats.autoStrikes);
    expect(synth.made.length === voicesAtStop, "no new voice created after stop", "before=" + voicesAtStop + " after=" + synth.made.length);
    expect(later.ringing <= ringingAtStop && later.ringing >= 0, "ringing voices only decay");
    LIVE_TIMER_LEAK(clock, "long after stop", expect);

    // Manual playing is independent of the bath: a strike lands, and a held
    // sing voice starts and stops, with no effect on the (already stopped) bath.
    expect(H().strike(0, 1) === true, "manual strike works after bath stop");
    expect(synth.made.length === voicesAtStop + 1, "manual strike creates its own voice");
    expect(H().state().stats.autoStrikes === strikesAtStop, "manual strike is not counted as auto");
    H().singStart(1);
    expect(H().state().voices === 1, "manual sing voice after bath stop");
    H().singStop(1);
    expect(H().state().voices === 0, "manual sing released after bath stop");
    expect(H().state().bath === null, "manual playing does not restart the bath");
  };

  // 2. The countdown reaching zero ends the bath exactly once. A manual stop
  //    racing it, or repeated stops afterwards, must not count again.
  const testCountdownStopsOnce = (t) => {
    const { clock, expect } = makeHarness(t);
    H().resetStats();

    H().setSetting("bath", 5); // 5-minute bath
    expect(H().startBath() === true, "5-minute bath starts");
    const s = H().state();
    expect(s.bath !== null && s.leftText.includes("5:00"), "countdown shows full length", s.leftText);

    // Run through the whole bath, landing a little past the end so the tick
    // that sees zero definitely fires.
    clock.advance(5 * 60000 + 5000);
    const ended = H().state();
    expect(ended.bath === null, "bath ended at zero");
    expect(ended.stats.stops === 1, "exactly one stop", "stops=" + ended.stats.stops);
    expect(ended.stats.naturalEnds === 1, "that stop was the natural end", "natural=" + ended.stats.naturalEnds);
    expect(ended.buttonText === "Start sound bath", "button reset at zero", ended.buttonText);
    expect(ended.leftText === "", "countdown cleared at zero", ended.leftText);
    expect(ended.bathTimers === 0, "no auto strikes left at natural end", "timers=" + ended.bathTimers);
    LIVE_TIMER_LEAK(clock, "at natural end", expect);

    const strikesAtEnd = ended.stats.autoStrikes;
    clock.advance(10 * 60000);
    expect(H().state().stats.stops === 1, "advancing further does not stop again");
    expect(H().state().stats.autoStrikes === strikesAtEnd, "no auto strike after natural end");

    // A user click after it ended is a no-op, not a second stop.
    expect(H().stopBath() === false, "stop after natural end does nothing");
    expect(H().state().stats.stops === 1, "still exactly one stop after late click");

    // And a manual stop before zero is counted once, with the countdown never
    // also firing a second one.
    H().resetStats();
    H().startBath();
    clock.advance(4 * 60000); // one minute before the end
    expect(H().stopBath() === true, "manual stop before zero works");
    clock.advance(2 * 60000); // run past the old end time
    const manual = H().state();
    expect(manual.stats.stops === 1, "manual stop counted once", "stops=" + manual.stats.stops);
    expect(manual.stats.naturalEnds === 0, "manual stop is not a natural end", "natural=" + manual.stats.naturalEnds);
    expect(manual.bath === null && manual.bathTimers === 0, "clean after manual stop");
    LIVE_TIMER_LEAK(clock, "after manual stop and past old end", expect);
  };

  // 3. Hammering start/stop must not leave timers, duplicate sessions, or a
  //    button/countdown out of step with the schedule.
  const testRapidToggleLeavesNothing = (t) => {
    const { clock, expect } = makeHarness(t);
    H().resetStats();

    // 20 quick on/off pairs. Each pair may also run a little time in between,
    // so some strikes are partially scheduled when stop arrives.
    for (let n = 0; n < 20; n++) {
      H().toggleBath();
      if (n % 4 === 0) clock.advance(2000);
      H().toggleBath();
      if (n % 4 === 0) clock.advance(1000);
    }
    const off = H().state();
    expect(off.bath === null, "no session after rapid toggling");
    expect(off.bathTimers === 0, "no auto-strike timers after rapid toggling", "timers=" + off.bathTimers);
    expect(off.buttonText === "Start sound bath", "button says start", off.buttonText);
    expect(off.leftText === "", "countdown clear", off.leftText);
    LIVE_TIMER_LEAK(clock, "after rapid toggling", expect);

    // Many starts with no stop in between must produce one session, one
    // countdown interval, and no stacking.
    const startsBefore = H().state().stats.starts;
    for (let n = 0; n < 6; n++) H().startBath();
    const on = H().state();
    expect(on.bath !== null, "started only once");
    expect(on.stats.starts === startsBefore + 1, "only the first start counted", "starts=" + (on.stats.starts - startsBefore));
    expect(clock.pendingIntervals() === 1, "exactly one countdown interval", "intervals=" + clock.pendingIntervals());

    clock.advance(30000);
    expect(clock.pendingIntervals() === 1, "still one countdown interval while running");

    expect(H().stopBath() === true, "one stop clears it");
    const done = H().state();
    expect(done.bath === null && done.bathTimers === 0, "all cleared after final stop");
    expect(clock.pendingTimeouts() === 0, "no timers (animation disabled)", "timeouts=" + clock.pendingTimeouts());
    expect(clock.pendingIntervals() === 0, "no countdown interval left", "intervals=" + clock.pendingIntervals());
    expect(H().stopBath() === false, "a second stop is a no-op");
  };

  // 4. Retuning while a "Sing" voice is held releases that voice at its old
  //    frequency, and the rebuilt page (bowls, spectrum, keyboard, pointer)
  //    still works.
  const testRetuneReleasesHeldVoice = (t, saved) => {
    const { clock, synth, expect } = makeHarness(t);

    expect(H().singStart(0) === true, "held voice starts");
    expect(H().state().voices === 1, "one held voice");
    const oldFreq = synth.made[0].freq;
    expect(oldFreq === H().state().bowlFreqs[0], "held voice uses the bowl's frequency");

    // Changing octave retunes everything.
    H().setSetting("octave", 5);
    const retuned = H().state();
    expect(H().state().voices === 0, "no held voice after retune", "voices=" + H().state().voices);
    expect(synth.releasedFreqs.includes(oldFreq), "old voice was released", "released=" + synth.releasedFreqs.join(","));
    expect(synth.releasedFreqs.length >= 1, "release happened through the voice, not a cut");
    expect(retuned.bowlFreqs.length === 7, "bowls rebuilt");
    expect(retuned.bowlFreqs[0] !== oldFreq, "bowls now tuned higher");
    expect(synth.sustained().length === 0, "nothing still sustained at the old pitch");

    // Released-voice bookkeeping: the released frequency must be the pre-retune
    // one, so it faded at the pitch it was made with.
    expect(synth.releasedFreqs.every((f) => Math.abs(f - oldFreq) < 1e-9), "released at the old frequency");

    // The rebuilt page: bowl buttons, the spectrum, and a new held voice.
    const btns = document.querySelectorAll(".bowl");
    expect(btns.length === 7, "seven bowl buttons after retune", "buttons=" + btns.length);
    H().drawSpectrum(true); // must not throw with no analyser
    expect(H().singStart(0) === true, "can sing a rebuilt bowl");
    const newFreq = synth.made[synth.made.length - 1].freq;
    expect(newFreq === retuned.bowlFreqs[0], "new voice uses the new tuning");
    expect(H().state().voices === 1, "new held voice is tracked");

    // Keyboard interaction after the rebuild.
    const keyDown = new KeyboardEvent("keydown", { key: "2", bubbles: true });
    document.dispatchEvent(keyDown);
    const madeAfterKey = synth.made.length;
    expect(synth.made[madeAfterKey - 1].freq === retuned.bowlFreqs[1], "keyboard strike plays the rebuilt bowl");
    const keyUp = new KeyboardEvent("keyup", { key: "2", bubbles: true });
    document.dispatchEvent(keyUp);

    // Pointer interaction after the rebuild: hold to sing, release to stop.
    // Release the earlier held voice first so the count is unambiguous.
    H().releaseAllVoices();
    expect(H().state().voices === 0, "held voices released before pointer test");
    H().setSetting("mode", "sing");
    const bowlEl = btns[2];
    let pointerOk = true;
    try {
      bowlEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 7 }));
    } catch {
      pointerOk = false;
    }
    expect(pointerOk, "pointerdown dispatch does not throw");
    expect(H().state().voices >= 1, "pointer down started a sing voice");
    try {
      bowlEl.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7 }));
    } catch {
      pointerOk = false;
    }
    expect(pointerOk, "pointerup dispatch does not throw");
    expect(H().state().voices === 0, "pointer up released the voice", "voices=" + H().state().voices);

    // Leave the page as it was.
    H().setSetting("mode", saved.mode);
  };

  // ------------------------------------------------------------- runner

  const test = (name, fn) => results.push({ name, fn });

  test("stop cancels every queued auto strike; manual play unaffected", testStopCancelsAutoStrikes);
  test("countdown zero ends the bath exactly once", testCountdownStopsOnce);
  test("rapid start/stop leaves no timers or duplicate sessions", testRapidToggleLeavesNothing);
  test("retuning releases a held voice at its old pitch and rebuilds cleanly", testRetuneReleasesHeldVoice);

  const reportLine = (ok, name, failures) =>
    (ok ? "PASS " : "FAIL ") + name + (ok ? "" : "\n       - " + failures.join("\n       - "));

  const output = (lines, summary, anyFail) => {
    try {
      console.log("%c[bath lifecycle] " + summary, anyFail ? "color:#e53935;font-weight:bold" : "color:#43a047;font-weight:bold");
      lines.forEach((l) => (anyFail || l.startsWith("FAIL") ? console.error(l) : console.log(l)));
    } catch {
      // console may be unavailable in exotic embeddings
    }
    let el = document.getElementById("bath-test-output");
    if (!el) {
      el = document.createElement("pre");
      el.id = "bath-test-output";
      el.style.cssText =
        "margin-top:18px;padding:12px;border-radius:8px;overflow:auto;max-height:40vh;" +
        "font:12px/1.5 monospace;white-space:pre-wrap;" +
        "background:#10141c;color:#e8eef7;border:1px solid " + (anyFail ? "#e53935" : "#43a047");
      (document.body || document.documentElement).appendChild(el);
    }
    el.style.borderColor = anyFail ? "#e53935" : "#43a047";
    el.textContent = "[bath lifecycle] " + summary + "\n\n" + lines.join("\n");
  };

  const run = () => {
    const hooks = window.bowlsTestHooks;
    if (!hooks) {
      const msg = "FAIL window.bowlsTestHooks missing: load js/bowls.js on this page before this test file.";
      output([msg], "0 passed, 1 failed", true);
      window.bathLifecycleTestResult = { passed: 0, failed: 1, results: [{ name: "hooks available", failures: [msg] }] };
      return window.bathLifecycleTestResult;
    }

    // If the page hasn't initialised yet (e.g. the file was included in the
    // head), build the bowl list now so state.bowls is meaningful.
    if (hooks.state().bowls === 0) {
      hooks.buildBowls();
      hooks.renderBowls();
    }

    const saved = { ...hooks.state().settings };
    const lines = [];
    const report = [];
    let passed = 0;
    let failed = 0;

    for (const { name, fn } of results) {
      const t = makeChecker();
      try {
        fn(t, saved);
        if (t.failures.length) throw new Error(t.failures.join("; "));
      } catch (err) {
        t.failures.push(String(err && err.message ? err.message : err));
      } finally {
        try {
          teardown(t, saved);
        } catch (err) {
          t.failures.push("teardown: " + (err && err.message ? err.message : err));
        }
      }
      const ok = t.failures.length === 0;
      if (ok) passed++;
      else failed++;
      report.push({ name, failures: ok ? [] : t.failures });
      lines.push(reportLine(ok, name, ok ? [] : t.failures));
    }

    const summary = passed + " passed, " + failed + " failed, " + results.length + " tests";
    const anyFail = failed > 0;
    output(lines, summary, anyFail);
    window.bathLifecycleTestResult = { passed, failed, results: report };
    return window.bathLifecycleTestResult;
  };

  window.bathLifecycleTests = { run };

  // Auto-run once the page is ready. The keyboard and pointer checks need the
  // page's own listeners, which only exist after initBowls(); body onload runs
  // that, so wait for the hooks to say they are up (with a short cap) rather
  // than guessing at a delay.
  const autoRun = () => {
    let tries = 0;
    const tick = () => {
      const hooks = window.bowlsTestHooks;
      if (hooks && hooks.isInitialized && hooks.isInitialized()) {
        run();
      } else if (++tries < 200) {
        setTimeout(tick, 10);
      } else {
        run(); // report whatever is possible rather than stay silent
      }
    };
    tick();
  };
  if (document.readyState === "complete") autoRun();
  else window.addEventListener("load", autoRun, { once: true });
})();
