import { vi } from 'vitest';

export function createMockHowl() {
  return {
    play: vi.fn().mockReturnValue(1),
    stop: vi.fn(),
    pause: vi.fn(),
    volume: vi.fn(),
    rate: vi.fn(),
    loop: vi.fn(),
    on: vi.fn(),
    playing: vi.fn().mockReturnValue(false),
    unload: vi.fn(),
  };
}

export type MockHowl = ReturnType<typeof createMockHowl>;

/**
 * A mock Howl whose playback state can be driven from a test: `played` simulates `play()`,
 * `finish()` simulates the `end` event after the last playback stops.
 */
export function createControllableHowl() {
  const listeners: Record<string, Array<(id: number) => void>> = {};
  let id = 0;
  let playing = false;
  let ended = false;

  const howl = {
    ...createMockHowl(),
    play: vi.fn(() => {
      playing = true;
      ended = false;
      return ++id;
    }),
    stop: vi.fn(() => {
      playing = false;
      ended = true;
    }),
    playing: vi.fn(() => playing),
    unload: vi.fn(() => {
      playing = false;
    }),
    on: vi.fn((event: string, callback: (id: number) => void) => {
      (listeners[event] ??= []).push(callback);
      return howl;
    }),
    emit(event: string, soundId: number) {
      (listeners[event] ?? []).forEach((callback) => callback(soundId));
    },
    finish(soundId = id) {
      playing = false;
      ended = true;
      howl.emit('end', soundId);
    },
  };

  Object.defineProperty(howl, 'ended', { get: () => ended });

  return howl;
}

export type ControllableHowl = ReturnType<typeof createControllableHowl>;

export function createRuntimeMock(overrides?: Record<string, unknown>) {
  return {
    claimSound: vi.fn().mockResolvedValue(createMockHowl()),
    freeSound: vi.fn().mockReturnValue(null),
    abandonStaleSound: vi.fn().mockReturnValue(null),
    isSoundEnabled: vi.fn().mockReturnValue(true),
    isSoundPlayerStale: vi.fn().mockReturnValue(false),
    sweepRetiredSounds: vi.fn(),
    preloadSounds: vi.fn().mockResolvedValue([]),
    unlockAudioContext: vi.fn().mockResolvedValue(undefined),
    checkAudioPermission: vi.fn().mockResolvedValue('granted'),
    subscribeSoundState: vi.fn().mockReturnValue(() => {}),
    setSoundEnabled: vi.fn(),
    initSoundEnabledState: vi.fn(),
    playSound: vi.fn(),
    initAudioContextUnlock: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}
