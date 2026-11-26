// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

class FakeParam {
  value: number
  targets: number[] = []
  constructor(value = 0) {
    this.value = value
  }
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
  setTargetAtTime(value: number) {
    this.targets.push(value)
  }
}

class FakeNode {
  starts = 0
  disconnects = 0
  gain = new FakeParam()
  frequency = new FakeParam()
  Q = new FakeParam()
  pan = new FakeParam()
  threshold = new FakeParam()
  knee = new FakeParam()
  ratio = new FakeParam()
  attack = new FakeParam()
  release = new FakeParam()
  type = ""
  buffer: unknown = null
  loop = false
  connect(next: unknown) {
    return next
  }
  disconnect() {
    this.disconnects++
  }
  start() {
    this.starts++
  }
  stop() {}
}

class FakeAudioContext {
  static all: FakeAudioContext[] = []
  state: "running" | "suspended" = "running"
  currentTime = 0
  sampleRate = 8000
  destination = new FakeNode()
  nodes: FakeNode[] = []
  resumes = 0
  suspends = 0
  constructor() {
    FakeAudioContext.all.push(this)
  }
  private make() {
    const node = new FakeNode()
    this.nodes.push(node)
    return node
  }
  createGain() {
    return this.make()
  }
  createOscillator() {
    return this.make()
  }
  createBufferSource() {
    return this.make()
  }
  createBiquadFilter() {
    return this.make()
  }
  createDynamicsCompressor() {
    return this.make()
  }
  createStereoPanner() {
    return this.make()
  }
  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) }
  }
  resume() {
    this.resumes++
    this.state = "running"
    return Promise.resolve()
  }
  suspend() {
    this.suspends++
    this.state = "suspended"
    return Promise.resolve()
  }
  master() {
    const master = this.nodes[1]
    if (!master) throw new Error("expected the engine to have built a master gain")
    return master
  }
  voices() {
    return this.nodes.reduce((sum, node) => sum + node.starts, 0)
  }
}

const engineContext = () => {
  const context = FakeAudioContext.all[0]
  if (!context) throw new Error("expected the engine to have created an AudioContext")
  return context
}

const busOf = (context: FakeAudioContext, index: number) => {
  const bus = context.nodes[index]
  if (!bus) throw new Error(`expected a bus node at index ${index}`)
  return bus
}

const flush = async () => {
  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(0)
}

const setVisibility = (state: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state })
  document.dispatchEvent(new Event("visibilitychange"))
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  localStorage.clear()
  FakeAudioContext.all = []
  ;(window as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext
})

afterEach(() => {
  vi.useRealTimers()
})

const soundOn = async () => {
  const kit = await import("../src")
  kit.configureSound({ defaultOn: true, storageKey: "test:lifecycle" })
  return kit
}

describe("sound engine lifecycle", () => {
  it("plays while sound is on and suspends when quiet", async () => {
    const kit = await soundOn()
    const stop = kit.playSound("press")
    await flush()
    const context = engineContext()
    expect(context).toBeDefined()
    expect(context.voices()).toBeGreaterThan(0)
    expect(typeof stop).toBe("function")
    await vi.advanceTimersByTimeAsync(10_000)
    expect(context.suspends).toBe(1)
    expect(context.state).toBe("suspended")
  })

  it("fades out and releases playing nodes as soon as sound is turned off", async () => {
    const kit = await soundOn()
    kit.playSound("motor", { duration: 5 })
    await flush()
    const context = engineContext()
    const bus = busOf(context, 2)
    expect(context.voices()).toBeGreaterThan(0)
    kit.soundPreference.set(false)
    await flush()
    expect(bus.gain.targets).toContain(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(bus.disconnects).toBe(1)
    expect(context.suspends).toBe(1)
    const heard = context.voices()
    const stop = kit.playSound("press")
    await flush()
    expect(context.voices()).toBe(heard)
    stop()
  })

  it("does not start a queued sound that was still loading when sound turned off", async () => {
    const kit = await soundOn()
    kit.playSound("press")
    kit.soundPreference.set(false)
    await flush()
    expect(FakeAudioContext.all.length).toBe(0)
  })

  it("suspends while the page is hidden and resumes when visible again", async () => {
    const kit = await soundOn()
    kit.playSound("press")
    await flush()
    const context = engineContext()
    setVisibility("hidden")
    await flush()
    expect(context.suspends).toBe(1)
    expect(context.state).toBe("suspended")
    setVisibility("visible")
    await flush()
    expect(context.resumes).toBe(1)
    expect(context.state).toBe("running")
  })

  it("stays suspended when the page returns while sound is off", async () => {
    const kit = await soundOn()
    kit.playSound("press")
    await flush()
    const context = engineContext()
    kit.soundPreference.set(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(context.suspends).toBe(1)
    setVisibility("hidden")
    setVisibility("visible")
    await flush()
    expect(context.resumes).toBe(0)
    expect(context.state).toBe("suspended")
  })

  it("applies a reconfigured volume to the running engine", async () => {
    const kit = await soundOn()
    kit.playSound("press")
    await flush()
    const context = engineContext()
    expect(context.master().gain.value).toBeCloseTo(0.55, 5)
    kit.configureSound({ volume: 0.2 })
    await flush()
    expect(context.master().gain.value).toBeCloseTo(0.2, 5)
    expect(FakeAudioContext.all.length).toBe(1)
  })

  it("re-resolves the default from stored preference and notifies on reconfigure", async () => {
    const kit = await soundOn()
    const seen = vi.fn()
    kit.soundPreference.subscribe(seen)
    kit.soundPreference.set(true)
    expect(localStorage.getItem("test:lifecycle")).toBe("on")
    kit.configureSound({ defaultOn: false, storageKey: "test:lifecycle" })
    expect(kit.soundPreference.get()).toBe(true)
    kit.configureSound({ defaultOn: false, storageKey: "test:lifecycle" })
    expect(seen.mock.calls.length).toBeGreaterThanOrEqual(3)
    localStorage.removeItem("test:lifecycle")
    kit.configureSound({ defaultOn: false, storageKey: "test:lifecycle" })
    expect(kit.soundPreference.get()).toBe(false)
  })

  it("silences the engine when a reconfigure resolves to off", async () => {
    const kit = await soundOn()
    kit.playSound("motor", { duration: 5 })
    await flush()
    const context = engineContext()
    const bus = busOf(context, 2)
    kit.configureSound({ defaultOn: false, storageKey: "test:lifecycle" })
    await flush()
    expect(kit.soundPreference.get()).toBe(false)
    expect(bus.gain.targets).toContain(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(bus.disconnects).toBe(1)
  })

  it("keeps stop() idempotent against repeats and the automatic release", async () => {
    const kit = await soundOn()
    const stop = kit.playSound("press")
    await flush()
    const context = engineContext()
    const bus = busOf(context, 2)
    stop()
    stop()
    await vi.advanceTimersByTimeAsync(200)
    expect(bus.disconnects).toBe(1)
    stop()
    expect(bus.disconnects).toBe(1)

    const busIndex = context.nodes.length
    const second = kit.playSound("press")
    await flush()
    const next = busOf(context, busIndex)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(next?.disconnects).toBe(1)
    expect(() => second()).not.toThrow()
    expect(next?.disconnects).toBe(1)
  })
})
