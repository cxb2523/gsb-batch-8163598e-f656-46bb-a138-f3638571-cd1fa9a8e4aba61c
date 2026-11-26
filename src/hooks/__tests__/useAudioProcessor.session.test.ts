import { renderHook, act } from '@testing-library/react';
import { useAudioProcessor, SSTVMode } from '../useAudioProcessor';
import { SSTV_MODES } from '@/lib/sstv/constants';

/* ------------------------------------------------------------------ */
/* Audio mocks                                                         */
/* ------------------------------------------------------------------ */

interface AudioHandles {
  ctx: any;
  ctor: jest.Mock;
  processor: { onaudioprocess: any; connect: jest.Mock; disconnect: jest.Mock } | null;
  analyser: any;
  close: jest.Mock;
}

/**
 * Install a controllable global AudioContext + getUserMedia mock.
 * Each `new AudioContext()` gets a FRESH set of handles, collected in `all`.
 */
function installAudioMock(options: { scriptProcessor?: boolean } = {}) {
  const all: AudioHandles[] = [];
  const streams: any[] = [];

  const getUserMedia = navigator.mediaDevices.getUserMedia as jest.Mock;
  getUserMedia.mockImplementation(async () => {
    const tracks = [{ stop: jest.fn(), kind: 'audio' }];
    const stream = { getTracks: () => tracks };
    streams.push(stream);
    (stream as any).__tracks = tracks;
    return stream;
  });

  const Ctor = jest.fn(() => {
    const processor =
      options.scriptProcessor === false
        ? null
        : {
            onaudioprocess: null as any,
            connect: jest.fn(),
            disconnect: jest.fn(),
          };

    const analyser = {
      fftSize: 2048,
      frequencyBinCount: 1024,
      getByteFrequencyData: jest.fn(),
      getFloatTimeDomainData: jest.fn(),
      connect: jest.fn(),
      disconnect: jest.fn(),
    };
    const source = { connect: jest.fn(), disconnect: jest.fn() };
    const gain = { gain: { value: 1 }, connect: jest.fn(), disconnect: jest.fn() };
    const close = jest.fn().mockResolvedValue(undefined);

    const ctx = {
      sampleRate: 48000,
      destination: {},
      createAnalyser: jest.fn(() => analyser),
      createMediaStreamSource: jest.fn(() => source),
      createGain: jest.fn(() => gain),
      createScriptProcessor: processor ? jest.fn(() => processor) : undefined,
      close,
    };

    const handles: AudioHandles = {
      ctx,
      ctor: Ctor,
      processor,
      analyser,
      close,
    };
    all.push(handles);
    return ctx;
  });

  (globalThis as any).AudioContext = Ctor;
  (window as any).AudioContext = Ctor;

  return {
    all,
    streams,
    /** Latest AudioContext handles. */
    latest: () => all[all.length - 1],
    /** Latest media stream tracks. */
    latestTracks: () => (streams[streams.length - 1] as any).__tracks as { stop: jest.Mock }[],
  };
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('useAudioProcessor session consistency', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('A1: switching mode while recording updates stats and dimensions without rebuilding audio chain', async () => {
    const audio = installAudioMock({ scriptProcessor: true });
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

    expect(result.current.getDimensions()).toEqual({ width: 320, height: 240 });

    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.state.isRecording).toBe(true);
    expect(result.current.state.stats).toMatchObject({
      mode: SSTV_MODES.ROBOT36.name,
      totalLines: 240,
      currentLine: 0,
      progress: 0,
    });

    const handles = audio.latest();
    expect(handles.ctor).toHaveBeenCalledTimes(1);
    const decoderBefore = result.current.getDecoder();

    // Switch mode imperatively (same call the UI makes).
    act(() => {
      result.current.switchMode('PD120');
    });

    // Stats + dimensions correspond to the new session.
    expect(result.current.getDecoder()!.getMode()).toBe('PD120');
    expect(result.current.getDimensions()).toEqual({ width: 640, height: 496 });
    expect(result.current.state.stats).toMatchObject({
      mode: SSTV_MODES.PD120.name,
      totalLines: 496,
      currentLine: 0,
      progress: 0,
    });

    // Decoder is rebuilt in place (same holder) but fully reset.
    expect(result.current.getDecoder()).toBe(decoderBefore);

    // Audio chain was NOT interrupted.
    expect(handles.close).not.toHaveBeenCalled();
    audio.latestTracks().forEach((t) => expect(t.stop).not.toHaveBeenCalled());
    expect(handles.processor!.disconnect).not.toHaveBeenCalled();
    expect(handles.ctor).toHaveBeenCalledTimes(1);
    expect(result.current.state.isRecording).toBe(true);
  });

  it('A1: rerendering with a new mode prop rebuilds the session', async () => {
    installAudioMock({ scriptProcessor: true });
    const { result, rerender } = renderHook(
      (props: { mode: SSTVMode }) => useAudioProcessor(props.mode),
      { initialProps: { mode: 'ROBOT36' } },
    );

    await act(async () => {
      await result.current.startRecording();
    });

    act(() => {
      rerender({ mode: 'PD160' });
    });

    expect(result.current.getDimensions()).toEqual({ width: 512, height: 400 });
    expect(result.current.state.stats).toMatchObject({
      mode: SSTV_MODES.PD160.name,
      totalLines: 400,
      currentLine: 0,
      progress: 0,
    });
  });

  it('A1: mode can be selected before first start; dimensions follow selection', () => {
    installAudioMock();
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

    act(() => {
      result.current.switchMode('PD120');
    });

    expect(result.current.getDecoder()).toBeNull();
    expect(result.current.getDimensions()).toEqual({ width: 640, height: 496 });
  });

  it('A2: switching mode clears the old image buffer', async () => {
    installAudioMock();
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

    await act(async () => {
      await result.current.startRecording();
    });

    const oldImage = result.current.getImageData()!;
    expect(oldImage.length).toBe(320 * 240 * 4);
    oldImage.fill(255);
    (result.current.getDecoder() as any).currentLine = 180;

    act(() => {
      result.current.switchMode('PD120');
    });

    const newImage = result.current.getImageData()!;
    expect(newImage.length).toBe(640 * 496 * 4);
    expect(newImage).not.toBe(oldImage);

    let firstBad = -1;
    for (let i = 0; i < newImage.length; i += 4) {
      if (newImage[i] !== 0 || newImage[i + 1] !== 0 || newImage[i + 2] !== 0) {
        firstBad = i;
        break;
      }
    }
    expect(firstBad).toBe(-1);
    expect(result.current.state.stats!.currentLine).toBe(0);
  });

  it('A3 (rAF fallback): stopping cancels queued frames and no late callback writes stats', async () => {
    installAudioMock({ scriptProcessor: false });

    // Manual requestAnimationFrame queue.
    const scheduled = new Map<number, FrameRequestCallback>();
    const firedCallbacks: FrameRequestCallback[] = [];
    let nextId = 0;
    const originalRAF = globalThis.requestAnimationFrame;
    const originalCAF = globalThis.cancelAnimationFrame;
    const rafMock = jest.fn((cb: FrameRequestCallback) => {
      nextId += 1;
      const id = nextId;
      scheduled.set(id, cb);
      return id;
    });
    const cafMock = jest.fn((id: number) => {
      scheduled.delete(id);
    });
    (globalThis as any).requestAnimationFrame = rafMock;
    (globalThis as any).cancelAnimationFrame = cafMock;

    try {
      const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

      await act(async () => {
        await result.current.startRecording();
      });

      // Fallback path scheduled exactly one polling frame.
      expect(rafMock).toHaveBeenCalled();
      expect(scheduled.size).toBe(1);
      const queuedCallback = [...scheduled.values()][0];
      firedCallbacks.push(queuedCallback);

      await act(async () => {
        result.current.stopRecording();
      });

      // All tracked frame ids were cancelled and the queue is empty.
      expect(cafMock).toHaveBeenCalled();
      expect(scheduled.size).toBe(0);

      const statsAfterStop = result.current.state.stats;
      expect(statsAfterStop).not.toBeNull();

      // Simulate a late/already-dequeued polling callback firing anyway.
      await act(async () => {
        expect(() => queuedCallback(0)).not.toThrow();
      });

      // Guard bailed before any setState: stats reference is unchanged and no
      // replacement frame was scheduled by the late callback.
      expect(result.current.state.stats).toBe(statsAfterStop);
      const rafCallsAfterStop = rafMock.mock.calls.length;
      await act(async () => {
        queuedCallback(16);
      });
      expect(rafMock.mock.calls.length).toBe(rafCallsAfterStop);
      expect(result.current.state.stats).toBe(statsAfterStop);
    } finally {
      (globalThis as any).requestAnimationFrame = originalRAF;
      (globalThis as any).cancelAnimationFrame = originalCAF;
    }
  });

  it('A3 (ScriptProcessor): audio events delivered after stop do not write stats', async () => {
    const audio = installAudioMock({ scriptProcessor: true });
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

    await act(async () => {
      await result.current.startRecording();
    });

    const processor = audio.latest().processor!;
    expect(typeof processor.onaudioprocess).toBe('function');

    act(() => {
      result.current.stopRecording();
    });
    const statsAfterStop = result.current.state.stats;

    // The handler stays callable but is guarded: a late audio event delivered
    // after stop must be a safe no-op and must not rewrite stats.
    expect(typeof processor.onaudioprocess).toBe('function');
    await act(async () => {
      expect(() =>
        processor.onaudioprocess!({
          inputBuffer: { getChannelData: () => new Float32Array(4096) },
        } as any),
      ).not.toThrow();
    });

    expect(result.current.state.stats).toBe(statsAfterStop);
  });

  it('A4: stopping then starting again yields a brand-new zeroed session', async () => {
    const audio = installAudioMock({ scriptProcessor: true });
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

    await act(async () => {
      await result.current.startRecording();
    });
    const firstDecoder = result.current.getDecoder()!;
    (firstDecoder as any).currentLine = 200;
    (firstDecoder as any).lastSyncPos = 9999;
    (firstDecoder as any).frequencyOffset = 33;
    (firstDecoder as any).bufferWritePos = 123;

    act(() => {
      result.current.stopRecording();
    });
    expect(result.current.state.isRecording).toBe(false);

    await act(async () => {
      await result.current.startRecording();
    });

    const secondDecoder = result.current.getDecoder()!;
    expect(secondDecoder).not.toBe(firstDecoder);
    expect(audio.latest().ctor).toHaveBeenCalledTimes(2);

    const stats = result.current.state.stats!;
    expect(stats.currentLine).toBe(0);
    expect(stats.progress).toBe(0);
    expect(stats.totalLines).toBe(240);
    expect(stats.mode).toBe(SSTV_MODES.ROBOT36.name);

    expect(secondDecoder.getStats().currentLine).toBe(0);
    expect((secondDecoder as any).lastSyncPos).toBe(-1);
    expect((secondDecoder as any).frequencyOffset).toBe(0);
    expect((secondDecoder as any).bufferWritePos).toBe(0);
    expect(result.current.state.isRecording).toBe(true);
  });

  it('A5: repeated stop calls are safe and release tracks/context once', async () => {
    const audio = installAudioMock({ scriptProcessor: true });
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

    await act(async () => {
      await result.current.startRecording();
    });
    const handles = audio.latest();
    const tracks = audio.latestTracks();

    act(() => {
      expect(() => result.current.stopRecording()).not.toThrow();
    });
    act(() => {
      expect(() => result.current.stopRecording()).not.toThrow();
    });
    act(() => {
      expect(() => result.current.stopRecording()).not.toThrow();
    });

    tracks.forEach((t) => expect(t.stop).toHaveBeenCalledTimes(1));
    expect(handles.close).toHaveBeenCalledTimes(1);
    expect(result.current.state.isRecording).toBe(false);
  });

  it('A5: unmount during recording cancels frames and releases resources without throwing', async () => {
    const audio = installAudioMock({ scriptProcessor: false });
    const { result, unmount } = renderHook(() => useAudioProcessor('ROBOT36'));

    await act(async () => {
      await result.current.startRecording();
    });

    const handles = audio.latest();
    expect(() => {
      act(() => unmount());
    }).not.toThrow();

    audio.latestTracks().forEach((t) => expect(t.stop).toHaveBeenCalled());
    expect(handles.close).toHaveBeenCalled();
  });

  it('A5: unmount without ever starting does not throw', () => {
    installAudioMock();
    const { unmount } = renderHook(() => useAudioProcessor('ROBOT36'));
    expect(() => {
      act(() => unmount());
    }).not.toThrow();
  });

  it('A6: reset clears image/stats but keeps mode and recording active', async () => {
    const audio = installAudioMock({ scriptProcessor: true });
    const { result } = renderHook(() => useAudioProcessor('PD160'));

    await act(async () => {
      await result.current.startRecording();
    });

    (result.current.getDecoder() as any).currentLine = 250;

    act(() => {
      result.current.resetDecoder();
    });

    // Mode unchanged.
    expect(result.current.getDecoder()!.getMode()).toBe('PD160');
    expect(result.current.getDimensions()).toEqual({ width: 512, height: 400 });
    // Still recording.
    expect(result.current.state.isRecording).toBe(true);
    expect(result.current.getDecoder()!.getStats().state).toBe('DECODING_IMAGE');
    // Stats cleared.
    expect(result.current.state.stats).toBeNull();
    // Line counter reset.
    expect(result.current.getDecoder()!.getStats().currentLine).toBe(0);

    // The next audio callback repopulates stats for the SAME mode at line 0.
    const processor = audio.latest().processor!;
    await act(async () => {
      processor.onaudioprocess!({
        inputBuffer: { getChannelData: () => new Float32Array(4096) },
      });
    });
    expect(result.current.state.stats).toMatchObject({
      mode: SSTV_MODES.PD160.name,
      totalLines: 400,
      currentLine: 0,
    });
  });

  it('start failure surfaces an error and allows a later successful start', async () => {
    installAudioMock({ scriptProcessor: true });
    const gum = navigator.mediaDevices.getUserMedia as jest.Mock;
    gum.mockRejectedValueOnce(new Error('permission denied'));

    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.state.isRecording).toBe(false);
    expect(result.current.state.error).toMatch(/permission denied/);

    // A subsequent start must not be bricked by the in-flight guard.
    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.state.isRecording).toBe(true);
    expect(result.current.state.error).toBeNull();
  });

  it('A6: reset while stopped clears the session without starting it', async () => {
    installAudioMock();
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

    await act(async () => {
      await result.current.startRecording();
    });
    act(() => result.current.stopRecording());

    act(() => result.current.resetDecoder());

    expect(result.current.state.isRecording).toBe(false);
    expect(result.current.state.stats).toBeNull();
    expect(result.current.getDecoder()!.getStats().state).toBe('IDLE');
    expect(result.current.getDecoder()!.getStats().currentLine).toBe(0);
    expect(result.current.getDecoder()!.getMode()).toBe('ROBOT36');
  });
});

/* ------------------------------------------------------------------ */
/* Fake-timer variant of the rAF fallback (how A3 is often verified)   */
/* ------------------------------------------------------------------ */

describe('useAudioProcessor rAF fallback with fake timers', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    const analyser = {
      fftSize: 2048,
      frequencyBinCount: 1024,
      context: { sampleRate: 48000 },
      getByteFrequencyData: jest.fn(),
      getFloatTimeDomainData: jest.fn(),
      connect: jest.fn(),
      disconnect: jest.fn(),
    };
    (globalThis as any).AudioContext = jest.fn(() => ({
      sampleRate: 48000,
      destination: {},
      createAnalyser: jest.fn(() => analyser),
      createGain: jest.fn(() => ({ gain: { value: 1 }, connect: jest.fn(), disconnect: jest.fn() })),
      // Force the requestAnimationFrame polling path.
      createScriptProcessor: undefined,
      createMediaStreamSource: jest.fn(() => ({ connect: jest.fn() })),
      close: jest.fn().mockResolvedValue(undefined),
    }));
    (window as any).AudioContext = (globalThis as any).AudioContext;
    (navigator.mediaDevices.getUserMedia as jest.Mock).mockResolvedValue({
      getTracks: () => [{ stop: jest.fn() }],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('A3: advancing timers after stop never rewrites stats', async () => {
    const { result } = renderHook(() => useAudioProcessor('ROBOT36'));

    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.state.isRecording).toBe(true);

    // Let several polling frames run.
    act(() => {
      jest.advanceTimersByTime(120);
    });

    act(() => {
      result.current.stopRecording();
    });
    const statsAtStop = result.current.state.stats;
    expect(statsAtStop).not.toBeNull();

    // Many more simulated frames/time must not produce stats writes.
    act(() => {
      jest.advanceTimersByTime(2000);
      jest.runOnlyPendingTimers();
    });

    expect(result.current.state.stats).toBe(statsAtStop);
  });
});
