/**
 * State-consistency tests for AdlMidiCore chip-channel reservations.
 *
 * These tests use a small in-memory mock of the Emscripten module so the
 * reservation bookkeeping can be exercised without a compiled WASM dist.
 * They cover:
 *   - mask trimming when the chip count is reduced mid-playback
 *   - out-of-range reads/writes
 *   - failed setNumChips leaving state untouched
 *   - close() clearing state and init() restoring a clean slate
 *   - retained masks being re-applied to the backend after a chip rebuild
 *
 * A separate block at the bottom runs the same contract against the real
 * nuked WASM build when dist/ is available, including genuine allocator
 * non-occupation (A5).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { AdlMidiCore } from '../../src/core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', '..', 'dist');
const CORE_PATH = join(DIST_DIR, 'libadlmidi.nuked.core.js');
const MIDI_PATH = join(__dirname, '..', '..', 'test-files', 'canyon.mid');
const HAS_DIST = existsSync(CORE_PATH) && existsSync(MIDI_PATH);

const PLAYER = 0x1337;
const DEFAULT_CHIPS = 2;
const MAX_CHIPS = 100;

/**
 * Build a mock WASM module whose reservation/chip semantics mirror the C API
 * contract (valid chip range, 0 success / negative failure).
 *
 * @param {number} [initialChips]
 */
function createMockModule(initialChips = DEFAULT_CHIPS) {
    const backend = {
        numChips: initialChips,
        /** @type {(number|null)[]} */
        masks: [],
        closedPlayers: 0,
    };

    const module = {
        _adl_init: vi.fn(() => PLAYER),
        _adl_close: vi.fn(() => {
            backend.closedPlayers += 1;
        }),
        _adl_setNumChips: vi.fn((_p, count) => {
            if (!Number.isInteger(count) || count < 1 || count > MAX_CHIPS) {
                return -1;
            }
            backend.numChips = count;
            return 0;
        }),
        _adl_getNumChips: vi.fn(() => backend.numChips),
        _adl_getNumChipsObtained: vi.fn(() => backend.numChips),
        _adl_reserveChipChannels: vi.fn((_p, chipId, mask) => {
            if (chipId < 0 || chipId >= backend.numChips) {
                return -2;
            }
            backend.masks[chipId] = mask >>> 0;
            return 0;
        }),
        _adl_getReservedChipChannels: vi.fn((_p, chipId) => backend.masks[chipId] ?? 0),
        _adl_rt_noteOn: vi.fn(() => {}),
        _adl_rt_noteOff: vi.fn(() => {}),
        _adl_generate: vi.fn(() => {}),
        _malloc: vi.fn(() => 4096),
        _free: vi.fn(() => {}),
        HEAP16: new Int16Array(8192),
    };

    return { module, backend };
}

/**
 * Construct an AdlMidiCore backed by the mock module and initialize it.
 *
 * @returns {{core: AdlMidiCore, module: any, backend: ReturnType<typeof createMockModule>['backend']}}
 */
function createInitializedCore(initialChips = DEFAULT_CHIPS) {
    const core = new AdlMidiCore();
    const { module, backend } = createMockModule(initialChips);
    core._module = module;
    core.init(44100);
    return { core, module, backend };
}

describe('AdlMidiCore chip reservations (mock backend)', () => {
    let ctx;

    beforeEach(() => {
        ctx = createInitializedCore();
    });

    afterEach(() => {
        ctx?.core?.close();
        ctx = null;
    });

    it('tracks a reservation and reads the same mask back', () => {
        const { core } = ctx;
        expect(core.reserveChipChannels(0, 0x7)).toBe(true);
        expect(core.getReservedChipChannels(0)).toBe(0x7);

        // mask 0 releases but the chip stays valid
        expect(core.reserveChipChannels(0, 0)).toBe(true);
        expect(core.getReservedChipChannels(0)).toBe(0);
    });

    it('A1: trims masks on chips removed by a successful shrink, keeps in-range masks', () => {
        const { core } = ctx;

        expect(core.setNumChips(4)).toBe(true);
        const masks = [0x1, 0x2, 0x4, 0x8];
        masks.forEach((mask, chipId) => {
            expect(core.reserveChipChannels(chipId, mask)).toBe(true);
        });

        masks.forEach((mask, chipId) => {
            expect(core.getReservedChipChannels(chipId)).toBe(mask);
        });

        // Shrink 4 -> 2 "mid playback".
        expect(core.setNumChips(2)).toBe(true);

        expect(core.getReservedChipChannels(0)).toBe(0x1);
        expect(core.getReservedChipChannels(1)).toBe(0x2);
        // Removed chips read as 0 rather than returning stale masks.
        expect(core.getReservedChipChannels(2)).toBe(0);
        expect(core.getReservedChipChannels(3)).toBe(0);
        expect(core.getReservedChipChannels(999)).toBe(0);
    });

    it('A1: shrinking without any reservations still succeeds', () => {
        const { core } = ctx;
        expect(core.setNumChips(8)).toBe(true);
        expect(() => core.setNumChips(1)).not.toThrow();
        expect(core.getReservedChipChannels(0)).toBe(0);
    });

    it('A2: out-of-range reserve returns false and never throws; get returns 0', () => {
        const { core, module } = ctx;

        expect(() => core.reserveChipChannels(999, 0x7)).not.toThrow();
        expect(core.reserveChipChannels(999, 0x7)).toBe(false);
        expect(core.getReservedChipChannels(999)).toBe(0);

        // Negative / non-integer ids are rejected the same way.
        expect(core.reserveChipChannels(-1, 0x7)).toBe(false);
        expect(core.getReservedChipChannels(-1)).toBe(0);
        expect(core.reserveChipChannels(1.5, 0x7)).toBe(false);
        expect(core.getReservedChipChannels(Number.NaN)).toBe(0);

        // JS-side bounds reject before touching the backend with a bad chip id.
        const badCalls = module._adl_reserveChipChannels.mock.calls
            .filter(([, chipId]) => chipId === 999 || chipId === -1);
        expect(badCalls).toHaveLength(0);
    });

    it('A2: chip immediately at the new count boundary is out of range', () => {
        const { core } = ctx;
        expect(core.setNumChips(2)).toBe(true);
        expect(core.reserveChipChannels(1, 0x1)).toBe(true);
        expect(core.reserveChipChannels(2, 0x1)).toBe(false);
        expect(core.getReservedChipChannels(2)).toBe(0);
    });

    it('A3: a failed setNumChips leaves reservation state unchanged', () => {
        const { core } = ctx;

        expect(core.reserveChipChannels(0, 0xbeef)).toBe(true);
        expect(core.getReservedChipChannels(0)).toBe(0xbeef);

        for (const illegal of [0, -1, -8, MAX_CHIPS + 1, 9999]) {
            expect(core.setNumChips(illegal)).toBe(false);
            // Mask and effective chip range are untouched.
            expect(core.getReservedChipChannels(0)).toBe(0xbeef);
            // If the previous known count is the default (2), chip 1 stays valid.
            expect(core.reserveChipChannels(1, 0x4)).toBe(true);
            expect(core.getReservedChipChannels(1)).toBe(0x4);
            core.reserveChipChannels(1, 0);
        }
    });

    it('A3: failed shrink attempt must not trim higher-chip masks', () => {
        const { core } = ctx;
        expect(core.setNumChips(4)).toBe(true);
        expect(core.reserveChipChannels(3, 0x8)).toBe(true);

        expect(core.setNumChips(-2)).toBe(false);

        expect(core.getReservedChipChannels(3)).toBe(0x8);
        expect(core.reserveChipChannels(3, 0)).toBe(true);
    });

    it('A3: failed setNumChips neither replays reservations nor changes range', () => {
        const { core, module } = ctx;
        expect(core.reserveChipChannels(0, 0xbeef)).toBe(true);
        module._adl_reserveChipChannels.mockClear();

        expect(core.setNumChips(0)).toBe(false);

        expect(module._adl_reserveChipChannels).not.toHaveBeenCalled();
        // Default range (2 chips) is still in effect: chip 1 remains valid.
        expect(core.reserveChipChannels(1, 0x2)).toBe(true);
        expect(core.getReservedChipChannels(0)).toBe(0xbeef);
    });

    it('A4: close clears records and reservation APIs throw not initialized', () => {
        const { core } = ctx;
        expect(core.reserveChipChannels(0, 0x7)).toBe(true);

        core.close();

        expect(() => core.reserveChipChannels(0, 0x7)).toThrow(/not initialized/i);
        expect(() => core.getReservedChipChannels(0)).toThrow(/not initialized/i);
        // Out-of-range reads also surface the lifecycle error, not 0, because
        // there is no player to validate against.
        expect(() => core.getReservedChipChannels(999)).toThrow(/not initialized/i);
    });

    it('A4: init() after close() yields a clean reservation slate', () => {
        const { core, backend } = ctx;
        expect(core.reserveChipChannels(0, 0x7)).toBe(true);
        expect(core.reserveChipChannels(1, 0x9)).toBe(true);

        core.close();
        expect(backend.closedPlayers).toBe(1);

        expect(core.init(44100)).toBe(true);

        expect(core.getReservedChipChannels(0)).toBe(0);
        expect(core.getReservedChipChannels(1)).toBe(0);
        expect(core.getReservedChipChannels(999)).toBe(0);

        // The fresh instance is usable normally.
        expect(core.reserveChipChannels(0, 0x5)).toBe(true);
        expect(core.getReservedChipChannels(0)).toBe(0x5);
    });

    it('A4: close() is idempotent and a never-initialized core can close', () => {
        const bare = new AdlMidiCore();
        expect(() => bare.close()).not.toThrow();

        const { core } = ctx;
        expect(() => {
            core.close();
            core.close();
        }).not.toThrow();
        ctx = null; // already closed; skip afterEach close
    });

    it('A5 (backend sync): retained masks are re-applied after a successful chip change', () => {
        const { core, module } = ctx;

        expect(core.setNumChips(4)).toBe(true);
        expect(core.reserveChipChannels(0, 0x1)).toBe(true);
        expect(core.reserveChipChannels(1, 0x2)).toBe(true);
        expect(core.reserveChipChannels(3, 0x8)).toBe(true);

        module._adl_reserveChipChannels.mockClear();

        expect(core.setNumChips(2)).toBe(true);

        const player = core.player;
        expect(module._adl_reserveChipChannels).toHaveBeenCalledTimes(2);
        expect(module._adl_reserveChipChannels).toHaveBeenNthCalledWith(1, player, 0, 0x1);
        expect(module._adl_reserveChipChannels).toHaveBeenNthCalledWith(2, player, 1, 0x2);

        const replayedChipIds = module._adl_reserveChipChannels.mock.calls.map((c) => c[1]);
        expect(replayedChipIds).not.toContain(2);
        expect(replayedChipIds).not.toContain(3);
    });

    it('works for an instance wired up manually without calling init()', () => {
        // Custom backends/tests may assign the module/player directly.
        const core = new AdlMidiCore();
        const { module } = createMockModule(2);
        core._module = module;
        core._player = PLAYER;

        expect(core.reserveChipChannels(0, 0x7)).toBe(true);
        expect(core.getReservedChipChannels(0)).toBe(0x7);
        expect(core.reserveChipChannels(999, 0x7)).toBe(false);
        expect(core.getReservedChipChannels(999)).toBe(0);

        core.close();
        expect(() => core.getReservedChipChannels(0)).toThrow(/not initialized/i);
    });
});

describe.skipIf(!HAS_DIST)('AdlMidiCore reservations on real WASM', () => {
    /** @type {AdlMidiCore | undefined} */
    let synth;

    beforeEach(async () => {
        synth = await AdlMidiCore.create({ corePath: CORE_PATH });
        synth.init(44100);
        synth.setBank(72);
    });

    afterEach(() => {
        synth?.close();
        synth = undefined;
    });

    it('A1: trims masks after a real 4 -> 2 setNumChips', () => {
        const core = /** @type {AdlMidiCore} */ (synth);
        expect(core.setNumChips(4)).toBe(true);
        const masks = [0x11, 0x22, 0x44, 0x88];
        masks.forEach((mask, i) => expect(core.reserveChipChannels(i, mask)).toBe(true));

        expect(core.setNumChips(2)).toBe(true);
        expect(core.getNumChipsObtained()).toBe(2);

        expect(core.getReservedChipChannels(0)).toBe(0x11);
        expect(core.getReservedChipChannels(1)).toBe(0x22);
        expect(core.getReservedChipChannels(2)).toBe(0);
        expect(core.getReservedChipChannels(3)).toBe(0);
    });

    it('A2: 999 is safely out of range on the real backend', () => {
        const core = /** @type {AdlMidiCore} */ (synth);
        expect(core.reserveChipChannels(999, 0x7)).toBe(false);
        expect(core.getReservedChipChannels(999)).toBe(0);
    });

    it('A3: illegal chip count returns false and keeps the mask', () => {
        const core = /** @type {AdlMidiCore} */ (synth);
        expect(core.reserveChipChannels(0, 0x1234)).toBe(true);
        expect(core.setNumChips(0)).toBe(false);
        expect(core.getReservedChipChannels(0)).toBe(0x1234);
    });

    it('A4: close/init resets reservation state', () => {
        let core = /** @type {AdlMidiCore} */ (synth);
        expect(core.reserveChipChannels(0, 0x7)).toBe(true);
        core.close();
        expect(() => core.getReservedChipChannels(0)).toThrow(/not initialized/i);

        core.init(44100);
        synth = core;
        expect(core.getReservedChipChannels(0)).toBe(0);
    });

    it('A5: reserved channels stay free of MIDI voices after a chip change', () => {
        const core = /** @type {AdlMidiCore} */ (synth);

        // Use plain 2-op voices so channel indexing is unambiguous.
        core.setNumFourOpChannels(0);
        expect(core.setNumChips(2)).toBe(true);

        // Reserve the first two per-chip OPL3 channels.
        const reservedMask = 0x3;
        expect(core.reserveChipChannels(0, reservedMask)).toBe(true);

        // Change the chip count again; the retained mask must be re-applied
        // and remain observable.
        expect(core.setNumChips(3)).toBe(true);
        expect(core.getReservedChipChannels(0)).toBe(reservedMask);
        expect(core.setNumChips(1)).toBe(true);
        expect(core.getReservedChipChannels(0)).toBe(reservedMask);

        // Pile on simultaneous notes to put allocator pressure on low channels.
        core.programChange(0, 0);
        for (let note = 48; note < 72; note++) {
            core.noteOn(0, note, 110);
        }
        for (let i = 0; i < 4; i++) {
            core.generate(2048);
        }

        const { text } = core.describeChannels();
        // First two global channels == chip 0 local channels 0 and 1.
        expect(text[0]).toBe('-');
        expect(text[1]).toBe('-');

        // Sanity: the notes were allocated somewhere (not everything free).
        const occupied = [...text].filter((ch) => ch === '+' || ch === '#' || ch === '@').length;
        expect(occupied).toBeGreaterThan(2);

        for (let note = 48; note < 72; note++) {
            core.noteOff(0, note);
        }
        core.panic();
    });

    it('trims masks when chip count is reduced while a MIDI file is playing', () => {
        const core = /** @type {AdlMidiCore} */ (synth);
        const midi = readFileSync(MIDI_PATH);
        expect(core.loadMidi(midi)).toBe(true);

        core.play(4096); // begin playback before changing chip count

        expect(core.setNumChips(4)).toBe(true);
        const masks = [0x3, 0xc, 0x30, 0xc0];
        masks.forEach((mask, chipId) => {
            expect(core.reserveChipChannels(chipId, mask)).toBe(true);
        });

        // Keep playback going across the shrink.
        for (let i = 0; i < 4; i++) {
            core.play(4096);
        }

        expect(core.setNumChips(2)).toBe(true);

        expect(core.getReservedChipChannels(0)).toBe(0x3);
        expect(core.getReservedChipChannels(1)).toBe(0xc);
        expect(core.getReservedChipChannels(2)).toBe(0);
        expect(core.getReservedChipChannels(3)).toBe(0);

        // Playback still emits audio after the mid-flight shrink.
        let maxAbs = 0;
        for (let i = 0; i < 8; i++) {
            const out = core.play(4096);
            for (const sample of out) {
                if (Number.isFinite(sample)) {
                    maxAbs = Math.max(maxAbs, Math.abs(sample));
                }
            }
        }
        expect(maxAbs).toBeGreaterThan(0);
    });
});
