import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const WORKLET_PATH = new URL('../src/loudness-worklet.js', import.meta.url);
const SAMPLE_RATE = 48000;
const FRAME_SIZE = 128;

function loadProcessor() {
  const code = fs.readFileSync(WORKLET_PATH, 'utf8');
  const messages = [];
  let ProcessorClass = null;

  const sandbox = {
    sampleRate: SAMPLE_RATE,
    console,
    Math,
    Float64Array,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          onmessage: null,
          postMessage: (message) => messages.push(message),
        };
      }
    },
    registerProcessor: (name, processorClass) => {
      assert.equal(name, 'bvb-loudness');
      ProcessorClass = processorClass;
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'loudness-worklet.js' });
  assert.ok(ProcessorClass, 'worklet should register a processor');

  return {
    create() {
      messages.length = 0;
      return new ProcessorClass();
    },
    messages,
  };
}

function feedSine(processor, seconds, amplitude, frequency = 1000, channels = 2) {
  const totalFrames = Math.round(seconds * SAMPLE_RATE);
  let frame = 0;
  while (frame < totalFrames) {
    const count = Math.min(FRAME_SIZE, totalFrames - frame);
    const input = [];
    for (let channel = 0; channel < channels; channel += 1) {
      const data = new Float32Array(count);
      for (let i = 0; i < count; i += 1) {
        data[i] = amplitude * Math.sin((2 * Math.PI * frequency * (frame + i)) / SAMPLE_RATE);
      }
      input.push(data);
    }
    processor.process([input]);
    frame += count;
  }
}

function feedSilence(processor, seconds, channels = 2) {
  const totalFrames = Math.round(seconds * SAMPLE_RATE);
  let frame = 0;
  while (frame < totalFrames) {
    const count = Math.min(FRAME_SIZE, totalFrames - frame);
    const input = [];
    for (let channel = 0; channel < channels; channel += 1) {
      input.push(new Float32Array(count));
    }
    processor.process([input]);
    frame += count;
  }
}

function lastMessage(messages) {
  const loudness = messages.filter((message) => message.type === 'loudness');
  assert.ok(loudness.length > 0, 'expected at least one loudness message');
  return loudness[loudness.length - 1];
}

const harness = loadProcessor();

test('1 kHz stereo sine at -20 dBFS measures about -20 LUFS', () => {
  const processor = harness.create();
  feedSine(processor, 5, 0.1);
  const message = lastMessage(harness.messages);
  assert.ok(Math.abs(message.integrated - -20) < 0.2, `integrated=${message.integrated}`);
  assert.ok(Math.abs(message.momentary - -20) < 0.2, `momentary=${message.momentary}`);
});

test('1 kHz stereo sine at -40 dBFS measures about -40 LUFS', () => {
  const processor = harness.create();
  feedSine(processor, 4, 0.01);
  const message = lastMessage(harness.messages);
  assert.ok(Math.abs(message.integrated - -40) < 0.3, `integrated=${message.integrated}`);
});

test('mono measurement is 3 LU quieter than dual-mono stereo', () => {
  const mono = harness.create();
  feedSine(mono, 4, 0.1, 1000, 1);
  const monoLufs = lastMessage(harness.messages).integrated;

  const stereo = harness.create();
  feedSine(stereo, 4, 0.1, 1000, 2);
  const stereoLufs = lastMessage(harness.messages).integrated;

  assert.ok(Math.abs(stereoLufs - monoLufs - 3.01) < 0.1, `mono=${monoLufs}, stereo=${stereoLufs}`);
});

test('absolute gating ignores digital silence', () => {
  const processor = harness.create();
  feedSine(processor, 3, 0.1);
  feedSilence(processor, 5);
  const message = lastMessage(harness.messages);
  assert.ok(Math.abs(message.integrated - -20) < 0.3, `integrated=${message.integrated}`);
});

test('relative gating ignores a much quieter passage', () => {
  const processor = harness.create();
  feedSine(processor, 5, 0.1);
  feedSine(processor, 5, 0.0031623);
  const message = lastMessage(harness.messages);
  assert.ok(Math.abs(message.integrated - -20) < 0.5, `integrated=${message.integrated}`);
});

test('silence produces no finite integrated loudness', () => {
  const processor = harness.create();
  feedSilence(processor, 3);
  const message = lastMessage(harness.messages);
  assert.equal(message.integrated, null);
  assert.equal(message.peak, 0);
});

test('reset clears the measurement history', () => {
  const processor = harness.create();
  feedSine(processor, 3, 0.1);
  processor.reset();
  feedSine(processor, 1, 0.01);
  const message = lastMessage(harness.messages);
  assert.ok(Math.abs(message.integrated - -40) < 0.3, `integrated=${message.integrated}`);
});
