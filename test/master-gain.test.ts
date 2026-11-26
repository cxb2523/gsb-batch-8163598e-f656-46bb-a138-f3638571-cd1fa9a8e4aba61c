// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createSeslen } from "../src/index.ts"

/**
 * Master gain arbitration: manual mute, reduced-motion auto-mute and
 * persistence are independent layers over the user's last set volume.
 * `unmute()` must restore that volume no matter how the layers stacked.
 */

type FakeParam = {
  value: number
  setValueAtTime: ReturnType<typeof vi.fn>
  linearRampToValueAtTime: ReturnType<typeof vi.fn>
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>
  cancelScheduledValues: ReturnType<typeof vi.fn>
}

function param(): FakeParam {
  return {
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  }
}

function makeNode(): { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } {
  const node = {
    connect: vi.fn(() => node),
    disconnect: vi.fn(),
  }
  return node
}

function makeGain(): ReturnType<typeof makeNode> & { gain: FakeParam } {
  return Object.assign(makeNode(), { gain: param() })
}

class FakeAudioContext {
  state: "suspended" | "running" | "closed" = "suspended"
  destination = makeNode()
  currentTime = 0
  sampleRate = 44100
  gains: ReturnType<typeof makeGain>[] = []
  resume = vi.fn(async () => {
    this.state = "running"
  })
  suspend = vi.fn(async () => {
    this.state = "suspended"
  })
  close = vi.fn(async () => {
    this.state = "closed"
  })
  createGain = vi.fn(() => {
    const g = makeGain()
    this.gains.push(g)
    return g
  })
}

const contexts: FakeAudioContext[] = []
let reduceMatches = false
let reduceListener: ((e: { matches: boolean }) => void) | null = null

beforeEach(() => {
  contexts.length = 0
  reduceMatches = false
  reduceListener = null
  ;(globalThis as { AudioContext?: unknown }).AudioContext = class extends FakeAudioContext {
    constructor() {
      super()
      contexts.push(this)
    }
  }
  window.matchMedia = vi.fn(() => ({
    matches: reduceMatches,
    addEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => {
      reduceListener = cb
    },
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  delete (globalThis as { AudioContext?: unknown }).AudioContext
  delete (window as { matchMedia?: unknown }).matchMedia
})

function setReducedMotion(reduce: boolean): void {
  reduceMatches = reduce
  reduceListener?.({ matches: reduce })
}

describe("master gain arbitration (manual mute × reduced-motion auto-mute)", () => {
  it("unmute restores the last user-set volume after stacked manual + auto mute", async () => {
    const ses = createSeslen({ sources: {}, volume: 0.7 })
    ses.bus("boot") // boots the context without playing
    const master = contexts[0]!.gains[0]!
    expect(master.gain.value).toBe(0.7)

    ses.setVolume(0.5)
    expect(master.gain.value).toBe(0.5)

    // Auto-mute kicks in: output silenced, user volume preserved.
    setReducedMotion(true)
    expect(master.gain.value).toBe(0)
    expect(ses.getVolume()).toBe(0.5)
    expect(ses.isMuted()).toBe(false)

    // Manual mute stacks on top, then auto-mute lifts — still muted.
    ses.mute()
    setReducedMotion(false)
    expect(master.gain.value).toBe(0)
    expect(ses.isMuted()).toBe(true)

    // Unmute restores the user's last set volume, not an auto-mute artifact.
    ses.unmute()
    expect(ses.getVolume()).toBe(0.5)
    expect(master.gain.value).toBe(0.5)
  })

  it("setVolume while auto-muted updates the volume revealed when auto-mute lifts", async () => {
    const ses = createSeslen({ sources: {}, volume: 0.8 })
    ses.bus("boot")
    const master = contexts[0]!.gains[0]!

    setReducedMotion(true)
    expect(master.gain.value).toBe(0)

    ses.setVolume(0.3)
    expect(master.gain.value).toBe(0)
    expect(ses.getVolume()).toBe(0.3)

    setReducedMotion(false)
    expect(master.gain.value).toBe(0.3)
  })

  it("setVolume while manually muted updates the post-unmute volume", async () => {
    const ses = createSeslen({ sources: {}, volume: 0.8 })
    ses.bus("boot")
    const master = contexts[0]!.gains[0]!

    ses.mute()
    ses.setVolume(0.3)
    expect(master.gain.value).toBe(0)
    ses.unmute()
    expect(ses.getVolume()).toBe(0.3)
    expect(master.gain.value).toBe(0.3)
  })

  it("reduced-motion auto-mute does not clobber a manual mute's restore target", async () => {
    const ses = createSeslen({ sources: {}, volume: 0.6 })
    ses.bus("boot")
    const master = contexts[0]!.gains[0]!

    ses.mute()
    // Auto-mute toggles twice while manually muted.
    setReducedMotion(true)
    setReducedMotion(false)
    expect(master.gain.value).toBe(0)

    ses.unmute()
    expect(ses.getVolume()).toBe(0.6)
    expect(master.gain.value).toBe(0.6)
  })

  it("manual unmute does not lift a reduced-motion auto-mute", async () => {
    const ses = createSeslen({ sources: {}, volume: 0.9 })
    ses.bus("boot")
    const master = contexts[0]!.gains[0]!

    setReducedMotion(true)
    ses.mute()
    ses.unmute()
    // Auto-mute still active ⇒ output stays silent…
    expect(master.gain.value).toBe(0)
    expect(ses.isMuted()).toBe(false)
    // …until reduced-motion lifts, revealing the user's volume.
    setReducedMotion(false)
    expect(master.gain.value).toBe(0.9)
  })
})
