import {
  PanelBottomClose,
  PanelBottomOpen,
  PanelRightClose,
  PanelRightOpen,
  Ratio,
  RotateCcw,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from '../i18n';
import {
  createThreePreview,
  type ThreePreviewInstance,
} from '../lib/volume/three-preview';
import type { PreparedVolumeFor3D, VolumeCursor } from '../types';
import { Button } from './Button';

interface VolumeViewport3DProps {
  volume: PreparedVolumeFor3D | null;
  cursor?: VolumeCursor | null;
  axisViewsVisible?: boolean;
  onAxisViewsVisibleChange?: (visible: boolean) => void;
  sidebarVisible?: boolean;
  onSidebarVisibleChange?: (visible: boolean) => void;
  onDownsampledChange?: (downsampled: boolean) => void;
  axisViewsControlsId?: string;
  sidebarControlsId?: string;
}

export function VolumeViewport3D({
  volume,
  cursor = null,
  axisViewsVisible = true,
  onAxisViewsVisibleChange,
  sidebarVisible = true,
  onSidebarVisibleChange,
  onDownsampledChange,
  axisViewsControlsId,
  sidebarControlsId,
}: VolumeViewport3DProps) {
  const { t } = useTranslation();
  const instructionsId = useId();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ThreePreviewInstance | null>(null);
  // Mirror the latest props during render so an asynchronous mount always
  // reads the current values instead of values captured by an old effect.
  const cursorRef = useRef<VolumeCursor | null>(cursor);
  cursorRef.current = cursor;
  const [error, setError] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [planesVisible, setPlanesVisible] = useState(true);
  const planesVisibleRef = useRef(planesVisible);
  planesVisibleRef.current = planesVisible;

  useEffect(() => {
    instanceRef.current?.focusCursor(cursor);
  }, [cursor]);

  useEffect(() => {
    instanceRef.current?.setPlanesVisible(planesVisible);
  }, [planesVisible]);

  useEffect(() => {
    onDownsampledChange?.(Boolean(volume?.downsampled));
  }, [onDownsampledChange, volume?.downsampled]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !volume) {
      setError(false);
      setPreviewReady(false);
      return undefined;
    }

    const MIN_HOST_SIZE = 32;
    const MAX_RETRIES = 4;

    // `cancelled` is the single generation guard for this effect run. The
    // cleanup flips it before anything else so an in-flight dynamic-import
    // creation is cancelled first, then all other resources are torn down.
    let cancelled = false;
    let instance: ThreePreviewInstance | null = null;
    let createInFlight = false;
    let initialFrame = 0;
    let retryTimer = 0;
    let retryCount = 0;
    let sizeObserver: ResizeObserver | null = null;

    setError(false);
    setPreviewReady(false);

    const clearRetryTimer = () => {
      if (retryTimer !== 0) {
        window.clearTimeout(retryTimer);
        retryTimer = 0;
      }
    };

    const disconnectSizeObserver = () => {
      sizeObserver?.disconnect();
      sizeObserver = null;
    };

    const scheduleRetry = () => {
      if (cancelled || instance || createInFlight) return;
      if (retryCount >= MAX_RETRIES) return;
      retryCount += 1;
      clearRetryTimer();
      retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        attemptMount();
        // Still below the size threshold (or the attempt could not start):
        // keep the bounded retry chain going until the cap is reached.
        if (!cancelled && !instance && !createInFlight) {
          scheduleRetry();
        }
      }, 120 * retryCount);
    };

    const attemptMount = () => {
      if (cancelled || instance || createInFlight) return;
      if (
        host.clientWidth < MIN_HOST_SIZE ||
        host.clientHeight < MIN_HOST_SIZE
      ) {
        return;
      }

      createInFlight = true;
      // A real mount attempt makes the size-watch/retry drivers obsolete;
      // clear them so an old timer/observer can never trigger a duplicate.
      clearRetryTimer();
      disconnectSizeObserver();

      void createThreePreview(host, volume, {
        isCancelled: () => cancelled,
      })
        .then((created) => {
          // A switch/unmount won while modules were loading. The creation
          // bails before building when it observes cancellation; if an
          // instance still arrived, dispose it immediately and never expose
          // it through instanceRef or attach it as the active preview.
          if (cancelled) {
            created.dispose();
            return;
          }

          instance = created;
          instanceRef.current = created;
          // Resynchronize from the latest refs: cursor/visibility may have
          // changed repeatedly while the asynchronous creation was pending.
          created.focusCursor(cursorRef.current);
          created.setPlanesVisible(planesVisibleRef.current);
          setPreviewReady(true);
        })
        .catch((creationError: unknown) => {
          createInFlight = false;
          if (cancelled) return;
          // Cancellation rejections are expected and must not show the error UI.
          if (
            creationError instanceof Error &&
            creationError.name === 'AbortError'
          ) {
            return;
          }
          if (retryCount < MAX_RETRIES) {
            scheduleRetry();
            return;
          }
          setError(true);
          setPreviewReady(false);
        });
    };

    initialFrame = window.requestAnimationFrame(() => {
      if (cancelled) return;
      attemptMount();
      if (cancelled || createInFlight || instance) return;

      // Host is still below the size threshold: keep watching for layout and
      // keep the bounded retry chain. Both handles are owned by this effect
      // and released in its cleanup.
      sizeObserver = new ResizeObserver(() => {
        attemptMount();
      });
      sizeObserver.observe(host);
      scheduleRetry();
    });

    return () => {
      // 1. Cancel the not-yet-finished asynchronous creation first.
      cancelled = true;
      // 2. Release scheduling/layout handles.
      window.cancelAnimationFrame(initialFrame);
      clearRetryTimer();
      disconnectSizeObserver();
      // 3. Detach the shared ref only if it still points at our instance.
      if (instanceRef.current === instance) {
        instanceRef.current = null;
      }
      // 4. Dispose the live instance (idempotent in the preview module).
      instance?.dispose();
      instance = null;
    };
  }, [volume]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const instance = instanceRef.current;
    if (!instance) return;
    const rotationStep = (Math.PI / 30) * (event.shiftKey ? 2.5 : 1);

    switch (event.key) {
      case 'ArrowLeft':
        instance.rotateView(-rotationStep, 0);
        break;
      case 'ArrowRight':
        instance.rotateView(rotationStep, 0);
        break;
      case 'ArrowUp':
        instance.rotateView(0, -rotationStep);
        break;
      case 'ArrowDown':
        instance.rotateView(0, rotationStep);
        break;
      case '+':
      case '=':
        instance.zoomView(0.86);
        break;
      case '-':
      case '_':
        instance.zoomView(1 / 0.86);
        break;
      case '0':
        instance.resetView();
        break;
      default:
        return;
    }

    event.preventDefault();
  };

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-black">
      <div
        ref={hostRef}
        id="volume-3d-surface"
        className="focus-surface absolute inset-0 h-full min-h-0 overflow-hidden"
        role="application"
        tabIndex={volume ? 0 : -1}
        aria-label={t('volumeViewport3d.surfaceLabel')}
        aria-describedby={instructionsId}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + - 0"
        onKeyDown={handleKeyDown}
        onPointerDown={(event) =>
          event.currentTarget.focus({ preventScroll: true })
        }
      />
      <span id={instructionsId} className="sr-only">
        {t('volumeViewport3d.keyboardInstructions')}
      </span>
      <div className="absolute inset-0 z-20 pointer-events-none">
        <div className="pointer-events-auto absolute inset-x-2 bottom-2 grid grid-cols-2 items-center gap-1 sm:inset-x-auto sm:right-2 sm:flex sm:flex-wrap sm:justify-end">
          <Button
            variant="overlay"
            size="sm"
            className="viewer-toolbar-button min-w-0 flex-1 sm:flex-none"
            aria-expanded={axisViewsVisible}
            aria-controls={axisViewsControlsId}
            onClick={() => onAxisViewsVisibleChange?.(!axisViewsVisible)}
          >
            {axisViewsVisible ? (
              <PanelBottomClose className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <PanelBottomOpen className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {axisViewsVisible
              ? t('volumeViewport3d.hideAxisViewsShort')
              : t('volumeViewport3d.showAxisViewsShort')}
          </Button>
          <Button
            variant="overlay"
            size="sm"
            className="viewer-toolbar-button min-w-0 flex-1 sm:flex-none"
            aria-expanded={sidebarVisible}
            aria-controls={sidebarControlsId}
            onClick={() => onSidebarVisibleChange?.(!sidebarVisible)}
          >
            {sidebarVisible ? (
              <PanelRightClose className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <PanelRightOpen className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {sidebarVisible
              ? t('volumeViewport3d.hideSidebarShort')
              : t('volumeViewport3d.showSidebarShort')}
          </Button>
          <Button
            variant="overlay"
            size="sm"
            className="viewer-toolbar-button min-w-0 flex-1 sm:flex-none"
            aria-pressed={planesVisible}
            aria-controls="volume-3d-surface"
            onClick={() => setPlanesVisible((current) => !current)}
          >
            <Ratio className="h-3.5 w-3.5" aria-hidden="true" />
            {planesVisible
              ? t('volumeViewport3d.hidePlanesShort')
              : t('volumeViewport3d.showPlanesShort')}
          </Button>
          <Button
            variant="overlay"
            size="sm"
            className="viewer-toolbar-button min-w-0 flex-1 sm:flex-none"
            disabled={!previewReady}
            onClick={() => instanceRef.current?.resetView()}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('volumeViewport3d.resetViewShort')}
          </Button>
        </div>
      </div>
      {error ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/85 px-4 text-center text-xs text-slate-400">
          {t('volumeViewport3d.previewError')}
        </div>
      ) : null}
    </div>
  );
}
