import { describe, expect, it, vi } from "vitest"
import { createBuses } from "../src/_buses.ts"

/**
 * Unit tests for the two-layer bus mixer: base gain (user volume / mute)
 * and duck gain (envelope coefficient) are separate GainNodes, so manual
 * changes and duck envelopes never overwrite each other.
 */

type RampEvent = { type: "set" | "linear"; value: number; time: number }

class FakeParam {
  value = 0
  events: RampEvent[] = []
  setValueAtTime = (v: number, t: number): void => {
    this.events.push({ type: "set", value: v, time: t })
  }
  linearRampToValueAtTime = (v: number, t: number): void => {
    this.events.push({ type: "linear", value: v, time: t })
  }
  exponentialRampToValueAtTime = (v: number, t: number): void => {
    this.events.push({ type: "linear", value: v, time: t })
  }
  cancelScheduledValues = (t: number): void => {
    this.events = this.events.filter((e) => e.time < t)
  }
  /** Effective value at time `t`: intrinsic `value` plus scheduled events. */
  at(t: number): number {
    let v = this.value
    let prevT = 0
    let prevV = v
    for (const e of this.events) {
      if (e.time > t) {
        if (e.type === "linear" && e.time > prevT) {
          return prevV + ((e.value - prevV) * (t - prevT)) / (e.time - prevT)
        }
        return prevV
      }
      v = e.value
      prevT = e.time
      prevV = v
    }
    return v
  }
}

function makeGain(): {
  gain: FakeParam
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
} {
  const node = {
    gain: new FakeParam(),
    connect: vi.fn(() => node),
    disconnect: vi.fn(),
  }
  return node
}

function makeCtx(): {
  ctx: AudioContext
  gains: ReturnType<typeof makeGain>[]
  setTime: (t: number) => void
} {
  const gains: ReturnType<typeof makeGain>[] = []
  const state = { currentTime: 0 }
  const ctx = {
    get currentTime() {
      return state.currentTime
    },
    createGain: () => {
      const g = makeGain()
      gains.push(g)
      return g
    },
  } as unknown as AudioContext
  return {
    ctx,
    gains,
    setTime: (t) => {
      state.currentTime = t
    },
  }
}

function setup(initial?: Record<string, { volume?: number; muted?: boolean }>): {
  buses: ReturnType<typeof createBuses>
  master: ReturnType<typeof makeGain>
  gains: ReturnType<typeof makeGain>[]
  setTime: (t: number) => void
} {
  const { ctx, gains, setTime } = makeCtx()
  const master = makeGain()
  const buses = createBuses(ctx, master as unknown as GainNode, initial)
  return { buses, master, gains, setTime }
}

describe("createBuses — layered base/duck gains", () => {
  it("wires each bus as base → duck → master", () => {
    const { buses, master, gains } = setup()
    buses.get("music")
    const [base, duck] = gains
    expect(base!.connect).toHaveBeenCalledWith(duck)
    expect(duck!.connect).toHaveBeenCalledWith(master)
    expect(duck!.gain.value).toBe(1)
    // Sounds route into the base (input) node.
    expect(buses.resolve("music")).toBe(base)
  })

  it("setVolume during a duck does not disturb the envelope; release settles on the new base", () => {
    const { buses, gains, setTime } = setup()
    const music = buses.get("music")
    music.setVolume(0.8)
    const [base, duck] = gains

    setTime(1)
    music.duck({ target: 0.25, holdSeconds: 0.5, attackSeconds: 0.1, releaseSeconds: 0.2 })
    const scheduled = [...duck!.gain.events]
    expect(scheduled.length).toBeGreaterThan(0)

    // Mid-duck volume change: touches only the base gain.
    setTime(1.2)
    music.setVolume(0.5)
    expect(base!.gain.value).toBe(0.5)
    expect(duck!.gain.events).toEqual(scheduled)

    // Envelope still attenuates mid-hold, releases back to coefficient 1,
    // so the bus ends at the *current* base volume (0.5 × 1).
    expect(duck!.gain.at(1.15)).toBeCloseTo(0.25, 5)
    expect(duck!.gain.at(2)).toBeCloseTo(1, 5)
  })

  it("mute/unmute during a duck leaves the envelope running and never leaks sound", () => {
    const { buses, gains, setTime } = setup()
    const music = buses.get("music")
    music.setVolume(0.8)
    const [base, duck] = gains

    setTime(0)
    music.duck({ target: 0.3, holdSeconds: 1, attackSeconds: 0.1, releaseSeconds: 0.3 })
    const scheduled = [...duck!.gain.events]

    setTime(0.5)
    music.mute()
    expect(base!.gain.value).toBe(0)
    // Effective gain is base × coefficient = 0 everywhere, even mid-envelope.
    for (const t of [0, 0.05, 0.5, 1.0, 1.2, 1.4]) {
      expect(base!.gain.value * duck!.gain.at(t)).toBe(0)
    }

    setTime(0.8)
    music.unmute()
    // Restores the last user-set volume; envelope untouched throughout.
    expect(base!.gain.value).toBe(0.8)
    expect(duck!.gain.events).toEqual(scheduled)
  })

  it("a duck on a muted bus keeps the output silent", () => {
    const { buses, gains } = setup({ fx: { volume: 0.7, muted: true } })
    const fx = buses.get("fx")
    const [base, duck] = gains
    expect(base!.gain.value).toBe(0)

    fx.duck({ target: 0.5, holdSeconds: 0.2, attackSeconds: 0.05, releaseSeconds: 0.1 })
    // The envelope runs (harmlessly) on the duck stage…
    expect(duck!.gain.events.length).toBeGreaterThan(0)
    // …but the base stage stays at 0, so nothing leaks.
    for (const t of [0, 0.05, 0.1, 0.25, 0.35]) {
      expect(base!.gain.value * duck!.gain.at(t)).toBe(0)
    }
    expect(fx.isMuted()).toBe(true)
    expect(fx.getVolume()).toBe(0.7)
  })

  it("re-ducking mid-envelope starts from the current coefficient (no jump)", () => {
    const { buses, gains, setTime } = setup()
    const music = buses.get("music")
    const [, duck] = gains

    setTime(0)
    music.duck({ target: 0.2, holdSeconds: 1, attackSeconds: 0.2, releaseSeconds: 0.2 })
    // Mid-attack: coefficient is halfway between 1 and 0.2.
    setTime(0.1)
    const mid = duck!.gain.at(0.1)
    expect(mid).toBeCloseTo(0.6, 5)

    music.duck({ target: 0.4, holdSeconds: 0.1, attackSeconds: 0.1, releaseSeconds: 0.1 })
    // The stale tail of the first envelope was cancelled…
    expect(duck!.gain.events.some((e) => e.time >= 0.1 && e.value === 0.2)).toBe(false)
    // …and the new envelope anchors at the interrupted coefficient.
    const anchor = duck!.gain.events.find((e) => e.type === "set" && e.time === 0.1)
    expect(anchor).toBeDefined()
    expect(anchor!.value).toBeCloseTo(0.6, 5)
    // New envelope ramps to its own target and releases to 1.
    expect(duck!.gain.at(0.2)).toBeCloseTo(0.4, 5)
    expect(duck!.gain.at(0.4)).toBeCloseTo(1, 5)
  })

  it("unmute restores the last user-set volume, even when set while muted", () => {
    const { buses, gains } = setup()
    const music = buses.get("music")
    const [base] = gains

    music.setVolume(0.8)
    music.mute()
    music.setVolume(0.3)
    expect(base!.gain.value).toBe(0)
    music.unmute()
    expect(music.getVolume()).toBe(0.3)
    expect(base!.gain.value).toBe(0.3)
  })

  it("a duck after a previous envelope fully released starts from 1", () => {
    const { buses, gains, setTime } = setup()
    const music = buses.get("music")
    const [, duck] = gains

    setTime(0)
    music.duck({ target: 0.2, holdSeconds: 0.1, attackSeconds: 0.1, releaseSeconds: 0.1 })
    setTime(1) // long after release
    music.duck({ target: 0.5, holdSeconds: 0.1, attackSeconds: 0.1, releaseSeconds: 0.1 })
    const anchor = duck!.gain.events.find((e) => e.type === "set" && e.time === 1)
    expect(anchor).toBeDefined()
    expect(anchor!.value).toBe(1)
  })
})
