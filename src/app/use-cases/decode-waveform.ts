import { getTrackAudioInstance } from "@/app/stores/adapters";
import { getAppCoreInstance } from "@/app/stores/AppCoreImpl";
import { BPM_FETCH_ACTION, type BpmFetchResponse } from "@/domain/bpm-audio-messages";
import { PLUME_CONSTANTS } from "@/domain/plume";
import type { TrackAudioInfo } from "@/domain/ports/track-audio";
import { inferBrowserApi } from "@/shared/browser";
import { AudioFetchError } from "@/shared/errors";
import { getString } from "@/shared/i18n";
import { CPL, logger } from "@/shared/logger";

const fetchAudioViaBackground = async (audioStreamUrl: string): Promise<ArrayBuffer> => {
  const browserApi = inferBrowserApi();
  const response = (await browserApi.runtime.sendMessage({
    action: BPM_FETCH_ACTION,
    url: audioStreamUrl,
  })) as BpmFetchResponse;

  if (!response?.ok || !response.data) {
    throw new AudioFetchError(response?.error ?? "Background audio fetch failed");
  }

  return new Uint8Array(response.data).buffer as ArrayBuffer;
};

const downsampleToPeaks = (samples: Float32Array, peakCount: number): Float32Array => {
  const peaks = new Float32Array(peakCount);
  const bucketSize = Math.floor(samples.length / peakCount);

  for (let i = 0; i < peakCount; i++) {
    const start = i * bucketSize;
    const end = start + bucketSize;
    let peak = 0;
    for (let j = start; j < end; j++) {
      const abs = Math.abs(samples[j] as number);
      if (abs > peak) peak = abs;
    }
    peaks[i] = peak;
  }

  return peaks;
};

const resolveCurrentTrackAudioInfo = (infos: TrackAudioInfo[]): TrackAudioInfo | null => {
  if (infos.length === 1) return infos[0];

  const trackNumberText = getAppCoreInstance().getState().trackNumber;
  if (!trackNumberText) return null;

  const match = trackNumberText.match(/(\d+)/);
  if (!match) return null;

  const currentNum = Number(match[1]);
  return infos.find((info) => info.trackNumber === currentNum) ?? null;
};

const resolveCurrentTrackAudioInfoFromPage = (): TrackAudioInfo | null => {
  const infos = getTrackAudioInstance().getTrackAudioInfos();
  return resolveCurrentTrackAudioInfo(infos);
};

/**
 * Identity of the track the waveform belongs to. Based on the track URL (not the
 * track number) so peaks cached for one track can never be attributed to another.
 */
export const getCurrentWaveformTrackKey = (): string | null => {
  const info = resolveCurrentTrackAudioInfoFromPage();
  if (!info) return null;
  return info.trackUrl || info.audioStreamUrl || null;
};

export const decodeWaveformForTrack = async (
  info: TrackAudioInfo,
  signal?: AbortSignal
): Promise<Float32Array | null> => {
  const { audioStreamUrl, trackUrl } = info;
  if (signal?.aborted) return null;

  logger(CPL.INFO, getString("INFO__WAVEFORM__DECODE_START", [trackUrl]));

  const audioContext = new AudioContext();
  // close() rejects when the context is already closed — guard so abort + finally don't double-close.
  let contextClosed = false;
  const closeContext = async (): Promise<void> => {
    if (contextClosed) return;
    contextClosed = true;
    try {
      await audioContext.close();
    } catch {
      // Already closed (e.g. abort raced the finally block) — nothing to release.
    }
  };
  // Aborting releases the AudioContext immediately, which also rejects a pending decodeAudioData.
  const handleAbort = (): void => {
    void closeContext();
  };
  signal?.addEventListener("abort", handleAbort, { once: true });

  try {
    const buffer = await fetchAudioViaBackground(audioStreamUrl);
    if (signal?.aborted) return null;

    const audioBuffer = await audioContext.decodeAudioData(buffer);
    if (signal?.aborted) return null;

    const samples = audioBuffer.getChannelData(0);
    const peaks = downsampleToPeaks(samples, PLUME_CONSTANTS.WAVEFORM_PEAK_COLUMNS);

    logger(CPL.INFO, getString("INFO__WAVEFORM__DECODE_SUCCESS", [trackUrl]));
    return peaks;
  } catch (error) {
    logger(CPL.WARN, getString("WARN__WAVEFORM__DECODE_FAILED", [trackUrl]), error);
    return null;
  } finally {
    signal?.removeEventListener("abort", handleAbort);
    await closeContext();
  }
};

export const decodeWaveformForCurrentTrack = async (signal?: AbortSignal): Promise<Float32Array | null> => {
  const currentInfo: TrackAudioInfo | null = resolveCurrentTrackAudioInfoFromPage();

  if (!currentInfo?.audioStreamUrl) return null;

  return decodeWaveformForTrack(currentInfo, signal);
};
