/* ============================================================
   audiodesk.js · 录音台 + 波形编辑器 UI
   ------------------------------------------------------------
   把 recorder.js 的能力接到界面：
     · 麦克风录音（含电平表、削波提示、降噪、闪避）
     · 波形显示 + 框选
     · 非破坏编辑（裁剪/删除/静音/淡入淡出/增益/去静音/归一化）
     · 响度显示与一键达标
   所有编辑都走 WaveEditor 的撤销栈，原始音频永不丢失。
   ============================================================ */

import { Recorder, AUDIO_PRESETS, WaveEditor, fileToTrack, applyPreset } from './recorder.js';
import { normalizeLoudness, LOUDNESS_PRESETS, mixTracks } from './audio-core.js';

export class AudioDesk {
  constructor(opts = {}) {
    this.el = opts.el;
    this.canvas = opts.canvas;
    this.cursorEl = opts.cursorEl;
    this.levelEl = opts.levelEl;
    this.timeEl = opts.timeEl;
    this.recBtn = opts.recBtn;
    this.onChange = opts.onChange || (() => {});
    this.onSeek = opts.onSeek || (() => {});
    this.onToast = opts.onToast || ((m) => console.log('[toast]', m));

    this.tracks = [];
    this.activeIndex = 0;
    this.editor = null;          // WaveEditor
    this.selection = null;       // {start, end} 秒
    this.zoom = 1;
    this.scroll = 0;

    this.recorder = new Recorder({ onLevel: (v) => this.setLevel(v), onTick: (s) => this.setRecTime(s) });
    this.recording = false;

    this.bindUI();
    this.render();
  }

  /* ============================================================
     数据装载
     ============================================================ */
  setTracks(tracks) {
    this.tracks = tracks || [];
    this.activeIndex = 0;
    this.rebuildEditor();
    this.render();
    this.onChange(this);
  }

  get track() { return this.tracks[this.activeIndex] || null; }
  get peaks() { return this.track ? this.track.ensureAnalysis().peaks : null; }

  rebuildEditor() {
    const tr = this.track;
    if (!tr) { this.editor = null; return; }
    // 每个音轨一个编辑器实例，撤销栈随之持久化
    if (!tr.editor) tr.editor = new WaveEditor(tr);
    this.editor = tr.editor;
    // 标记范围同步
    this.editor.markStart = 0;
    this.editor.markEnd = tr.duration;
  }

  /* ============================================================
     波形绘制
     ============================================================ */
  render() {
    const cv = this.canvas;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 300, h = cv.clientHeight || 120;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const tr = this.track;
    if (!tr) {
      ctx.fillStyle = '#5a5f6e';
      ctx.font = '12px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('导入音频或点「录音」开始', w / 2, h / 2);
      return;
    }

    const peaks = tr.ensureAnalysis().peaks;
    const dur = tr.duration || 1;
    const mid = h / 2;

    // 中线
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

    // 选区
    if (this.selection) {
      const x0 = (this.selection.start / dur) * w;
      const x1 = (this.selection.end / dur) * w;
      ctx.fillStyle = 'rgba(74,140,255,.22)';
      ctx.fillRect(x0, 0, x1 - x0, h);
    }

    // 波形：对称柱
    const n = peaks.min.length;
    ctx.fillStyle = tr.muted ? '#4a4f5c' : '#4a8cff';
    const bars = Math.max(1, Math.floor(w));
    for (let i = 0; i < bars; i++) {
      const a = Math.floor(i / bars * n), b = Math.floor((i + 1) / bars * n);
      let mn = 1, mx = -1;
      for (let j = a; j < b && j < n; j++) {
        if (peaks.min[j] < mn) mn = peaks.min[j];
        if (peaks.max[j] > mx) mx = peaks.max[j];
      }
      const y0 = mid - mx * mid * 0.94;
      const y1 = mid - mn * mid * 0.94;
      ctx.fillRect(i, y0, 1, Math.max(1, y1 - y0));
    }

    // 节拍标记
    const beats = tr.ensureAnalysis().beats || [];
    ctx.strokeStyle = 'rgba(255,209,102,.55)';
    ctx.lineWidth = 1;
    for (const b of beats) {
      const x = Math.round((b.time / dur) * w) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }

    // 播放头
    if (this.cursorEl && this._time != null) {
      this.cursorEl.style.left = ((this._time / dur) * w) + 'px';
    }
  }

  setTime(t) { this._time = t; this.render(); }

  /* ============================================================
     交互：框选 / 点击定位
     ============================================================ */
  bindUI() {
    const cv = this.canvas;
    if (!cv) return;

    let dragging = false, anchorX = 0, moved = false;

    cv.addEventListener('pointerdown', (e) => {
      const tr = this.track;
      if (!tr) return;
      const rect = cv.getBoundingClientRect();
      anchorX = e.clientX - rect.left;
      dragging = true; moved = false;
      cv.setPointerCapture(e.pointerId);
    });

    cv.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = cv.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (Math.abs(x - anchorX) > 3) moved = true;
      if (moved) {
        const dur = this.track.duration || 1;
        const a = Math.min(anchorX, x) / rect.width * dur;
        const b = Math.max(anchorX, x) / rect.width * dur;
        this.selection = { start: Math.min(a, b), end: Math.max(a, b) };
        this.render();
      }
    });

    cv.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      try { cv.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
      if (!moved) {
        // 点击 = 定位
        const rect = cv.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const dur = this.track ? this.track.duration : 0;
        this.selection = null;
        this.render();
        this.onSeek(Math.max(0, x / rect.width * dur));
      }
    });

    // 滚轮缩放
    cv.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.zoom = Math.max(1, Math.min(20, this.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      this.render();
    }, { passive: false });

    // 键盘
    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'Delete' && this.selection && this.editor) {
        e.preventDefault();
        this.act('delete');
      }
    });
  }

  /* ============================================================
     录音
     ============================================================ */
  async toggleRecord() {
    if (this.recording) { await this.stopRecord(); return; }
    try {
      await this.recorder.start();
      this.recording = true;
      if (this.recBtn) {
        this.recBtn.classList.add('recording');
        this.recBtn.textContent = '■ 停止';
      }
    } catch (e) {
      this.onToast('无法访问麦克风：' + e.message);
    }
  }

  async stopRecord() {
    const blob = await this.recorder.stop();
    this.recording = false;
    if (this.recBtn) {
      this.recBtn.classList.remove('recording');
      this.recBtn.textContent = '● 录音';
    }
    if (!blob || !blob.size) return;
    try {
      const tr = await blobToTrack(blob);
      tr.name = '录音 ' + new Date().toLocaleTimeString('zh-CN');
      tr.ensureAnalysis();
      this.tracks.push(tr);
      this.activeIndex = this.tracks.length - 1;
      this.rebuildEditor();
      this.render();
      this.onChange(this);
      this.onToast(`已录入 ${tr.duration.toFixed(1)} 秒`);
    } catch (e) {
      this.onToast('录音解码失败：' + e.message);
    }
  }

  setLevel(v) {
    if (!this.levelEl) return;
    const pct = Math.min(100, v * 100);
    this.levelEl.style.width = pct + '%';
    this.levelEl.classList.toggle('clip', v >= 0.99);
  }

  setRecTime(sec) {
    if (!this.timeEl) return;
    const m = Math.floor(sec / 60), s = sec % 60;
    this.timeEl.textContent = `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
  }

  /* ============================================================
     导入
     ============================================================ */
  async importFile(file) {
    try {
      const tr = await fileToTrack(file);
      tr.ensureAnalysis();
      tr.name = file.name;
      this.tracks.push(tr);
      this.activeIndex = this.tracks.length - 1;
      this.rebuildEditor();
      this.render();
      this.onChange(this);
      this.onToast(`已导入 ${tr.name}（${tr.duration.toFixed(1)}s）`);
    } catch (e) {
      this.onToast('音频导入失败：' + e.message);
    }
  }

  /* ============================================================
   非破坏编辑
   ============================================================ */
  act(name) {
    const ed = this.editor;
    const tr = this.track;
    if (!ed || !tr) return;

    const hasSel = !!this.selection;
    const sel = this.selection || { start: 0, end: tr.duration };

    try {
      switch (name) {
        case 'trim':
          if (!hasSel) return this.onToast('请先框选一段波形');
          ed.trimTo(sel.start, sel.end);
          this.selection = null;
          break;
        case 'delete':
          if (!hasSel) return this.onToast('请先框选一段波形');
          ed.delete(sel.start, sel.end);
          this.selection = null;
          break;
        case 'silence':
          if (!hasSel) return this.onToast('请先框选一段波形');
          ed.silence(sel.start, sel.end);
          this.selection = null;
          break;
        case 'fadeIn': ed.fadeEdges(sel.start, Math.min(sel.end, sel.start + 1.2)); break;
        case 'fadeOut': ed.fadeEdges(Math.max(sel.start, sel.end - 1.2), sel.end); break;
        case 'gainUp': ed.gain(sel.start, sel.end, Math.pow(10, 3 / 20)); break;
        case 'gainDown': ed.gain(sel.start, sel.end, Math.pow(10, -3 / 20)); break;
        case 'stretch': ed.stretchRange(sel.start, sel.end, 2); break;
        case 'removeSilence': ed.removeSilence({ thresholdDb: -42, minGap: 0.35 }); break;
        case 'normalize': this.normalizeTrack(-1); break;
        case 'undo': ed.undo(); this.selection = null; break;
        case 'reset': ed.reset(); this.selection = null; break;
        case 'zoomIn': this.zoom = Math.min(20, this.zoom * 1.4); break;
        case 'zoomOut': this.zoom = Math.max(1, this.zoom / 1.4); break;
        case 'fit': this.zoom = 1; break;
        default: return;
      }
      this.render();
      this.onChange(this);
    } catch (e) {
      this.onToast(e.message);
    }
  }

  /** 归一化到目标 dBFS */
  normalizeTrack(targetDb) {
    const ed = this.editor;
    const tr = this.track;
    if (!ed || !tr) return;
    const a = tr.ensureAnalysis();
    const peak = a.peaks ? peakOf(a.peaks) : 0;
    if (peak <= 1e-6) { this.onToast('这段音频是静音，无法归一化'); return; }
    const target = Math.pow(10, targetDb / 20);
    ed.gain(0, tr.duration, target / peak);
  }

  /** 应用预设（降噪/齿音/爆音/压缩/归一化） */
  applyPreset(name) {
    const ed = this.editor;
    const tr = this.track;
    if (!ed || !tr) return;
    if (!AUDIO_PRESETS[name]) return;
    try {
      // 原始样本存进撤销栈，随时可回退
      const backup = tr.samples.slice();
      applyPreset(tr, name);
      ed.ops.push({ type: 'preset', name, backup, undoType: 'rawReplace' });
      this.render();
      this.onChange(this);
      this.onToast('已应用：' + (AUDIO_PRESETS[name].label || name));
    } catch (e) {
      this.onToast(e.message);
    }
  }

  /** 按键式响度归一（抖音 −14 / B站 −16 …） */
  normalizeToPreset(presetName) {
    const target = LOUDNESS_PRESETS[presetName];
    if (!target) return null;
    const mixed = this.mix();
    if (!mixed) return null;
    return normalizeLoudness(mixed.samples, mixed.sampleRate, target);
  }

  /* ============================================================
     混音导出
     ============================================================ */
  mix() {
    if (!this.tracks.length) return null;
    return mixTracks(this.tracks);
  }

  /* ============================================================
     状态显示
     ============================================================ */
  status() {
    const tr = this.track;
    if (!tr) return { lufs: null, peak: null, bpm: null, duration: 0 };
    const a = tr.ensureAnalysis();
    // 峰值直接由波形包络算，不依赖 analysis 里是否带了 peakDb
    const pk = a.peaks ? peakOf(a.peaks) : 0;
    const peakDb = pk > 1e-6 ? 20 * Math.log10(pk) : null;
    return {
      lufs: a.loudness ? Math.round(a.loudness.lufs * 10) / 10 : null,
      peak: peakDb == null ? null : Math.round(peakDb * 10) / 10,
      bpm: a.bpm || null,
      duration: tr.duration,
      name: tr.name,
    };
  }
}

/* 峰值（dBFS）*/
function peakOf(peaks) {
  let m = 0;
  for (let i = 0; i < peaks.max.length; i++) if (peaks.max[i] > m) m = peaks.max[i];
  for (let i = 0; i < peaks.min.length; i++) if (-peaks.min[i] > m) m = -peaks.min[i];
  return m;
}

async function blobToTrack(blob) {
  const buf = await blob.arrayBuffer();
  const { decodeWav } = await import('./audio-core.js');
  return decodeWav(buf);
}