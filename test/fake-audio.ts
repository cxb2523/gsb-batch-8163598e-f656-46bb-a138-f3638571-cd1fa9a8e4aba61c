// A minimal Web Audio stand-in: enough surface for renderPatch to build and tear down a
// graph, plus an event log so a test can assert on order rather than side effects it
// cannot hear. Every node records connects, disconnects and scheduled stops.

export interface FakeParam {
  value: number;
  calls: { method: string; args: unknown[] }[];
  setValueAtTime(v: number, t: number): FakeParam;
  linearRampToValueAtTime(v: number, t: number): FakeParam;
  exponentialRampToValueAtTime(v: number, t: number): FakeParam;
  setTargetAtTime(v: number, t: number, tc: number): FakeParam;
  cancelScheduledValues(t: number): FakeParam;
  cancelAndHoldAtTime?(t: number): FakeParam;
}

export interface FakeNode {
  id: number;
  kind: string;
  connections: FakeNode[];
  disconnected: boolean;
  onended?: (() => void) | null;
  disconnect(): void;
  connect(dest: FakeNode): void;
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  readonly sampleRate = 48000;
  currentTime = 0;
  state: "running" | "suspended" | "closed" = "running";
  readonly destination: FakeNode;
  readonly nodes: FakeNode[] = [];
  /** Stop times requested on scheduled sources, keyed by node id. */
  readonly stops: { id: number; kind: string; at: number }[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
    this.destination = this.node("destination");
  }

  node(kind: string, extra: Record<string, unknown> = {}): FakeNode {
    const n: FakeNode = {
      id: this.nodes.length + 1,
      kind,
      connections: [],
      disconnected: false,
      connect(dest: FakeNode) {
        this.connections.push(dest);
      },
      disconnect() {
        this.disconnected = true;
        this.connections = [];
      },
      ...extra,
    };
    this.nodes.push(n);
    return n;
  }

  makeParam(initial = 0): FakeParam {
    const calls: FakeParam["calls"] = [];
    const param: FakeParam = {
      value: initial,
      calls,
      setValueAtTime(v, t) {
        calls.push({ method: "setValueAtTime", args: [v, t] });
        param.value = v;
        return param;
      },
      linearRampToValueAtTime(v, t) {
        calls.push({ method: "linearRampToValueAtTime", args: [v, t] });
        return param;
      },
      exponentialRampToValueAtTime(v, t) {
        calls.push({ method: "exponentialRampToValueAtTime", args: [v, t] });
        return param;
      },
      setTargetAtTime(v, t, tc) {
        calls.push({ method: "setTargetAtTime", args: [v, t, tc] });
        return param;
      },
      cancelScheduledValues(t) {
        calls.push({ method: "cancelScheduledValues", args: [t] });
        return param;
      },
      cancelAndHoldAtTime(t) {
        calls.push({ method: "cancelAndHoldAtTime", args: [t] });
        return param;
      },
    };
    return param;
  }

  private scheduled(kind: string, extra: Record<string, unknown>) {
    // Arrow functions capture the context; the node is found again by id, since it is
    // still being constructed when the handlers are defined.
    const node = this.node(kind, {
      started: false,
      start: (t: number) => {
        (node as unknown as { started: boolean }).started = true;
        this.nodeStarts.push({ id: node.id, kind, at: t });
      },
      stop: (at: number) => {
        this.stops.push({ id: node.id, kind, at });
      },
      ...extra,
    });
    return node;
  }

  readonly nodeStarts: { id: number; kind: string; at: number }[] = [];

  createGain(): FakeNode {
    return this.node("gain", { gain: this.makeParam(1) });
  }

  createOscillator(): FakeNode {
    return this.scheduled("oscillator", {
      type: "sine",
      frequency: this.makeParam(440),
      detune: this.makeParam(0),
    });
  }

  createBufferSource(): FakeNode {
    return this.scheduled("buffer-source", { buffer: null });
  }

  createBiquadFilter(): FakeNode {
    return this.node("biquad", {
      type: "lowpass",
      frequency: this.makeParam(350),
      Q: this.makeParam(1),
      detune: this.makeParam(0),
    });
  }

  createDelay(): FakeNode {
    return this.node("delay", { delayTime: this.makeParam(0) });
  }

  createConvolver(): FakeNode {
    return this.node("convolver", { buffer: null });
  }

  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: (ch: number) => data[ch],
    };
  }

  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }
}

export function installFakeAudio(): () => void {
  const g = globalThis as Record<string, unknown>;
  const prev = {
    AudioContext: g.AudioContext,
    OfflineAudioContext: g.OfflineAudioContext,
    OscillatorNode: g.OscillatorNode,
  };
  g.AudioContext = FakeAudioContext;
  g.OfflineAudioContext = FakeAudioContext;
  g.OscillatorNode = function OscillatorNode() {};
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  };
}
