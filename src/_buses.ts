/// <reference path="./env.d.ts" />
import type { BusHandle } from "./_types.ts"

/**
 * Tiny bus mixer. Each bus is a two-stage gain chain:
 *
 *   sound → baseGain (user volume / mute) → duckGain (duck envelope) → master
 *
 * The bus's *effective* gain is always `base × duckCoefficient`. Manual
 * `setVolume` / `mute` / `unmute` only ever touch `baseGain`; `duck()` only
 * ever schedules ramps on `duckGain`. The two layers therefore never clobber
 * each other: changing the volume mid-duck leaves the envelope running, and
 * when the envelope releases (back to coefficient 1) the bus settles on
 * whatever the base gain is at that moment — 0 when muted.
 *
 * Buses are lazily created on first `get(name)` so the wiring cost is zero
 * for callers that never use them.
 */
export function createBuses(
  ctx: AudioContext,
  master: GainNode,
  initial?: Record<string, { volume?: number; muted?: boolean }>,
): {
  /** Resolve the destination node a sound should connect to (bus or master). */
  resolve(name: string | undefined): GainNode
  /** Get or create a bus handle. */
  get(name: string): BusHandle
  /** Underlying base-gain nodes (for testing). */
  nodes(): Map<string, GainNode>
} {
  /** A scheduled duck envelope: piecewise-linear control points over the
   *  duck coefficient (1 = no attenuation), plus the time it fully releases. */
  type Envelope = {
    points: { t: number; v: number }[]
    end: number
  }
  type Bus = {
    name: string
    base: GainNode
    duck: GainNode
    /** Last user-set volume — mute never overwrites it. */
    volume: number
    muted: boolean
    env: Envelope | null
  }
  const buses = new Map<string, Bus>()

  function ensure(name: string): Bus {
    let b = buses.get(name)
    if (b) return b
    const base = ctx.createGain()
    const duck = ctx.createGain()
    const init = initial?.[name]
    const vol = clamp01(init?.volume ?? 1)
    const muted = init?.muted ?? false
    base.gain.value = muted ? 0 : vol
    duck.gain.value = 1
    base.connect(duck)
    duck.connect(master)
    b = { name, base, duck, volume: vol, muted, env: null }
    buses.set(name, b)
    return b
  }

  // Pre-create initial buses so they exist even if never referenced.
  if (initial) {
    for (const name of Object.keys(initial)) ensure(name)
  }

  /** Duck coefficient in effect at `now` — evaluates the active envelope so
   *  a re-duck starts from the current attenuation instead of jumping. */
  function currentCoefficient(b: Bus, now: number): number {
    const env = b.env
    if (!env) return 1
    if (now >= env.end) {
      b.env = null
      return 1
    }
    const pts = env.points
    const first = pts[0] as { t: number; v: number }
    if (now <= first.t) return first.v
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as { t: number; v: number }
      const c = pts[i] as { t: number; v: number }
      if (now <= c.t) {
        const span = c.t - a.t
        if (span <= 0) return c.v
        return a.v + ((c.v - a.v) * (now - a.t)) / span
      }
    }
    return (pts[pts.length - 1] as { t: number; v: number }).v
  }

  function handle(b: Bus): BusHandle {
    return {
      get name() {
        return b.name
      },
      getVolume() {
        return b.volume
      },
      setVolume(value) {
        // Base layer only — a running duck envelope is left untouched and
        // simply scales the new base gain.
        b.volume = clamp01(value)
        b.base.gain.value = b.muted ? 0 : b.volume
      },
      mute() {
        if (b.muted) return
        b.muted = true
        b.base.gain.value = 0
      },
      unmute() {
        if (!b.muted) return
        b.muted = false
        // Restore the last user-set volume, not a stale pre-mute snapshot.
        b.base.gain.value = b.volume
      },
      isMuted() {
        return b.muted
      },
      duck({ target, holdSeconds, attackSeconds = 0.05, releaseSeconds = 0.2 }) {
        const now = ctx.currentTime
        const attack = Math.max(0, attackSeconds)
        const hold = Math.max(0, holdSeconds)
        const release = Math.max(0, releaseSeconds)
        // Re-ducking mid-envelope starts from the *current* coefficient so
        // the new ramp is continuous instead of jumping.
        const start = currentCoefficient(b, now)
        const goal = clamp01(target)
        const end = now + attack + hold + release
        b.env = {
          points: [
            { t: now, v: start },
            { t: now + attack, v: goal },
            { t: now + attack + hold, v: goal },
            { t: end, v: 1 },
          ],
          end,
        }
        const param = b.duck.gain
        param.cancelScheduledValues(now)
        param.setValueAtTime(start, now)
        param.linearRampToValueAtTime(goal, now + attack)
        param.setValueAtTime(goal, now + attack + hold)
        param.linearRampToValueAtTime(1, end)
      },
    }
  }

  return {
    resolve(name) {
      if (!name) return master
      return ensure(name).base
    },
    get(name) {
      return handle(ensure(name))
    },
    nodes() {
      const map = new Map<string, GainNode>()
      for (const [k, v] of buses) map.set(k, v.base)
      return map
    },
  }
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0
  return Math.max(0, Math.min(1, v))
}
