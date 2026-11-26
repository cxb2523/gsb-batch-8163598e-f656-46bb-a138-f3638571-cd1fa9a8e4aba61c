import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createMockHowl } from './mocks';

vi.mock('../../src/runtime', async () => {
  const { createRuntimeMock } = await import('./mocks');
  return createRuntimeMock();
});

import { useSound, useSoundEnabled, useSoundOnChange } from '../../src/hooks';
import { abandonStaleSound, claimSound, freeSound, isSoundEnabled, isSoundPlayerStale } from '../../src/runtime';

let mockHowl: ReturnType<typeof createMockHowl>;

beforeEach(() => {
  vi.clearAllMocks();
  mockHowl = createMockHowl();
  vi.mocked(isSoundEnabled).mockReturnValue(true);
  vi.mocked(claimSound).mockResolvedValue(mockHowl);
});

/** Helper: render useSound and flush the preloadSounds effect */
async function renderUseSound(soundName = 'ui/toggle_on') {
  const hook = renderHook(() => useSound(soundName));
  await act(async () => {});
  return hook;
}

/** Helper: trigger play and flush its async state updates */
async function triggerPlay(result: { current: ReturnType<typeof useSound> }) {
  act(() => {
    void result.current.play();
  });
  // Flush the async chain (unlockAudioContext → claimSound → setIsPlaying)
  await act(async () => {});
}

describe('useSound', () => {
  it('returns the correct shape', async () => {
    const { result } = await renderUseSound();
    expect(result.current).toHaveProperty('play');
    expect(result.current).toHaveProperty('stop');
    expect(result.current).toHaveProperty('pause');
    expect(result.current).toHaveProperty('resume');
    expect(result.current).toHaveProperty('isPlaying');
    expect(result.current).toHaveProperty('isLoaded');
    expect(result.current).toHaveProperty('checkPermission');
    expect(typeof result.current.play).toBe('function');
    expect(typeof result.current.stop).toBe('function');
    expect(typeof result.current.isPlaying).toBe('boolean');
  });

  it('plays loops on a separate player and stops both', async () => {
    const loopHowl = createMockHowl();
    vi.mocked(claimSound).mockImplementation(async (_name, options) => (options?.loop ? loopHowl : mockHowl));
    const { result } = await renderUseSound();

    act(() => {
      void result.current.play({ loop: true });
    });
    await act(async () => {});
    expect(claimSound).toHaveBeenCalledWith('ui/toggle_on', { loop: true });
    expect(loopHowl.loop).toHaveBeenCalledWith(true);
    expect(loopHowl.play).toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(true);

    await triggerPlay(result);
    expect(mockHowl.play).toHaveBeenCalled();

    act(() => result.current.stop());
    expect(loopHowl.stop).toHaveBeenCalled();
    expect(mockHowl.stop).toHaveBeenCalled();
    expect(freeSound).toHaveBeenCalledWith('ui/toggle_on', { loop: true });
    expect(freeSound).toHaveBeenCalledWith('ui/toggle_on');
    expect(result.current.isPlaying).toBe(false);
  });

  it('play() calls claimSound then plays', async () => {
    const { result } = await renderUseSound();
    await triggerPlay(result);

    expect(claimSound).toHaveBeenCalledWith('ui/toggle_on');
    expect(mockHowl.play).toHaveBeenCalled();
  });

  it('play() does nothing when sounds are disabled', async () => {
    vi.mocked(isSoundEnabled).mockReturnValue(false);
    const { result } = renderHook(() => useSound('ui/toggle_on'));
    await act(async () => {});

    await act(async () => {
      await result.current.play();
    });

    expect(claimSound).not.toHaveBeenCalled();
  });

  it('stop() calls howl.stop() and frees sound', async () => {
    const { result } = await renderUseSound();
    await triggerPlay(result);

    act(() => {
      result.current.stop();
    });

    expect(mockHowl.stop).toHaveBeenCalled();
    expect(freeSound).toHaveBeenCalled();
  });

  it('pause() calls howl.pause()', async () => {
    const { result } = await renderUseSound();
    await triggerPlay(result);

    act(() => {
      result.current.pause();
    });

    expect(mockHowl.pause).toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(false);
  });

  it('resume() replays active sounds', async () => {
    const { result } = await renderUseSound();
    await triggerPlay(result);

    act(() => {
      result.current.pause();
    });
    act(() => {
      result.current.resume();
    });
    // resume calls unlockAudioContext().then(...) — flush its microtasks
    await act(async () => {});

    expect(mockHowl.play).toHaveBeenCalledTimes(2);
    expect(mockHowl.play).toHaveBeenLastCalledWith(1);
  });

  it('cleanup on unmount stops and frees sound', async () => {
    const { result, unmount } = await renderUseSound();
    await triggerPlay(result);

    unmount();

    expect(mockHowl.stop).toHaveBeenCalled();
    expect(freeSound).toHaveBeenCalled();
  });

  it('switches to a fresh player when its current one is invalidated by a hot update', async () => {
    const oldHowl = createMockHowl();
    const newHowl = createMockHowl();
    vi.mocked(claimSound)
      .mockResolvedValueOnce(oldHowl)
      .mockResolvedValueOnce(newHowl);

    const { result } = await renderUseSound();
    await triggerPlay(result);
    expect(oldHowl.play).toHaveBeenCalledTimes(1);

    // A pack re-registration invalidated the old player
    vi.mocked(isSoundPlayerStale).mockImplementation((howl) => howl === oldHowl);
    await triggerPlay(result);

    // The new play never reaches the stale player
    expect(oldHowl.play).toHaveBeenCalledTimes(1);
    expect(newHowl.play).toHaveBeenCalledTimes(1);
    // The stale player's claim is kept so it can finish, not released on the spot
    expect(freeSound).not.toHaveBeenCalledWith('ui/toggle_on');
  });

  it('stop() silences and releases players invalidated by a hot update', async () => {
    const oldHowl = createMockHowl();
    const newHowl = createMockHowl();
    vi.mocked(claimSound)
      .mockResolvedValueOnce(oldHowl)
      .mockResolvedValueOnce(newHowl);

    const { result } = await renderUseSound();
    await triggerPlay(result);

    vi.mocked(isSoundPlayerStale).mockImplementation((howl) => howl === oldHowl);
    await triggerPlay(result);

    act(() => result.current.stop());

    expect(oldHowl.stop).toHaveBeenCalled();
    expect(newHowl.stop).toHaveBeenCalled();
    // Both claims are released: one for the abandoned player, one for the current player
    expect(freeSound).toHaveBeenCalledWith('ui/toggle_on');
  });

  it('does not reuse a stale player when it is not playing', async () => {
    const oldHowl = createMockHowl();
    const newHowl = createMockHowl();
    vi.mocked(claimSound)
      .mockResolvedValueOnce(oldHowl)
      .mockResolvedValueOnce(newHowl);

    const { result } = await renderUseSound();
    await triggerPlay(result);

    vi.mocked(isSoundPlayerStale).mockImplementation((howl) => howl === oldHowl);
    await triggerPlay(result);

    // Playback ended on the old player: the hook releases its claim on it through the stale path so
    // the newer player's claim stays intact
    const endHandlers = oldHowl.on.mock.calls.filter(([event]) => event === 'end');
    expect(endHandlers.length).toBeGreaterThan(0);
    act(() => {
      endHandlers[0][1](1);
    });

    expect(abandonStaleSound).toHaveBeenCalledWith('ui/toggle_on');
  });
});

describe('useSoundOnChange', () => {
  it('plays sound when value changes', async () => {
    const { rerender } = renderHook(
      ({ value }) => useSoundOnChange('ui/toggle_on', value),
      { initialProps: { value: 'a' } }
    );
    await act(async () => {});

    rerender({ value: 'b' });

    await vi.waitFor(() => {
      expect(claimSound).toHaveBeenCalledWith('ui/toggle_on');
    });
  });

  it('skips initial render when initial: false', async () => {
    renderHook(() =>
      useSoundOnChange('ui/toggle_on', 'a', { initial: false })
    );
    await act(async () => {});

    expect(mockHowl.play).not.toHaveBeenCalled();
  });

  it('plays on initial render by default', async () => {
    renderHook(() => useSoundOnChange('ui/toggle_on', 'a'));
    await act(async () => {});

    await vi.waitFor(() => {
      expect(claimSound).toHaveBeenCalledWith('ui/toggle_on');
    });
  });
});

describe('useSoundEnabled', () => {
  it('throws without SoundProvider', () => {
    expect(() => {
      renderHook(() => useSoundEnabled());
    }).toThrow();
  });
});
