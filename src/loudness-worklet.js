/**
 * B站音量均衡器 - 响度测量 Worklet
 *
 * 在音频线程里按 ITU-R BS.1770-4 / EBU R128 计算：
 *   - Momentary（400 ms）
 *   - Short-term（3 s）
 *   - Integrated（带绝对门限 + 相对门限）
 *
 * 这里只做测量，不改动声音。增益由主线程的 GainNode 施加。
 */

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const BLOCK_SECONDS = 0.4;
const HOP_SECONDS = 0.1;
const SHORT_TERM_BLOCKS = 30; // 30 * 100 ms = 3 s

function energyToLufs(energy) {
  return energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity;
}

/**
 * 计算一组 400 ms 块能量的 integrated loudness。
 * 先做 -70 LUFS 绝对门限，再以绝对门限后的平均能量 -10 LU 做相对门限。
 */
function gatedLoudness(energies) {
  if (!energies.length) return null;

  const aboveAbsolute = [];
  for (let i = 0; i < energies.length; i += 1) {
    const e = energies[i];
    if (e > 0 && energyToLufs(e) > ABSOLUTE_GATE_LUFS) {
      aboveAbsolute.push(e);
    }
  }
  if (!aboveAbsolute.length) return null;

  let sum = 0;
  for (let i = 0; i < aboveAbsolute.length; i += 1) sum += aboveAbsolute[i];
  const relativeGate = energyToLufs(sum / aboveAbsolute.length) + RELATIVE_GATE_LU;

  let gatedSum = 0;
  let gatedCount = 0;
  for (let i = 0; i < aboveAbsolute.length; i += 1) {
    const e = aboveAbsolute[i];
    if (energyToLufs(e) > relativeGate) {
      gatedSum += e;
      gatedCount += 1;
    }
  }
  if (!gatedCount) return null;
  return energyToLufs(gatedSum / gatedCount);
}

/**
 * BS.1770 K-weighting 的两级双二阶滤波器。
 * 系数由模拟原型在任意采样率下双线性变换得到；48 kHz 时与标准表一致。
 */
function makeKWeightingCoefficients(sampleRate) {
  // Stage 1: high shelf
  const shelfFc = 1681.974450955533;
  const shelfGainDb = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  const k1 = Math.tan((Math.PI * shelfFc) / sampleRate);
  const vh = Math.pow(10, shelfGainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const shelfDen = 1 + k1 / shelfQ + k1 * k1;
  const shelf = {
    b0: (vh + (vb * k1) / shelfQ + k1 * k1) / shelfDen,
    b1: (2 * (k1 * k1 - vh)) / shelfDen,
    b2: (vh - (vb * k1) / shelfQ + k1 * k1) / shelfDen,
    a1: (2 * (k1 * k1 - 1)) / shelfDen,
    a2: (1 - k1 / shelfQ + k1 * k1) / shelfDen,
  };

  // Stage 2: high-pass
  const hpFc = 38.13547087602444;
  const hpQ = 0.5003270373238773;
  const k2 = Math.tan((Math.PI * hpFc) / sampleRate);
  const hpDen = 1 + k2 / hpQ + k2 * k2;
  const highpass = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k2 * k2 - 1)) / hpDen,
    a2: (1 - k2 / hpQ + k2 * k2) / hpDen,
  };

  return { shelf, highpass };
}

class Biquad {
  constructor(coefficients) {
    this.b0 = coefficients.b0;
    this.b1 = coefficients.b1;
    this.b2 = coefficients.b2;
    this.a1 = coefficients.a1;
    this.a2 = coefficients.a2;
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  process(x) {
    const y =
      this.b0 * x +
      this.b1 * this.x1 +
      this.b2 * this.x2 -
      this.a1 * this.y1 -
      this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

class LoudnessProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sampleRate = sampleRate;
    this.blockSize = Math.max(1, Math.round(sampleRate * BLOCK_SECONDS));
    this.hopSize = Math.max(1, Math.round(sampleRate * HOP_SECONDS));
    this.coefficients = makeKWeightingCoefficients(sampleRate);
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'reset') {
        this.reset();
      }
    };
    this.reset();
  }

  reset() {
    this.filters = [];
    this.ring = new Float64Array(this.blockSize);
    this.ringIndex = 0;
    this.ringSum = 0;
    this.hopCounter = 0;
    this.samplesSeen = 0;
    this.blockEnergies = [];
    this.peak = 0;
    this.integratedCache = null;
    this.reportCounter = 0;
  }

  ensureChannels(channelCount) {
    while (this.filters.length < channelCount) {
      this.filters.push({
        shelf: new Biquad(this.coefficients.shelf),
        highpass: new Biquad(this.coefficients.highpass),
      });
    }
  }

  report() {
    const energies = this.blockEnergies;
    if (!energies.length) return;

    this.reportCounter += 1;
    // 长视频不必每 100 ms 都重算一遍 integrated；每 500 ms 一次足够。
    if (this.integratedCache == null || this.reportCounter % 5 === 0) {
      this.integratedCache = gatedLoudness(energies);
    }
    const integrated = this.integratedCache;
    const lastIndex = energies.length - 1;
    const momentary = energyToLufs(energies[lastIndex]);

    const start = Math.max(0, energies.length - SHORT_TERM_BLOCKS);
    let shortSum = 0;
    for (let i = start; i < energies.length; i += 1) shortSum += energies[i];
    const shortTerm = energyToLufs(shortSum / (energies.length - start));

    const recent = energies.slice(-SHORT_TERM_BLOCKS);
    const recentGated = gatedLoudness(recent);

    this.port.postMessage({
      type: 'loudness',
      momentary,
      shortTerm,
      recent: recentGated,
      integrated,
      blocks: energies.length,
      peak: this.peak,
      sampleRate: this.sampleRate,
    });
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    const channelCount = input.length;
    const frameCount = input[0].length;
    this.ensureChannels(channelCount);

    for (let i = 0; i < frameCount; i += 1) {
      let frameEnergy = 0;
      for (let c = 0; c < channelCount; c += 1) {
        const sample = input[c][i];
        const abs = sample < 0 ? -sample : sample;
        if (abs > this.peak) this.peak = abs;

        const state = this.filters[c];
        const weighted = state.highpass.process(state.shelf.process(sample));
        frameEnergy += weighted * weighted;
      }

      const old = this.ring[this.ringIndex];
      this.ringSum += frameEnergy - old;
      this.ring[this.ringIndex] = frameEnergy;
      this.ringIndex = (this.ringIndex + 1) % this.blockSize;
      this.samplesSeen += 1;
      this.hopCounter += 1;

      if (this.hopCounter >= this.hopSize) {
        this.hopCounter = 0;
        if (this.samplesSeen >= this.blockSize) {
          this.blockEnergies.push(this.ringSum / this.blockSize);
          // 最多保留 30 分钟，避免两小时视频把音频线程拖慢。
          if (this.blockEnergies.length > 18000) {
            this.blockEnergies.splice(0, this.blockEnergies.length - 18000);
            this.integratedCache = null;
          }
          this.report();
        }
      }
    }

    return true;
  }
}

registerProcessor('bvb-loudness', LoudnessProcessor);
