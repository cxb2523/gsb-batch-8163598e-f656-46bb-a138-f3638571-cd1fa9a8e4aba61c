// Tibetan Singing Bowls: every bowl is synthesized with the Web Audio API.
// A bowl is a fundamental plus a few inharmonic overtones. Each overtone is
// two sine oscillators a fraction of a hertz apart, which produces the slow
// beating ("wah-wah") of a real bowl. Nothing is sampled or downloaded.

const CHAKRAS = [
  { name: "Root", color: "#ef5350" },
  { name: "Sacral", color: "#ff9800" },
  { name: "Solar plexus", color: "#fdd835" },
  { name: "Heart", color: "#66bb6a" },
  { name: "Throat", color: "#29b6f6" },
  { name: "Third eye", color: "#5c6bc0" },
  { name: "Crown", color: "#ab47bc" },
];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const SETS = {
  chakra: { label: "Chakra scale", semis: [0, 2, 4, 5, 7, 9, 11], names: CHAKRAS.map((c) => c.name) },
  pentatonic: { label: "Pentatonic", semis: [0, 2, 4, 7, 9, 12, 14], names: ["I", "II", "III", "IV", "V", "VI", "VII"] },
};
const OCTAVES = { 3: "Low", 4: "Middle", 5: "High" };
const PITCHES = { 440: "A = 440 Hz", 432: "A = 432 Hz" };
const BATH_LENGTHS = { 5: "5 min", 10: "10 min", 20: "20 min", 30: "30 min" };
const MODES = { strike: "Strike", sing: "Sing (hold)" };

// Overtone ratios and levels of the bowl model, and how long each one rings.
const PARTIALS = [
  { ratio: 1, amp: 1, beat: 0.55, tau: 3.4 },
  { ratio: 2.71, amp: 0.5, beat: 1.3, tau: 1.9 },
  { ratio: 5.15, amp: 0.26, beat: 2.4, tau: 1.1 },
  { ratio: 8.3, amp: 0.11, beat: 3.7, tau: 0.6 },
];

const KEY = "bowls-settings";
let settings = {
  set: "chakra",
  octave: 4,
  pitch: 440,
  volume: 70,
  reverb: 35,
  mode: "strike",
  bath: 10,
};

let AC = null;
let bus, dryGain, wetGain, master, analyser;
let bowls = [];
const voices = {}; // index -> { held, ringUntil, ... }
const ringing = new Map(); // index -> { t0, tau, sustain }
let bath = null; // active sound-bath session, see startBath()
let bathId = 0;
const bathStats = {
  starts: 0,
  stops: 0,
  naturalEnds: 0,
  autoStrikes: 0,
  autoCancelled: 0,
};
let animId = 0;
let initDone = false; // true once the page's bind() has run

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- clock

// Every delayed thing in the app -- the bath's countdown and its scheduled
// strikes -- goes through this clock. A test can install a controllable one
// and drive time by hand, with no real waiting.
const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  requestAnimationFrame: (fn) => requestAnimationFrame(fn),
  cancelAnimationFrame: (id) => cancelAnimationFrame(id),
};
let clock = realClock;

// Scheduling picks bowls and delays at random. A test pins this down so the
// same run always produces the same schedule.
let random = () => Math.random();

// Voices are made by this backend: Web Audio in the page, a silent recorder
// in tests, so the lifecycle can be checked without an audio device.
let synth = null; // null means "use the Web Audio backend"
let animationEnabled = true; // tests turn the frame loop off

// ---------------------------------------------------------------- tuning

const freqOf = (semi, octave) =>
  settings.pitch * Math.pow(2, (12 * (octave + 1) + semi - 69) / 12);

const buildBowls = () => {
  const set = SETS[settings.set];
  bowls = set.semis.map((s, i) => {
    const octave = settings.octave + Math.floor(s / 12);
    const idx = ((s % 12) + 12) % 12;
    return {
      i,
      freq: freqOf(s % 12, octave),
      note: NOTE_NAMES[idx] + octave,
      label: set.names[i],
      color: CHAKRAS[i].color,
      scale: 1.04 - i * 0.05,
    };
  });
};

// ---------------------------------------------------------------- audio

const impulse = (ctx, seconds = 3.6, decay = 2.6) => {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp += 0.35 * (Math.random() * 2 - 1 - lp); // soften the highs
      data[i] = lp * Math.pow(1 - t, decay) * 1.6;
    }
  }
  return buf;
};

const ensureAudio = () => {
  if (!AC) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    AC = new Ctx();
    bus = AC.createGain();
    dryGain = AC.createGain();
    wetGain = AC.createGain();
    const conv = AC.createConvolver();
    conv.buffer = impulse(AC);
    master = AC.createGain();
    const comp = AC.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 6;
    analyser = AC.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.82;
    bus.connect(dryGain).connect(master);
    bus.connect(conv).connect(wetGain).connect(master);
    master.connect(comp).connect(AC.destination);
    master.connect(analyser);
    applyMix();
  }
  if (AC.state === "suspended") AC.resume();
  return AC;
};

const applyMix = () => {
  if (!AC) return;
  const t = AC.currentTime;
  const wet = settings.reverb / 100;
  master.gain.setTargetAtTime((settings.volume / 100) ** 1.6, t, 0.05);
  dryGain.gain.setTargetAtTime(1 - 0.45 * wet, t, 0.05);
  wetGain.gain.setTargetAtTime(wet * 1.1, t, 0.05);
};

// A short bright "tick" of the mallet touching the rim.
const clink = (t0, strength) => {
  const len = Math.floor(AC.sampleRate * 0.03);
  const buf = AC.createBuffer(1, len, AC.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = AC.createBufferSource();
  src.buffer = buf;
  const bp = AC.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 2600;
  bp.Q.value = 0.8;
  const g = AC.createGain();
  g.gain.value = 0.10 * strength;
  src.connect(bp).connect(g).connect(bus);
  src.start(t0);
};

// One bowl voice. `sing` voices swell slowly and hold until released; struck
// voices start loud and ring out on their own.
const makeVoice = (freq, { sing = false, strength = 1 } = {}) => {
  const t0 = AC.currentTime;
  const out = AC.createGain();
  out.gain.value = 0;
  const wob = AC.createGain();
  wob.gain.value = sing ? 0.82 : 1;
  out.connect(wob).connect(bus);
  const nodes = [];
  let lfo = null;
  if (sing) {
    lfo = AC.createOscillator();
    lfo.frequency.value = 0.28 + Math.random() * 0.2;
    const lg = AC.createGain();
    lg.gain.value = 0.16;
    lfo.connect(lg).connect(wob.gain);
    lfo.start(t0);
    nodes.push(lfo);
  }
  const drift = 1 + (Math.random() - 0.5) * 0.0016;
  let maxTau = 0;
  PARTIALS.forEach((p, i) => {
    const f = freq * p.ratio * drift;
    const pg = AC.createGain();
    pg.gain.value = p.amp * (sing && i > 1 ? 0.5 : 1);
    const env = AC.createGain();
    if (sing) {
      env.gain.value = 1;
    } else {
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(1, t0 + 0.004);
      env.gain.setTargetAtTime(0, t0 + 0.004, p.tau);
    }
    maxTau = Math.max(maxTau, p.tau);
    for (const d of [0, p.beat * (0.8 + Math.random() * 0.4)]) {
      const o = AC.createOscillator();
      o.type = "sine";
      o.frequency.value = f + d;
      o.connect(pg);
      o.start(t0);
      nodes.push(o);
    }
    pg.connect(env).connect(out);
  });
  const peak = 0.2 * strength;
  if (sing) {
    out.gain.setTargetAtTime(peak * 1.15, t0, 0.9);
  } else {
    out.gain.setValueAtTime(peak, t0);
    clink(t0, strength);
    const stopAt = t0 + maxTau * 7 + 0.5;
    nodes.forEach((n) => n.stop(stopAt));
  }
  return {
    t0,
    tau: PARTIALS[0].tau,
    sing,
    freq,
    released: false,
    release() {
      if (this.released) return;
      this.released = true;
      const t = AC.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setTargetAtTime(0, t, 1.3);
      nodes.forEach((n) => n.stop(t + 9));
    },
  };
};

// The Web Audio backend: a synthetic bowl voice made from the live context.
const webAudioSynth = {
  ready: () => !!ensureAudio(),
  now: () => (AC ? AC.currentTime : 0),
  voice: (freq, opts) => makeVoice(freq, opts),
};

// The backend used for a single voice. In tests it is a silent recorder; in
// the page it is Web Audio. Either way the returned shape is the same, so the
// voice lifecycle code below never has to know which one is in use.
const makeVoiceFor = (freq, opts) => (synth || webAudioSynth).voice(freq, opts);

// ---------------------------------------------------------------- playing

// True when a voice can be made: either a backend has been injected (tests),
// or the Web Audio context came up.
const backendReady = () =>
  synth ? (typeof synth.ready === "function" ? !!synth.ready() : true) : !!ensureAudio();

const strike = (i, strength = 1, source = "manual") => {
  if (!backendReady() || !bowls[i]) return false;
  makeVoiceFor(bowls[i].freq, { strength });
  ringing.set(i, { t0: nowOf(), tau: PARTIALS[0].tau, sustain: false });
  if (source === "bath") bathStats.autoStrikes++;
  startAnim();
  return true;
};

const singStart = (i) => {
  if (!backendReady() || voices[i] || !bowls[i]) return false;
  const t = nowOf();
  voices[i] = makeVoiceFor(bowls[i].freq, { sing: true });
  ringing.set(i, { t0: t, tau: 1e9, sustain: true, swell: t });
  startAnim();
  return true;
};

const singStop = (i) => {
  const v = voices[i];
  if (!v) return false;
  v.release(); // the voice keeps its own frequency, even after a retune
  delete voices[i];
  const t = nowOf();
  ringing.set(i, {
    t0: t,
    tau: 1.3,
    sustain: false,
    from: ringing.get(i)?.level || 0.8,
  });
  return true;
};

// Release every sustained voice, e.g. before a retune rebuilds the bowls.
// Each voice was made at the old frequency, so it fades out at that pitch.
const releaseAllVoices = () => {
  Object.keys(voices).forEach((i) => singStop(+i));
};

const nowOf = () => (synth ? synth.now() : AC ? AC.currentTime : 0);

// ---------------------------------------------------------------- visuals

const levelOf = (r, now) => {
  if (r.sustain) return Math.min(1, 0.15 + (now - r.swell) / 2.2);
  return (r.from ?? 1) * Math.exp(-(now - r.t0) / (r.tau * 1.15));
};

const startAnim = () => {
  if (!animationEnabled || animId) return;
  animId = clock.requestAnimationFrame(frame);
};

const frame = () => {
  animId = 0;
  const now = nowOf();
  document.querySelectorAll(".bowl").forEach((el, i) => {
    const r = ringing.get(i);
    if (!r) return;
    const lv = levelOf(r, now);
    r.level = lv;
    if (lv < 0.03) {
      ringing.delete(i);
      el.classList.remove("ringing");
      el.style.setProperty("--glow", 0);
    } else {
      el.classList.add("ringing");
      el.style.setProperty("--glow", lv.toFixed(3));
    }
  });
  drawSpectrum();
  if (ringing.size || (bath && bath.end)) animId = clock.requestAnimationFrame(frame);
  else drawSpectrum(true);
};

const drawSpectrum = (idle = false) => {
  const cv = $("spectrum");
  if (!cv) return;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const c = cv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const fmin = 100;
  const fmax = 5000;
  const xOf = (f) => (Math.log(f / fmin) / Math.log(fmax / fmin)) * w;
  // gridlines at 100, 1k
  c.strokeStyle = "rgba(255,255,255,0.12)";
  c.lineWidth = 1;
  for (const f of [100, 200, 500, 1000, 2000, 5000]) {
    const x = Math.round(xOf(f)) + 0.5;
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x, h);
    c.stroke();
  }
  if (!AC || !analyser || idle) return;
  const bins = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(bins);
  const nyq = AC.sampleRate / 2;
  c.beginPath();
  let started = false;
  for (let px = 0; px <= w; px += 2) {
    const f = fmin * Math.pow(fmax / fmin, px / w);
    const k = Math.min(bins.length - 1, Math.round((f / nyq) * bins.length));
    const db = bins[k];
    const y = h - Math.max(0, Math.min(1, (db + 105) / 70)) * (h - 6) - 2;
    if (!started) {
      c.moveTo(px, y);
      started = true;
    } else c.lineTo(px, y);
  }
  c.strokeStyle = "#ffb74d";
  c.lineWidth = 2;
  c.stroke();
  c.lineTo(w, h);
  c.lineTo(0, h);
  c.closePath();
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "rgba(255,183,77,0.35)");
  g.addColorStop(1, "rgba(255,183,77,0)");
  c.fillStyle = g;
  c.fill();
};

// ---------------------------------------------------------------- sound bath

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// A bath session owns every delayed strike it schedules. They are all kept in
// one set so that stopping the bath cancels them together, and each timer is
// stamped with the session id so one that fires late can never touch a newer
// session.
const bathTimers = new Set();

const trackTimer = (key) => {
  bathTimers.add(key);
  return key;
};

const clearBathTimers = () => {
  let cancelled = 0;
  for (const key of bathTimers) {
    clock.clearTimeout(key);
    cancelled++;
  }
  bathTimers.clear();
  return cancelled;
};

// Queue one automatic strike for the active session. A zero delay strikes
// immediately (it has already happened, so there is nothing to cancel); any
// positive delay is a cancellable timer.
const scheduleAuto = (delay, bowlIndex, strength) => {
  if (!bath) return null;
  const id = bath.id;
  if (delay <= 0) {
    strike(bowlIndex, strength, "bath");
    return null;
  }
  let key;
  key = clock.setTimeout(() => {
    bathTimers.delete(key);
    if (!bath || bath.id !== id) return; // stopped or replaced
    if (clock.now() >= bath.end) return; // never strike past the end
    strike(bowlIndex, strength, "bath");
  }, delay);
  return trackTimer(key);
};

const nextBowl = () => {
  let n;
  do n = Math.floor(random() * bowls.length);
  while (n === bath.last && bowls.length > 1);
  return n;
};

// One step of the bath: strike a bowl, occasionally echo on another, then
// plan the next step -- but only if it lands before the end, so no timer is
// left queued that could never legitimately fire.
const bathStep = () => {
  if (!bath || clock.now() >= bath.end) return;
  const b = bath;
  const id = b.id;
  const i = nextBowl();
  b.last = i;
  scheduleAuto(0, i, 0.6 + random() * 0.4);
  if (random() < 0.25) scheduleAuto(700, (i + 2) % bowls.length, 0.5);
  const gap = 3500 + random() * 5500;
  if (clock.now() + gap < b.end) {
    let key;
    key = clock.setTimeout(() => {
      bathTimers.delete(key);
      b.stepTimer = null;
      if (!bath || bath.id !== id) return;
      if (clock.now() >= bath.end) return;
      bathStep();
    }, gap);
    b.stepTimer = trackTimer(key);
  } else {
    b.stepTimer = null;
  }
};

const updateBathLeft = () => {
  const el = $("bath-left");
  if (!bath) {
    if (el) el.textContent = "";
    return 0;
  }
  const left = Math.max(0, (bath.end - clock.now()) / 1000);
  if (el) el.textContent = fmtTime(left) + " left";
  return left;
};

// The countdown's tick: refresh the readout, and if time is up, end the bath.
const bathTick = () => {
  if (!bath) return;
  if (clock.now() >= bath.end) {
    endBath("natural");
    return;
  }
  updateBathLeft();
};

// The single exit of a bath. Manual stop and countdown expiry both come here;
// the `bath` null check makes it idempotent, so the end is counted once and
// two paths can't each fire a stop.
const endBath = (reason) => {
  const b = bath;
  if (!b) return false;
  bath = null;
  const cancelled = clearBathTimers();
  if (b.tick != null) clock.clearInterval(b.tick);
  bathStats.stops++;
  if (reason === "natural") bathStats.naturalEnds++;
  bathStats.autoCancelled += cancelled;
  const btn = $("bath-btn");
  if (btn) btn.textContent = "Start sound bath";
  updateBathLeft();
  return true;
};

const stopBath = () => endBath("manual");

const startBath = () => {
  if (!backendReady()) return false;
  if (bath) return false; // already running: never stack two sessions
  bathStats.starts++;
  const id = ++bathId;
  bath = {
    id,
    end: clock.now() + settings.bath * 60000,
    last: -1,
    tick: null,
    stepTimer: null,
  };
  bath.tick = clock.setInterval(bathTick, 500);
  const btn = $("bath-btn");
  if (btn) btn.textContent = "Stop sound bath";
  updateBathLeft();
  bathStep();
  startAnim();
  return true;
};

const toggleBath = () => (bath ? stopBath() : startBath());

// ---------------------------------------------------------------- UI

const bowlSvg = (b) => `
  <svg viewBox="0 0 100 80" aria-hidden="true" class="plain-bowl">
    <defs>
      <linearGradient id="bg${b.i}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${b.color}" stop-opacity="0.95"/>
        <stop offset="1" stop-color="${b.color}" stop-opacity="0.45"/>
      </linearGradient>
    </defs>
    <ellipse cx="50" cy="74" rx="42" ry="6" fill="rgba(0,0,0,0.35)"/>
    <g class="rings">
      <ellipse class="ring" cx="50" cy="30" rx="46" ry="9"/>
      <ellipse class="ring" cx="50" cy="30" rx="46" ry="9"/>
      <ellipse class="ring" cx="50" cy="30" rx="46" ry="9"/>
    </g>
    <path d="M5 30 Q8 68 50 71 Q92 68 95 30 Z" fill="url(#bg${b.i})"/>
    <ellipse cx="50" cy="30" rx="45" ry="9" fill="${b.color}" fill-opacity="0.9"/>
    <ellipse cx="50" cy="31" rx="40" ry="6.5" fill="rgba(0,0,0,0.45)"/>
    <path d="M12 44 Q50 52 88 44" stroke="rgba(255,255,255,0.35)" stroke-width="1.2" fill="none"/>
  </svg>`;

const renderBowls = () => {
  $("bowls").innerHTML = bowls
    .map(
      (b) => `
    <button type="button" class="bowl" data-i="${b.i}" style="--c:${b.color};--s:${b.scale.toFixed(2)}"
      aria-label="${b.note}, ${b.label}, ${b.freq.toFixed(1)} hertz">
      <span class="bowl-key">${b.i + 1}</span>
      ${bowlSvg(b)}
      <div class="bowl-note">${b.note}</div>
      <div class="bowl-freq">${b.freq.toFixed(1)} Hz</div>
      <div class="bowl-name">${b.label}</div>
    </button>`,
    )
    .join("");
};

const chips = (id, obj, key) => {
  $(id).innerHTML = Object.entries(obj)
    .map(([k, v]) => {
      const label = typeof v === "string" ? v : v.label;
      return `<button type="button" data-k="${k}" aria-pressed="${String(settings[key]) === k}">${label}</button>`;
    })
    .join("");
};

const renderControls = () => {
  chips("mode-chips", MODES, "mode");
  chips("set-chips", SETS, "set");
  chips("octave-chips", OCTAVES, "octave");
  chips("pitch-chips", PITCHES, "pitch");
  chips("bath-chips", BATH_LENGTHS, "bath");
  $("volume").value = settings.volume;
  $("volume-val").textContent = settings.volume + "%";
  $("reverb").value = settings.reverb;
  $("reverb-val").textContent = settings.reverb + "%";
};

const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable -- not worth failing over
  }
};

const restore = () => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!s) return;
    if (SETS[s.set]) settings.set = s.set;
    if (OCTAVES[s.octave]) settings.octave = +s.octave;
    if (PITCHES[s.pitch]) settings.pitch = +s.pitch;
    if (BATH_LENGTHS[s.bath]) settings.bath = +s.bath;
    if (MODES[s.mode]) settings.mode = s.mode;
    for (const k of ["volume", "reverb"]) {
      if (typeof s[k] === "number") settings[k] = Math.min(100, Math.max(0, s[k]));
    }
  } catch {
    // ignore corrupt saved data
  }
};

const setSetting = (key, value) => {
  settings[key] = value;
  save();
  if (["set", "octave", "pitch"].includes(key)) {
    // A held voice was made at the old tuning. Releasing it before the bowls
    // are rebuilt lets it fade out at its original frequency, rather than
    // jumping pitch or being cut off.
    releaseAllVoices();
    buildBowls();
    renderBowls();
  }
  renderControls();
};

const bindChips = (id, key, num) =>
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    setSetting(key, num ? +b.dataset.k : b.dataset.k);
  });

const bind = () => {
  bindChips("mode-chips", "mode", false);
  bindChips("set-chips", "set", false);
  bindChips("octave-chips", "octave", true);
  bindChips("pitch-chips", "pitch", true);
  bindChips("bath-chips", "bath", true);
  $("volume").addEventListener("input", (e) => {
    settings.volume = +e.target.value;
    $("volume-val").textContent = settings.volume + "%";
    applyMix();
    save();
  });
  $("reverb").addEventListener("input", (e) => {
    settings.reverb = +e.target.value;
    $("reverb-val").textContent = settings.reverb + "%";
    applyMix();
    save();
  });

  const grid = $("bowls");
  grid.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".bowl");
    if (!el) return;
    const i = +el.dataset.i;
    if (settings.mode === "sing") {
      // Pointer capture can be refused for a stale pointer; singing must not
      // depend on it.
      try {
        el.setPointerCapture?.(e.pointerId);
      } catch {
        // ignore: capture is a nicety, not a requirement
      }
      singStart(i);
    } else {
      strike(i);
    }
  });
  const release = (e) => {
    const el = e.target.closest?.(".bowl");
    if (el && settings.mode === "sing") singStop(+el.dataset.i);
  };
  grid.addEventListener("pointerup", release);
  grid.addEventListener("pointercancel", release);
  grid.addEventListener("contextmenu", (e) => e.preventDefault());
  // keyboard: 1-7 strike; hold Shift+number to sing (release to stop)
  document.addEventListener("keydown", (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= bowls.length) {
      if (settings.mode === "sing") singStart(n - 1);
      else strike(n - 1);
    }
  });
  document.addEventListener("keyup", (e) => {
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= bowls.length && settings.mode === "sing") singStop(n - 1);
  });
  window.addEventListener("resize", () => drawSpectrum(!ringing.size));
};

const initBowls = () => {
  restore();
  buildBowls();
  renderBowls();
  renderControls();
  bind();
  drawSpectrum(true);
  initDone = true;
};

// ------------------------------------------------------------------ test hooks

// A small, explicit surface for js/bath-lifecycle.test.js (or the browser
// console). It swaps the clock, the random source and the voice backend, and
// exposes only what the lifecycle tests need. The test file removes it after
// it runs; the page never uses it.
const testHooks = {
  install({ newClock, newRandom, newSynth } = {}) {
    // Drop any frame queued by the real clock before switching over.
    if (animId) {
      (clock.cancelAnimationFrame || cancelAnimationFrame)(animId);
      animId = 0;
    }
    if (newClock) clock = newClock;
    if (newRandom) random = newRandom;
    if (newSynth) synth = newSynth;
    animationEnabled = false;
  },
  restore() {
    if (animId) {
      (clock.cancelAnimationFrame || cancelAnimationFrame)(animId);
      animId = 0;
    }
    clock = realClock;
    random = () => Math.random();
    synth = null;
    animationEnabled = true;
  },
  state() {
    return {
      bath,
      bathTimers: bathTimers.size,
      voices: Object.keys(voices).length,
      voiceKeys: Object.keys(voices).map(Number),
      ringing: ringing.size,
      bowls: bowls.length,
      bowlFreqs: bowls.map((b) => b.freq),
      stats: { ...bathStats },
      buttonText: $("bath-btn")?.textContent ?? null,
      leftText: $("bath-left")?.textContent ?? null,
      settings: { ...settings },
    };
  },
  strike: (i, strength) => strike(i, strength, "manual"),
  startBath,
  stopBath,
  toggleBath,
  setSetting,
  singStart,
  singStop,
  releaseAllVoices,
  buildBowls,
  renderBowls,
  renderControls,
  drawSpectrum,
  resetStats() {
    bathStats.starts = 0;
    bathStats.stops = 0;
    bathStats.naturalEnds = 0;
    bathStats.autoStrikes = 0;
    bathStats.autoCancelled = 0;
  },
  // Tear a running session down without counting it as a stop, so each test
  // starts from a clean slate.
  reset() {
    const b = bath;
    bath = null;
    clearBathTimers();
    if (b && b.tick != null) clock.clearInterval(b.tick);
    releaseAllVoices();
    ringing.clear();
    testHooks.resetStats();
    const btn = $("bath-btn");
    if (btn) btn.textContent = "Start sound bath";
    const left = $("bath-left");
    if (left) left.textContent = "";
  },
  clockIsInjected: () => clock !== realClock,
  isInitialized: () => initDone,
};

if (typeof window !== "undefined") window.bowlsTestHooks = testHooks;
