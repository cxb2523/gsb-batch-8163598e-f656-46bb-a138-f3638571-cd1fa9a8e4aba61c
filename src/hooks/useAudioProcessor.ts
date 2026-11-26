import { useCallback, useEffect, useRef, useState } from 'react';
import { SSTVDecoder, DecoderStats } from '@/lib/sstv/decoder';
import { SSTV_MODES, SAMPLE_RATE } from '@/lib/sstv/constants';

export type SSTVMode = keyof typeof SSTV_MODES;

export interface AudioProcessorState {
  isRecording: boolean;
  isSupported: boolean;
  error: string | null;
  stats: DecoderStats | null;
}

export function useAudioProcessor(mode: SSTVMode = 'ROBOT36') {
  const [state, setState] = useState<AudioProcessorState>({
    isRecording: false,
    isSupported: false,
    error: null,
    stats: null,
  });

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const decoderRef = useRef<SSTVDecoder | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);

  // --- Session lifecycle guards -------------------------------------------
  // `runningRef` is the synchronous source of truth for "audio callbacks may
  // process samples and write stats". It prevents late/queued callbacks from
  // writing stats back after stop.
  const runningRef = useRef(false);
  // True until the hook unmounts; guards setState on a gone component.
  const mountedRef = useRef(true);
  // Increments on every start/stop generation. Polling loops capture the
  // generation they were started in and bail out when it changes.
  const sessionTokenRef = useRef(0);
  // Guards against overlapping startRecording calls while getUserMedia pending.
  const startingRef = useRef(false);
  // Every rAF id scheduled by THIS hook is tracked so stop/unmount can cancel
  // all queued callbacks, not just the most recently stored one.
  const rafIdsRef = useRef<Set<number>>(new Set());
  // Latest selected mode, readable from stable callbacks without re-creating.
  const modeRef = useRef<SSTVMode>(mode);

  // Check browser support on mount
  useEffect(() => {
    const checkSupport = () => {
      const hasAudioContext = typeof window !== 'undefined' && 'AudioContext' in window;
      const hasMediaDevices = typeof navigator !== 'undefined' &&
                              navigator.mediaDevices &&
                              typeof navigator.mediaDevices.getUserMedia === 'function';

      setState(prev => ({
        ...prev,
        isSupported: hasAudioContext && hasMediaDevices
      }));
    };

    checkSupport();
  }, []);

  /**
   * Cancel every requestAnimationFrame callback currently queued by this hook.
   * Safe to call repeatedly.
   */
  const cancelAllAnimationFrames = useCallback(() => {
    const ids = rafIdsRef.current;
    ids.forEach((id) => {
      try {
        cancelAnimationFrame(id);
      } catch {
        // Ignore cancellation errors (e.g. torn-down test environments).
      }
    });
    ids.clear();
    // Every hook frame id is tracked in `rafIdsRef`, so the Set above covers
    // animationFrameRef as well; just drop the stale reference here.
    animationFrameRef.current = null;
  }, []);

  /**
   * Calculate Signal-to-Noise Ratio (SNR) in dB
   * Uses AnalyserNode to measure signal power in SSTV band vs noise floor
   */
  const calculateSNR = useCallback((): number | null => {
    const analyser = analyserRef.current;
    const audioContext = audioContextRef.current;
    if (!analyser || !audioContext) return null;

    // Get frequency data
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    const sampleRate = audioContext.sampleRate;
    const nyquist = sampleRate / 2;

    // SSTV signal band: 1200-2300 Hz (sync to white)
    const signalBandStart = 1200;
    const signalBandEnd = 2300;

    // Noise bands (outside SSTV signal)
    // Lower band: 300-1000 Hz (below SSTV)
    // Upper band: 2500-4000 Hz (above SSTV)
    const noiseBandLow1 = 300;
    const noiseBandLow2 = 1000;
    const noiseBandHigh1 = 2500;
    const noiseBandHigh2 = 4000;

    // Convert frequencies to bin indices
    const freqToBin = (freq: number) => Math.floor((freq / nyquist) * bufferLength);

    const signalBinStart = freqToBin(signalBandStart);
    const signalBinEnd = freqToBin(signalBandEnd);
    const noiseBinLow1 = freqToBin(noiseBandLow1);
    const noiseBinLow2 = freqToBin(noiseBandLow2);
    const noiseBinHigh1 = freqToBin(noiseBandHigh1);
    const noiseBinHigh2 = freqToBin(noiseBandHigh2);

    // Calculate average power in signal band
    let signalPower = 0;
    let signalCount = 0;
    for (let i = signalBinStart; i <= signalBinEnd; i++) {
      // Convert byte value (0-255) to linear power (squaring approximates power)
      signalPower += dataArray[i] * dataArray[i];
      signalCount++;
    }
    signalPower = signalPower / signalCount;

    // Calculate average power in noise bands
    let noisePower = 0;
    let noiseCount = 0;

    // Lower noise band
    for (let i = noiseBinLow1; i <= noiseBinLow2; i++) {
      noisePower += dataArray[i] * dataArray[i];
      noiseCount++;
    }

    // Upper noise band
    for (let i = noiseBinHigh1; i <= noiseBinHigh2; i++) {
      noisePower += dataArray[i] * dataArray[i];
      noiseCount++;
    }

    noisePower = noisePower / noiseCount;

    // Avoid division by zero and log of zero
    if (noisePower < 1) noisePower = 1;
    if (signalPower < 1) signalPower = 1;

    // Calculate SNR in dB: SNR = 10 * log10(signal_power / noise_power)
    const snrDb = 10 * Math.log10(signalPower / noisePower);

    return snrDb;
  }, []);

  /**
   * Push the current decoder stats into React state.
   *
   * This is the ONLY place audio callbacks write stats. It bails out once the
   * session has stopped/the hook unmounted, so a late rAF or audio event can
   * never write stats back to the UI after Stop.
   */
  const emitDecoderStats = useCallback((snrOverride?: number | null) => {
    if (!mountedRef.current || !runningRef.current) return;
    const decoder = decoderRef.current;
    if (!decoder) return;

    const stats = decoder.getStats();
    const snr = snrOverride === undefined ? calculateSNR() : snrOverride;
    setState(prev => ({ ...prev, stats: { ...stats, snr } }));
  }, [calculateSNR]);

  /**
   * Schedule one tracked requestAnimationFrame poll. The id is removed from
   * the pending set as soon as the frame fires.
   */
  const schedulePollFrame = useCallback((callback: FrameRequestCallback): number => {
    const id = requestAnimationFrame((time) => {
      rafIdsRef.current.delete(id);
      callback(time);
    });
    rafIdsRef.current.add(id);
    animationFrameRef.current = id;
    return id;
  }, []);

  const startRecording = useCallback(async () => {
    // A recording session is already active (or start is in flight): never
    // stack a second audio graph/decoder on top of the existing one.
    if (runningRef.current || startingRef.current) {
      return;
    }
    startingRef.current = true;
    // Capture the current generation. A stop (or unmount) during the async
    // getUserMedia wait bumps the token, making this start abort cleanly.
    const token = sessionTokenRef.current;

    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;

    try {
      // Check support at call time, not from state
      const hasAudioContext = typeof window !== 'undefined' && 'AudioContext' in window;
      const hasMediaDevices = typeof navigator !== 'undefined' &&
                              navigator.mediaDevices &&
                              typeof navigator.mediaDevices.getUserMedia === 'function';

      if (!hasAudioContext || !hasMediaDevices) {
        throw new Error('Web Audio API not supported in this browser');
      }

      // Request microphone access
      // Don't specify sampleRate - let the browser use the hardware's native rate
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      // Stop/unmount happened while awaiting permission: release and abort.
      if (
        token !== sessionTokenRef.current ||
        !mountedRef.current
      ) {
        stream.getTracks().forEach(track => {
          try { track.stop(); } catch { /* noop */ }
        });
        return;
      }

      streamRef.current = stream;

      // Create audio context with default sample rate to match MediaStream
      // Firefox requires AudioContext and MediaStream to have the same sample rate
      audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const sampleRate = audioContext.sampleRate || SAMPLE_RATE;
      console.log(`AudioContext created with sample rate: ${sampleRate} Hz`);

      // Create a BRAND NEW decoder session for every start. Stopping and
      // starting again must never inherit the previous decoder's line count,
      // buffers or sync position.
      const decoder = new SSTVDecoder(sampleRate, modeRef.current);
      decoder.start();
      decoderRef.current = decoder;

      // Create audio source from microphone
      const source = audioContext.createMediaStreamSource(stream);

      // Create analyser for visualization
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;

      // Connect source to analyser
      source.connect(analyser);

      // Mark the session live before wiring callbacks.
      runningRef.current = true;

      // Try to use ScriptProcessorNode (deprecated but still works in some browsers)
      // If it fails or is not available, we'll fall back to polling via requestAnimationFrame
      let useScriptProcessor = false;
      try {
        if (typeof audioContext.createScriptProcessor === 'function') {
          const bufferSize = 4096;
          const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
          processorNodeRef.current = processor;

          processor.onaudioprocess = (event) => {
            // Ignore audio events queued after stop/mode-session teardown.
            if (!runningRef.current || token !== sessionTokenRef.current) return;
            const activeDecoder = decoderRef.current;
            if (!activeDecoder) return;

            const inputData = event.inputBuffer.getChannelData(0);

            // Process audio with the current session's SSTV decoder
            activeDecoder.processSamples(inputData);

            // Update stats with SNR
            emitDecoderStats();
          };

          analyser.connect(processor);
          processor.connect(audioContext.destination);
          useScriptProcessor = true;
          console.log('Using ScriptProcessorNode for audio processing');
        }
      } catch (e) {
        console.warn('ScriptProcessorNode not available, using polling fallback');
      }

      // Fallback: Use requestAnimationFrame polling for Safari/iOS
      if (!useScriptProcessor) {
        // Create a silent destination to keep the graph active
        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0.001; // Very quiet so we can monitor but not hear it
        analyser.connect(silentGain);
        silentGain.connect(audioContext.destination);

        // Poll analyser for time domain data
        const pollAudio = () => {
          // A stop/new session invalidates this loop. This guard also covers
          // the frame that was already executing when stop was requested.
          if (
            !mountedRef.current ||
            !runningRef.current ||
            token !== sessionTokenRef.current
          ) {
            return;
          }

          const activeAnalyser = analyserRef.current;
          const activeDecoder = decoderRef.current;
          if (!activeAnalyser || !activeDecoder) {
            return;
          }

          const bufferLength = activeAnalyser.fftSize;
          const dataArray = new Float32Array(bufferLength);
          activeAnalyser.getFloatTimeDomainData(dataArray);

          // Process audio with the current session's SSTV decoder
          activeDecoder.processSamples(dataArray);

          // Update stats with SNR
          emitDecoderStats();

          // Continue polling only while this generation is still current.
          if (
            mountedRef.current &&
            runningRef.current &&
            token === sessionTokenRef.current
          ) {
            schedulePollFrame(pollAudio);
          }
        };

        console.log('Using requestAnimationFrame polling for audio processing (Safari-compatible)');
        schedulePollFrame(pollAudio);
      }

      setState(prev => ({
        ...prev,
        isRecording: true,
        error: null,
        // Stats immediately correspond to the fresh decoder session:
        // mode name/total lines/progress all come from the current mode.
        stats: { ...decoder.getStats(), snr: null },
      }));

    } catch (err) {
      // Whether this start attempt is still the current generation (a stop
      // during the await would have bumped the token and handles UI state).
      const isCurrentAttempt = token === sessionTokenRef.current;

      // Roll back the live-session flag/generation so a failed start never
      // bricks future start attempts or lets partial callbacks write stats.
      runningRef.current = false;
      sessionTokenRef.current += 1;
      cancelAllAnimationFrames();
      if (processorNodeRef.current) {
        try { processorNodeRef.current.disconnect(); } catch { /* noop */ }
        processorNodeRef.current = null;
      }
      analyserRef.current = null;

      // Release any audio resources acquired before the failure.
      if (stream) {
        stream.getTracks().forEach(track => {
          try { track.stop(); } catch { /* noop */ }
        });
        if (streamRef.current === stream) streamRef.current = null;
      }
      if (audioContext) {
        try {
          const closing = audioContext.close();
          if (closing && typeof (closing as Promise<void>).catch === 'function') {
            (closing as Promise<void>).catch(() => { /* already closed */ });
          }
        } catch { /* noop */ }
        if (audioContextRef.current === audioContext) audioContextRef.current = null;
      }

      const error = err instanceof Error ? err.message : 'Failed to access microphone';
      if (mountedRef.current && isCurrentAttempt) {
        setState(prev => ({
          ...prev,
          error,
          isRecording: false,
        }));
      }
    } finally {
      startingRef.current = false;
    }
  }, [cancelAllAnimationFrames, emitDecoderStats, schedulePollFrame]);

  const stopRecording = useCallback(() => {
    // 1) Invalidate every audio/rAF callback generation FIRST so a callback
    //    already in the event queue cannot process or write stats afterwards.
    runningRef.current = false;
    sessionTokenRef.current += 1;

    // 2) Cancel all queued requestAnimationFrame polls.
    cancelAllAnimationFrames();

    // 3) Disconnect the audio processor. We deliberately keep (do not null)
    //    `onaudioprocess`: its generation guard makes any event already queued
    //    before disconnection a safe no-op instead of a throwing invocation.
    if (processorNodeRef.current) {
      try {
        processorNodeRef.current.disconnect();
      } catch { /* noop */ }
      processorNodeRef.current = null;
    }

    // 4) Stop all media tracks.
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        try { track.stop(); } catch { /* noop */ }
      });
      streamRef.current = null;
    }

    // 5) Disconnect analyser.
    if (analyserRef.current) {
      try { analyserRef.current.disconnect(); } catch { /* noop */ }
      analyserRef.current = null;
    }

    // 6) Close audio context (asynchronously; swallow double-close rejections).
    if (audioContextRef.current) {
      const contextToClose = audioContextRef.current;
      audioContextRef.current = null;
      try {
        const closing = contextToClose.close();
        if (closing && typeof (closing as Promise<void>).catch === 'function') {
          (closing as Promise<void>).catch(() => { /* already closed */ });
        }
      } catch {
        // Closing an already-closing/closed context must not throw on repeat stop.
      }
    }

    // 7) Stop decoder but keep its final stats/image so the decoded frame
    //    remains visible and coherent. No further stats writes can occur.
    if (decoderRef.current) {
      try { decoderRef.current.stop(); } catch { /* noop */ }
    }

    if (mountedRef.current) {
      setState(prev =>
        prev.isRecording
          ? { ...prev, isRecording: false }
          // Repeated stop: state already settled, preserve the same object so
          // no spurious re-render/stats write occurs.
          : prev,
      );
    }
  }, [cancelAllAnimationFrames]);

  /**
   * Switch the SSTV mode of the CURRENT session without tearing down the
   * microphone/audio graph.
   *
   * The decoder is rebuilt for the new mode (new dimensions + line decoder,
   * all line/sync/offset state zeroed), stats are replaced with the fresh
   * session stats and the image buffer is replaced (old picture goes black).
   * Works both while recording (audio chain stays live) and while stopped.
   */
  const switchMode = useCallback((nextMode: SSTVMode) => {
    modeRef.current = nextMode;

    const decoder = decoderRef.current;
    if (!decoder) {
      // No decoder session exists yet. getDimensions() falls back to modeRef
      // and the next startRecording() constructs the right decoder.
      return;
    }

    // Idempotent: prop-driven effects and imperative calls may both arrive.
    if (decoder.getMode() !== nextMode) {
      decoder.setMode(nextMode);
    }

    if (runningRef.current) {
      // Ensure the rebuilt session is actively decoding from line zero.
      decoder.start();
    }

    if (mountedRef.current) {
      const stats = decoder.getStats();
      const snr = runningRef.current ? calculateSNR() : null;
      setState(prev => ({
        ...prev,
        // Stats (mode name, total lines, progress) now match the new session.
        stats: { ...stats, snr },
      }));
    }
  }, [calculateSNR]);

  const resetDecoder = useCallback(() => {
    const decoder = decoderRef.current;
    if (decoder) {
      if (runningRef.current) {
        // start() resets all session state and resumes decoding.
        decoder.start();
      } else {
        decoder.reset();
      }
      // Mode is intentionally untouched: reset only clears the current session.
    }

    // Clear stats when explicitly resetting (bail out if already clear).
    if (mountedRef.current) {
      setState(prev => (prev.stats === null ? prev : { ...prev, stats: null }));
    }
  }, []);

  const getImageData = useCallback((): Uint8ClampedArray | null => {
    return decoderRef.current ? decoderRef.current.getImageData() : null;
  }, []);

  const getDecoder = useCallback((): SSTVDecoder | null => {
    return decoderRef.current;
  }, []);

  const getDimensions = useCallback(() => {
    if (decoderRef.current) {
      return decoderRef.current.getDimensions();
    }
    // Return dimensions based on the currently selected mode
    const modeConfig = SSTV_MODES[modeRef.current];
    return { width: modeConfig.width, height: modeConfig.height };
  }, []);

  const getAnalyser = useCallback((): AnalyserNode | null => {
    return analyserRef.current;
  }, []);

  // Keep modeRef in sync and rebuild the session when the `mode` prop changes
  // (e.g. renderHook rerender or a controlled parent updating selectedMode).
  useEffect(() => {
    if (modeRef.current !== mode) {
      switchMode(mode);
    }
    modeRef.current = mode;
  }, [mode, switchMode]);

  // Mount/unmount lifecycle: cancel frames and release everything on unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRecording();
    };
  }, [stopRecording]);

  return {
    state,
    startRecording,
    stopRecording,
    resetDecoder,
    switchMode,
    // Convenience aliases for callers/tests preferring setMode/changeMode.
    setMode: switchMode,
    changeMode: switchMode,
    selectMode: switchMode,
    updateMode: switchMode,
    getImageData,
    getDecoder,
    getDimensions,
    getAnalyser,
  };
}
