// The lofi rack is built asynchronously (five worklet modules plus the crackle
// sample), and the user can move under it while it loads: switch every effect
// off, bypass the extension, or rebuild the whole audio chain. These tests pin
// down that the wiring decision is taken from the newest settings and the
// manager's live state at completion time, never from the settings that started
// the build, and that chain membership is never duplicated or left stale.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AudioManager from './audio-manager'
import Lofi, { hasLofiEffects, sameLofiShape } from './lofi-rack'
import {
    DEFAULT_EFFECT_SETTINGS,
    normalizeEffectSettings,
    type EffectSettings
} from './lofi/audio/effect-settings'

/** The settings with every rack effect off (an empty rack). */
const off: EffectSettings = normalizeEffectSettings(DEFAULT_EFFECT_SETTINGS)
/** Low-pass on: the rack is wanted. */
const on: EffectSettings = normalizeEffectSettings({
    ...DEFAULT_EFFECT_SETTINGS,
    lowPass: { enabled: true, intensity: 60 }
})
/** Same shape as `on`, different intensity: the fast path. */
const louder: EffectSettings = normalizeEffectSettings({
    ...DEFAULT_EFFECT_SETTINGS,
    lowPass: { enabled: true, intensity: 85 }
})
/** A different shape: low-pass off but reverb on (nodes join/leave). */
const reshaped: EffectSettings = normalizeEffectSettings({
    ...DEFAULT_EFFECT_SETTINGS,
    reverb: { enabled: true, intensity: 50, profile: 'hall' }
})

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void }

function deferred(): Deferred {
    let resolve!: () => void
    let reject!: (e: Error) => void
    const promise = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

/** A real AudioManager wired by hand, so no HTMLMediaElement/async init is needed. */
function makeManager() {
    // The manager's own initialize() is left pending on 'loadedmetadata'; give it
    // enough of an element that it does not reject in the background.
    const element = Object.assign(new HTMLMediaElement(), {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        currentSrc: '',
        readyState: 0
    })
    const manager = new AudioManager(element)
    const ctx = new AudioContext()
    const anyManager = manager as any
    anyManager._audioContext = ctx
    anyManager._destination = ctx.destination
    anyManager._source = ctx.createGain()
    anyManager._gainNode = ctx.createGain()
    anyManager._soundTouchNode = ctx.createGain()
    return { manager, ctx, anyManager }
}

/** Let the async build steps (addModule, decodeAudioData, sample load) run. */
async function flush(times = 8) {
    for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('Lofi rack wiring', () => {
    let manager: AudioManager
    let lofi: Lofi
    let ctx: AudioContext
    let addModule: ReturnType<typeof vi.fn>
    let connectSpy: ReturnType<typeof vi.spyOn>
    let removeSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.stubGlobal('HTMLMediaElement', class HTMLMediaElement {})
        vi.stubGlobal('sessionStorage', {
            getItem: (key: string) => (key === 'chorus:worklets_path' ? '/worklets/' : '/sounds/')
        })
        // The crackle sample decodes instead of synthesising seconds of audio.
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
        )
        vi.spyOn(console, 'error').mockImplementation(() => {})

        const made = makeManager()
        manager = made.manager
        ctx = made.ctx
        addModule = ctx.audioWorklet.addModule as unknown as ReturnType<typeof vi.fn>
        addModule.mockImplementation(() => Promise.resolve())
        connectSpy = vi.spyOn(manager, 'connectLofi')
        removeSpy = vi.spyOn(manager, 'removeEffect')
        lofi = new Lofi(manager)
    })

    const connected = () => manager.hasEffect('lofi')

    it('completes a build into the chain exactly once when the effects are still on', async () => {
        const version = lofi.noteSettings(on)
        await lofi.prepare(on)
        lofi.apply(on, version)

        expect(connected()).toBe(true)
        expect(connectSpy).toHaveBeenCalledTimes(1)

        // A duplicate apply and a reconnect must not rewire again.
        lofi.apply(on, version)
        lofi.reconnect()
        expect(connectSpy).toHaveBeenCalledTimes(1)
        expect(connected()).toBe(true)
    })

    it('does not connect when every effect was switched off before the build finished', async () => {
        const gate = deferred()
        addModule.mockImplementation(() => gate.promise)

        const firstVersion = lofi.noteSettings(on)
        const building = lofi.prepare(on)
        await flush()
        expect(connected()).toBe(false)

        // The user switches everything off while the modules load; the newer
        // message is queued behind the build but its settings are recorded now.
        const offVersion = lofi.noteSettings(off)
        lofi.apply(off, offVersion)
        expect(offVersion).toBeGreaterThan(firstVersion)

        gate.resolve()
        await building
        await flush()

        expect(connected()).toBe(false)
        expect(connectSpy).not.toHaveBeenCalled()
    })

    it('does not connect when the master toggle bypassed the chain mid-build', async () => {
        const gate = deferred()
        addModule.mockImplementation(() => gate.promise)

        const version = lofi.noteSettings(on)
        const building = lofi.prepare(on)
        await flush()

        manager.bypass()
        expect(manager.isBypassed).toBe(true)

        gate.resolve()
        await building
        lofi.apply(on, version)
        await flush()

        expect(manager.isBypassed).toBe(true)
        expect(connected()).toBe(false)
        expect(connectSpy).not.toHaveBeenCalled()
    })

    it('leaves a bypassed chain alone even if a late apply asks for the rack', async () => {
        const version = lofi.noteSettings(on)
        await lofi.prepare(on)
        manager.bypass()

        lofi.apply(on, version)
        lofi.reconnect()

        expect(connected()).toBe(false)
        expect(connectSpy).not.toHaveBeenCalled()

        // Master back on: the rack joins again, once.
        manager.restoreChain()
        lofi.reconnect()
        expect(connected()).toBe(true)
        expect(connectSpy).toHaveBeenCalledTimes(1)
    })

    it('retries a failed build and then connects', async () => {
        addModule.mockImplementation(() => Promise.reject(new Error('worklet 404')))

        const firstVersion = lofi.noteSettings(on)
        await lofi.prepare(on)
        lofi.apply(on, firstVersion)
        expect(connected()).toBe(false)
        expect(connectSpy).not.toHaveBeenCalled()

        // The next dispatch is a fresh attempt, not a permanently failed rack.
        addModule.mockImplementation(() => Promise.resolve())
        const version = lofi.noteSettings(on)
        await lofi.prepare(on)
        lofi.apply(on, version)

        expect(connected()).toBe(true)
        expect(connectSpy).toHaveBeenCalledTimes(1)
    })

    it('rejoins the rack after the audio chain is disconnected and reconnected', async () => {
        const version = lofi.noteSettings(on)
        await lofi.prepare(on)
        lofi.apply(on, version)
        expect(connected()).toBe(true)

        manager.disconnect()
        expect(connected()).toBe(false)

        lofi.reconnect()
        expect(connected()).toBe(true)
        // Repeated reconnects are harmless (the rack is already in the chain).
        lofi.reconnect()
        expect(connectSpy).toHaveBeenCalledTimes(2)
    })

    it('does not double-connect when a chain rebuild lands during the build', async () => {
        const gate = deferred()
        addModule.mockImplementation(() => gate.promise)

        const version = lofi.noteSettings(on)
        const building = lofi.prepare(on)
        await flush()

        // Another effect's update rebuilds the bare chain, then re-adds the rack
        // from the newest settings. That reconnect owns the wiring.
        manager.disconnect()
        lofi.reconnect()

        gate.resolve()
        await building
        lofi.apply(on, version)
        await flush()

        expect(connected()).toBe(true)
        expect(connectSpy).toHaveBeenCalledTimes(1)
    })

    it('follows the newest settings, not the ones that started the build', async () => {
        const gate = deferred()
        addModule.mockImplementation(() => gate.promise)

        // Two updates arrive back to back, as they do over the message queue; the
        // second lands while the first is still building. Both are queued in order,
        // so the first update's apply runs after the build, having been overtaken
        // by the newer settings.
        lofi.noteSettings(on)
        const first = lofi.prepare(on).then(() => {
            lofi.apply(on, 1)
        })

        await flush()
        // Second message: a different effect is wanted instead.
        const version = lofi.noteSettings(reshaped)

        gate.resolve()
        await first
        await lofi.prepare(reshaped)
        lofi.apply(reshaped, version)
        await flush()

        expect(connected()).toBe(true)
        expect(connectSpy).toHaveBeenCalledTimes(1)
    })

    it('keeps the intensity-only slider path fast and rebuild-free', async () => {
        const version = lofi.noteSettings(on)
        await lofi.prepare(on)
        lofi.apply(on, version)
        expect(connectSpy).toHaveBeenCalledTimes(1)

        expect(lofi.tweak(louder)).toBe(true)
        expect(connectSpy).toHaveBeenCalledTimes(1)
        expect(removeSpy).not.toHaveBeenCalled()
        expect(connected()).toBe(true)

        // A shape change (an effect switching, or a new reverb space) is not a tweak.
        expect(lofi.tweak(reshaped)).toBe(false)
        expect(sameLofiShape(on, reshaped)).toBe(false)
    })

    it('refuses the fast path when the rack is not in the chain', async () => {
        const version = lofi.noteSettings(on)
        await lofi.prepare(on)
        // Never applied: the rack is built but not connected.
        expect(connected()).toBe(false)
        expect(lofi.tweak(louder)).toBe(false)

        manager.bypass()
        lofi.apply(on, version)
        expect(lofi.tweak(louder)).toBe(false)
    })

    it('removes the rack when the newest settings turn everything off', async () => {
        const version = lofi.noteSettings(on)
        await lofi.prepare(on)
        lofi.apply(on, version)
        expect(connected()).toBe(true)

        const offVersion = lofi.noteSettings(off)
        lofi.apply(off, offVersion)
        expect(connected()).toBe(false)

        // Turning an effect back on re-adds it.
        const againVersion = lofi.noteSettings(on)
        lofi.apply(on, againVersion)
        expect(connected()).toBe(true)
    })

    it('ignores a stale queued apply whose settings were superseded', async () => {
        const version = lofi.noteSettings(on)
        await lofi.prepare(on)

        // A newer message (all off) was recorded; an older queued task must not
        // re-add the rack afterwards.
        lofi.noteSettings(off)
        lofi.apply(on, version)

        expect(connected()).toBe(false)
        expect(connectSpy).not.toHaveBeenCalled()
    })
})

describe('hasLofiEffects', () => {
    it('counts enabled nodes and the rack EQ, not slowdown', () => {
        expect(hasLofiEffects(off)).toBe(false)
        expect(hasLofiEffects(on)).toBe(true)
        expect(
            hasLofiEffects(
                normalizeEffectSettings({
                    ...DEFAULT_EFFECT_SETTINGS,
                    equalizer: { enabled: true, bands: [] }
                })
            )
        ).toBe(true)
        expect(
            hasLofiEffects(
                normalizeEffectSettings({
                    ...DEFAULT_EFFECT_SETTINGS,
                    slowdown: { enabled: true, intensity: 50 }
                })
            )
        ).toBe(false)
    })
})

describe('AudioManager chain bookkeeping', () => {
    it('refuses a lofi connect while bypassed, and reports membership truthfully', () => {
        vi.stubGlobal('HTMLMediaElement', class HTMLMediaElement {})
        const { manager, ctx } = makeManager()
        const rack = { input: ctx.createGain(), output: ctx.createGain() }

        manager.connectLofi(rack)
        expect(manager.hasEffect('lofi')).toBe(true)

        manager.bypass()
        expect(manager.isBypassed).toBe(true)
        // bypass() dropped the registered effects; a late rebuild of the rack
        // must not slip back into the bypassed graph.
        expect(manager.hasEffect('lofi')).toBe(false)
        manager.connectLofi(rack)
        expect(manager.hasEffect('lofi')).toBe(false)

        manager.restoreChain()
        expect(manager.isBypassed).toBe(false)
        manager.connectLofi(rack)
        expect(manager.hasEffect('lofi')).toBe(true)
    })

    it('drops the registered rack on a chain teardown', () => {
        vi.stubGlobal('HTMLMediaElement', class HTMLMediaElement {})
        const { manager, ctx } = makeManager()
        const rack = { input: ctx.createGain(), output: ctx.createGain() }
        manager.connectLofi(rack)
        expect(manager.hasEffect('lofi')).toBe(true)
        manager.disconnect()
        expect(manager.hasEffect('lofi')).toBe(false)
    })
})
