import { SSTVDecoder, DecoderState } from '../decoder';
import { SSTV_MODES } from '../constants';
import { PD120LineDecoder } from '../pd120-line-decoder';
import { PD160LineDecoder } from '../pd160-line-decoder';
import { Robot36LineDecoder } from '../robot36-line-decoder';
import { ScottieS1LineDecoder } from '../scottie-s1-line-decoder';

const SAMPLE_RATE = 48000;

/** Fill the image buffer with non-black pixels to simulate decoded lines. */
function dirtyImage(decoder: SSTVDecoder, value = 255): void {
  const img = decoder.getImageData();
  for (let i = 0; i < img.length; i += 4) {
    img[i] = value;
    img[i + 1] = value;
    img[i + 2] = value;
    img[i + 3] = 255;
  }
}

function expectImageOpaqueBlack(img: Uint8ClampedArray): void {
  // Scan with plain comparisons first: creating a Jest matcher per channel on
  // million-entry buffers would make the test needlessly slow.
  let firstBad = -1;
  for (let i = 0; i < img.length; i += 4) {
    if (img[i] !== 0 || img[i + 1] !== 0 || img[i + 2] !== 0 || img[i + 3] !== 255) {
      firstBad = i;
      break;
    }
  }
  expect(firstBad).toBe(-1);
}

describe('SSTVDecoder mode/session rebuilding', () => {
  it('A1: switching mode updates dimensions, mode name, total lines and zero progress', () => {
    const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');
    decoder.start();

    // Simulate some decoded progress.
    (decoder as any).currentLine = 120;
    let stats = decoder.getStats();
    expect(stats.mode).toBe(SSTV_MODES.ROBOT36.name);
    expect(stats.totalLines).toBe(240);
    expect(stats.currentLine).toBe(120);
    expect(stats.progress).toBe(50);
    expect(decoder.getDimensions()).toEqual({ width: 320, height: 240 });

    decoder.setMode('PD120');

    stats = decoder.getStats();
    expect(decoder.getMode()).toBe('PD120');
    expect(decoder.getDimensions()).toEqual({
      width: SSTV_MODES.PD120.width,
      height: SSTV_MODES.PD120.height,
    });
    expect(stats.mode).toBe(SSTV_MODES.PD120.name);
    expect(stats.totalLines).toBe(SSTV_MODES.PD120.height);
    expect(stats.currentLine).toBe(0);
    expect(stats.progress).toBe(0);
  });

  it('A1: prop/alias entry points (switchMode/changeMode/reinitialize) rebuild correctly', () => {
    const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');

    decoder.switchMode('PD160');
    expect(decoder.getMode()).toBe('PD160');
    expect(decoder.getDimensions()).toEqual({ width: 512, height: 400 });
    expect(decoder.getStats().mode).toBe(SSTV_MODES.PD160.name);
    expect(decoder.getStats().totalLines).toBe(400);

    decoder.changeMode('SCOTTIE_S1');
    expect(decoder.getMode()).toBe('SCOTTIE_S1');
    expect(decoder.getDimensions()).toEqual({ width: 320, height: 256 });
    expect(decoder.getStats().totalLines).toBe(256);

    decoder.reinitialize('PD120');
    expect(decoder.getMode()).toBe('PD120');
    expect(decoder.getStats().progress).toBe(0);

    // reinitialize() without a mode only resets the current session.
    (decoder as any).currentLine = 10;
    decoder.reinitialize();
    expect(decoder.getMode()).toBe('PD120');
    expect(decoder.getStats().currentLine).toBe(0);
  });

  it('A2: switching mode replaces the line decoder for the new mode', () => {
    const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');
    expect((decoder as any).lineDecoder).toBeInstanceOf(Robot36LineDecoder);

    decoder.setMode('PD120');
    expect((decoder as any).lineDecoder).toBeInstanceOf(PD120LineDecoder);

    decoder.setMode('PD160');
    expect((decoder as any).lineDecoder).toBeInstanceOf(PD160LineDecoder);

    decoder.setMode('SCOTTIE_S1');
    expect((decoder as any).lineDecoder).toBeInstanceOf(ScottieS1LineDecoder);
  });

  it('A2: switching mode clears the old picture and zeroes every session field', () => {
    const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');
    decoder.start();

    const syncDetector = (decoder as any).syncDetector;
    const syncResetSpy = jest.spyOn(syncDetector, 'reset');

    // Dirty all session state.
    dirtyImage(decoder);
    (decoder as any).currentLine = 200;
    (decoder as any).bufferWritePos = 12345;
    (decoder as any).lastSyncPos = 9876;
    (decoder as any).lastSyncWidth = 9;
    (decoder as any).frequencyOffset = 42.5;
    (decoder as any).signalStrength = 88;
    (decoder as any).sampleCounter = 999;
    (decoder as any).absoluteSamplePosition = 555;
    (decoder as any).audioBuffer.fill(0.7);
    (decoder as any).demodulatedBuffer.fill(-0.4);
    (decoder as any).syncDetector.syncPulseCounter = 77;

    const oldImage = decoder.getImageData();
    expect(oldImage[0]).toBe(255);
    expect(oldImage[1]).toBe(255);
    expect(oldImage[2]).toBe(255);

    decoder.setMode('PD120');

    // The sample-rate-bound detector instance is reused but reset.
    expect((decoder as any).syncDetector).toBe(syncDetector);
    expect(syncResetSpy).toHaveBeenCalled();

    // New dimensions -> new buffer size and contents.
    const newImage = decoder.getImageData();
    expect(newImage.length).toBe(SSTV_MODES.PD120.width * SSTV_MODES.PD120.height * 4);
    expect(newImage).not.toBe(oldImage);
    expectImageOpaqueBlack(newImage);

    expect(decoder.getStats().currentLine).toBe(0);
    expect(decoder.getStats().progress).toBe(0);
    expect((decoder as any).currentLine).toBe(0);
    expect((decoder as any).bufferWritePos).toBe(0);
    expect((decoder as any).lastSyncPos).toBe(-1);
    expect((decoder as any).lastSyncWidth).toBeNull();
    expect((decoder as any).frequencyOffset).toBe(0);
    expect(decoder.getStats().frequency).toBe(1900);
    expect((decoder as any).signalStrength).toBe(0);
    expect(decoder.getStats().signalStrength).toBe(0);
    expect((decoder as any).sampleCounter).toBe(0);
    expect((decoder as any).absoluteSamplePosition).toBe(0);

    // Buffers and detector state are zeroed.
    expect((decoder as any).audioBuffer.every((v: number) => v === 0)).toBe(true);
    expect((decoder as any).demodulatedBuffer.every((v: number) => v === 0)).toBe(true);
    expect((decoder as any).syncDetector.syncPulseCounter).toBe(0);
  });

  it('setMode preserves the running decoding state', () => {
    const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');
    expect(decoder.getStats().state).toBe(DecoderState.IDLE);

    decoder.start();
    expect(decoder.getStats().state).toBe(DecoderState.DECODING_IMAGE);

    decoder.setMode('PD180');
    expect(decoder.getStats().state).toBe(DecoderState.DECODING_IMAGE);

    decoder.stop();
    decoder.setMode('ROBOT72');
    expect(decoder.getStats().state).toBe(DecoderState.IDLE);
  });

  it('A4: start() after progress gives a clean zeroed session', () => {
    const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36');
    decoder.start();

    dirtyImage(decoder, 200);
    (decoder as any).currentLine = 239;
    (decoder as any).lastSyncPos = 4242;
    (decoder as any).frequencyOffset = -17;
    (decoder as any).bufferWritePos = 777;

    decoder.stop();
    expect(decoder.getStats().state).toBe(DecoderState.IDLE);

    decoder.start();

    const stats = decoder.getStats();
    expect(stats.state).toBe(DecoderState.DECODING_IMAGE);
    expect(stats.currentLine).toBe(0);
    expect(stats.progress).toBe(0);
    expect((decoder as any).lastSyncPos).toBe(-1);
    expect((decoder as any).frequencyOffset).toBe(0);
    expect((decoder as any).bufferWritePos).toBe(0);
    expectImageOpaqueBlack(decoder.getImageData());
  });

  it('A6: reset clears the session but keeps the configured mode', () => {
    const decoder = new SSTVDecoder(SAMPLE_RATE, 'PD160');
    decoder.start();
    (decoder as any).currentLine = 100;

    decoder.reset();

    expect(decoder.getMode()).toBe('PD160');
    expect(decoder.getDimensions()).toEqual({ width: 512, height: 400 });
    expect(decoder.getStats().mode).toBe(SSTV_MODES.PD160.name);
    expect(decoder.getStats().currentLine).toBe(0);
    expect(decoder.getStats().progress).toBe(0);
    expectImageOpaqueBlack(decoder.getImageData());
  });
});
