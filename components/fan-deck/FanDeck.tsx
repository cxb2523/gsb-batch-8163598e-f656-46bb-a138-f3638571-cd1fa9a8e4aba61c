"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DialRoot, useDialKit } from "dialkit";
import "dialkit/styles.css";
import styles from "./FanDeck.module.css";
import { cardAt, createHaptics, isContact, subscribeSwitch, wantsSwitch } from "./haptic";
import { VOICINGS, hush, schedule } from "./sound";
import type { Gesture, Voice, Voicing } from "./sound";

/* Where the source lives. The page is the live demo; the deck itself is the
   open-source part. */
const REPO = "https://github.com/wieandteduard/interactive-fan-deck";
const REPO_API = REPO.replace("https://github.com/", "https://api.github.com/repos/");

/* The star count only appears once there is one worth showing. */
const STARS_WORTH_SHOWING = 50;

/* Unauthenticated GitHub allows sixty requests an hour per address, so the
   count is kept for an hour in this tab and never fetched more often. Any
   failure — no repo yet, rate limit, offline — just means no count. */
async function fetchStars(): Promise<number | null> {
  const key = "fan-deck:stars";
  try {
    const cached = sessionStorage.getItem(key);
    if (cached) {
      const { n, at } = JSON.parse(cached) as { n: number; at: number };
      if (Date.now() - at < 3_600_000) return n;
    }
  } catch {
    /* storage unavailable: fall through to the network */
  }
  try {
    const res = await fetch(REPO_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: number };
    const n = data.stargazers_count;
    if (typeof n !== "number") return null;
    try {
      sessionStorage.setItem(key, JSON.stringify({ n, at: Date.now() }));
    } catch {
      /* fine */
    }
    return n;
  } catch {
    return null;
  }
}

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/* Blade proportions, measured off the Figma sheet (node 3222:4574) at 1:1 —
   blade 1002 × 231, corner radius 32, rivet hole ⌀30 whose centre sits 24 in
   from both edges of the corner it lives in. Everything is kept as a fraction
   of the blade width so the whole fan scales off one length. */
const HINGES = ["bottom-right", "bottom-left", "top-right", "top-left"] as const;
type Hinge = (typeof HINGES)[number];

/* The stock. Subway is the MTA's yellow — the N/Q/R/W — run down through amber
   and ochre into a dark umber, the way a single warm chip page of a deck
   reads. Blue is one hue held around 212 degrees, a stone blue off the cyan
   edge. Spectrum walks the wheel the way a full deck does; each step is a
   colour paper could plausibly be printed on rather than a raw HSL sample, so
   the lightness stays even across the sweep. */
const PALETTES = {
  subway: [
    [252, 204, 10],
    [246, 184, 14],
    [236, 162, 20],
    [222, 140, 26],
    [205, 118, 30],
    [186, 98, 32],
    [165, 82, 34],
    [142, 68, 34],
    [118, 56, 32],
    [94, 45, 28],
    [70, 35, 22],
    [48, 26, 16],
  ],
  blue: [
    [125, 170, 224],
    [96, 148, 218],
    [70, 128, 213],
    [48, 110, 205],
    [30, 94, 192],
    [22, 81, 175],
    [20, 70, 157],
    [20, 61, 139],
    [19, 52, 121],
    [18, 44, 103],
    [16, 36, 85],
    [14, 29, 68],
  ],
  spectrum: [
    [240, 196, 25],
    [242, 168, 28],
    [238, 132, 32],
    [229, 95, 39],
    [218, 59, 52],
    [203, 43, 84],
    [179, 44, 119],
    [142, 49, 149],
    [94, 60, 164],
    [51, 80, 159],
    [28, 116, 190],
    [24, 152, 180],
    [34, 169, 142],
    [69, 172, 91],
    [127, 183, 51],
    [184, 190, 34],
  ],
} as const;

type Palette = keyof typeof PALETTES | "drift";
const PALETTE_NAMES: Palette[] = ["drift", ...(Object.keys(PALETTES) as (keyof typeof PALETTES)[])];

/* The drifting deck: one ramp of lightness and chroma, in OKLCH, whose hue
   turns continuously. Lightness runs from a light tint down to a deep one and
   chroma peaks in the middle, so at any hue it reads as the same deck in a
   different stock — dark blue now, dark red in a while. */
const DRIFT_L = [0.8, 0.74, 0.68, 0.62, 0.56, 0.5, 0.45, 0.4, 0.35, 0.3, 0.26, 0.22];
const DRIFT_C = [0.1, 0.12, 0.135, 0.145, 0.15, 0.15, 0.145, 0.135, 0.12, 0.105, 0.09, 0.075];

/* OKLCH → sRGB, clipped. Standard matrices (Björn Ottosson). */
function oklch(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const sv = s_ * s_ * s_;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * sv,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * sv,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * sv,
  ];
  return lin.map((v) => {
    const c = Math.max(0, Math.min(1, v));
    const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(srgb * 255);
  }) as [number, number, number];
}

const lerp = (xs: readonly number[], t: number) => {
  const pos = t * (xs.length - 1);
  const i = Math.min(Math.floor(pos), xs.length - 2);
  return xs[i] + (xs[i + 1] - xs[i]) * (pos - i);
};

function tint(t: number, palette: Palette, hue: number) {
  let r: number, g: number, b: number;
  if (palette === "drift") {
    /* A few degrees of spread down the ramp keeps the deck from reading as
       one flat colour in twelve values. */
    [r, g, b] = oklch(lerp(DRIFT_L, t), lerp(DRIFT_C, t), hue + t * 14);
  } else {
    const ramp = PALETTES[palette];
    const pos = t * (ramp.length - 1);
    const i = Math.min(Math.floor(pos), ramp.length - 2);
    const f = pos - i;
    [r, g, b] = ramp[i].map((c, k) =>
      Math.round(c + (ramp[i + 1][k] - c) * f)
    ) as [number, number, number];
  }
  const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  return {
    rgb: [r, g, b] as const,
    colour: `rgb(${r} ${g} ${b})`,
    hex: hex.toUpperCase(),
    lum: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255,
  };
}

/* The easings the motion panel offers, mapped onto the site's own curves. */
const EASINGS = {
  quint: "var(--ease-out-quint)",
  quart: "var(--ease-out-quart)",
  expo: "var(--ease-out-expo)",
  cubic: "var(--ease-out-cubic)",
  "in-out-quart": "var(--ease-in-out-quart)",
} as const;

/* DialKit's own production gate doesn't hold under Next: it tests
   `typeof process !== "undefined"` first, and Next only inlines the member
   expression `process.env.NODE_ENV` into client bundles — bare `process` stays
   undefined in the browser, so the check falls through to its `true` fallback
   and the panel ships. So the mount is gated here instead. useDialKit still
   runs and still returns these defaults with no root mounted — the values below
   are the real configuration, not just panel seeds. (This hides the panel; it
   does not drop DialKit from the bundle, since the hook is imported either
   way.) */
const DEV = process.env.NODE_ENV !== "production";

/* Opening happens in two beats, the way you'd do it by hand: the shut deck
   swings flat first, then the blades draw the half circle out of it. Closing
   runs the same two beats backwards. Both beats are on the motion panel. */
/* "align" is the deck upright but already in the open position: on the way
   out it slides across while the copy fades, and only then turns; on the way
   back it turns upright first and slides home last. */
type Stage = "shut" | "align" | "flat" | "open";
type Intent = "open" | "shut";

/* The two directions, written once, as which stage follows which. A closing
   is not a separate animation: it is the opening walked with this map, so
   every reversal is the same code path starting from wherever the deck got
   to. `undefined` means the deck is already where it is going. */
const NEXT: Record<Intent, Partial<Record<Stage, Stage>>> = {
  open: { shut: "align", align: "flat", flat: "open" },
  shut: { open: "flat", flat: "align", align: "shut" },
};

/* Shutting runs quicker than opening — a deck falls closed, it doesn't unfold
   closed. Held as a ratio of the dialled durations so the relationship survives
   whatever the motion panel is set to. Both the timers below and the sound
   above multiply by this same number, so the two can't drift apart. */
const CLOSE = 0.78;

/* The switch attribute is what makes WebKit play a haptic. React has no
   prop for it; setting it on the node keeps the markup a real switch. */
function armSwitch(node: HTMLInputElement | null) {
  node?.setAttribute("switch", "");
}

export function FanDeck() {
  const dials = useDialKit("Fan deck", {
    blades: [12, 3, 24, 1],
    spread: [180, 0, 180, 1],
    hinge: { type: "select", options: [...HINGES], default: "bottom-left" },
    palette: {
      type: "select",
      options: PALETTE_NAMES,
      default: "drift",
    },
    /* degrees per second the drifting hue turns */
    drift: [6, 0, 30, 0.5],
  });
  const motion = useDialKit("Motion", {
    align: [520, 100, 1500, 10],
    turn: [720, 120, 2000, 10],
    sweep: [1340, 150, 3000, 10],
    settle: [220, 0, 800, 10],
    ease: {
      type: "select",
      options: Object.keys(EASINGS),
      default: "quint",
    },
    float: [2.2, 0, 12, 0.1],
    lift: [1.2, 0, 8, 0.1],
    hover: [370, 60, 1200, 10],
  });
  const sound = useDialKit("Sound", {
    on: true,
    volume: [0.1, 0, 1, 0.02],
    voice: { type: "select", options: [...VOICINGS], default: "tap" },
    /* multiplier on brightness (the lowpass ceilings) */
    bright: [1, 0.4, 2, 0.05],
    /* multiplier on grain length (attack and decay) */
    length: [1, 0.3, 4, 0.05],
  });
  /* h1Gap is the distance from the headline down to the subcopy, buttonGap
     from the subcopy down to the button — each dial owns exactly one gap. */
  const copy = useDialKit("Copy", {
    x: [57.5, 40, 70, 0.5],
    /* dvh; moves the whole composition — deck and copy together. */
    y: [-4, -20, 20, 0.5],
    /* dvh; nudges the copy alone against the deck. */
    copyY: [-3, -20, 20, 0.5],
    h1: [48, 20, 72, 1],
    h1Leading: [0.94, 0.75, 1.2, 0.01],
    h1Tracking: [-3.2, -8, 2, 0.1],
    lede: [20, 12, 32, 1],
    h1Gap: [20, 0, 96, 1],
    button: [15.5, 10, 18, 0.5],
    buttonGap: [40, 0, 96, 1],
  });
  const count = dials.blades;
  const spread = dials.spread;
  const hinge = dials.hinge as Hinge;
  const palette = dials.palette as Palette;
  const ALIGN = motion.align;
  const TURN = motion.turn;
  const SPREAD = motion.sweep;
  const SETTLE = motion.settle;

  const [stage, setStage] = useState<Stage>("shut");
  const [stars, setStars] = useState<number | null>(null);
  /* A real switch on each card: the iPhone haptic, and on a Mac the
     trackpad tick. False on the server so the markup matches. */
  const switchTick = useSyncExternalStore(subscribeSwitch, wantsSwitch, () => false);
  /* The pointer handler is swapped every render through this box, never read
     during render — createHaptics only touches it from an event listener. */
  const onFinger = useRef<(event: PointerEvent) => void>(() => {});
  // eslint-disable-next-line react-hooks/refs
  const [feel] = useState(() => createHaptics(onFinger));

  /* The deck arrives shut tight and only then eases into its resting splay,
     once its own entrance has resolved. */
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = setTimeout(() => setReady(true), reduce ? 0 : 700);
    return () => clearTimeout(id);
  }, []);

  /* The hue, turning. Starts on a dark blue and heads through violet toward
     red. Ten steps a second is plenty: the background-color transition on the
     cards smooths the rest. */
  const [hue, setHue] = useState(262);
  const driftRate = dials.drift;
  useEffect(() => {
    if (driftRate === 0) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      setHue((h) => (h + (driftRate * (now - last)) / 1000) % 360);
      last = now;
    }, 100);
    return () => clearInterval(id);
  }, [driftRate]);
  const [swing, setSwing] = useState(TURN);
  const open = stage === "open";

  /* ── Sound ─────────────────────────────────────────────
     The context is created on the first gesture that can legitimately make
     sound and never before — browsers refuse audio ahead of a gesture, and a
     page that loads shut has nothing to say anyway. One master gain is the
     volume dial; `live` is every voice currently scheduled, so an interrupted
     gesture can be hushed without a click. */
  const audio = useRef<{ ctx: AudioContext; bus: GainNode } | null>(null);
  const live = useRef<Voice[]>([]);

  function speaker() {
    if (!sound.on || document.hidden) return null;
    if (!audio.current) {
      const ctx = new AudioContext();
      const bus = new GainNode(ctx, { gain: sound.volume });
      bus.connect(ctx.destination);
      audio.current = { ctx, bus };
    }
    const { ctx, bus } = audio.current;
    if (ctx.state === "suspended") void ctx.resume();
    bus.gain.setTargetAtTime(sound.volume, ctx.currentTime, 0.02);
    return { ctx, bus };
  }

  /* `spanMs` is the beat's actual length, already scaled for direction by the
     chain. Passing it instead of the dialled TURN/SPREAD means the audio
     clock and the CSS transition consume one shared number: a close whose
     cards take 0.78 of the dial gets its grains scored across 0.78 of it too,
     never across the full one. */
  function play(gesture: Gesture, spanMs = gesture === "turn" ? TURN : SPREAD) {
    const out = speaker();
    if (!out) return;
    schedule(
      out.ctx,
      out.bus,
      gesture,
      out.ctx.currentTime + 0.015,
      {
        turn: gesture === "turn" ? spanMs : TURN,
        sweep: gesture === "turn" ? SPREAD : spanMs,
        blades: count,
        voice: sound.voice as Voicing,
        bright: sound.bright,
        length: sound.length,
      },
      live.current
    );
  }

  function quiet() {
    if (audio.current) hush(audio.current.ctx, live.current);
  }

  /* ── The phase chain ──────────────────────────────────
     Opening and closing are one chain of beats, not two hand-written runs. A
     stage says what the deck is doing; NEXT says where each stage goes when
     heading one way or the other. Walking it one beat at a time means a
     reversal is not a special case — it is the same walk, aimed the other
     way, from wherever the deck already is. A deck caught mid-sweep closes
     from that angle, never by snapping back to flat first.

     Each run is a generation. Starting one bumps the token and cancels every
     timer the previous run held, so nothing from the old run can fire late,
     and the voices it had already put on the audio clock are hushed at the
     same moment. That is the whole interruption story. */
  const run = useRef({
    token: 0,
    timers: [] as ReturnType<typeof setTimeout>[],
  });
  /* Where the deck is heading overall, not just this frame. A click during a
     run asks for the opposite of this, which is what makes two quick clicks
     leave the second one's intent in charge. */
  const heading = useRef<Intent>("shut");
  /* The stage the last beat actually set. Read on a timer and on the hover
     re-target frame rather than a render, so neither acts on an angle React
     hasn't painted yet. */
  const stageRef = useRef<Stage>("shut");
  /* Always this render's beat handler. Timer callbacks hold the generation
     they were scheduled in, so a cancelled run is one whose token no longer
     matches. */
  const advance = useRef<(token: number) => void>(() => {});

  function cancelRun() {
    run.current.token += 1;
    for (const id of run.current.timers) clearTimeout(id);
    run.current.timers.length = 0;
  }

  /* How long each beat runs, in ms, already scaled for direction. The CSS
     transition, the chain's timer and the sound all read this one function,
     so a close beat is shortened on all three or on none of them. Only the
     sweep and the turn take the CLOSE ratio; the last slide home keeps its
     own duration. */
  function beatLength(from: Stage, to: Stage, closing: boolean): number {
    if (to === "open") return SPREAD;
    if (to === "flat") return (from === "open" ? SPREAD : TURN) * (closing ? CLOSE : 1);
    if (to === "align") return from === "shut" ? ALIGN : TURN * (closing ? CLOSE : 1);
    return 0;
  }

  /* One beat: enter the next stage, score the sound that belongs to that
     stage, and schedule the beat after it. Called both when a run starts and
     by the timer that ends the previous beat, so there is exactly one place
     the deck decides what happens next. */
  function step(intent: Intent, token: number) {
    const from = stageRef.current;
    const to = NEXT[intent][from];

    if (!to) {
      /* Already at the target — the chain has nowhere left to go. */
      if (intent === "open") setSwing(SETTLE);
      else feel.clearHot();
      return;
    }

    const closing = intent === "shut";
    const after = beatLength(from, to, closing);

    stageRef.current = to;
    setStage(to);
    /* `--swing` is the duration of the rotation this beat starts, so the CSS
       transition runs for exactly the window the timer and sound assume. */
    if (after > 0) setSwing(after);

    /* Closing finishes by entering "shut". There is no beat after it, so
       this is where the hover highlight the cards wore while they moved is
       dropped — the deck at rest must not keep a stale data-hot. */
    if (to === "shut") feel.clearHot();

    /* The sound belongs to the beat that is actually starting — a riffle at
       the sweep, a lock at the turn, nothing for the slide — and is scored
       across that beat's window, so it can be neither a beat early nor a
       beat late. */
    if (to === "open") play("open", SPREAD);
    else if (to === "flat" && closing) play("close", SPREAD * CLOSE);
    else if (to === "flat") play("turn", TURN);
    else if (to === "align" && closing) play("turn", TURN * CLOSE);

    if (after > 0) {
      run.current.timers.push(
        setTimeout(() => {
          if (token === run.current.token) advance.current(token);
        }, after)
      );
    }
  }

  function walk(intent: Intent, token: number) {
    if (token !== run.current.token) return;
    step(intent, token);
  }
  useEffect(() => {
    advance.current = (token) => walk(heading.current, token);
  });

  function begin(intent: Intent) {
    /* Before anything new is scheduled: cancel the old run's timers and hush
       the voices it had already put on the audio clock. This is the line
       that keeps a cancelled riffle from sounding after its cards stopped. */
    cancelRun();
    quiet();
    /* A hidden tab neither schedules nor moves. The click is dropped whole —
       not queued — so the deck stays exactly as it was left and comes back
       with its heading, stage and label still agreeing with one another. */
    if (document.hidden) return;
    heading.current = intent;
    walk(intent, run.current.token);
  }

  function toggle() {
    /* A click during a run asks for the opposite of where the deck is
       heading overall — so two quick clicks leave the second intent in
       charge, with the first walk's timers gone and its voices hushed. */
    begin(heading.current === "open" ? "shut" : "open");
  }

  function fanShut() {
    begin("shut");
  }

  /* Star count: one fetch, cached for an hour in the tab. */
  useEffect(() => {
    let alive = true;
    void fetchStars().then((n) => {
      if (alive) setStars(n);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => () => feel.stop(), [feel]);

  /* Development only: lets the same scheduler be rendered into an
     OfflineAudioContext from a test harness, so the sound can be measured
     — peak level, click detection, timing — rather than guessed at. The
     stage and heading getters make the chain observable from the console. */
  useEffect(() => {
    if (!DEV) return;
    (window as unknown as { __fanDeckSound?: unknown }).__fanDeckSound = {
      schedule,
      hush,
      stage: () => stageRef.current,
      heading: () => heading.current,
    };
    return () => {
      cancelRun();
      void audio.current?.ctx.close();
    };
  }, []);

  /* ── Hover follows the cards ──────────────────────────
     `elementsFromPoint` reads painted transforms, so it always answers for
     the card as drawn — the old code's problem was when it asked: only on a
     pointer event, never while the cards swung underneath a resting pointer.
     While a run is in flight this re-resolves the hit each frame against the
     current transform, so data-hot follows the card as it moves. The loop
     stops the moment the chain lands, and a close clears the highlight on its
     final beat, so nothing is left hot once the deck is home. */
  const rehover = useRef(0);
  useEffect(() => {
    const tick = () => {
      if (NEXT[heading.current][stageRef.current] == null) {
        rehover.current = 0;
        return;
      }
      const at = feel.where();
      if (at) {
        const hit = cardAt(at.x, at.y);
        if ((hit?.id ?? null) !== feel.card) feel.focus(hit);
      }
      rehover.current = requestAnimationFrame(tick);
    };
    rehover.current = requestAnimationFrame(tick);
    return () => {
      if (rehover.current) cancelAnimationFrame(rehover.current);
      rehover.current = 0;
    };
  }, [stage, feel]);

  /* ── Background tabs ──────────────────────────────────
     A hidden tab keeps its timers running in most browsers, and an audio
     clock keeps running whatever the page does. Both are stopped here: the
     run is cancelled so no beat is scheduled while hidden, and every voice
     already on the clock is hushed so nothing plays from a tab you are not
     looking at. Coming back does not replay anything — the deck is left
     where it stood at the last painted beat, and the next click starts a
     fresh run from that stage. */
  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) return;
      cancelRun();
      quiet();
      feel.clearHot();
      /* Nothing resumes on return, so the deck and its heading must agree.
         A run cut off mid-flight leaves the deck at some half-way stage while
         the heading still points at where it was going; that would make the
         next click close from a deck the label calls shut. So whatever stage
         was on screen when the tab went is taken as final: a deck left
         mid-flight settles its heading back to "shut", a deck that had
         finished opening keeps "open". The stage itself is not moved — the
         deck stays exactly as you left it, only the direction the next click
         will take is corrected. */
      if (NEXT[heading.current][stageRef.current] != null) {
        heading.current = stageRef.current === "open" ? "open" : "shut";
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  });

  function fingerMeets(x: number, y: number, hovering = true) {
    /* Remembered before the early return: even when the hit hasn't changed,
       the point has, and the frame loop needs the current one. A finger is
       not a hover, though — it has no resting position, so it never seeds the
       point the loop re-targets from. */
    if (hovering) feel.remember(x, y);
    const hit = cardAt(x, y);
    const next = hit?.id ?? null;
    if (next === feel.card) return;
    feel.focus(hit);
    if (next == null) return;
    /* Shut, the stack splays under the cursor and each edge is a card.
       Open, the same crossing is the slide across the fan. */
    if (open || stage === "shut") play("hover");
    feel.meet("touch");
  }
  useLayoutEffect(() => {
    onFinger.current = (event) => fingerMeets(event.clientX, event.clientY);
  });
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (isContact(event.pointerType) || event.buttons > 0) return;
      onFinger.current(event);
    };
    /* Off the page, there is no point to re-target; drop the remembered one
       so the frame loop doesn't keep highlighting the last card it saw. */
    const out = (event: PointerEvent) => {
      if (event.relatedTarget == null) feel.forget();
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerout", out, { passive: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerout", out);
    };
  }, [feel]);

  const blades = useMemo(() => {
    /* Flat and open share a base angle — the first blade's — so the spread grows
       out of the horizontal stack rather than re-centring on it. Every blade
       crosses its own arc over the same window, which keeps the gaps equal at
       every frame of the sweep. */
    const base = -spread / 2;
    const step = count > 1 ? spread / (count - 1) : 0;
    return Array.from({ length: count }, (_, i) => {
      const { colour, hex, lum } = tint(
        count > 1 ? i / (count - 1) : 0,
        palette,
        hue
      );
      return {
        i,
        angle:
          stage === "shut" || stage === "align"
            ? 0
            : base + (stage === "open" ? i * step : 0),
        colour,
        hex,
        /* The cut edge of the stock: the white core of the paper catching the
           light, so it runs brighter than the face. Strongest on the deep
           tints, all but gone on the pale ones, which have nothing to catch. */
        edge: `rgba(255, 255, 255, ${(0.16 + 0.34 * (1 - lum)).toFixed(3)})`,
        /* The two fibre passes cross-fade by how light the stock is, so the
           mid tints — where both would otherwise land — don't end up wearing
           twice the texture of the ends of the ramp. */
        grain: (0.45 * Math.pow(lum, 0.45)).toFixed(3),
        grainHi: (0.34 * Math.pow(1 - lum, 0.9)).toFixed(3),
        /* Each blade shows a different patch of the sheet so twelve blades don't
           read as twelve copies of one fibre pattern. */
        texture: `${(i * 137) % 100}% ${(i * 61) % 100}%`,
      };
    });
  }, [count, spread, stage, palette, hue]);

  /* Closed, the blades are congruent and would stack twelve identical shadows
     into one black bruise — so the cast fades out as the gap between blades
     closes, and only the bottom blade keeps its own. */
  const spacing = count > 1 && stage === "open" ? spread / (count - 1) : 0;
  const shadow = Math.min(1, spacing / 6).toFixed(3);

  /* The button wears the deck's own darkest stock — its face is the last stop
     of the palette, pressed it shows the one before, hovered it goes a shade
     deeper still. Swap the palette and the button follows. */
  const face = tint(1, palette, hue).rgb;
  const pressed = tint(count > 1 ? (count - 2) / (count - 1) : 0, palette, hue).rgb;
  const rgb = (c: readonly number[], k = 1) =>
    `rgb(${c.map((v) => Math.round(v * k)).join(" ")})`;
  /* The type follows the deck a little: near-black and mid-grey, each carrying
     a trace of the current hue. On the static palettes the trace is of their
     own darkest stock. */
  const inkHue =
    palette === "drift"
      ? hue
      : (Math.atan2(
          face[2] - (face[0] + face[1]) / 2,
          face[0] - face[1]
        ) *
          180) /
          Math.PI +
        180;
  /* The headline is the button's own face — the deck's darkest stock — so
     the two change in step. */
  const inkMain = rgb(face);
  const inkLede = rgb(oklch(0.52, 0.035, inkHue));

  /* The copy is there while the deck is shut and home, and fades as the deck
     slides across into position; it comes back once the deck has slid home. */
  const copyVisible = stage === "shut";

  return (
    <main
      className={styles.page}
      data-hinge={hinge}
      data-open={open ? "true" : "false"}
      data-stage={stage}
      data-ready={ready ? "true" : "false"}
      data-copy={copyVisible ? "shown" : "hidden"}
      style={
        {
          "--fan-sh": shadow,
          "--swing": `${swing}ms`,
          "--align": `${ALIGN}ms`,
          "--ease": EASINGS[motion.ease as keyof typeof EASINGS],
          "--hover": `${motion.hover}ms`,
          "--float": 1 + motion.float / 100,
          "--lift": `${-motion.lift}%`,
          "--ink-main": inkMain,
          "--ink-lede": inkLede,
          "--btn-face": rgb(face),
          "--btn-face-hover": rgb(face, 0.72),
          "--btn-face-active": rgb(pressed),
          "--copy-x": `${copy.x}%`,
          "--offset-y": `${copy.y}dvh`,
          "--copy-y": `${copy.copyY}dvh`,
          "--h1": `${copy.h1}px`,
          "--h1-lh": copy.h1Leading.toFixed(2),
          "--h1-ls": `${(copy.h1Tracking / 100).toFixed(3)}em`,
          "--lede": `${copy.lede}px`,
          "--h1-gap": `${copy.h1Gap}px`,
          "--btn": `${copy.button}px`,
          "--btn-gap": `${copy.buttonGap}px`,
        } as React.CSSProperties
      }
    >
      {DEV && <DialRoot position="top-right" theme="light" />}

      <section className={styles.copy} aria-hidden={!copyVisible}>
        <h1
          className={`${styles.title} ${styles.enter}`}
          style={{ "--stagger": 1 } as React.CSSProperties}
        >
          Interactive
          <br />
          Fan Deck
        </h1>
        <p
          className={`${styles.lede} ${styles.enter}`}
          style={{ "--stagger": 2 } as React.CSSProperties}
        >
          Color fan deck in code for
          <br />a more playful web.
        </p>
        <a
          className={`${styles.star} ${styles.enter}`}
          style={{ "--stagger": 3 } as React.CSSProperties}
          href={REPO}
          target="_blank"
          rel="noreferrer"
          tabIndex={copyVisible ? 0 : -1}
        >
          <svg
            className={styles.mark}
            viewBox="0 0 16 16"
            aria-hidden="true"
            fill="currentColor"
          >
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
          </svg>
          Star on GitHub
        </a>
        {stars !== null && stars >= STARS_WORTH_SHOWING && (
          <p
            className={`${styles.stars} ${styles.enter}`}
            style={{ "--stagger": 4 } as React.CSSProperties}
          >
            {compact.format(stars)} stars
          </p>
        )}
      </section>

      {/* Outside the stage, so the click doesn't also reach the stage's toggle. */}
      <button
        type="button"
        className={styles.close}
        onClick={fanShut}
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
      >
        Close
      </button>

      <div className={styles.stage}>
        {/* The deck is the only thing that opens it — the cards, not the page.
            The wrapper carries position, shadow and the hover float; the pivot
            inside it carries only the rotation, so on a phone the whole fan can
            be turned on its side without the shadow turning with it. */}
        <div
          className={styles.deck}
          role="button"
          tabIndex={0}
          aria-pressed={open}
          aria-label={open ? "Close the fan deck" : "Open the fan deck"}
          onClick={() => {
            /* Sliding a finger across the open fan is how you feel the cards.
               It should not also close them. */
            if (feel.consumeClick(open) === "drag") return;
            toggle();
          }}
          /* pointerdown is already a user gesture, so the context can be built
             here — a few dozen milliseconds before the click lands — instead
             of inside the click, where its creation would delay the first
             sound. A finger landing on a card ticks here too. */
          onPointerDown={(event) => {
            void speaker();
            const input =
              event.target instanceof Element
                ? event.target.closest("input[data-haptic]")
                : null;
            const thumb = input instanceof HTMLInputElement ? input : null;
            if (isContact(event.pointerType)) {
              feel.down(thumb, event.clientX, event.clientY);
              fingerMeets(event.clientX, event.clientY, false);
              return;
            }
            /* Trackpad: Safari starts tracking on this press, and only then.
               Leave the switch where it is until the pointer actually moves,
               or the origin WebKit records is already the leapfrogged one
               and the slide never crosses it. */
            if (!thumb) return;
            feel.down(thumb, event.clientX, event.clientY, 0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggle();
            }
          }}
        >
        <div
          className={`${styles.pivot} ${styles.enter}`}
          style={{ "--stagger": 0 } as React.CSSProperties}
        >
          {blades.map((blade) => (
            <div
              key={blade.i}
              data-blade={blade.i}
              className={styles.blade}
              style={
                {
                  "--angle": `${blade.angle}deg`,
                  /* The hover hint: shut, the cards splay a few degrees either
                     way under the cursor, like a hand of cards. */
                  "--peek": `${((blade.i - (count - 1) / 2) * 1.0).toFixed(2)}deg`,
                  "--colour": blade.colour,
                  "--texture": blade.texture,
                  "--grain": blade.grain,
                  "--grain-hi": blade.grainHi,
                  "--edge": blade.edge,
                } as React.CSSProperties
              }
              onPointerEnter={(event) => {
                /* The slide is handled on pointermove. pointerenter doesn't
                   follow a pressed pointer, and would tick twice where it does. */
                if (isContact(event.pointerType) || event.buttons > 0) return;
                fingerMeets(event.clientX, event.clientY);
              }}
            >
              <div className={styles.body}>
                <span className={styles.grain} />
                <span className={styles.grainHi} />
                {/* Over the grain, so the lit edge stays clean. */}
                <span className={styles.rim} />
              </div>
              {/* Off the tip, but inside the rotated blade so it turns with it. */}
              <span className={styles.code} aria-label={blade.hex}>
                {/* One fixed cell per glyph: the hue drifts, the digits change,
                    and the code never moves. Tabular figures only cover the
                    numerals; A to F need the same treatment. */}
                {blade.hex.split("").map((glyph, at) => (
                  <span key={at} className={styles.glyph} aria-hidden="true">
                    {glyph}
                  </span>
                ))}
              </span>
              {switchTick && (
                <input
                  ref={armSwitch}
                  type="checkbox"
                  data-haptic=""
                  className={styles.switch}
                  tabIndex={-1}
                  aria-hidden="true"
                  onClick={(event) => {
                    if (feel.consumeClick(open) === "tap") return;
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                />
              )}
            </div>
          ))}

          {/* The rivet caps the stack, so it is drawn last and sits above every
              blade — the way the pin on a real deck does. One smooth dome, lit
              from the upper left, with the pin set into the middle of it. */}
          <span className={styles.rivet}>
            <svg viewBox="0 0 100 100" fill="none" aria-hidden="true">
              <defs>
                <radialGradient id="fd-dome" cx="34%" cy="30%" r="82%">
                  <stop offset="0%" stopColor="#fdfdfe" />
                  <stop offset="26%" stopColor="#e8ebef" />
                  <stop offset="58%" stopColor="#bcc3cc" />
                  <stop offset="82%" stopColor="#8a929c" />
                  <stop offset="100%" stopColor="#5f6771" />
                </radialGradient>
                {/* light coming back up off the white sheet */}
                <radialGradient id="fd-bounce" cx="72%" cy="80%" r="44%">
                  <stop offset="0%" stopColor="#fff" stopOpacity="0.5" />
                  <stop offset="100%" stopColor="#fff" stopOpacity="0" />
                </radialGradient>
                <radialGradient id="fd-pin" cx="36%" cy="32%" r="86%">
                  <stop offset="0%" stopColor="#585f68" />
                  <stop offset="52%" stopColor="#79818b" />
                  <stop offset="100%" stopColor="#cbd1d8" />
                </radialGradient>
                <filter
                  id="fd-cast"
                  x="-60%"
                  y="-60%"
                  width="220%"
                  height="220%"
                >
                  <feGaussianBlur stdDeviation="3.4" />
                </filter>
              </defs>
              <circle
                cx="50"
                cy="56"
                r="42"
                fill="#0c1420"
                opacity="0.38"
                filter="url(#fd-cast)"
              />
              <circle cx="50" cy="50" r="43" fill="url(#fd-dome)" />
              <circle cx="50" cy="50" r="43" fill="url(#fd-bounce)" />
              <circle cx="50" cy="50" r="11" fill="url(#fd-pin)" />
            </svg>
          </span>
        </div>
        </div>
      </div>
    </main>
  );
}
