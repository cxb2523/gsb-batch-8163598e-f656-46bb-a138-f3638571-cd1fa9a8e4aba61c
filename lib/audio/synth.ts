/*
 * Adapted from @web-kits/audio (https://github.com/raphaelsalaja/audio),
 * commit 3a9fe941c589d26d3487db17f5183eb9cecf3258, packages/audio/src/engine.ts
 * (oscillator, FM, envelope, filter, and per-layer delay paths; all other
 * source types and effects trimmed per BUILD.md).
 * Copyright (c) 2026 Raphael Salaja. MIT License. Full text: THIRD-PARTY-NOTICES.md.
 */

import { getContext, getDestination } from "./context";
import { createReverb, createShimmer, shimmerTail, type EffectNode } from "./effects";
import type {
  Envelope,
  Filter,
  NoiseColor,
  NoiseSource,
  OscillatorSource,
  Patch,
  Source,
} from "./patch";
import { layersOf } from "./patch";

const SILENCE = 0.0001;
const MIN_TIME_CONSTANT = 0.001;

function generateWhiteNoise(data: Float32Array) {
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
}

function generatePinkNoise(data: Float32Array) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
}

function generateBrownNoise(data: Float32Array) {
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }
}

function createNoiseBuffer(ctx: BaseAudioContext, color: NoiseColor, duration: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  if (color === "pink") generatePinkNoise(data);
  else if (color === "brown") generateBrownNoise(data);
  else generateWhiteNoise(data);
  return buffer;
}

interface BuiltSource {
  /** The node the layer's signal flows out of. */
  node: AudioScheduledSourceNode;
  /** Every scheduled node that must be stopped and torn down, modulators included. */
  sources: AudioScheduledSourceNode[];
  /** Every node that belongs to this source's own subgraph. */
  nodes: AudioNode[];
  /** The oscillator's detune, when the source has one. */
  detuneParam?: AudioParam;
}

function buildNoiseSource(
  ctx: BaseAudioContext,
  src: NoiseSource,
  t: number,
  duration: number,
): BuiltSource {
  const node = ctx.createBufferSource();
  node.buffer = createNoiseBuffer(ctx, src.color ?? "white", duration + 0.1);
  node.start(t);
  node.stop(t + duration + 0.1);
  return { node, sources: [node], nodes: [node] };
}

export interface PlayOptions {
  volume?: number;
  detune?: number;
  jitter?: { detune?: number; volume?: number };
}

export interface PlayHandle {
  stop(releaseTime?: number): void;
  /** True once stop() has been called or the sound has played out. */
  readonly ended: boolean;
  duration: number;
}

function buildSource(
  ctx: BaseAudioContext,
  src: Source,
  t: number,
  duration: number,
): BuiltSource {
  return src.type === "noise"
    ? buildNoiseSource(ctx, src, t, duration)
    : buildOscillatorSource(ctx, src, t, duration);
}

function buildOscillatorSource(
  ctx: BaseAudioContext,
  src: OscillatorSource,
  t: number,
  duration: number,
): BuiltSource {
  const osc = ctx.createOscillator();
  osc.type = src.type;

  if (typeof src.frequency === "number") {
    osc.frequency.setValueAtTime(src.frequency, t);
  } else {
    osc.frequency.setValueAtTime(src.frequency.start, t);
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(src.frequency.end, 1),
      t + Math.min(src.frequency.time ?? duration, duration),
    );
  }

  if (src.detune) {
    osc.detune.value = src.detune;
  }

  osc.start(t);
  osc.stop(t + duration + 0.1);

  const sources: AudioScheduledSourceNode[] = [osc];
  const nodes: AudioNode[] = [osc];

  if (src.fm) {
    const carrierFreq =
      typeof src.frequency === "number" ? src.frequency : src.frequency.start;

    const fmMod = ctx.createOscillator();
    fmMod.type = "sine";
    fmMod.frequency.value = carrierFreq * src.fm.ratio;

    const modGain = ctx.createGain();
    modGain.gain.value = src.fm.depth;

    fmMod.connect(modGain);
    modGain.connect(osc.frequency);
    fmMod.start(t);
    fmMod.stop(t + duration + 0.1);

    sources.push(fmMod);
    nodes.push(fmMod, modGain);
  }

  return { node: osc, sources, nodes, detuneParam: osc.detune };
}

function buildEnvelope(
  ctx: BaseAudioContext,
  envelope: Envelope | undefined,
  gain: number,
  t: number,
): { node: GainNode; duration: number } {
  const node = ctx.createGain();

  if (!envelope) {
    node.gain.setValueAtTime(gain, t);
    node.gain.setTargetAtTime(SILENCE, t, 0.15);
    return { node, duration: 0.5 };
  }

  const attack = envelope.attack ?? 0;
  const decay = envelope.decay;
  const sustain = envelope.sustain ?? 0;
  const release = envelope.release ?? 0;
  const sustainLevel = Math.max(sustain * gain, SILENCE);
  const decayTC = decay / 3;

  if (envelope.curve === "ramp") {
    const peak = Math.max(gain, SILENCE);
    node.gain.setValueAtTime(SILENCE, t);
    if (attack > 0) {
      node.gain.exponentialRampToValueAtTime(peak, t + attack);
    } else {
      node.gain.setValueAtTime(peak, t);
    }
    node.gain.exponentialRampToValueAtTime(SILENCE, t + attack + decay);
    return { node, duration: attack + decay + release };
  }

  node.gain.setValueAtTime(SILENCE, t);

  if (attack > 0) {
    node.gain.linearRampToValueAtTime(gain, t + attack);
  } else {
    node.gain.setValueAtTime(gain, t);
  }

  if (sustain > 0) {
    node.gain.setTargetAtTime(sustainLevel, t + attack, decayTC);
    if (release > 0) {
      node.gain.setTargetAtTime(SILENCE, t + attack + decay, release / 3);
    }
  } else {
    node.gain.setTargetAtTime(SILENCE, t + attack, decayTC);
  }

  return { node, duration: attack + decay + release };
}

function buildFilter(
  ctx: BaseAudioContext,
  filter: Filter,
  t: number,
): BiquadFilterNode {
  const node = ctx.createBiquadFilter();
  node.type = filter.type;
  node.frequency.setValueAtTime(filter.frequency, t);
  node.Q.value = filter.Q ?? filter.resonance ?? 1;

  if (filter.envelope) {
    const env = filter.envelope;
    const attackEnd = t + (env.attack ?? 0);
    node.frequency.linearRampToValueAtTime(env.peak, attackEnd);
    node.frequency.exponentialRampToValueAtTime(
      Math.max(filter.frequency, 1),
      attackEnd + env.decay,
    );
  }

  return node;
}

export function patchDuration(patch: Patch): number {
  const durations = layersOf(patch).map((layer) => {
    const env = layer.envelope;
    const envDur = env ? (env.attack ?? 0) + env.decay + (env.release ?? 0) : 0.5;
    const fxTail = (layer.effects ?? []).reduce(
      (max, e) =>
        e.type === "reverb"
          ? Math.max(max, e.decay ?? 0.5)
          : e.type === "delay"
            ? Math.max(max, shimmerTail(e))
            : max,
      0,
    );
    return (layer.delay ?? 0) + envDur + fxTail;
  });
  return Math.max(...durations) + 0.15;
}

export function renderPatch(
  ctx: BaseAudioContext,
  patch: Patch,
  opts?: PlayOptions,
  baseTime?: number,
  destination?: AudioNode,
): PlayHandle {
  const dest = destination ?? ctx.destination;
  const t0 = baseTime ?? ctx.currentTime;

  const jitter = opts?.jitter;
  const detuneJitter = jitter?.detune ? (Math.random() * 2 - 1) * jitter.detune : 0;
  const volumeJitter = jitter?.volume ? 1 + (Math.random() * 2 - 1) * jitter.volume : 1;

  const duration = patchDuration(patch);
  const envelopes: GainNode[] = [];
  const scheduled: { node: AudioScheduledSourceNode; start: number }[] = [];
  const layerNodes: AudioNode[] = [];
  const effectNodes: EffectNode[] = [];

  let ended = false;
  let stopping = false;
  let lastNaturalTimer: ReturnType<typeof setTimeout> | null = null;

  // Detaching the whole chain is what makes stop final. Fading the envelope alone leaves
  // the filter and the effect loop live, and a delay's feedback path keeps re-triggering
  // itself after the source is gone.
  const disconnectLayerNodes = () => {
    for (const n of layerNodes) {
      try {
        n.disconnect();
      } catch {}
    }
  };
  const disposeEffects = () => {
    for (const fx of effectNodes) {
      try {
        fx.dispose();
      } catch {}
    }
  };
  const teardown = () => {
    disconnectLayerNodes();
    disposeEffects();
  };

  for (const layer of layersOf(patch)) {
    const layerStart = t0 + (layer.delay ?? 0);
    const baseGain = (layer.gain ?? 0.5) * (opts?.volume ?? 1) * volumeJitter;

    const { node: envNode, duration: envDuration } = buildEnvelope(
      ctx,
      layer.envelope,
      baseGain,
      layerStart,
    );
    envelopes.push(envNode);

    const built = buildSource(ctx, layer.source, layerStart, envDuration);
    if (built.detuneParam && (opts?.detune || detuneJitter !== 0)) {
      built.detuneParam.value += (opts?.detune ?? 0) + detuneJitter;
    }

    let tail: AudioNode = built.node;
    const filterNodes: BiquadFilterNode[] = [];
    const filters = layer.filter
      ? Array.isArray(layer.filter)
        ? layer.filter
        : [layer.filter]
      : [];
    for (const f of filters) {
      const fn = buildFilter(ctx, f, layerStart);
      tail.connect(fn);
      tail = fn;
      filterNodes.push(fn);
    }

    tail.connect(envNode);

    let cursor: AudioNode = envNode;
    for (const effect of layer.effects ?? []) {
      const fx =
        effect.type === "reverb"
          ? createReverb(ctx, effect)
          : effect.type === "delay"
            ? createShimmer(ctx, effect)
            : null;
      if (!fx) continue;
      cursor.connect(fx.input);
      cursor = fx.output;
      effectNodes.push(fx);
    }
    cursor.connect(dest);

    layerNodes.push(...built.nodes, envNode, ...filterNodes);
    for (const node of built.sources) {
      scheduled.push({ node, start: layerStart });
    }
  }

  const isOffline = typeof (ctx as OfflineAudioContext).startRendering === "function";

  let pendingEnds = scheduled.length;
  if (pendingEnds === 0) ended = true;
  const onSourceEnded = () => {
    pendingEnds -= 1;
    if (pendingEnds > 0 || stopping) return;
    ended = true;
    // The source is finished; the effect tail is not, so only detach the dry chain here.
    disconnectLayerNodes();
    // Release the effect nodes once the tail has rung out. Scheduled from `onended` rather
    // than from render time: if the context was suspended when this was built, wall-clock
    // time would run ahead of the audio clock and cut the tail short.
    if (isOffline || typeof setTimeout !== "function" || effectNodes.length === 0) return;
    const remaining = Math.max(0, t0 + duration - ctx.currentTime);
    lastNaturalTimer = setTimeout(() => {
      lastNaturalTimer = null;
      disposeEffects();
    }, remaining * 1000 + 50);
  };
  for (const { node } of scheduled) {
    node.onended = onSourceEnded;
  }

  return {
    duration,
    get ended() {
      return ended;
    },
    stop(releaseTime?: number) {
      if (stopping) return;
      stopping = true;
      ended = true;
      if (lastNaturalTimer !== null) {
        clearTimeout(lastNaturalTimer);
        lastNaturalTimer = null;
      }

      const now = ctx.currentTime;
      const fade = Math.max(releaseTime ?? 0.015, 0);

      for (const env of envelopes) {
        const gain = env.gain;
        if (typeof gain.cancelAndHoldAtTime === "function") {
          gain.cancelAndHoldAtTime(now);
        } else {
          gain.cancelScheduledValues(now);
          gain.setValueAtTime(gain.value, now);
        }
        gain.setTargetAtTime(SILENCE, now, Math.max(fade / 3, MIN_TIME_CONSTANT));
      }

      // Cut the wet path now so a reverb or delay tail cannot outlive the source, but
      // keep the dry path until the fade has played out. Tearing the chain down at `now`
      // would turn the fade into a click.
      for (const fx of effectNodes) {
        try {
          fx.mute(fade);
        } catch {}
      }

      const stopAt = now + fade + 0.05;
      for (const { node, start } of scheduled) {
        try {
          // A layer still waiting on its delay must never be heard: stopping AT its start
          // time gives it zero duration, whereas stopping later would let it play after
          // the preview was already dismissed.
          node.stop(start > now ? start : stopAt);
        } catch {}
      }

      if (fade <= 0 || typeof setTimeout !== "function") {
        teardown();
        return;
      }
      // Disconnect a little after the sources actually stopped, so the graph is not pulled
      // out from under the last sample of the fade.
      setTimeout(() => teardown(), (fade + 0.1) * 1000);
    },
  };
}

export function playPatch(patch: Patch, opts?: PlayOptions): PlayHandle {
  // Build the graph inside the gesture. getContext() already asks a suspended context to
  // resume without awaiting it, so awaiting resume() here would only push the start past
  // the tap; the scheduled nodes simply begin when the context starts running.
  return renderPatch(getContext(), patch, opts, undefined, getDestination());
}
