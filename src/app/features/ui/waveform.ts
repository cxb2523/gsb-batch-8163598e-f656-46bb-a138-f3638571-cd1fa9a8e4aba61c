import { getMusicPlayerInstance } from "@/app/stores/adapters";
import { getAppCoreInstance } from "@/app/stores/AppCoreImpl";
import { seekToProgress } from "@/app/use-cases";
import { decodeWaveformForCurrentTrack, getCurrentWaveformTrackKey } from "@/app/use-cases/decode-waveform";
import { PLUME_CONSTANTS } from "@/domain/plume";
import { PLUME_CSS_CLASSES, PLUME_ELEM_SELECTORS } from "@/infra/elements/plume";
import { getString } from "@/shared/i18n";

// Peaks are cached per track (keyed by track URL, not track number) and survive
// clearWaveform — navigating back to a track or re-entering fullscreen reuses the cache.
const peaksCache = new Map<string, Float32Array>();

// In-flight decodes keyed by the same track key: a second trigger for the same track
// (e.g. main canvas + fullscreen clone) reuses the promise instead of re-fetching the audio.
interface InflightDecode {
  promise: Promise<Float32Array | null>;
  controller: AbortController;
}
const inflightDecodes = new Map<string, InflightDecode>();

// Bumped by clearWaveform: any decode completion from before the bump is stale and
// must not touch the cache or the canvas (track changed or the feature was toggled off).
let decodeGeneration = 0;

const abortInflightDecodes = (): void => {
  inflightDecodes.forEach(({ controller }) => controller.abort());
  inflightDecodes.clear();
};

export const clearPeaksCache = (): void => {
  decodeGeneration++;
  abortInflightDecodes();
  peaksCache.clear();
};

export const createWaveformCanvas = (): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  canvas.id = PLUME_ELEM_SELECTORS.waveformCanvas.split("#")[1];
  canvas.ariaLabel = getString("ARIA__WAVEFORM_CANVAS");

  const { featureFlags } = getAppCoreInstance().getState();
  const isEnabled = featureFlags.waveform;
  if (!isEnabled) canvas.classList.add(PLUME_CSS_CLASSES.featureHidden);

  return canvas;
};

export const renderWaveform = (
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  progressFraction: number,
  accentColor: string
): void => {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const width = canvas.offsetWidth;
  const height = canvas.offsetHeight;
  if (width === 0 || height === 0) return;

  canvas.width = width;
  canvas.height = height;

  ctx.clearRect(0, 0, width, height);

  const peakCount = peaks.length;
  const columnWidth = width / peakCount;

  for (let i = 0; i < peakCount; i++) {
    const barHeight = height * 0.1 + (peaks[i] as number) * height * 0.9;
    const x = i * columnWidth;

    ctx.fillStyle = i / peakCount < progressFraction ? accentColor : "rgba(128,128,128,0.35)";
    ctx.fillRect(x, height - barHeight, Math.max(columnWidth - 1, 1), barHeight);
  }
};

const hideCanvas = (canvas: HTMLCanvasElement): void => {
  canvas.classList.add(PLUME_CSS_CLASSES.featureHidden);
};

export const triggerWaveformDecode = async (canvas: HTMLCanvasElement): Promise<void> => {
  const appState = getAppCoreInstance().getState();

  if (!appState.featureFlags.waveform) {
    hideCanvas(canvas);
    return;
  }

  // Cache key identifies the track itself (its URL), so a decode started for track A
  // can never be stored under — or rendered over — track B.
  const cacheKey = getCurrentWaveformTrackKey();

  // Fast path: peaks already cached for this track — skip decode and render immediately.
  if (cacheKey && peaksCache.has(cacheKey)) {
    canvas.classList.remove(PLUME_CSS_CLASSES.featureHidden);
    const progressFraction =
      appState.currentTime != null && appState.duration ? appState.currentTime / appState.duration : 0;
    renderWaveform(canvas, peaksCache.get(cacheKey)!, progressFraction, getAccentColor());
    return;
  }

  if (appState.duration > PLUME_CONSTANTS.WAVEFORM_MAX_DURATION_SECONDS) {
    hideCanvas(canvas);
    return;
  }

  if (!cacheKey) {
    // Current track can't be identified — nothing to decode or cache against.
    hideCanvas(canvas);
    return;
  }

  // Show loading state while decode runs (CSS pulse + aria label; no canvas drawing)
  const generation = decodeGeneration;
  canvas.classList.remove(PLUME_CSS_CLASSES.featureHidden);
  canvas.classList.add(PLUME_CSS_CLASSES.waveformLoading);
  canvas.ariaLabel = getString("ARIA__WAVEFORM_CANVAS__LOADING");

  // Reuse an in-flight decode for the same track instead of fetching the audio again.
  let inflight = inflightDecodes.get(cacheKey);
  if (!inflight) {
    const controller = new AbortController();
    const promise = decodeWaveformForCurrentTrack(controller.signal);
    inflight = { promise, controller };
    inflightDecodes.set(cacheKey, inflight);
    const forgetIfCurrent = (): void => {
      if (inflightDecodes.get(cacheKey)?.promise === promise) inflightDecodes.delete(cacheKey);
    };
    promise.then(forgetIfCurrent, forgetIfCurrent);
  }

  const peaks = await inflight.promise;

  canvas.classList.remove(PLUME_CSS_CLASSES.waveformLoading);
  canvas.ariaLabel = getString("ARIA__WAVEFORM_CANVAS");

  // Stale completion: the waveform was cleared (track change, feature toggled off)
  // while this decode was in flight — its result must not reach the cache or canvas.
  if (generation !== decodeGeneration) {
    hideCanvas(canvas);
    return;
  }
  // Defensive: the current track no longer matches the track this decode belongs to.
  if (getCurrentWaveformTrackKey() !== cacheKey) {
    hideCanvas(canvas);
    return;
  }
  if (!peaks) {
    hideCanvas(canvas);
    return;
  }

  peaksCache.set(cacheKey, peaks);

  const newAppState = getAppCoreInstance().getState();
  const progressFraction = !!newAppState.duration ? newAppState.currentTime / newAppState.duration : 0;

  renderWaveform(canvas, peaks, progressFraction, getAccentColor());
};

export const clearWaveform = (canvas: HTMLCanvasElement): void => {
  // Invalidate any in-flight decode completions and cancel the decodes themselves,
  // releasing their AudioContext resources.
  decodeGeneration++;
  abortInflightDecodes();
  // Peaks cache is preserved — navigation back to this track skips the decode.

  canvas.classList.remove(PLUME_CSS_CLASSES.waveformLoading);
  canvas.classList.add(PLUME_CSS_CLASSES.featureHidden);
  canvas.ariaLabel = getString("ARIA__WAVEFORM_CANVAS");

  const ctx = canvas.getContext("2d");
  ctx?.clearRect(0, 0, canvas.width, canvas.height);
};

export const attachWaveformSeekHandler = (canvas: HTMLCanvasElement): void => {
  canvas.addEventListener("click", (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekToProgress(
      fraction * PLUME_CONSTANTS.PROGRESS_SLIDER_GRANULARITY,
      getAppCoreInstance(),
      getMusicPlayerInstance()
    );
  });
};

export const syncWaveformPlayhead = (canvas: HTMLCanvasElement, progressFraction: number): void => {
  const cacheKey = getCurrentWaveformTrackKey();
  if (!cacheKey) return;

  const peaks = peaksCache.get(cacheKey);
  if (!peaks) return;

  renderWaveform(canvas, peaks, progressFraction, getAccentColor());
};

// Reads the Bandcamp accent color from the CSS custom property set on :root.
const getAccentColor = (): string => {
  const plumeVersion = document.querySelector(PLUME_ELEM_SELECTORS.headerLogoVersion) as HTMLParagraphElement | null;
  const versionColor = plumeVersion ? getComputedStyle(plumeVersion).color : null;
  return versionColor || "#ffffff";
};
