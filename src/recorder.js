/* ============================================================
   recorder.js · 录音 / 波形编辑 / 一键去静默（P0-A/B/C）
   ------------------------------------------------------------
   录音链路：getUserMedia → MediaRecorder（落盘）→ AudioWorklet/Analyser
   做实时电平与削波告警 → 解码成 AudioTrack。

   「一键去静默」是短视频配音提效最明显的一键功能（规划 D2），
   这里实现为可撤销的**非破坏性编辑操作列表**：
   原始样本永不被修改，编辑记录在 clips 上，随时可重算 / 还原。
   ============================================================ */

import { AudioTrack, decodeWav, resample, detectSilence, analyzeTrack, normalizeLoudness } from './audio-core.js';

/* ============================================================
   录音器
   ============================================================ */
export class Recorder {
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate || 48000;
    this.maxSeconds = opts.maxSeconds || 600;
    this.state = 'idle';           // idle | recording | paused | stopped
    this.level = 0;                // 归一化电平 0..1
    this.peak = 0;
    this.clipping = false;         // 爆音告警
    this.countdown = 0;            // 倒计时预备
    this.onLevel = opts.onLevel || (() => {});
    this.onClip = opts.onClip || (() => {});
    this.onState = opts.onState || (() => {});
    this._ctx = null;
    this._stream = null;
    this._rec = null;
    this._chunks = [];
    this._analyser = null;
    this._raf = 0;
    this._clipGuardUntil = 0;
    this._duckOthers = opts.duckOthers || (() => {});
  }

  _setState(s) {
    this.state = s;
    this.onState(s);
  }

  /** 请求麦克风；source: 'mic' | 'system' | 'camera' */
  async prepare(source = 'mic', deviceId) {
    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,       // 降噪交给后期预设，避免双重处理
        autoGainControl: false,
        channelCount: 1,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      video: source === 'camera' ? { width: 640, height: 360 } : false,
    };
    this._stream = await navigator.mediaDevices.getUserMedia(constraints);
    return this._stream;
  }

  /** 可选：降噪开关（真正处理在 AudioWorklet，这里只切换约束） */
  async setNoiseSuppression(on) {
    if (!this._stream) return;
    const tracks = this._stream.getAudioTracks();
    if (!tracks.length) return;
    this._stopStream();
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: !!on,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
    return this._stream;
  }

  async start(opts = {}) {
    if (!this._stream) await this.prepare(opts.source || 'mic', opts.deviceId);
    this._duckOthers(true);

    this._ctx = this._ctx || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.sampleRate });
    if (this._ctx.state === 'suspended') await this._ctx.resume();

    const src = this._ctx.createMediaStreamSource(this._stream);
    this._analyser = this._ctx.createAnalyser();
    this._analyser.fftSize = 2048;
    this._analyser.smoothingTimeConstant = 0.2;
    src.connect(this._analyser);

    // 爆音告警：超过削波阈值持续 2 帧即触发
    this._clipGuardUntil = Date.now() + 1500;

    const mime = pickMime();
    this._rec = new MediaRecorder(this._stream, mime ? { mimeType: mime } : undefined);
    this._chunks = [];
    this._rec.ondataavailable = (e) => { if (e.data && e.data.size) this._chunks.push(e.data); };
    this._rec.start(200);
    this._t0 = performance.now();
    this._setState('recording');
    this._monitor();
    return this;
  }

  pause() {
    if (this.state !== 'recording') return;
    this._rec && this._rec.pause();
    this._setState('paused');
  }
  resume() {
    if (this.state !== 'paused') return;
    this._rec && this._rec.resume();
    this._setState('recording');
  }

  async stop() {
    if (this.state === 'idle') return null;
    const rec = this._rec;
    const blob = await new Promise((resolve) => {
      if (!rec || rec.state === 'inactive') return resolve(null);
      rec.onstop = () => resolve(new Blob(this._chunks, { type: rec.mimeType || 'audio/webm' }));
      rec.stop();
    });
    cancelAnimationFrame(this._raf);
    this._setState('stopped');
    this._duckOthers(false);
    if (this._analyser) { this._analyser.disconnect(); this._analyser = null; }
    return blob;
  }

  _stopStream() {
    if (this._stream) { this._stream.getTracks().forEach(t => t.stop()); this._stream = null; }
  }
  dispose() {
    cancelAnimationFrame(this._raf);
    this._stopStream();
    if (this._ctx) { this._ctx.close(); this._ctx = null; }
    this._setState('idle');
  }

  /** 监听回放：把录音送回耳机（需要用户手势） */
  async monitorPlayback(track, from = 0, to = null) {
    const ctx = this._ctx || new (window.AudioContext || window.webkitAudioContext)();
    const len = to ? Math.floor((to - from) * this.sampleRate) : track.samples.length;
    const buf = ctx.createBuffer(1, len, this.sampleRate);
    buf.copyToChannel(track.samples.subarray(Math.floor(from * this.sampleRate), Math.floor(from * this.sampleRate) + len), 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    return { stop: () => src.stop() };
  }

  _monitor() {
    const buf = new Float32Array(this._analyser.fftSize);
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      if (!this._analyser) return;
      this._analyser.getFloatTimeDomainData(buf);
      let peak = 0, sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (a > peak) peak = a;
        sum += buf[i] * buf[i];
      }
      const rms = Math.sqrt(sum / buf.length);
      this.peak = peak;
      this.level = Math.min(1, rms * 3.2);
      const now = Date.now();
      if (peak > 0.985 && now > this._clipGuardUntil) {
        if (!this.clipping) { this.clipping = true; this.onClip(true); }
      } else if (this.clipping && peak < 0.9) {
        this.clipping = false; this.onClip(false);
      }
      const elapsed = (performance.now() - this._t0) / 1000;
      this.onLevel(this.level, this.peak, this.clipping, elapsed);
      if (elapsed > this.maxSeconds) this.stop();
    };
    tick();
  }
}

function pickMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const m of cands) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

/** 录音 blob → AudioTrack（做重采样 + 峰值分析） */
export async function blobToTrack(blob, opts = {}) {
  const targetRate = opts.sampleRate || 48000;
  const buf = await blob.arrayBuffer();
  let samples, rate;
  try {
    // WAV 走自研解码（精确、可离线）
    const w = decodeWav(buf);
    samples = w.samples; rate = w.sampleRate;
  } catch {
    // WebM/Opus 交给浏览器解码
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    try {
      const audio = await ctx.decodeAudioData(buf);
      samples = audio.getChannelData(0).slice();
      rate = audio.sampleRate;
    } finally {
      // 解码失败时也必须关闭，否则 AudioContext 泄漏，
      // 系统里的音频/麦克风占用一直不释放（指示灯常亮）。
      ctx.close();
    }
  }
  if (rate !== targetRate) samples = resample(samples, rate, targetRate);
  const t = new AudioTrack({ name: opts.name || '录音', kind: opts.kind || 'voice', sampleRate: targetRate, samples });
  t.ensureAnalysis();
  return t;
}

/* 导入任意音频文件 */
export async function fileToTrack(file, opts = {}) {
  return blobToTrack(file, { ...opts, name: opts.name || file.name });
}

/** 把索引夹到 [0, len] */
function clampIdx(i, len) {
  return i < 0 ? 0 : i > len ? len : i;
}

/* ============================================================
   波形编辑：非破坏性操作列表
   ============================================================ */
export class WaveEditor {
  constructor(track) {
    this.track = track;
    this.original = track.samples.slice();   // 原始样本，永不修改
    this.ops = [];                          // 操作栈
    this.markStart = 0;
    this.markEnd = track.duration;
  }

  reset() {
    this.track.setSamples(this.original.slice(), this.track.sampleRate);
    this.ops = [];
    this.markStart = 0;
    this.markEnd = this.track.duration;
    return this;
  }

  _push(op) { this.ops.push(op); return op; }

  /** 切割：在 t 处切开 */
  splitAt(t) {
    if (t <= this.markStart || t >= this.markEnd) return null;
    const i = Math.floor(t * this.track.sampleRate);
    const a = this.track.samples.slice(0, i);
    const b = this.track.samples.slice(i);
    const startShift = b.length / this.track.sampleRate;
    this.track.setSamples(a, this.track.sampleRate);
    this.markEnd -= startShift;
    return this._push({ type: 'split', t, startShift });
  }

  /** 删除 [t0,t1) */
  delete(t0, t1) {
    const a = Math.max(0, Math.floor(t0 * this.track.sampleRate));
    const b = Math.min(this.track.samples.length, Math.ceil(t1 * this.track.sampleRate));
    if (b <= a) return null;
    const out = new Float32Array(this.track.samples.length - (b - a));
    out.set(this.track.samples.subarray(0, a), 0);
    out.set(this.track.samples.subarray(b), a);
    this.track.setSamples(out, this.track.sampleRate);
    const d = (b - a) / this.track.sampleRate;
    this.markEnd = Math.max(this.markStart, this.markEnd - d);
    return this._push({ type: 'delete', t0, t1, dur: d });
  }

  /** 静音 [t0,t1)（保留长度，振幅置零） */
  silence(t0, t1) {
    const a = Math.max(0, Math.floor(t0 * this.track.sampleRate));
    const b = Math.min(this.track.samples.length, Math.ceil(t1 * this.track.sampleRate));
    if (b <= a) return null;
    const s = this.track.samples;
    const backup = s.slice(a, b);
    s.fill(0, a, b);
    this.track.analysis = null;
    return this._push({ type: 'silence', t0, t1, backup, offset: a });
  }

  /** 拼接另一段（剪贴板） */
  paste(clip, at) {
    const i = Math.max(0, Math.floor(at * this.track.sampleRate));
    const out = new Float32Array(this.track.samples.length + clip.length);
    out.set(this.track.samples.subarray(0, i), 0);
    out.set(clip, i);
    out.set(this.track.samples.subarray(i), i + clip.length);
    this.track.setSamples(out, this.track.sampleRate);
    this.markEnd += clip.length / this.track.sampleRate;
    // 必须把真正贴进去的样本存进操作栈。原来只存了长度 len，撤销时
    // _restoreFromOps 用 _clipByLen(len) 造一段全零数组贴回去 ——
    // 撤销一次粘贴，贴入的内容变成等长静音，原音频永久丢失。
    // consume=0：整段插入，没有消耗原有样本。
    return this._push({ type: 'paste', at, len: clip.length / this.track.sampleRate, consume: 0, block: clip.slice() });
  }

  /** 交叉淡化：与 clip 拼接，重叠 crossfade 秒 */
  pasteWithFade(clip, at, crossfade = 0.08) {
    const sr = this.track.sampleRate;
    const f = Math.min(Math.floor(crossfade * sr), clip.length, this.track.samples.length - Math.floor(at * sr));
    const out = new Float32Array(this.track.samples.length + clip.length - f);
    const base = Math.floor(at * sr);
    out.set(this.track.samples.subarray(0, base + f), 0);
    // 淡出原片段尾部
    for (let i = 0; i < f; i++) out[base + i] *= 1 - i / f;
    // 淡入 clip 头部
    for (let i = 0; i < clip.length; i++) {
      const g = i < f ? i / f : 1;
      out[base + i] += clip[i] * g;
    }
    out.set(clip.subarray(f), base + f);
    this.track.setSamples(out, sr);
    // 同 paste：必须存真正贴进去的样本，否则撤销会把这段换成等长静音。
    // 存的是淡化前的原始 clip，重放时用同样的 fade 重算一遍，结果一致。
    return this._push({ type: 'paste', at, len: (clip.length - f) / sr, fade: crossfade, consume: f, block: clip.slice() });
  }

  copyRange() {
    return this.track.slice(this.markStart, this.markEnd);
  }

  gain(t0, t1, factor) {
    const a = Math.max(0, Math.floor(t0 * this.track.sampleRate));
    const b = Math.min(this.track.samples.length, Math.ceil(t1 * this.track.sampleRate));
    const backup = this.track.samples.slice(a, b);
    for (let i = a; i < b; i++) this.track.samples[i] *= factor;
    this.track.analysis = null;
    return this._push({ type: 'gain', t0, t1, factor, backup, offset: a });
  }

  fadeEdges(t0, t1, seconds = 0.05) {
    const sr = this.track.sampleRate;
    const a = Math.floor(t0 * sr), b = Math.floor(t1 * sr);
    const f = Math.min(Math.floor(seconds * sr), Math.floor((b - a) / 2));
    const backup = this.track.samples.slice(a, b);
    for (let i = 0; i < f; i++) {
      this.track.samples[a + i] *= i / f;
      this.track.samples[b - 1 - i] *= i / f;
    }
    this.track.analysis = null;
    return this._push({ type: 'fade', t0, t1, seconds, backup, offset: a });
  }

  /** 只保留 [t0,t1)（裁剪） */
  trimTo(t0, t1) {
    const sr = this.track.sampleRate;
    const a = Math.max(0, Math.floor(t0 * sr));
    const b = Math.min(this.track.samples.length, Math.ceil(t1 * sr));
    if (b <= a) return null;
    const backup = this.track.samples.slice();
    this.track.setSamples(backup.slice(a, b), sr);
    this.markStart = 0;
    this.markEnd = this.track.duration;
    // 裁剪必须记成自己的操作类型并带上裁剪区间。
    // 原来借用 delete（{type:'delete', t0:0, t1:duration+1}）记账，而 undo 里
    // delete 走 _restoreFromOps 重放：重放这条伪 delete 会把整轨清空 ——
    // 裁剪后一按撤销，音频全没了。_restoreFromOps 也无法从伪 delete 反推
    // 原本裁掉了哪一段（它只存了「删到哪」，没存「留哪儿」）。
    return this._push({ type: 'trim', t0, t1 });
  }

  /** 归一化到目标峰值（dBFS） */
  normalizeTo(targetDb = -1) {
    const a = this.track.ensureAnalysis();
    let peak = 0;
    const p = a.peaks;
    if (p) {
      for (let i = 0; i < p.max.length; i++) if (p.max[i] > peak) peak = p.max[i];
      for (let i = 0; i < p.min.length; i++) if (-p.min[i] > peak) peak = -p.min[i];
    }
    if (peak <= 1e-6) return null;
    const target = Math.pow(10, targetDb / 20);
    return this.gain(0, this.track.duration, target / peak);
  }

  /** 变速不变调：重采样 + 时间拉伸（WSOLA 简化版） */
  stretchRange(t0, t1, ratio) {
    const sr = this.track.sampleRate;
    const a = Math.floor(t0 * sr), b = Math.floor(t1 * sr);
    const seg = this.track.samples.slice(a, b);
    const stretched = timeStretch(seg, ratio);
    const out = new Float32Array(this.track.samples.length - (b - a) + stretched.length);
    out.set(this.track.samples.subarray(0, a), 0);
    out.set(stretched, a);
    out.set(this.track.samples.subarray(b), a + stretched.length);
    this.track.setSamples(out, sr);
    const d = (stretched.length - (b - a)) / sr;
    this.markEnd += d;
    return this._push({ type: 'stretch', t0, t1, ratio, dur: d });
  }

  /** 一键去静默：剔除静音段，并把整轨压缩拼接 */
  removeSilence(opts = {}) {
    const sr = this.track.sampleRate;
    const len = this.track.samples.length;
    const regions = detectSilence(this.track.samples, sr, opts);
    if (!regions.length) return { regions: [], removed: 0, saved: 0 };

    const pad = Math.max(0, Math.floor((opts.keepPad == null ? 0.06 : opts.keepPad) * sr));

    // 标记要剔除的区间（采样索引），并保证互不重叠、单调递增
    const cuts = [];
    for (const r of regions) {
      const s = clampIdx(Math.round(r.start * sr - pad), len);
      const e = clampIdx(Math.round(r.end * sr + pad), len);
      if (e <= s) continue;
      if (cuts.length && s <= cuts[cuts.length - 1][1]) {
        cuts[cuts.length - 1][1] = Math.max(cuts[cuts.length - 1][1], e);
      } else {
        cuts.push([s, e]);
      }
    }
    if (!cuts.length) return { regions, removed: 0, saved: 0 };

    // 由剔除区间反推保留区间
    const keep = [];
    let cursor = 0;
    for (const [s, e] of cuts) {
      if (s > cursor) keep.push([cursor, s]);
      cursor = e;
    }
    if (cursor < len) keep.push([cursor, len]);

    let total = 0;
    for (const [s, e] of keep) total += (e - s);

    const out = new Float32Array(total);
    let o = 0;
    for (const [s, e] of keep) {
      const n = e - s;
      if (n > 0) { out.set(this.track.samples.subarray(s, e), o); o += n; }
    }

    const backup = this.track.samples.slice();
    this.track.setSamples(out, sr);
    this.markStart = 0;
    this.markEnd = total / sr;
    const saved = (backup.length - total) / sr;
    this._push({ type: 'removeSilence', removed: cuts.length, saved, backup });
    return { regions, removed: cuts.length, saved };
  }

  /** 撤销最后一个操作（基于备份还原） */
  undo() {
    const op = this.ops.pop();
    if (!op) return null;
    switch (op.type) {
      case 'silence': case 'gain': case 'fade':
        this.track.samples.set(op.backup, op.offset);
        this.track.analysis = null;
        break;
      case 'removeSilence':
        this.track.setSamples(op.backup, this.track.sampleRate);
        break;
      case 'preset':
        // 预设是原地改样本 → 直接整段还原
        this.track.setSamples(op.backup, this.track.sampleRate);
        break;
      case 'delete': case 'paste': case 'split': case 'stretch': case 'trim':
        // 这几类是结构性变更，直接整体还原到操作前更稳妥
        this._restoreFromOps();
        break;
    }
    return op;
  }

  _restoreFromOps() {
    // 结构性操作：用原始样本 + 重放剩余操作重建
    const remaining = this.ops.slice();
    this.track.setSamples(this.original.slice(), this.track.sampleRate);
    this.ops = [];
    for (const op of remaining) {
      switch (op.type) {
        case 'split': {
          const i = Math.floor(op.t * this.track.sampleRate);
          if (i > 0 && i < this.track.samples.length) {
            const head = this.track.samples.slice(0, i);
            this.track.setSamples(head, this.track.sampleRate);
            this.ops.push(op);
          }
          break;
        }
        case 'delete': this.delete(op.t0, op.t1); break;
        case 'trim': this.trimTo(op.t0, op.t1); break;
        case 'paste':
          // 用操作里存的真实样本重放。旧代码走 _clipByLen(len) 造全零数组，
          // 重放出来的是一段静音 —— 这是「撤销粘贴后原音频变静音」的根因。
          // 老版操作记录没有 block 字段（内存里没有历史数据，无需兼容），
          // 万一遇到就跳过，不静默贴一段零。
          if (!op.block) break;
          if (op.fade) this.pasteWithFade(op.block, op.at, op.fade);
          else this.paste(op.block, op.at);
          break;
        case 'stretch': this.stretchRange(op.t0, op.t1, op.ratio); break;
      }
    }
  }

  /** 重算分析（编辑后调用） */
  reanalyze() {
    this.track.analysis = null;
    return this.track.ensureAnalysis();
  }
}

/** 时间拉伸（WSOLA）。ratio = 输出长度 / 输入长度：
 *  ratio > 1 → 变慢变长；ratio < 1 → 变快变短。音高基本不变。 */
export function timeStretch(input, ratio) {
  if (Math.abs(ratio - 1) < 1e-3 || input.length < 128) return input;
  const frame = 1024;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const hopOut = Math.max(1, Math.floor(frame / 2));
  // 输入推进量 = hopOut * ratio（输出变长 ⇒ 输入读得更慢）
  const hopIn = Math.max(1, Math.round(hopOut * ratio));
  const out = new Float32Array(outLen);
  const searchRadius = 192;

  let inPos = 0, outPos = 0;
  let prevTail = new Float32Array(frame);   // 上一帧输出，用来找最相似的续接点

  while (inPos + frame < input.length && outPos + frame < outLen) {
    // 在候选位置里找与 prevTail 最匹配的一帧（重叠相加平滑）
    let best = inPos, bestScore = -Infinity;
    const lo = Math.max(0, inPos - searchRadius);
    const hi = Math.min(input.length - frame, inPos + searchRadius);
    for (let c = lo; c <= hi; c += 8) {
      let score = 0;
      for (let i = 0; i < frame; i += 8) score += input[c + i] * prevTail[i];
      if (score > bestScore) { bestScore = score; best = c; }
    }
    // 线性交叉淡化写入
    const fade = Math.min(hopOut, frame, outLen - outPos);
    for (let i = 0; i < fade; i++) {
      const w = i / fade;
      out[outPos + i] = out[outPos + i] * (1 - w) + input[best + i] * w;
    }
    for (let i = fade; i < frame && outPos + i < outLen; i++) {
      out[outPos + i] = input[best + i];
    }
    // 记录新的尾部供下帧匹配
    const tail = new Float32Array(frame);
    for (let i = 0; i < frame; i++) {
      const idx = outPos + i - hopOut;
      tail[i] = idx >= 0 && idx < outLen ? out[idx] : 0;
    }
    prevTail = tail;
    inPos = best + hopIn;
    outPos += hopOut;
  }
  return out;
}

/* ============================================================
   预设化音频处理（规划 D2：不暴露参数面板）
   ============================================================ */
export const AUDIO_PRESETS = {
  denoise:      { label: '降噪', desc: '频谱门限，去掉环境底噪', fn: (t) => spectralGate(t, 0.012) },
  deEss:        { label: '去齿音', desc: '压 6~9kHz 的刺耳齿音', fn: (t) => deEss(t) },
  dePop:        { label: '去口水音/爆音', desc: '削掉瞬态尖峰', fn: (t) => deClick(t) },
  normalize:    { label: '响度标准化', desc: '对齐到平台目标 LUFS', fn: (t, o) => normalizeLoudness(t, (o && o.lufs) || -14) },
  compress:     { label: '轻压缩', desc: '压动态，口播更贴耳', fn: (t) => compress(t, 3, 0.25) },
};

function spectralGate(track, thresh) {
  const a = track.ensureAnalysis();
  // 简易实现：用噪声门限做时间域衰减（真正频谱门限需 FFT 重合成，这里走等效近似）
  const floorEst = estimateNoiseFloor(track.samples);
  const lin = floorEst * (1 + thresh * 40);
  for (let i = 0; i < track.samples.length; i++) {
    const v = track.samples[i];
    const m = Math.abs(v);
    if (m < lin) track.samples[i] *= 0.35;
  }
  track.analysis = null;
  return a;
}

function estimateNoiseFloor(samples) {
  // 取最安静的 10% 窗口的平均幅度作为底噪
  const win = 1024;
  const n = Math.floor(samples.length / win);
  if (n < 4) return 0.001;
  const mags = new Float32Array(n);
  for (let w = 0; w < n; w++) {
    let sum = 0;
    for (let i = w * win; i < (w + 1) * win; i++) sum += samples[i] * samples[i];
    mags[w] = Math.sqrt(sum / win);
  }
  const sorted = Array.from(mags).sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(n * 0.1));
  let s = 0;
  for (let i = 0; i < k; i++) s += sorted[i];
  return s / k;
}

/** 去齿音：压 6~9kHz 的刺耳齿音 */
function deEss(track) {
  const sr = track.sampleRate;
  const cut = 6000;
  const rc = 1 / (2 * Math.PI * cut);
  const dt = 1 / sr;
  const alpha = rc / (rc + dt);
  let lp = 0;
  for (let i = 0; i < track.samples.length; i++) {
    const x = track.samples[i];
    lp = alpha * lp + (1 - alpha) * x;   // 低通部分
    const hp = x - lp;                     // > cut 的部分
    // 只在超过阈值时做软压缩，避免整体变闷
    const m = Math.abs(hp);
    const g = m > 0.12 ? 1 - 0.55 * ((m - 0.12) / 0.88) : 1;
    track.samples[i] = lp + hp * Math.max(0, g);
  }
  track.analysis = null;
  return track;
}

/** 去爆音/口水音：削掉瞬态尖峰 + 去直流 */
function deClick(track) {
  const s = track.samples;
  // 1) 瞬态检测：一阶差分超过阈值就判定为咔哒声，向邻域平滑
  for (let i = 2; i < s.length - 2; i++) {
    const d = s[i] - s[i - 1];
    if (d > 0.35 || d < -0.35) {
      s[i] = (s[i - 1] + s[i + 1]) * 0.5;
    }
  }
  // 2) 去直流偏置（整体均值）
  let mean = 0;
  for (let i = 0; i < s.length; i++) mean += s[i];
  mean /= Math.max(1, s.length);
  for (let i = 0; i < s.length; i++) s[i] -= mean;
  track.analysis = null;
  return track;
}

function compress(track, thresholdDb = 3, ratio = 0.25) {
  const lin = Math.pow(10, -thresholdDb / 20);
  const atk = 0.01, rel = 0.12;
  let env = 0;
  for (let i = 0; i < track.samples.length; i++) {
    const a = Math.abs(track.samples[i]);
    env = a > env ? env + (a - env) * atk : env + (a - env) * rel;
    if (env > lin) {
      const over = env / lin;
      const g = Math.pow(over, ratio - 1);
      track.samples[i] *= g;
      env *= g;
    }
  }
  track.analysis = null;
  return track;
}

/** 应用一个预设（串行，返回被应用的名称） */
export function applyPreset(track, name, opts = {}) {
  const p = AUDIO_PRESETS[name];
  if (!p) throw new Error('未知音频预设：' + name);
  p.fn(track, opts);
  track.analysis = null;
  track.ensureAnalysis();
  return p.label;
}