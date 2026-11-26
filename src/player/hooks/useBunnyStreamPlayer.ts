/**
 * `useBunnyStreamPlayer` — a React hook that subscribes to all native
 * {@link BunnyStreamPlayer} events and exposes a single aggregated
 * `PlayerState` (low-frequency) + `PlayerProgress` (high-frequency),
 * eliminating the per-screen `useState` boilerplate.
 *
 * The hook is purely additive: it returns `eventHandlers` that the consumer
 * spreads onto `<BunnyStreamPlayer {...player.eventHandlers} />`, plus a
 * stable `controls` object that proxies the imperative ref API.
 *
 * State is split so that consumers reading only `state.*` (e.g. play/pause
 * buttons) do NOT re-render on every `onProgress` tick (~4×/s).
 */

import type { BunnyVodPlayerRef } from '../BunnyStreamPlayer.types';
import type {
  PlayerEventHandlers,
  PlayerProgress,
  UseBunnyStreamPlayerOptions,
  UseBunnyStreamPlayerResult,
} from './useBunnyStreamPlayer.types';

import * as React from 'react';

import { createPlayerEventHandlers } from '../state/playerEventHandlers';
import { createGenerationScopedReducer } from '../state/playerReducer';
import { DEFAULT_PLAYER_STATE, DEFAULT_PROGRESS } from '../state/playerState';

export type {
  PlayerEventHandlers,
  PlayerProgress,
  PlayerState,
  UseBunnyStreamPlayerOptions,
  UseBunnyStreamPlayerResult,
} from './useBunnyStreamPlayer.types';

/**
 * Subscribes to all {@link BunnyStreamPlayer} events and aggregates them into
 * a single `PlayerState` + `PlayerProgress`. See the file docstring for
 * usage.
 *
 * @param options  Optional user-supplied event handlers.
 * @param sourceKey  Identity key for the current source (e.g. from
 *   `sourceIdentityKey`). When this changes, the hook resets `state` and
 *   `progress` to defaults and advances the source generation — this
 *   prevents stale VOD state (videoId, duration, progress, playback state)
 *   from lingering after a VOD → live transition or a source change. A
 *   handler set retained by the previous, torn-down source recognises itself
 *   as stale and ignores late events (including `onProgress`); current
 *   source events still update state and forward the raw payload to user
 *   callbacks. Pass `undefined` to opt out of resets (legacy behaviour).
 */
export function useBunnyStreamPlayer(
  options?: UseBunnyStreamPlayerOptions,
  sourceKey?: string | number,
): UseBunnyStreamPlayerResult {
  const ref = React.useRef<BunnyVodPlayerRef | null>(null);

  // Monotonic source generation. Mirrored into a ref so the stable reducer
  // fence and the memoised handlers can read the newest value without
  // changing their own identity every render.
  const generationRef = React.useRef(0);
  const scopedReducer = React.useMemo(
    () => createGenerationScopedReducer(() => generationRef.current),
    [],
  );
  const [state, dispatch] = React.useReducer(scopedReducer, DEFAULT_PLAYER_STATE);
  const [progress, setProgress] = React.useState<PlayerProgress>(DEFAULT_PROGRESS);

  // Track the sourceKey + generation in state so a source change can be
  // handled during render (React's endorsed "adjust state when props change"
  // pattern). The reset therefore lands BEFORE children render and before
  // any effect/native event can observe the new source, closing the window
  // where the old effect-based reset raced late native events.
  const [trackedSourceKey, setTrackedSourceKey] = React.useState(sourceKey);
  const [generation, setGeneration] = React.useState(0);

  if (!Object.is(trackedSourceKey, sourceKey)) {
    setTrackedSourceKey(sourceKey);
    setGeneration(generation + 1);
    // Reset BOTH channels together so state is never cleared while progress
    // still holds the old position. RESET is unstamped and always accepted.
    dispatch({ type: 'RESET' });
    setProgress(DEFAULT_PROGRESS);
  }
  // Mirror the current generation for the stable reducer fence and event
  // handlers to read. On the source-changing render this still holds the
  // previous generation; React restarts with the incremented state before
  // events are handled, at which point the mirror advances as well.
  generationRef.current = generation;

  // Store user handlers in a ref so the memoised event handlers below have a
  // stable identity even when the user passes inline callbacks.
  const optionsRef = React.useRef<UseBunnyStreamPlayerOptions | undefined>(options);
  optionsRef.current = options;

  // Stable imperative API — proxies the ref so consumers can call
  // `player.controls.play()` without touching the ref directly.
  const controls = React.useMemo<BunnyVodPlayerRef>(
    () => ({
      play: () => ref.current?.play(),
      pause: () => ref.current?.pause(),
      seekTo: (positionMs: number) => ref.current?.seekTo(positionMs),
      skipForward: (offsetMs?: number) => ref.current?.skipForward(offsetMs),
      skipBackward: (offsetMs?: number) => ref.current?.skipBackward(offsetMs),
      setVolume: (volume: number) => ref.current?.setVolume(volume),
      setPlaybackRate: (rate: number) => ref.current?.setPlaybackRate(rate),
      mute: () => ref.current?.mute(),
      unmute: () => ref.current?.unmute(),
      enterPiP: () => ref.current?.enterPiP(),
      setVideoQuality: (quality) => ref.current?.setVideoQuality(quality),
    }),
    [],
  );

  // One handler set per source generation. Its identity is stable across
  // ordinary re-renders and option changes (options go through optionsRef);
  // only a sourceKey change mints a new set. The previous set — still held by
  // the torn-down native instance — closes over the old bound generation and
  // drops any late events instead of writing them into the new source.
  const eventHandlers = React.useMemo<PlayerEventHandlers>(
    () =>
      createPlayerEventHandlers(dispatch, setProgress, optionsRef, {
        generationRef,
        boundGeneration: generation,
      }),
    // `dispatch`/`setProgress`/refs are all stable; `generation` is the only
    // identity-changing dependency and only moves on a sourceKey change.
    [dispatch, generation],
  );

  return { ref, state, progress, controls, eventHandlers };
}
