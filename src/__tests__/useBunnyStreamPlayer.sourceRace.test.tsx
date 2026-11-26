import type { UseBunnyStreamPlayerOptions } from '../player/hooks/useBunnyStreamPlayer.types';

import { describe, expect, it, jest } from '@jest/globals';
import { renderHook } from '@testing-library/react-native';

import { useBunnyStreamPlayer } from '../player/hooks/useBunnyStreamPlayer';
import { createGenerationScopedReducer, isGenerationCurrent } from '../player/state/playerReducer';
import { DEFAULT_PLAYER_STATE } from '../player/state/playerState';
import { fire } from './helpers';

// Renders the hook with a controlled `sourceKey` so tests can rerender with a
// new source identity exactly like a screen navigating VOD A -> VOD B/live.
async function renderKeyedHook(
  initialKey: string | number | undefined,
  options?: UseBunnyStreamPlayerOptions,
) {
  return renderHook(
    ({ key, opts }: { key?: string | number; opts?: UseBunnyStreamPlayerOptions }) =>
      useBunnyStreamPlayer(opts, key),
    { initialProps: { key: initialKey, opts: options } },
  );
}

const OLD_READY = { videoId: 'vid-old', durationMs: 60_000 } as const;
const OLD_PROGRESS = { positionMs: 30_000, durationMs: 60_000, progress: 0.5 } as const;
const NEW_READY = { videoId: 'vid-new', durationMs: 120_000 } as const;
const NEW_PROGRESS = { positionMs: 4_000, durationMs: 120_000, progress: 0.03 } as const;

describe('useBunnyStreamPlayer source-switch race', () => {
  it('resets state and progress together the moment sourceKey changes', async () => {
    const { result, rerender, unmount } = await renderKeyedHook('source-a');

    await fire(result.current.eventHandlers.onReady, OLD_READY);
    await fire(result.current.eventHandlers.onProgress, OLD_PROGRESS);
    await fire(result.current.eventHandlers.onError, { code: 'X', message: 'boom' });
    expect(result.current.progress.positionMs).toBe(30_000);
    expect(result.current.state.error).not.toBeNull();

    await rerender({ key: 'source-b', opts: undefined });

    // Both channels are cleared in the same post-switch observation.
    expect(result.current.progress).toEqual({ positionMs: 0, durationMs: 0, progress: 0 });
    expect(result.current.state.videoId).toBeNull();
    expect(result.current.state.durationMs).toBe(0);
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.isLoading).toBe(true);
    await unmount();
  });

  it('drops late old-source events that arrive after sourceKey changes', async () => {
    const onReady = jest.fn();
    const onProgress = jest.fn();
    const onError = jest.fn();
    const { result, rerender, unmount } = await renderKeyedHook('source-a', {
      onReady,
      onProgress,
      onError,
    });

    await fire(result.current.eventHandlers.onReady, OLD_READY);
    await fire(result.current.eventHandlers.onProgress, OLD_PROGRESS);
    expect(onReady).toHaveBeenCalledTimes(1);

    // The torn-down native instance keeps holding THIS handler set.
    const staleHandlers = result.current.eventHandlers;

    await rerender({ key: 'source-b', opts: { onReady, onProgress, onError } });

    // Late events from the old source are delivered through the old set.
    await fire(staleHandlers.onReady, OLD_READY);
    await fire(staleHandlers.onProgress, OLD_PROGRESS);
    await fire(staleHandlers.onError, { code: 'OLD', message: 'late old failure' });
    await fire(staleHandlers.onPlaybackStateChange, { state: 'playing', positionMs: 30_000 });

    // Neither state nor progress is polluted by the old source.
    expect(result.current.state.videoId).toBeNull();
    expect(result.current.state.durationMs).toBe(0);
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.playbackState).toBe('idle');
    expect(result.current.progress).toEqual({ positionMs: 0, durationMs: 0, progress: 0 });

    // Late events from the previous generation are ignored entirely, so the
    // user callbacks receive only the events fired while source-a was current.
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenLastCalledWith(OLD_READY);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    await unmount();
  });

  it('keeps new-source events that arrive immediately after the switch', async () => {
    const onReady = jest.fn();
    const onProgress = jest.fn();
    const { result, rerender, unmount } = await renderKeyedHook('source-a', {
      onReady,
      onProgress,
    });

    await fire(result.current.eventHandlers.onReady, OLD_READY);
    const staleHandlers = result.current.eventHandlers;

    await rerender({ key: 'source-b', opts: { onReady, onProgress } });

    // The new source emits ready/progress right away — these must survive.
    await fire(result.current.eventHandlers.onReady, NEW_READY);
    await fire(result.current.eventHandlers.onProgress, NEW_PROGRESS);

    expect(result.current.state.videoId).toBe('vid-new');
    expect(result.current.state.durationMs).toBe(120_000);
    expect(result.current.state.playbackState).toBe('ready');
    expect(result.current.state.isLoading).toBe(false);
    expect(result.current.progress).toEqual({ ...NEW_PROGRESS });
    expect(onReady).toHaveBeenLastCalledWith(NEW_READY);
    expect(onProgress).toHaveBeenLastCalledWith({ ...NEW_PROGRESS });

    // A late old event interleaved AFTER the new data still cannot overwrite it.
    await fire(staleHandlers.onProgress, OLD_PROGRESS);
    await fire(staleHandlers.onReady, OLD_READY);
    expect(result.current.progress).toEqual({ ...NEW_PROGRESS });
    expect(result.current.state.videoId).toBe('vid-new');
    expect(result.current.state.durationMs).toBe(120_000);
    await unmount();
  });

  it('lets new data win regardless of old/new event interleaving order', async () => {
    const { result, rerender, unmount } = await renderKeyedHook('vod-1');
    const staleHandlers = result.current.eventHandlers;

    await rerender({ key: 'live-1', opts: undefined });

    // Late old event arrives BEFORE the new live source reports in.
    await fire(staleHandlers.onProgress, OLD_PROGRESS);
    expect(result.current.progress.positionMs).toBe(0);

    // New live event is accepted and clears loading.
    await fire(result.current.eventHandlers.onLiveStateChange, {
      state: 'live',
      isLive: true,
    });
    expect(result.current.state.liveState?.state).toBe('live');
    expect(result.current.state.isLoading).toBe(false);

    // More late VOD events remain ignored.
    await fire(staleHandlers.onReady, OLD_READY);
    await fire(staleHandlers.onError, { code: 'OLD', message: 'late' });
    expect(result.current.state.videoId).toBeNull();
    expect(result.current.state.error).toBeNull();
    await unmount();
  });

  it('keeps eventHandlers identity stable across same-source rerenders and option changes', async () => {
    const onReady1 = jest.fn();
    const onReady2 = jest.fn();
    const { result, rerender, unmount } = await renderKeyedHook('source-a', { onReady: onReady1 });

    const handlersBefore = result.current.eventHandlers;
    const onReadyFnBefore = handlersBefore.onReady;

    // Same sourceKey, new inline options object — identity must be stable.
    await rerender({ key: 'source-a', opts: { onReady: onReady2 } });
    expect(result.current.eventHandlers).toBe(handlersBefore);
    expect(result.current.eventHandlers.onReady).toBe(onReadyFnBefore);

    // optionsRef routes through to the newest user callback with raw payload.
    await fire(result.current.eventHandlers.onReady, NEW_READY);
    expect(onReady1).not.toHaveBeenCalled();
    expect(onReady2).toHaveBeenCalledTimes(1);
    expect(onReady2).toHaveBeenCalledWith(NEW_READY);
    await unmount();
  });

  it('does not update state on high-frequency onProgress ticks', async () => {
    const { result, unmount } = await renderKeyedHook('source-a');
    await fire(result.current.eventHandlers.onReady, NEW_READY);
    const stateBefore = result.current.state;

    await fire(result.current.eventHandlers.onProgress, NEW_PROGRESS);
    expect(result.current.progress.positionMs).toBe(4000);
    // Same state reference — progress ticks bypass the reducer.
    expect(result.current.state).toBe(stateBefore);
    expect(result.current.state.durationMs).toBe(120_000);
    await unmount();
  });
});

describe('source generation reducer fence', () => {
  it('accepts unstamped and current-generation actions but rejects older ones', () => {
    expect(isGenerationCurrent(undefined, 2)).toBe(true);
    expect(isGenerationCurrent(2, 2)).toBe(true);
    expect(isGenerationCurrent(3, 2)).toBe(true);
    expect(isGenerationCurrent(1, 2)).toBe(false);

    const reduce = createGenerationScopedReducer(() => 2);
    const ready = { type: 'READY' as const, videoId: 'v', durationMs: 1000 };

    // Current generation reduces normally.
    const next = reduce(DEFAULT_PLAYER_STATE, { ...ready, sourceGeneration: 2 });
    expect(next.videoId).toBe('v');

    // Old generation returns the prior state reference untouched.
    const stale = reduce(next, { type: 'PLAY', sourceGeneration: 1 });
    expect(stale).toBe(next);
    expect(stale.isPlaying).toBe(false);

    // Unstamped RESET always goes through.
    const reset = reduce(next, { type: 'RESET' });
    expect(reset).toBe(DEFAULT_PLAYER_STATE);
  });
});
