import type { LiveStateChangeEvent } from '../BunnyStreamPlayer.types';
import type {
  PlayerEventHandlers,
  PlayerProgress,
  UseBunnyStreamPlayerOptions,
} from '../hooks/useBunnyStreamPlayer.types';
import type { PlayerAction, ScopedPlayerAction } from './playerReducer';
import type { Dispatch, SetStateAction } from 'react';

interface CurrentOptionsRef {
  current: UseBunnyStreamPlayerOptions | undefined;
}

/**
 * Monotonic source-generation scope for one memoised handler set.
 *
 * The hook keeps `generationRef.current` pointed at the newest source and
 * binds each memoised handler set to the generation it was created for.
 * A handler set retained by a torn-down native instance after a
 * `sourceKey` change is therefore able to recognise itself as stale.
 */
export interface HandlerGenerationScope {
  /** Latest generation owned by the hook (mutable ref). */
  generationRef: { current: number };
  /** Generation this handler set was created for. */
  boundGeneration: number;
}

/**
 * A scope is stale only when its bound generation is older than the hook's
 * current generation. Directional (rather than strict inequality) so a
 * transient ref lag can never mark the newest handler set as stale.
 */
function isScopeStale(scope: HandlerGenerationScope | undefined): boolean {
  return scope !== undefined && scope.boundGeneration < scope.generationRef.current;
}

/**
 * Builds an event handler that unwraps `nativeEvent`, dispatches a reducer
 * action, and forwards the same payload to the matching user callback in
 * `optionsRef.current`. The callback is read at call time so option changes
 * between renders take effect without recreating the handler.
 *
 * When a {@link HandlerGenerationScope} is supplied, an event from a previous
 * source generation is ignored entirely — no state action and no user
 * callback — so a late native event from a torn-down source cannot affect
 * either the new source's aggregated state or source-specific user logic.
 * Current-generation events still forward the raw, unwrapped payload.
 */
function bindHandler<E>(
  dispatch: Dispatch<ScopedPlayerAction>,
  optionsRef: CurrentOptionsRef,
  key: keyof UseBunnyStreamPlayerOptions,
  toAction: (e: E) => PlayerAction,
  scope: HandlerGenerationScope | undefined,
): (event: { nativeEvent: E }) => void {
  return (event) => {
    // See isScopeStale: only an older bound generation is ignored.
    if (isScopeStale(scope)) {
      return;
    }
    const payload = event.nativeEvent;
    const action: ScopedPlayerAction = scope
      ? { ...toAction(payload), sourceGeneration: scope.boundGeneration }
      : toAction(payload);
    dispatch(action);
    (optionsRef.current?.[key] as ((p: E) => void) | undefined)?.(payload);
  };
}

/** Builds the `onLiveStateChange` payload, dropping undefined optional fields. */
function buildLiveStatePayload(e: LiveStateChangeEvent) {
  const {
    state: liveState,
    isLive,
    reason,
    targetEpochMs,
    title,
    videoId,
    message,
    dvrEnabled,
  } = e;
  return {
    state: liveState,
    isLive,
    ...(reason !== undefined && { reason }),
    ...(targetEpochMs !== undefined && { targetEpochMs }),
    ...(title !== undefined && { title }),
    ...(videoId !== undefined && { videoId }),
    ...(message !== undefined && { message }),
    ...(dvrEnabled !== undefined && { dvrEnabled }),
  };
}

export function createPlayerEventHandlers(
  dispatch: Dispatch<ScopedPlayerAction>,
  setProgress: Dispatch<SetStateAction<PlayerProgress>>,
  optionsRef: CurrentOptionsRef,
  scope?: HandlerGenerationScope,
): PlayerEventHandlers {
  // Late events from a previous source generation are gated by every
  // state-writing path. Reading the mutable ref at call time lets each
  // memoised per-generation set detect that the hook has moved on.
  const isStale = () => isScopeStale(scope);
  const currentGeneration = scope?.boundGeneration;
  const stamp = <A extends PlayerAction>(action: A): ScopedPlayerAction =>
    currentGeneration === undefined ? action : { ...action, sourceGeneration: currentGeneration };
  return {
    onReady: bindHandler(
      dispatch,
      optionsRef,
      'onReady',
      (e) => ({
        type: 'READY' as const,
        videoId: e.videoId,
        durationMs: e.durationMs,
      }),
      scope,
    ),
    onPlaybackStateChange: bindHandler(
      dispatch,
      optionsRef,
      'onPlaybackStateChange',
      (e) => ({
        type: 'STATE_CHANGE' as const,
        state: e.state,
      }),
      scope,
    ),
    onProgress: (e) => {
      // High-frequency: bypass the reducer entirely. The generation fence
      // still applies so a late old-source tick is ignored (including the
      // user callback) and cannot revive old progress.
      if (isStale()) {
        return;
      }
      const { positionMs, durationMs, progress: prog } = e.nativeEvent;
      setProgress({ positionMs, durationMs, progress: prog });
      optionsRef.current?.onProgress?.({ positionMs, durationMs, progress: prog });
    },
    onError: bindHandler(
      dispatch,
      optionsRef,
      'onError',
      (e) => ({
        type: 'ERROR' as const,
        error: e,
      }),
      scope,
    ),
    onBuffering: bindHandler(
      dispatch,
      optionsRef,
      'onBuffering',
      (e) => ({
        type: 'BUFFERING' as const,
        isBuffering: e.isBuffering,
      }),
      scope,
    ),
    onPlay: bindHandler(dispatch, optionsRef, 'onPlay', () => ({ type: 'PLAY' as const }), scope),
    onPause: bindHandler(
      dispatch,
      optionsRef,
      'onPause',
      () => ({ type: 'PAUSE' as const }),
      scope,
    ),
    onEnd: bindHandler(dispatch, optionsRef, 'onEnd', () => ({ type: 'END' as const }), scope),
    onVolumeChange: bindHandler(
      dispatch,
      optionsRef,
      'onVolumeChange',
      (e) => ({
        type: 'VOLUME' as const,
        volume: e.volume,
        isMuted: e.isMuted,
      }),
      scope,
    ),
    onPlaybackRateChange: bindHandler(
      dispatch,
      optionsRef,
      'onPlaybackRateChange',
      (e) => ({
        type: 'PLAYBACK_RATE' as const,
        rate: e.rate,
      }),
      scope,
    ),
    onVideoSizeChange: bindHandler(
      dispatch,
      optionsRef,
      'onVideoSizeChange',
      (e) => ({
        type: 'VIDEO_SIZE' as const,
        width: e.width,
        height: e.height,
      }),
      scope,
    ),
    onPlaybackError: bindHandler(
      dispatch,
      optionsRef,
      'onPlaybackError',
      (e) => ({
        type: 'PLAYBACK_ERROR' as const,
        message: e.message,
      }),
      scope,
    ),
    onLiveStateChange: (e) => {
      if (isStale()) {
        return;
      }
      const payload = buildLiveStatePayload(e.nativeEvent);
      dispatch(stamp({ type: 'LIVE_STATE', liveState: payload }));
      optionsRef.current?.onLiveStateChange?.(payload);
    },
    onLiveError: bindHandler(
      dispatch,
      optionsRef,
      'onLiveError',
      (e) => ({
        type: 'LIVE_ERROR' as const,
        message: e.message,
      }),
      scope,
    ),
  };
}
