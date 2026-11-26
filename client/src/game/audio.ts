// Signal Meadow style: compact square-wave cues, warm pulse tones, and restrained audio so the game remains readable on mobile.
import type { AudioCue } from "./types";

const MUSIC_URL = "/manus-storage/bytebound-meadow-loop_fc44f82d.wav";

type Tone = { frequency: number; duration: number; type: OscillatorType; gain: number; slide?: number };

const CUES: Record<AudioCue, Tone[]> = {
  jump: [{ frequency: 420, duration: 0.07, type: "square", gain: 0.055, slide: 760 }, { frequency: 760, duration: 0.08, type: "triangle", gain: 0.04, slide: 980 }],
  collect: [{ frequency: 880, duration: 0.055, type: "square", gain: 0.05, slide: 1180 }, { frequency: 1180, duration: 0.08, type: "square", gain: 0.045, slide: 1480 }],
  stomp: [{ frequency: 180, duration: 0.09, type: "square", gain: 0.045, slide: 90 }],
  checkpoint: [{ frequency: 520, duration: 0.08, type: "triangle", gain: 0.04, slide: 720 }, { frequency: 720, duration: 0.12, type: "triangle", gain: 0.04, slide: 1040 }],
  hurt: [{ frequency: 180, duration: 0.11, type: "sawtooth", gain: 0.035, slide: 90 }],
  finish: [{ frequency: 520, duration: 0.08, type: "square", gain: 0.04, slide: 780 }, { frequency: 780, duration: 0.08, type: "square", gain: 0.04, slide: 1040 }, { frequency: 1040, duration: 0.16, type: "triangle", gain: 0.045, slide: 1320 }],
};

/** Optional constructor seams used by local unit tests; normal browser usage passes nothing. */
export type ByteboundAudioDeps = {
  music?: HTMLAudioElement | null;
  createContext?: () => AudioContext;
};

export class ByteboundAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private music: HTMLAudioElement | null = null;
  private muted = false;
  private volume = 0.28;
  // Lifecycle gates. Music may play only when unlocked && !muted && !paused && !disposed.
  private unlocked = false;
  private playbackPaused = false;
  private disposed = false;
  // True while a music.play() promise has not settled. Browsers can leave .paused=true
  // synchronously during the request, so this guard prevents duplicate overlapping play calls.
  private playPending = false;
  // Tracks an initiated/accepted playback session independently of the element's .paused
  // flag (which lightweight test doubles may not update). Reset on every intentional pause.
  private musicActive = false;
  private readonly voices = new Set<OscillatorNode>();
  private readonly deps: ByteboundAudioDeps;

  constructor(deps: ByteboundAudioDeps = {}) {
    this.deps = deps;
    if (deps.music !== undefined) {
      this.music = deps.music;
    } else {
      const AudioCtor = resolveAudioConstructor();
      if (AudioCtor) {
        this.music = new AudioCtor(MUSIC_URL);
        this.music.loop = true;
        this.music.preload = "auto";
        this.music.volume = this.volume;
      }
    }
  }

  isMuted() { return this.muted; }
  isDisposed() { return this.disposed; }
  isPaused() { return this.playbackPaused; }
  isUnlocked() { return this.unlocked; }

  setMuted(muted: boolean) {
    if (this.disposed) return;
    this.muted = muted;
    if (this.music) this.music.muted = muted;
    if (this.master && this.context) {
      // Immediate gain change guarantees no already-scheduled cue leaks while muted.
      this.master.gain.setTargetAtTime?.(muted ? 0 : 1, this.context.currentTime, 0.005);
      this.master.gain.value = muted ? 0 : 1;
    }
    if (muted) {
      this.stopAllVoices();
      this.pauseMusicElement();
    } else {
      // Do not create the cue graph here: the initial settings sync calls this on mount,
      // before any gesture. If a graph already exists, re-arm it; otherwise the next
      // unlock()/playCue() creates it and the HUD unmute control calls unlock() directly.
      this.safeResumeContext();
      this.syncMusic();
    }
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /** Mark playback as allowed after a user gesture and resume the shared context/music. */
  unlock() {
    if (this.disposed) return;
    this.unlocked = true;
    this.ensureContext();
    this.safeResumeContext();
    this.syncMusic();
  }

  /** Pause music and silence/suspend cues because the game itself is not advancing. */
  pause() {
    this.setPaused(true);
  }

  /** Resume after pause/settings/hidden/blur; music restarts only if the other gates allow it. */
  resume() {
    this.setPaused(false);
  }

  setPaused(paused: boolean) {
    if (this.disposed) return;
    if (this.playbackPaused === paused) return;
    this.playbackPaused = paused;
    if (paused) {
      this.stopAllVoices();
      this.pauseMusicElement();
      this.safeSuspendContext();
    } else {
      this.safeResumeContext();
      this.syncMusic();
    }
  }

  private safeResumeContext() {
    if (this.muted || this.playbackPaused) return;
    const ctx = this.context as unknown as { resume?: () => Promise<void> | void } | null;
    if (!ctx || typeof ctx.resume !== "function") return;
    try { Promise.resolve(ctx.resume()).catch(() => undefined); } catch { /* unsupported double */ }
  }

  private safeSuspendContext() {
    const ctx = this.context as unknown as { suspend?: () => Promise<void> | void } | null;
    if (!ctx || typeof ctx.suspend !== "function") return;
    try { Promise.resolve(ctx.suspend()).catch(() => undefined); } catch { /* unsupported double */ }
  }

  private pauseMusicElement() {
    this.musicActive = false;
    if (this.music && !this.music.paused) {
      try { this.music.pause(); } catch { /* double may already be stopped */ }
    }
  }

  private musicWanted() {
    // An explicit unlock gesture OR an already-created audio graph (e.g. a cue has sounded)
    // is enough to consider playback armed, matching the previous setMuted(false) behaviour.
    const armed = this.unlocked || this.context !== null;
    return armed && !this.muted && !this.playbackPaused && !this.disposed;
  }

  playCue(cue: AudioCue) {
    // Muted, paused (game interrupted), or disposed instances must never create/resurrect audio.
    if (this.muted || this.playbackPaused || this.disposed) return;
    const context = this.ensureContext();
    if (!context || !this.master) return;
    this.safeResumeContext();
    const destination = this.master;
    const start = context.currentTime;
    let offset = 0;
    for (const tone of CUES[cue]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(tone.frequency, start + offset);
      oscillator.frequency.linearRampToValueAtTime(tone.slide ?? tone.frequency, start + offset + tone.duration);
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(tone.gain, start + offset + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + tone.duration);
      oscillator.connect(gain); gain.connect(destination);
      this.trackVoice(oscillator);
      oscillator.start(start + offset); oscillator.stop(start + offset + tone.duration + 0.02);
      offset += tone.duration * 0.72;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unlocked = false;
    this.playbackPaused = false;
    this.playPending = false;
    this.stopAllVoices();
    this.musicActive = false;
    if (this.music) {
      try { this.music.pause(); } catch { /* already stopped */ }
      this.music.loop = false;
      try { this.music.removeAttribute?.("src"); } catch { /* test doubles may not implement it */ }
      this.music.src = "";
      try { this.music.load?.(); } catch { /* harmless if unsupported */ }
    }
    if (this.context) { try { Promise.resolve(this.context.close?.()).catch(() => undefined); } catch { /* noop */ } }
    this.music = null; this.context = null; this.master = null; this.voices.clear();
  }

  private ensureContext(): AudioContext | null {
    if (this.disposed) return null;
    if (!this.context) {
      const context = this.deps.createContext ? this.deps.createContext() : createDefaultContext();
      if (!context) return null;
      this.context = context;
      this.master = context.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(context.destination);
    }
    return this.context;
  }

  /** Idempotently align the single music element with current intent; never stacks playback. */
  private syncMusic() {
    if (this.disposed || !this.music) return;
    if (!this.musicWanted()) {
      this.pauseMusicElement();
      return;
    }
    // One HTMLAudioElement means one stream. Skip when a playback session is already active
    // or a play() request is still settling, so repeated unlock/resume cannot overlap/restart.
    if (this.musicActive || this.playPending) return;
    this.playPending = true;
    let result: void | Promise<void>;
    try {
      result = this.music.play();
    } catch {
      this.playPending = false;
      this.musicActive = false;
      return;
    }
    if (result && typeof result.then === "function") {
      let accepted = false;
      result.then(
        () => { accepted = true; },
        () => { accepted = false; }, // Autoplay rejection / AbortError: stay inactive so a later gesture retries.
      ).then(() => {
        this.playPending = false;
        if (this.disposed || !this.music) return;
        if (accepted && this.musicWanted()) {
          this.musicActive = true;
        } else {
          // Rejected, or intent changed while the request was settling: never claim playback.
          this.pauseMusicElement();
        }
      });
    } else {
      this.playPending = false;
      this.musicActive = true;
    }
  }

  private trackVoice(oscillator: OscillatorNode) {
    this.voices.add(oscillator);
    oscillator.addEventListener?.("ended", () => this.voices.delete(oscillator));
  }

  private stopAllVoices() {
    this.voices.forEach((oscillator) => {
      try { oscillator.stop(); } catch { /* already stopped */ }
      try { oscillator.disconnect(); } catch { /* already disconnected */ }
    });
    this.voices.clear();
  }
}

function resolveAudioConstructor(): (new (src?: string) => HTMLAudioElement) | null {
  const globalRef = globalThis as { Audio?: new (src?: string) => HTMLAudioElement; window?: { Audio?: new (src?: string) => HTMLAudioElement } };
  return globalRef.Audio ?? (typeof window !== "undefined" ? window.Audio : undefined) ?? globalRef.window?.Audio ?? null;
}

function createDefaultContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  return new Ctor();
}
