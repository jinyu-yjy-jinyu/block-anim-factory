/* ============================================================
   audio-core.js · 音频内核
   ------------------------------------------------------------
   V0 的 AudioSource 是程序化合成的确定性曲线；V1 起要接真实录音。
   这一层把两者统一成同一个接口，让上层（积木 / 渲染 / 导出）
   完全不需要知道声音是「合成的」还是「录下来的」。

   核心约束（规划里的致命风险之一）：
   预览与导出必须逐帧一致 ⇒ 音频分析结果必须**只取决于时间 t**，
   不依赖 AudioContext 的实时播放状态。
   因此这里所有分析都是「按采样帧查表」，而不是「读当前播放位置」。
   ============================================================ */

/* ---------- 有符号 16bit PCM ---------- */
export function encodeWav(samples, sampleRate = 48000, channels = 1) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);                       // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * 2, true);
  dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    // 对称缩放；注意 Math.round(1.0*32767)=32767，而 Math.round(-1.0*32767)=-32767，
    // 都在 int16 范围内（-32768..32767），无需额外夹取
    const s = Math.round(v * 32767);
    dv.setInt16(44 + i * 2, s, true);
  }
  return buf;
}

export function decodeWav(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const str = (off, len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
    return s;
  };
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('不是合法的 WAV 文件');

  let pos = 12;
  let fmt = null, dataOffset = 0, dataLen = 0;
  while (pos + 8 <= dv.byteLength) {
    const id = str(pos, 4);
    const size = dv.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      fmt = {
        format: dv.getUint16(pos + 8, true),
        channels: dv.getUint16(pos + 10, true),
        sampleRate: dv.getUint32(pos + 12, true),
        bits: dv.getUint16(pos + 22, true),
      };
    } else if (id === 'data') {
      dataOffset = pos + 8;
      dataLen = Math.min(size, dv.byteLength - dataOffset);
    }
    pos += 8 + size + (size & 1);
  }
  if (!fmt) throw new Error('WAV 缺少 fmt 块');
  if (!dataOffset) throw new Error('WAV 缺少 data 块');

  const bytesPerSample = fmt.bits / 8;
  const frames = Math.floor(dataLen / (bytesPerSample * fmt.channels));
  const left = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const off = dataOffset + (i * fmt.channels + c) * bytesPerSample;
      let v = 0;
      if (fmt.bits === 16) v = dv.getInt16(off, true) / 32767;
      else if (fmt.bits === 8) v = (dv.getUint8(off) - 128) / 128;
      else if (fmt.bits === 32) v = dv.getInt32(off, true) / 0x80000000;
      else if (fmt.format === 3) v = dv.getFloat32(off, true);
      acc += v;
    }
    left[i] = acc / fmt.channels;
  }
  return { samples: left, sampleRate: fmt.sampleRate, duration: frames / fmt.sampleRate };
}

/* 重采样（线性插值，足够用于分析与预览） */
export function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const f = src - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

/* ============================================================
   音频轨道：可编辑的音频片段集合
   ============================================================ */
export class AudioTrack {
  constructor(opts = {}) {
    this.id = opts.id || 'trk_' + Math.random().toString(36).slice(2, 8);
    this.name = opts.name || '音轨';
    this.kind = opts.kind || 'voice';       // voice | music | sfx | ambience
    this.sampleRate = opts.sampleRate || 48000;
    this.samples = opts.samples || new Float32Array(0);
    this.gain = opts.gain == null ? 1 : opts.gain;
    this.muted = false;
    this.solod = false;
    this.volume = 1;                        // 包络后的实时音量
    this.duckTo = 1;                        // 闪避目标
    this.analysis = null;
  }

  get duration() { return this.samples.length / this.sampleRate; }

  setSamples(s, rate) {
    this.samples = s;
    if (rate) this.sampleRate = rate;
    this.analysis = null;
    return this;
  }

  /* 截取 [t0, t1)（秒） */
  slice(t0, t1) {
    const a = Math.max(0, Math.floor(t0 * this.sampleRate));
    const b = Math.min(this.samples.length, Math.ceil(t1 * this.sampleRate));
    return this.samples.slice(a, Math.max(a, b));
  }

  /* 拼接（原地） */
  concat(other) {
    if (other.sampleRate !== this.sampleRate) {
      other = new AudioTrack({ sampleRate: this.sampleRate, samples: resample(other.samples, other.sampleRate, this.sampleRate) });
    }
    const out = new Float32Array(this.samples.length + other.samples.length);
    out.set(this.samples, 0);
    out.set(other.samples, this.samples.length);
    this.samples = out;
    this.analysis = null;
    return this;
  }

  /* 线性增益 */
  applyGain(g) {
    for (let i = 0; i < this.samples.length; i++) this.samples[i] *= g;
    this.analysis = null;
    return this;
  }

  /* 淡入 / 淡出（秒） */
  fade(t0, t1, t2, seconds) {
    const sr = this.sampleRate;
    const a = Math.floor(t0 * sr), b = Math.floor(t1 * sr);
    const f = Math.max(1, Math.floor(seconds * sr));
    for (let i = 0; i < f; i++) {
      const g = i / f;
      if (a + i < b) this.samples[a + i] *= g;
      if (b - 1 - i >= 0) this.samples[b - 1 - i] *= g;
    }
    this.analysis = null;
    return this;
  }

  /* 归一化到目标峰值 */
  normalize(target = 0.98) {
    let peak = 0;
    for (let i = 0; i < this.samples.length; i++) {
      const a = Math.abs(this.samples[i]);
      if (a > peak) peak = a;
    }
    if (peak > 1e-6) this.applyGain(target / peak);
    return this;
  }

  ensureAnalysis() {
    if (!this.analysis) this.analysis = analyzeTrack(this);
    return this.analysis;
  }
}

/* ============================================================
   离线分析：全部只取决于样本数据 ⇒ 预览/导出一致
   ============================================================ */

/* 波形峰值包络（min/max 对），用于波形显示与去静默 */
export function computePeaks(samples, sampleRate, bucketsPerSecond = 200) {
  const n = samples.length;
  const bucket = Math.max(1, Math.floor(sampleRate / bucketsPerSecond));
  const count = Math.ceil(n / bucket);
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const rms = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    const s = b * bucket, e = Math.min(n, s + bucket);
    let lo = 0, hi = 0, sum = 0;
    for (let i = s; i < e; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v * v;
    }
    min[b] = lo; max[b] = hi;
    rms[b] = Math.sqrt(sum / Math.max(1, e - s));
  }
  return { min, max, rms, bucket, bucketsPerSecond };
}

/* 短时傅里叶：逐帧频谱（FFT 已在下方实现） */
export function computeSpectrogram(samples, sampleRate, opts = {}) {
  const fftSize = opts.fftSize || 1024;
  const hop = opts.hop || 256;
  const bins = fftSize / 2;
  const frames = Math.max(1, Math.floor((samples.length - fftSize) / hop) + 1);
  const spec = new Float32Array(frames * bins);
  const win = hann(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < fftSize; i++) {
      const idx = off + i;
      re[i] = idx < samples.length ? samples[idx] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bins; b++) {
      const mag = Math.hypot(re[b], im[b]) / (fftSize / 2);
      spec[f * bins + b] = mag;
    }
  }
  return { spec, frames, bins, fftSize, hop, sampleRate, framesPerSecond: sampleRate / hop };
}

/* 三频段能量包络：Bass / Mid / Treble —— 「音频驱动画面」的核心变量 */
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;

export function computeBandEnergies(samples, sampleRate, opts = {}) {
  const fps = opts.fps || 60;
  const spectro = computeSpectrogram(samples, sampleRate, {
    fftSize: opts.fftSize || 1024,
    hop: opts.hop || Math.max(128, Math.floor(sampleRate / fps)),
  });
  const { spec, frames, bins } = spectro;
  const nyq = sampleRate / 2;
  // 频段边界（bin 下标），至少各留 1 个 bin，避免窄段恒为 0
  const bHi = Math.max(2, Math.round(200 / nyq * bins));       // Bass  < 200Hz
  const bLo = Math.max(bHi + 2, Math.round(2000 / nyq * bins)); // Mid   200~2000Hz
  const bTop = Math.max(bLo + 2, Math.min(bins - 1, Math.round(12000 / nyq * bins)));
  const total = Math.max(1, Math.round(fps * (samples.length / sampleRate)));

  const amp = new Float32Array(total);
  const bass = new Float32Array(total);
  const mid = new Float32Array(total);
  const treble = new Float32Array(total);
  const rmsAll = new Float32Array(total);

  // computeSpectrogram 已把幅度归一化（除以 fftSize/2），
    // 此处只需把「幅度均值」还原成 0..1 的绝对幅度并限幅。
    const norm = (sum, count) => clamp01((sum / Math.max(1, count)) * 3.0);

  for (let t = 0; t < total; t++) {
    const time = t / fps;
    const f = Math.min(frames - 1, Math.floor(time * spectro.framesPerSecond));
    let eB = 0, eM = 0, eT = 0, eAll = 0, cnt = 0;
    for (let b = 1; b < bins; b++) {
      const m = spec[f * bins + b];
      eAll += m;
      cnt++;
      if (b < bHi) eB += m;
      else if (b < bLo) eM += m;
      else if (b < bTop) eT += m;
    }
    bass[t] = norm(eB, bHi - 1);
    mid[t] = norm(eM, bLo - bHi);
    treble[t] = norm(eT, bTop - bLo);
    // 总振幅：全谱均方根
    amp[t] = clamp01(Math.sqrt(eAll / Math.max(1, cnt)) * 3.4);
    rmsAll[t] = amp[t];
  }
  // 轻度平滑，避免抖动
  smooth(amp, 3); smooth(bass, 3); smooth(mid, 3); smooth(treble, 3);
  return { amp, bass, mid, treble, rms: rmsAll, fps, total };
}

/* 节拍检测：能量包络 → 自适应阈值 → 峰值 */
export function detectBeats(energy, fps, opts = {}) {
  const minInterval = opts.minInterval || 0.25;      // 秒
  const thresholdK = opts.thresholdK || 1.45;
  const out = [];
  if (!energy.length) return out;

  // 滑动均值作为自适应基线
  const w = Math.max(3, Math.round(fps * 0.6));
  const minGap = Math.max(1, Math.round(minInterval * fps));
  let lastIdx = -minGap;
  for (let i = 1; i < energy.length - 1; i++) {
    let sum = 0, cnt = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(energy.length - 1, i + w); k++) { sum += energy[k]; cnt++; }
    const base = sum / cnt;
    const v = energy[i];
    if (v > base * thresholdK && v > energy[i - 1] && v >= energy[i + 1] && i - lastIdx >= minGap) {
      out.push({ time: i / fps, strength: v - base });
      lastIdx = i;
    }
  }
  // 估计 BPM：相邻间隔的中位数
  let bpm = 0;
  if (out.length >= 2) {
    const gaps = [];
    for (let i = 1; i < out.length; i++) gaps.push(out[i].time - out[i - 1].time);
    gaps.sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)];
    if (med > 0.01) {
      let b = 60 / med;
      while (b < 70) b *= 2;
      while (b > 180) b /= 2;
      bpm = Math.round(b);
    }
  }
  return { beats: out, bpm };
}

/* 静音检测：连续低于阈值 dB 的区间 */
export function detectSilence(samples, sampleRate, opts = {}) {
  const threshDb = opts.thresholdDb == null ? -42 : opts.thresholdDb;
  const minSilence = opts.minSilence == null ? 0.35 : opts.minSilence;
  const keepPad = opts.keepPad == null ? 0.06 : opts.keepPad;
  const lin = Math.pow(10, threshDb / 20);

  // 10ms 窗口 RMS
  const win = Math.max(1, Math.floor(sampleRate * 0.01));
  const winCount = Math.floor(samples.length / win);
  const flags = new Uint8Array(winCount);
  for (let w = 0; w < winCount; w++) {
    let sum = 0;
    for (let i = w * win; i < (w + 1) * win; i++) sum += samples[i] * samples[i];
    const r = Math.sqrt(sum / win);
    flags[w] = r < lin ? 1 : 0;
  }
  const regions = [];
  let start = -1;
  for (let w = 0; w <= winCount; w++) {
    const silent = w < winCount && flags[w] === 1;
    if (silent && start < 0) start = w;
    else if (!silent && start >= 0) {
      const t0 = start * win / sampleRate;
      const t1 = w * win / sampleRate;
      if (t1 - t0 >= minSilence) regions.push({ start: t0, end: t1, dur: t1 - t0 });
      start = -1;
    }
  }
  return regions;
}

/* 一次性算出所有分析结果并缓存 */
export function analyzeTrack(track, opts = {}) {
  const { samples, sampleRate } = track;
  const peaks = computePeaks(samples, sampleRate, opts.peaksPerSecond || 200);
  const bands = computeBandEnergies(samples, sampleRate, { fps: opts.fps || 60 });
  const beat = detectBeats(bands.amp, opts.fps || 60);
  return {
    peaks,
    bands,
    beats: beat.beats,
    bpm: beat.bpm,
    duration: samples.length / sampleRate,
    loudness: measureLoudness(samples, sampleRate),
  };
}

/* ============================================================
   EBU R128 响度计量（K 加权 + 门限）
   ============================================================ */
/* ------------------------------------------------------------
   K 加权（ITU-R BS.1770-4）
   K 加权 = 两个高频搁架串联：
     Stage1 模拟原型 f0≈1500Hz, Q=1/√2, 高频 +4dB
     Stage2 RLB 高频提升，高频 ≈0dB（配合 Stage1 凑出 4dB 曲线）
   系数含义：H(z) = (b0 + b1 z⁻¹ + b2 z⁻²) / (1 + a1 z⁻¹ + a2 z⁻²)
   48kHz 直接采用官方表值；其它采样率用同一模拟原型做双线性变换。
   ------------------------------------------------------------ */

/* RBJ 高频搁架 → 归一化双二阶 */
function highShelf(sr, f0, q, gainDb) {
  const A = Math.pow(10, gainDb / 40);
  const w = 2 * Math.PI * f0 / sr;
  const cosw = Math.cos(w), sinw = Math.sin(w);
  const alpha = sinw / 2 * Math.sqrt((A + 1 / A) * (1 - 1) + 2);   // S=1 ⇒ 简化为 sinw
  const beta = 2 * Math.sqrt(A) * (sinw / 2);
  const b0 = A * ((A + 1) + (A - 1) * cosw + beta);
  const b1 = -2 * A * ((A - 1) + (A + 1) * cosw);
  const b2 = A * ((A + 1) + (A - 1) * cosw - beta);
  const a0 = (A + 1) - (A - 1) * cosw + beta;
  const a1 = 2 * ((A - 1) - (A + 1) * cosw);
  const a2 = (A + 1) - (A - 1) * cosw - beta;
  void alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function designStage1(sampleRate) {
  if (Math.abs(sampleRate - 48000) < 1) {
    // BS.1770-4 官方表值
    return { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 };
  }
  return highShelf(sampleRate, 1500, 0.7071752369554196, 4.0);
}

function designStage2(sampleRate) {
  if (Math.abs(sampleRate - 48000) < 1) {
    return { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 };
  }
  return highShelf(sampleRate, 1500, 0.7071752369554196, 0.0);
}

function designKWeighting(sampleRate) {
  return { stage1: designStage1(sampleRate), stage2: designStage2(sampleRate) };
}

/* 直接形式 I 双二阶；系数已归一化（b 全部除过 a0） */
function biquad(input, coef) {
  const { b0, b1, b2, a1, a2 } = coef;
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

/* 整体响度 LUFS */
export function measureLoudness(samples, sampleRate) {
  if (samples.length < sampleRate * 0.05) return { lufs: -70, lra: 0, peak: 0 };
  const K = designKWeighting(sampleRate);
  const stage1 = biquad(samples, K.stage1);
  const stage2 = biquad(stage1, K.stage2);

  // 400ms 块、75% 重叠
  const block = Math.floor(sampleRate * 0.4);
  const step = Math.floor(block * 0.25);
  const loud = [];
  for (let off = 0; off + block <= stage2.length; off += step) {
    let sum = 0;
    for (let i = off; i < off + block; i++) sum += stage2[i] * stage2[i];
    const ms = sum / block;
    if (ms > 0) loud.push(-0.691 + 10 * Math.log10(ms));
  }
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (!loud.length) return { lufs: -70, lra: 0, peak };
  loud.sort((a, b) => a - b);
  const absGate = -70;
  const above = loud.filter(v => v > absGate);
  const relGate = (above.length ? above : loud).reduce((a, b) => a + b, 0) / (above.length || loud.length) - 10;
  const gated = (above.length ? above : loud).filter(v => v > relGate);
  const mean = gated.reduce((a, b) => a + b, 0) / Math.max(1, gated.length);
  const lufs = mean;
  // LRA 简化：10%~95% 分位差
  const lra = loud[Math.floor(loud.length * 0.95)] - loud[Math.floor(loud.length * 0.10)];
  return {
    lufs: Math.round(lufs * 100) / 100,
    lra: Math.round(lra * 100) / 100,
    peak: Math.round(peak * 1000) / 1000,
    truePeakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
  };
}

/* 按目标 LUFS 施加增益（自动限幅防止削波） */
export function normalizeLoudness(track, targetLufs = -14, opts = {}) {
  const m = measureLoudness(track.samples, track.sampleRate);
  if (m.lufs <= -69) return { gain: 1, before: m, after: m };
  let gain = Math.pow(10, (targetLufs - m.lufs) / 20);
  const ceiling = opts.ceilingDb == null ? -1 : opts.ceilingDb;
  const ceilLin = Math.pow(10, ceiling / 20);
  if (m.peak * gain > ceilLin && m.peak > 0) {
    gain = ceilLin / m.peak;
  }
  track.applyGain(gain);
  return { gain, before: m, after: measureLoudness(track.samples, track.sampleRate) };
}

/* 平台响度预设（规划 D6） */
export const LOUDNESS_PRESETS = {
  douyin:    { label: '抖音',    lufs: -14.0, ceilingDb: -1.0, note: '短视频主流' },
  bilibili:  { label: 'B站',     lufs: -16.0, ceilingDb: -1.0, note: '容忍更大动态' },
  youtube:   { label: 'YouTube', lufs: -14.0, ceilingDb: -1.0, note: '与抖音接近' },
  wechat:    { label: '视频号',  lufs: -16.0, ceilingDb: -2.0, note: '更保守' },
  podcast:   { label: '播客',    lufs: -16.0, ceilingDb: -1.0, note: 'EBU R128 标准' },
};

/* ============================================================
   混音：多轨 → 单声道（渲染与导出共用）
   ============================================================ */
export function mixTracks(tracks, duration, opts = {}) {
  const sr = opts.sampleRate || 48000;
  const out = new Float32Array(Math.ceil(duration * sr));
  const ducking = opts.ducking !== false;
  const voiceEnergy = ducking ? buildVoiceEnergy(tracks, duration, sr) : null;

  for (const tr of tracks) {
    if (tr.muted || !tr.samples.length) continue;
    const offset = Math.floor((tr.start || 0) * sr);
    let env = 1;
    for (let i = 0; i < tr.samples.length; i++) {
      const idx = offset + i;
      if (idx < 0 || idx >= out.length) continue;
      let g = tr.gain;
      // 自动闪避：人声出现时把音乐压下去
      if (ducking && voiceEnergy && tr.kind === 'music') {
        const t = idx / sr;
        g *= 1 - tr.duckTo * voiceEnergy(t);
      }
      out[idx] += tr.samples[i] * g;
      env = g;
    }
  }
  // 软限幅，避免相加后削波
  const ceiling = Math.pow(10, (opts.ceilingDb == null ? -1 : opts.ceilingDb) / 20);
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    if (Math.abs(v) > ceiling) out[i] = Math.sign(v) * ceiling;
  }
  return out;
}

/* 人声能量包络（用于闪避判断），50Hz 采样足够 */
function buildVoiceEnergy(tracks, duration, sr) {
  const step = Math.max(1, Math.floor(sr / 100));   // 10ms
  const bins = Math.ceil(duration * 100);
  const env = new Float32Array(bins);
  for (const tr of tracks) {
    if (tr.kind !== 'voice' || tr.muted || !tr.samples.length) continue;
    const off = Math.floor((tr.start || 0) * sr);
    for (let b = 0; b < bins; b++) {
      const s = off + b * step;
      let sum = 0, cnt = 0;
      for (let i = s; i < Math.min(off + tr.samples.length, s + step); i++) {
        sum += tr.samples[i] * tr.samples[i]; cnt++;
      }
      if (!cnt) continue;
      const rms = Math.sqrt(sum / cnt);
      env[b] += Math.min(1, rms * 4);
    }
  }
  smooth(env, 5);
  return (t) => {
    const i = Math.floor(t * 100);
    return i >= 0 && i < env.length ? Math.min(1, env[i]) : 0;
  };
}

/* 取某时刻的混音音量（用于实时电平表） */
export function sampleAt(tracks, t, opts = {}) {
  const sr = opts.sampleRate || 48000;
  const idx = Math.floor(t * sr);
  let v = 0, peak = 0;
  for (const tr of tracks) {
    if (tr.muted || !tr.samples.length) continue;
    const off = Math.floor((tr.start || 0) * sr);
    const i = idx - off;
    if (i < 0 || i >= tr.samples.length) continue;
    const s = tr.samples[i] * tr.gain;
    v += s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  return { value: Math.max(-1, Math.min(1, v)), peak };
}

/* ---------- FFT（原地，基 2） ---------- */
export function fft(re, im) {
  const n = re.length;
  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  return w;
}

export function smooth(arr, radius = 1) {
  if (radius <= 0 || arr.length < 3) return arr;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0, cnt = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(arr.length - 1, i + radius); k++) { sum += arr[k]; cnt++; }
    out[i] = sum / cnt;
  }
  arr.set(out);
  return arr;
}