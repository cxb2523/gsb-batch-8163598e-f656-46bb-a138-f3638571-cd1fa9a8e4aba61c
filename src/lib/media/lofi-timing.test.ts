// End-to-end timing races for the lofi rack across MediaOverride, the real
// owner of the effect queue: settings messages arrive over window.postMessage
// and are processed one at a time, while the rack's worklet modules load
// asynchronously. These pin the acceptance scenarios on the actual call path:
// all-off and bypass landing mid-build, a failing build retried successfully,
// and a disconnect/reconnect leaving the chain matching the newest settings.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AudioManager from '$lib/audio-effects/audio-manager'
import Equalizer from '$lib/audio-effects/equalizer'
import MSProcessor from '$lib/audio-effects/ms-processor'
import Reverb from '$lib/audio-effects/reverb'
import Lofi from '$lib/audio-effects/lofi-rack'
import MediaOverride from './media-override'
import {
    DEFAULT_EFFECT_SETTINGS,
    normalizeEffectSettings,
    type EffectSettings
} from '$lib/audio-effects/lofi/audio/effect-settings'

const off: EffectSettings = normalizeEffectSettings(DEFAULT_EFFECT_SETTINGS)
const on: EffectSettings = normalizeEffectSettings({
    ...DEFAULT_EFFECT_SETTINGS,
    lowPass: { enabled: true, intensity: 60 }
})
const louder: EffectSettings = normalizeEffectSettings({
    ...DEFAULT_EFFECT_SETTINGS,
    lowPass: { enabled: true, intensity: 90 }
})

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((res) => (resolve = res))
    return { promise, resolve }
}

async function flush(times = 16) {
    for (let i = 0; i < times; i++) await Promise.resolve()
}

/** The shared Web Audio mock lacks these; transitions call them. */
function patchGain(node: AudioNode) {
    const gain = (node as GainNode).gain as any
    gain.cancelScheduledValues ??= () => {}
    gain.setValueAtTime ??= () => {}
    gain.linearRampToValueAtTime ??= () => {}
    return node as GainNode
}

describe('lofi rack timing races (MediaOverride path)', () => {
    let manager: AudioManager
    let lofi: Lofi
    let override: MediaOverride
    let addModule: ReturnType<typeof vi.fn>
    let connectSpy: ReturnType<typeof vi.spyOn>
    let ctx: AudioContext

    beforeEach(() => {
        // MediaOverride talks to playbackRate/preservesPitch on the element.
        vi.stubGlobal('HTMLMediaElement', class HTMLMediaElement {})
        vi.stubGlobal('sessionStorage', {
            getItem: (key: string) => {
                if (key === 'chorus:worklets_path') return '/worklets/'
                if (key === 'chorus:sounds_path') return '/sounds/'
                return null
            }
        })
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
        )
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})

        const element = Object.assign(new HTMLMediaElement(), {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn()
        })
        manager = new AudioManager(element)
        ctx = new AudioContext()
        const anyManager = manager as any
        anyManager._audioContext = ctx
        anyManager._destination = ctx.destination
        anyManager._source = ctx.createGain()
        anyManager._gainNode = patchGain(ctx.createGain())
        anyManager._soundTouchNode = ctx.createGain()
        // The chain is "ready" for the override's guards; initialize() itself is
        // left un-awaited (its setup promise resolves immediately here).
        anyManager._isInitialized = true
        anyManager._setupPromise = Promise.resolve()

        addModule = ctx.audioWorklet.addModule as unknown as ReturnType<typeof vi.fn>
        addModule.mockImplementation(() => Promise.resolve())

        lofi = new Lofi(manager)
        override = new MediaOverride({
            lofi,
            reverb: new Reverb(manager),
            equalizer: new Equalizer(manager),
            msProcessor: new MSProcessor(manager),
            source: element,
            audioManager: manager
        })
        connectSpy = vi.spyOn(manager, 'connectLofi')
    })

    const connected = () => manager.hasEffect('lofi')

    it('switching all effects off mid-build leaves the chain untouched', async () => {
        const gate = deferred()
        addModule.mockImplementation(() => gate.promise)

        const first = override.updateLofi(on)
        await flush()
        expect(connected()).toBe(false)

        // Second message while the first update is still awaiting the modules.
        const second = override.updateLofi(off)

        gate.resolve()
        await Promise.all([first, second])
        await flush()

        expect(connected()).toBe(false)
        expect(connectSpy).not.toHaveBeenCalled()
    })

    it('bypassing the extension mid-build keeps the rack off the graph', async () => {
        const gate = deferred()
        addModule.mockImplementation(() => gate.promise)

        const update = override.updateLofi(on)
        await flush()

        override.teardown() // master off: bypass()
        expect(manager.isBypassed).toBe(true)

        gate.resolve()
        await update
        await flush()

        expect(connected()).toBe(false)
        expect(manager.isBypassed).toBe(true)
        expect(connectSpy).not.toHaveBeenCalled()
    })

    it('a failed build is retried by the next settings message and connects once', async () => {
        addModule.mockImplementation(() => Promise.reject(new Error('worklet 404')))

        await override.updateLofi(on)
        await flush()
        expect(connected()).toBe(false)

        addModule.mockImplementation(() => Promise.resolve())
        await override.updateLofi(on)
        await flush()

        expect(connected()).toBe(true)
        expect(connectSpy).toHaveBeenCalledTimes(1)
    })

    it('disconnect then reconnect leaves the rack in the chain again', async () => {
        await override.updateLofi(on)
        expect(connected()).toBe(true)

        // Another effect's update rebuilds the bare chain and re-adds the rack.
        manager.disconnect()
        expect(connected()).toBe(false)
        lofi.reconnect()
        expect(connected()).toBe(true)
    })

    it('follows settings chosen while the master toggle was off', async () => {
        await override.updateLofi(on)
        expect(connected()).toBe(true)

        // Master off bypasses the graph; lofi messages keep arriving but are only
        // recorded (the UI cannot reach the chain while disabled).
        override.teardown()
        expect(manager.isBypassed).toBe(true)
        const offWhileOff = normalizeEffectSettings(DEFAULT_EFFECT_SETTINGS)
        override.noteLofiSettings(offWhileOff)

        // Master on: the rack must not come back when the last choice was "off".
        override.rearm()
        expect(manager.isBypassed).toBe(false)
        expect(connected()).toBe(false)

        // Turning an effect back on connects it again.
        await override.updateLofi(on)
        expect(connected()).toBe(true)
    })

    it('the intensity slider path does not rebuild the chain', async () => {
        await override.updateLofi(on)
        expect(connected()).toBe(true)
        connectSpy.mockClear()
        const muteSpy = vi.spyOn(manager, 'muteForTransition')
        const removeSpy = vi.spyOn(manager, 'removeEffect')

        override.tweakLofi(louder)
        await flush()

        expect(connected()).toBe(true)
        expect(connectSpy).not.toHaveBeenCalled()
        expect(removeSpy).not.toHaveBeenCalled()
        // The fast path never mutes or queues a rebuild.
        expect(muteSpy).not.toHaveBeenCalled()
    })
})
