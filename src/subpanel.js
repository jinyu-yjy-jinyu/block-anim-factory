/* ============================================================
   subpanel.js · 字幕面板 UI
   ------------------------------------------------------------
   职责：列表展示 / 双语编辑 / 逐词时间码 / 拆句 / 校验 / 导入导出
   所有数据操作都作用在 SubtitleTrack 上，不直接碰 IR。
   ============================================================ */

import {
  SubtitleTrack, toSRT, toVTT, toASS, importSubtitles,
  fillWordTimings, splitCue, cueAnchors,
} from './subtitles.js';

export class SubtitlePanel {
  constructor(opts = {}) {
    this.listEl = opts.listEl;
    this.issuesEl = opts.issuesEl;
    this.styleEl = opts.styleEl;
    this.onToast = opts.onToast || (() => {});
    this.onChange = opts.onChange || (() => {});
    this.onSeek = opts.onSeek || (() => {});

    this.track = new SubtitleTrack({ name: '字幕' });
    this.currentTime = 0;
    this.duration = 0;
    this.issueByCue = new Map();
  }

  setTrack(track) {
    this.track = track || new SubtitleTrack();
    this.renderStyles();
    this.render();
    this.validate();
  }

  setTime(t) { this.currentTime = t; this.markActive(); }
  setDuration(d) { this.duration = d; this.validate(); }

  /* ============================================================
     列表
     ============================================================ */
  render() {
    const el = this.listEl;
    if (!el) return;
    el.innerHTML = '';

    if (!this.track.cues.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:24px 16px;color:var(--muted);font-size:12px;text-align:center;line-height:1.8';
      empty.innerHTML = '还没有字幕<br><span style="font-size:11px">点「+ 条」在当前时间新增，或导入 SRT/ASS/VTT</span>';
      el.appendChild(empty);
      return;
    }

    for (const cue of this.track.cues) {
      el.appendChild(this.renderItem(cue));
    }
    this.markActive();
  }

  renderItem(cue) {
    const row = document.createElement('div');
    row.className = 'sub-item';
    row.dataset.cueId = cue.id;

    // 时间
    const t = document.createElement('div');
    t.className = 't';
    t.innerHTML = `<b>${fmt(cue.start)}</b><br>${fmt(cue.end)}`;
    row.appendChild(t);

    // 文本
    const mid = document.createElement('div');
    const main = document.createElement('input');
    main.type = 'text';
    main.value = cue.text;
    main.title = '主字幕';
    main.addEventListener('change', () => {
      cue.text = main.value;
      this.validate();
      this.onChange(this);
    });
    main.addEventListener('focus', () => this.onSeek(cue.start));
    mid.appendChild(main);

    const sub = document.createElement('input');
    sub.type = 'text';
    sub.className = 'sub-text';
    sub.value = cue.secondary || '';
    sub.placeholder = '第二行（双语，可选）';
    sub.addEventListener('change', () => {
      cue.secondary = sub.value;
      this.validate();
      this.onChange(this);
    });
    mid.appendChild(sub);
    row.appendChild(mid);

    // 字数
    const n = [...cue.text].length;
    const mark = document.createElement('span');
    if (this.issueByCue.has(cue.id)) {
      const lv = this.issueByCue.get(cue.id);
      mark.className = lv === 'error' ? 'errmark' : 'warnmark';
      mark.textContent = lv === 'error' ? '!' : n > 30 ? '⚠' : '·';
      mark.title = this.issueByCue.get(cue.id + ':msg') || '';
    } else {
      mark.textContent = String(n);
      mark.style.color = 'var(--muted)';
      mark.style.fontSize = '10px';
    }
    row.appendChild(mark);

    // 校验后刷新问题标记
    queueMicrotask(() => this.validate());
    return row;
  }

  markActive() {
    if (!this.listEl) return;
    const active = this.track.at(this.currentTime);
    for (const row of this.listEl.querySelectorAll('.sub-item')) {
      row.classList.toggle('active', active && row.dataset.cueId === active.id);
    }
  }

  /* ============================================================
     操作
     ============================================================ */
  addCue() {
    const start = Math.round(this.currentTime * 100) / 100;
    const last = this.track.cues[this.track.cues.length - 1];
    const end = start + 2.0;
    void last;
    const cue = this.track.add({ start, end, text: '新字幕', styleId: this.styleEl ? this.styleEl.value : 'default' });
    this.render();
    this.validate();
    this.onChange(this);
    this.onSeek(cue.start);
    return cue;
  }

  removeCue(id) {
    this.track.remove(id);
    this.render();
    this.validate();
    this.onChange(this);
  }

  /** 按字数比例补齐逐词时间码 */
  fillWords() {
    const n = fillWordTimings(this.track);
    this.onToast(`已为 ${n} 条字幕补齐逐词时间码`);
    this.render();
    this.onChange(this);
  }

  /** 把超长字幕按标点/字数拆开 */
  splitLong() {
    let count = 0;
    const next = [];
    for (const cue of [...this.track.cues]) {
      const parts = splitCue(cue, 18);
      if (parts.length) { next.push(...parts); count += parts.length - 1; }
      else next.push(cue);
    }
    this.track.cues = next;
    this.track.sort();
    this.render();
    this.validate();
    this.onChange(this);
    this.onToast(count ? `已拆分 ${count} 条长字幕` : '没有需要拆分的字幕');
  }

  /* ============================================================
     样式
     ============================================================ */
  renderStyles() {
    const sel = this.styleEl;
    if (!sel) return;
    sel.innerHTML = '';
    for (const s of this.track.styles) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.label;
      sel.appendChild(o);
    }
    // 当前字幕的样式优先
    const cur = this.track.at(this.currentTime);
    sel.value = cur ? cur.styleId : 'default';
  }

  setStyleForCurrent(id) {
    const cur = this.track.at(this.currentTime);
    if (cur) { cur.styleId = id; this.onChange(this); }
  }

  setStyleAll(id) {
    for (const c of this.track.cues) c.styleId = id;
    this.onChange(this);
  }

  /* ============================================================
     校验
     ============================================================ */
  validate() {
    const issues = this.track.validate({ duration: this.duration || Infinity, maxChars: 18, maxLines: 2 });
    this.issueByCue.clear();
    for (const i of issues) {
      if (i.level === 'info') continue;
      if (!this.issueByCue.has(i.id) || i.level === 'error') this.issueByCue.set(i.id, i.level);
      this.issueByCue.set(i.id + ':msg', i.msg);
    }
    if (this.issuesEl) {
      this.issuesEl.innerHTML = '';
      if (!issues.length) {
        const ok = document.createElement('div');
        ok.className = 'info';
        ok.textContent = '✓ 字幕检查通过：无超长、无重叠、无超时';
        this.issuesEl.appendChild(ok);
      } else {
        const shown = issues.slice(0, 40);
        for (const i of shown) {
          const d = document.createElement('div');
          d.className = i.level;
          d.textContent = `${i.level === 'error' ? '✕' : i.level === 'warn' ? '⚠' : '·'} ${i.msg}`;
          d.addEventListener('click', () => this.onSeek(i.cue.start));
          d.style.cursor = 'pointer';
          this.issuesEl.appendChild(d);
        }
        if (issues.length > shown.length) {
          const m = document.createElement('div');
          m.className = 'info';
          m.textContent = `… 另有 ${issues.length - shown.length} 条`;
          this.issuesEl.appendChild(m);
        }
      }
    }
    // 刷新行内标记
    if (this.listEl) {
      for (const row of this.listEl.querySelectorAll('.sub-item')) {
        const cue = this.track.cues.find(c => c.id === row.dataset.cueId);
        if (!cue) continue;
        const mark = row.lastChild;
        const lv = this.issueByCue.get(cue.id);
        const n = [...cue.text].length;
        mark.className = lv === 'error' ? 'errmark' : lv ? 'warnmark' : '';
        mark.textContent = lv === 'error' ? '!' : lv ? '⚠' : String(n);
        mark.title = this.issueByCue.get(cue.id + ':msg') || `${n} 字`;
      }
    }
    return issues;
  }

  /* ============================================================
     导入导出
     ============================================================ */
  async importFile(file) {
    try {
      const text = await file.text();
      this.track = importSubtitles(text, { name: file.name.replace(/\.[^.]+$/, '') });
      this.renderStyles();
      this.render();
      this.validate();
      this.onChange(this);
      this.onToast(`已导入 ${this.track.cues.length} 条字幕`);
    } catch (e) {
      this.onToast('字幕导入失败：' + e.message);
    }
  }

  exportAs(format) {
    if (!this.track.cues.length) { this.onToast('没有可导出的字幕'); return null; }
    let text, ext, mime;
    if (format === 'vtt') { text = toVTT(this.track); ext = 'vtt'; mime = 'text/vtt'; }
    else if (format === 'ass') { text = toASS(this.track); ext = 'ass'; mime = 'text/plain'; }
    else { text = toSRT(this.track); ext = 'srt'; mime = 'application/x-subrip'; }
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    return { blob, ext, count: this.track.cues.length };
  }

  /** 字幕锚点（供积木的「在标记点」消费） */
  anchors() { return cueAnchors(this.track); }

  /** 当前时刻的字幕文本（供渲染层用） */
  textAt(t) {
    const c = this.track.at(t);
    return c ? { text: c.text, secondary: c.secondary, cue: c } : null;
  }

  toJSON() { return this.track.toJSON(); }
  loadJSON(j) { this.track = SubtitleTrack.fromJSON(j); this.renderStyles(); this.render(); this.validate(); }
}

function fmt(t) {
  const m = Math.floor(t / 60), s = t % 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}