/* ============================================================
   audiosource.js · 统一音频源（P0-E / P1-D）
   ------------------------------------------------------------
   规划风险里写得很清楚：音频分析必须按采样帧对齐，
   预览与导出才可能一致。

   这个类把两条路径收敛成同一个接口：
     · 合成（V0）：程序化曲线，无需文件，天然确定
     · 真实录音（V1）：AudioTrack 的离线分析结果（峰值/频段/节拍）
   上层积木（amp / bass / beat …）只认这个接口。

   关键：所有取值都是 **纯函数 sample(t)**，
   不读 AudioContext 的实时播放位置，所以拖时间轴能立刻正确。
   ============================================================ */

import { AudioTrack, computeBandEnergies, computePeaks, detectBeats, measureLoudness } from './audio-core.js';

export class AudioSource {
  /**
   * @param {object} opts
   *   kind: 'synth' | 'track'
   *   bpm, seed, intensity, beatEnv  —— 合成模式
   *   tracks: AudioTrack[]           —— 真实模式
   */
  constructor(opts = {}) {
    this.kind = opts.kind || 'synth';
    this.bpm = opts.bpm || 120;
    this.seed = opts.seed == null ? 7 : opts.seed;
    this.intensity = opts.intensity == null ? 1 : opts.intensity;
    this.beatEnv = opts.beatEnv || 'pulse';
    this.duration = opts.duration || 0;

    this.tracks = opts.tracks || [];
    this.fps = opts.fps || 60;
    this._bpmDetected = null;

    // 真实模式的合并分析结果（惰性构建）
    this._mix = null;
  }

  setDuration(d) { this.duration = d; }

  /* ---------- 模式切换 ---------- */
  static synth(opts = {}) { return new AudioSource(Object.assign({ kind: 'synth' }, opts)); }

  static fromTracks(tracks, opts = {}) {
    const s = new AudioSource(Object.assign({ kind: 'track', tracks }, opts));
    let dur = 0;
    for (const t of tracks) dur = Math.max(dur, (t.start || 0) + t.duration);
    s.duration = dur;
    // 没有真实音频时，用工程时长兜底，节拍点才有东西可铺
    if (dur <= 0) s.setNominalDuration(opts.nominalDuration || 0);
    return s;
  }

  /** 是否有可用的真实音频
   · 空轨道列表 ⇒ 合成
   · 全部静音（峰值≈0）⇒ 合成（否则画面会「死」掉，没东西驱动）
   · 有真实信号 ⇒ 真实
   注意：这里只做轻量抽样判断，避免为探测付出全量分析代价。 */
  isReal() {
    if (this.kind !== 'track' || !this.tracks.length) return false;
    for (const t of this.tracks) {
      if (t.muted || !t.samples || !t.samples.length) continue;
      // 抽样 64 个点判断是否有信号
      const n = t.samples.length;
      const step = Math.max(1, Math.floor(n / 64));
      for (let i = 0; i < n; i += step) {
        if (Math.abs(t.samples[i]) > 1e-4) return true;
      }
    }
    return false;
  }

  /* ============================================================
     合成模式（V0）：程序化包络
     ============================================================ */
  _synth(kind, t) {
    if (t < 0) return 0;
    const spb = 60 / this.bpm;
    const phase = (t / spb) % 1;
    const kick = this.beatEnv === 'kick' ? Math.pow(1 - phase, 3.2) : Math.pow(1 - phase, 1.6);
    const breath = 0.55 + 0.45 * noise1(this.seed, 1.7);
    const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
    switch (kind) {
      case 'amp': return clamp01((kick * 0.75 + breath * 0.45) * this.intensity);
      case 'bass': return clamp01(Math.pow(1 - phase, 2.5) * this.intensity);
      case 'mid': return clamp01(this._synth('amp', t) * 0.7 + noise1(this.seed + 3, 5.1) * 0.3);
      case 'treble': return clamp01(noise1(this.seed + 9, 11.3) * 0.6 + this._synth('bass', t) * 0.25);
      case 'beat': return Math.pow(1 - phase, 8);
      default: return 0;
    }
  }

  /* ============================================================
     真实模式：多轨混合后的分析
     ============================================================ */
  _ensureMix() {
    if (this._mix) return this._mix;
    const duration = Math.max(this.duration, 0.1);
    const total = Math.max(1, Math.round(duration * this.fps));

    const amp = new Float32Array(total);
    const bass = new Float32Array(total);
    const mid = new Float32Array(total);
    const treble = new Float32Array(total);
    const beatMask = new Uint8Array(total);

    for (const tr of this.tracks) {
      if (tr.muted || !tr.samples.length) continue;
      const a = tr.ensureAnalysis();
      const bands = a.bands;
      // 分析结果固定按 60fps 生成（analyzeTrack 的默认值），
      // 而这里的输出数组按项目 fps 索引 —— 直接拿 i 取 bands[i]
      // 在非 60fps 工程里会把时间轴整体压缩/拉伸。
      const bandFps = bands.fps || 60;
      const offset = tr.start || 0;
      const gain = tr.gain == null ? 1 : tr.gain;

      for (let i = 0; i < total; i++) {
        const j = Math.round((i / this.fps - offset) * bandFps);
        if (j < 0 || j >= bands.amp.length) continue;
        amp[i] = Math.max(amp[i], bands.amp[j] * gain);
        bass[i] = Math.max(bass[i], bands.bass[j] * gain);
        mid[i] = Math.max(mid[i], bands.mid[j] * gain);
        treble[i] = Math.max(treble[i], bands.treble[j] * gain);
      }
      // 节拍打点
      for (const b of (a.beats || [])) {
        const idx = Math.round((b.time + (tr.start || 0)) * this.fps);
        for (let k = 0; k < 6 && idx + k < total; k++) {
          beatMask[idx + k] = Math.max(beatMask[idx + k], Math.round(255 * Math.pow(1 - k / 6, 2)));
        }
      }
    }

    // 无声轨也要有合法数组，避免上层除零
    this._mix = { amp, bass, mid, treble, beatMask, total, fps: this.fps };
    return this._mix;
  }

  /** 采样一段（线性插值） */
  _at(arr, t, fps) {
    const x = t * fps;
    const i = Math.floor(x);
    if (i < 0) return 0;
    if (i >= arr.length - 1) return arr[arr.length - 1] || 0;
    const f = x - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  }

  /* ============================================================
     统一取值接口
     ============================================================ */
  /** @returns {number} 0..1 */
  value(kind, time) {
    if (!this.isReal()) return this._synth(kind, time);
    const m = this._ensureMix();
    switch (kind) {
      case 'amp': return this._at(m.amp, time, this.fps);
      case 'bass': return this._at(m.bass, time, this.fps);
      case 'mid': return this._at(m.mid, time, this.fps);
      case 'treble': return this._at(m.treble, time, this.fps);
      case 'beat': return this._at(m.beatMask, time, this.fps) / 255;
      default: return 0;
    }
  }

  amplitude(t) { return this.value('amp', t); }
  bassAt(t) { return this.value('bass', t); }
  midAt(t) { return this.value('mid', t); }
  trebleAt(t) { return this.value('treble', t); }
  beatPulse(t) { return this.value('beat', t); }

  /* ---------- BPM ---------- */
  /** 返回每分钟节拍数：真实模式优先用检测结果 */
  bpmValue() {
    if (this.isReal()) {
      if (this._bpmDetected == null) this._detectBpm();
      return this._bpmDetected || this.bpm;
    }
    return this.bpm;
  }

  _detectBpm() {
    const times = [];
    for (const tr of this.tracks) {
      if (tr.muted || !tr.samples.length) continue;
      const a = tr.ensureAnalysis();
      for (const b of (a.beats || [])) times.push(b.time + (tr.start || 0));
    }
    if (times.length < 4) { this._bpmDetected = 0; return 0; }
    times.sort((x, y) => x - y);
    const gaps = [];
    for (let i = 1; i < times.length; i++) {
      const g = times[i] - times[i - 1];
      if (g > 0.2 && g < 2) gaps.push(g);
    }
    if (!gaps.length) { this._bpmDetected = 0; return 0; }
    gaps.sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)];
    let bpm = 60 / med;
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    this._bpmDetected = Math.round(bpm);
    return this._bpmDetected;
  }

  /* ---------- 节拍点（踩点用） ---------- */
  beatTimes(durationOverride) {
    // 合成模式（或没有真实音频）下按 BPM 铺满整条时间轴
    const dur = durationOverride != null ? durationOverride
      : (this.duration > 0 ? this.duration : this._nominalDuration());
    if (!this.isReal()) {
      const out = [];
      const spb = 60 / this.bpm;
      if (!isFinite(dur) || dur <= 0) return out;
      for (let t = 0; t < dur; t += spb) out.push({ time: t, strength: 1 });
      return out;
    }
    const out = [];
    for (const tr of this.tracks) {
      if (tr.muted || !tr.samples.length) continue;
      const a = tr.ensureAnalysis();
      for (const b of (a.beats || [])) out.push({ time: b.time + (tr.start || 0), strength: b.strength });
    }
    out.sort((x, y) => x.time - y.time);
    return out;
  }

  /** 没有真实音频时的兜底时长（供节拍/踩点铺点用） */
  _nominalDuration() {
    if (this._nominal != null) return this._nominal;
    return this._nominal = 0;
  }

  /** 设置兜底时长（UI 里由工程时长注入） */
  setNominalDuration(d) {
    this._nominal = Math.max(0, Number(d) || 0);
    if (this.duration <= 0) this.duration = this._nominal;
    return this;
  }

  /** 把动画起点对齐到最近的节拍（音乐踩点） */
  snapToBeat(t, tolerance = 0.18) {
    const beats = this.beatTimes();
    let best = null, bd = tolerance;
    for (const b of beats) {
      const d = Math.abs(b.time - t);
      if (d <= bd) { bd = d; best = b.time; }
    }
    return best == null ? null : Math.round(best * 1000) / 1000;
  }

  /* ---------- 频谱（波形柱 / 环形频谱用） ---------- */
  /**
   * @param t 当前时间
   * @param bins 频段数
   * @returns {number[]} 0..1
   */
  spectrum(t, bins = 48) {
    if (!this.isReal()) {
      // 合成模式：把三段能量按对数频率铺开，形状稳定且跟拍
      const b = this.value('bass', t), m = this.value('mid', t), h = this.value('treble', t);
      const out = new Array(bins);
      for (let i = 0; i < bins; i++) {
        const f = i / bins;                       // 0 低 → 1 高
        const base = f < 0.2 ? b : f < 0.55 ? m : h;
        const wobble = 0.55 + 0.45 * noise1(i + this.seed, 4 + f * 8);
        out[i] = Math.min(1, base * wobble * 1.25);
      }
      return out;
    }

    const tr = this.tracks.find(x => !x.muted && x.samples.length && t >= (x.start || 0) && t < (x.start || 0) + x.duration);
    if (!tr) return new Array(bins).fill(0);
    // 频谱存在 track.spectrogram 上（由 prepareTrack 写入），不在 analysis 里 ——
    // 以前读 a.spectrogram 恒为 undefined，频谱就永远是平的。
    // 这里顺带补上「没预计算就现算一次」的兜底，缓存挂在轨道上，不会重复计算。
    const spec = ensureSpectrogram(tr);
    if (!spec) return new Array(bins).fill(0);

    const offset = tr.start || 0;
    const local = Math.max(0, t - offset);
    const frame = Math.min(spec.frames - 1, Math.floor(local * spec.framesPerSecond));

    // 把该帧的频谱重采样成 bins 段（对数刻度更符合听感）
    const out = new Array(bins);
    for (let i = 0; i < bins; i++) {
      const f0 = Math.pow(i / bins, 1.6);
      const f1 = Math.pow((i + 1) / bins, 1.6);
      let b0 = Math.floor(f0 * spec.bins), b1 = Math.max(b0 + 1, Math.ceil(f1 * spec.bins));
      b1 = Math.min(b1, spec.bins);
      let sum = 0;
      for (let b = b0; b < b1; b++) sum += spec.spec[frame * spec.bins + b];
      out[i] = Math.min(1, (sum / Math.max(1, b1 - b0)) * 6);
    }
    return out;
  }

  /* ---------- 响度（导出前校验） ---------- */
  loudness() {
    if (!this.isReal()) return { lufs: -70, lra: 0, peak: 0 };
    // 多轨时按能量最大的一条报告（简化）
    let best = { lufs: -70, lra: 0, peak: 0 };
    for (const tr of this.tracks) {
      if (tr.muted || !tr.samples.length) continue;
      const m = measureLoudness(tr.samples, tr.sampleRate);
      if (m.lufs > best.lufs) best = m;
    }
    return best;
  }

  /* ---------- 波形包络（波形编辑器用） ---------- */
  peaks(trackIndex = 0) {
    const tr = this.tracks[trackIndex];
    if (!tr) return null;
    return tr.ensureAnalysis().peaks;
  }

  /* ---------- 词级时间码（字幕 karaoke 用） ---------- */
  wordTimings() {
    const out = [];
    for (const tr of this.tracks) {
      if (tr.muted || !tr.wordTimings || !tr.wordTimings.length) continue;
      for (const w of tr.wordTimings) out.push({ ...w, t: w.time + (tr.start || 0) });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }
}

/* ---------- 局部工具 ---------- */
function hash2(x, y) {
  let n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}
function noise1(seed, scale) {
  const x = seed * scale;
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash2(i, seed), b = hash2(i + 1, seed);
  return a + (b - a) * u;
}

/* ============================================================
   把音频挂到 AudioTrack 上（词级时间码来自 ASR）
   ============================================================ */
export function attachWordTimings(track, words) {
  track.wordTimings = (words || []).map(w => ({
    word: w.word, time: w.start, end: w.end, confidence: w.confidence,
  }));
  return track;
}

/* 快速为一条音轨算好全部分析（导入后调用一次） */
export function prepareTrack(track, opts = {}) {
  track.ensureAnalysis();
  const a = track.analysis;
  track.spectrogram = computeSpectrogramCached(track, opts);
  track.detectedBpm = a.bpm;
  track.loudness = a.loudness;
  return a;
}

function computeSpectrogramCached(track, opts = {}) {
  const key = '__spectro' + (opts.fftSize || 1024);
  if (!track[key]) {
    const { computeSpectrogram } = computeSpectrogramRef;
    track[key] = computeSpectrogram(track.samples, track.sampleRate, {
      fftSize: opts.fftSize || 1024,
      hop: opts.hop || 512,
    });
  }
  return track[key];
}

/** 取轨道的频谱，没有就现算一次并缓存（频谱图开销大，只算一次） */
export function ensureSpectrogram(track) {
  if (!track) return null;
  if (track.spectrogram) return track.spectrogram;
  track.spectrogram = computeSpectrogramCached(track);
  return track.spectrogram;
}

/* 避免顶层循环依赖：延迟取用 */
import * as AC from './audio-core.js';
const computeSpectrogramRef = AC;