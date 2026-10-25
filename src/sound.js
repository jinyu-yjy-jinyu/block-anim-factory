/* ============================================================
   sound.js · 预览声音播放器
   ------------------------------------------------------------
   声音积木只是「在某一帧触发一个 cue」。求值层从不读实时播放状态，
   因此预览与导出仍然逐帧一致；这里只负责让预览真的出声。

   内置 beep/click/pop/whoosh 由 WebAudio 现场合成，不需要任何素材；
   自定义声音注册 URL（或音频数据）后缓存解码结果。
   Node / 无 AudioContext 的环境自动退化为无声 stub，测试可直接实例化。
   ============================================================ */

const BUILTIN = {
  beep:   { duration: 0.18, kind: 'tone',  type: 'sine',     freq: 880,  freqEnd: 880,  gain: 0.22 },
  click:  { duration: 0.06, kind: 'tone',  type: 'square',   freq: 1500, freqEnd: 1100, gain: 0.16 },
  pop:    { duration: 0.14, kind: 'tone',  type: 'sine',     freq: 640,  freqEnd: 180,  gain: 0.26 },
  whoosh: { duration: 0.45, kind: 'noise', filter: 'bandpass', freq: 320, freqEnd: 1600, q: 1.1, gain: 0.2 },
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function builtinSoundNames() {
  return Object.keys(BUILTIN);
}

export function soundDurationOf(name) {
  const b = BUILTIN[name];
  return b ? b.duration : 0;
}

export class SoundPlayer {
  constructor(opts = {}) {
    this.context = opts.context || null;
    this.master = null;
    this.volume = opts.volume == null ? 100 : clamp01(Number(opts.volume) / 100) * 100;
    this.enabled = opts.enabled !== false;
    this.active = new Set();
    this.registry = new Map();       // name -> { url, duration?, data? }
    this.buffers = new Map();        // name -> AudioBuffer
    this.loading = new Map();        // name -> Promise
    this._seed = 0x9e3779b9;
  }

  get ready() {
    return !!this.context;
  }

  _ensureContext() {
    if (this.context) return this.context;
    if (typeof AudioContext !== 'function' && typeof globalThis.webkitAudioContext !== 'function') return null;
    const Ctor = typeof AudioContext === 'function' ? AudioContext : globalThis.webkitAudioContext;
    try {
      this.context = new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = this.volume / 100;
      this.master.connect(this.context.destination);
    } catch {
      this.context = null;
      this.master = null;
    }
    return this.context;
  }

  /** 注册自定义声音；src 可以是 URL、Blob URL 或 ArrayBuffer。 */
  register(name, src, meta = {}) {
    if (!name) return this;
    this.registry.set(String(name), {
      url: typeof src === 'string' ? src : null,
      data: typeof src === 'string' ? null : src,
      duration: Number(meta.duration) || 0,
    });
    this.buffers.delete(String(name));
    this.loading.delete(String(name));
    return this;
  }

  unregister(name) {
    this.registry.delete(String(name));
    this.buffers.delete(String(name));
    this.loading.delete(String(name));
    return this;
  }

  duration(name) {
    const key = String(name ?? '');
    const buf = this.buffers.get(key);
    if (buf) return buf.duration;
    const b = BUILTIN[key];
    if (b) return b.duration;
    const reg = this.registry.get(key);
    return reg && reg.duration ? reg.duration : 0;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(100, Number(v) || 0));
    if (this.master) this.master.gain.value = this.volume / 100;
    return this;
  }

  play(name, volume = 1) {
    if (!this.enabled || this.volume <= 0) return null;
    const key = String(name ?? 'beep');
    const ctx = this._ensureContext();
    if (!ctx) return null;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch { /* 用户尚未交互时无法恢复 */ } }

    const gain = clamp01(Number(volume)) * (this.volume / 100);
    if (gain <= 0) return null;

    const reg = this.registry.get(key);
    if (reg) return this._playRegistered(key, reg, gain);

    const spec = BUILTIN[key] || BUILTIN.beep;
    return this._synth(spec, gain);
  }

  stopAll() {
    for (const src of this.active) {
      try { src.stop(); } catch { /* 已停止 */ }
    }
    this.active.clear();
    return this;
  }

  dispose() {
    this.stopAll();
    this.registry.clear();
    this.buffers.clear();
    this.loading.clear();
    if (this.context && typeof this.context.close === 'function') {
      try { this.context.close(); } catch { /* 已关闭 */ }
    }
    this.context = null;
    this.master = null;
  }

  /* ---------- 内部：合成 ---------- */

  _track(src, nodes = []) {
    const entry = { src, stop: () => { try { src.stop(); } catch { /* 已停止 */ } } };
    this.active.add(entry);
    src.onended = () => {
      this.active.delete(entry);
      for (const n of nodes) { try { n.disconnect(); } catch { /* 已断开 */ } }
    };
    return entry;
  }

  _synth(spec, gain) {
    const ctx = this.context;
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);

    if (spec.kind === 'noise') {
      const len = Math.max(1, Math.floor(ctx.sampleRate * spec.duration));
      const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = this._noise() * 0.8;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = spec.filter || 'bandpass';
      filter.Q.value = spec.q || 1;
      filter.frequency.setValueAtTime(spec.freq || 300, now);
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, spec.freqEnd || 1200), now + spec.duration);
      g.gain.exponentialRampToValueAtTime(spec.gain * gain, now + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, now + spec.duration);
      src.connect(filter);
      filter.connect(g);
      g.connect(this.master);
      src.start(now);
      src.stop(now + spec.duration + 0.02);
      return this._track(src, [filter, g]);
    }

    const osc = ctx.createOscillator();
    osc.type = spec.type || 'sine';
    osc.frequency.setValueAtTime(spec.freq || 880, now);
    if (spec.freqEnd && spec.freqEnd !== spec.freq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, spec.freqEnd), now + spec.duration);
    }
    g.gain.exponentialRampToValueAtTime(spec.gain * gain, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + spec.duration);
    osc.connect(g);
    g.connect(this.master);
    osc.start(now);
    osc.stop(now + spec.duration + 0.02);
    return this._track({ stop: () => osc.stop() }, [osc, g]);
  }

  _noise() {
    // 固定种子的 LCG：同一次预览里的噪声可复现，不依赖 Math.random
    this._seed = (this._seed * 1664525 + 1013904223) >>> 0;
    return (this._seed / 0xffffffff) * 2 - 1;
  }

  _playRegistered(name, reg, gain) {
    const cached = this.buffers.get(name);
    if (cached) return this._playBuffer(cached, gain);
    if (!this.loading.has(name)) {
      this.loading.set(name, this._load(name, reg).catch(() => null));
    }
    this.loading.get(name).then((buf) => {
      if (!buf || !this.enabled || this.volume <= 0) return;
      this._playBuffer(buf, gain);
    });
    return null;
  }

  async _load(name, reg) {
    const ctx = this._ensureContext();
    if (!ctx) return null;
    let data = reg.data;
    if (!data && reg.url) {
      const res = await fetch(reg.url);
      if (!res.ok) throw new Error(`声音加载失败：${res.status}`);
      data = await res.arrayBuffer();
    }
    if (!data) return null;
    const buf = await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(data, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
    if (!buf) return null;
    this.buffers.set(name, buf);
    if (!reg.duration) reg.duration = buf.duration;
    return buf;
  }

  _playBuffer(buffer, gain) {
    const ctx = this.context;
    if (!ctx) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.master);
    src.start();
    return this._track(src, [g]);
  }
}

export function createSoundPlayer(opts = {}) {
  return new SoundPlayer(opts);
}
