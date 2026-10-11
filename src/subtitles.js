/* ============================================================
   subtitles.js · 字幕系统（P0-D）
   ------------------------------------------------------------
   规划要求：
     · ASR 自动生成 + 手动校正（ASR 属外部能力，这里提供数据通路与校正 UI 所需结构）
     · SRT / ASS / VTT 导入导出
     · 字幕样式复用文字引擎全部动效
     · 字幕驱动画面：字幕轨决定场景切分，改字幕即改时间轴
     · 双语字幕、安全区提示、爆字数告警
   ============================================================ */

import { uid } from './ir.js';

/* ============================================================
   字幕条目
   ============================================================ */
export class SubtitleCue {
  constructor(opts = {}) {
    this.id = opts.id || uid('C');
    this.start = opts.start || 0;          // 秒
    this.end = opts.end || 0;
    this.text = opts.text || '';
    this.secondary = opts.secondary || '';   // 双语：第二行
    this.words = opts.words || [];            // 逐词时间码 [{word,start,end}]
    this.styleId = opts.styleId || 'default';
    this.note = '';
  }
  get duration() { return Math.max(0, this.end - this.start); }
  contains(t) { return t >= this.start && t < this.end; }
  toJSON() {
    return {
      id: this.id, start: this.start, end: this.end, text: this.text,
      secondary: this.secondary, styleId: this.styleId,
      words: this.words.map(w => ({ word: w.word, start: w.start, end: w.end })),
    };
  }
}

/* ============================================================
   字幕轨
   ============================================================ */
export class SubtitleTrack {
  constructor(opts = {}) {
    this.id = opts.id || uid('ST');
    this.name = opts.name || '字幕';
    this.cues = [];
    this.styles = opts.styles ? opts.styles.map(cloneStyle) : defaultStyles();
  }

  add(cue) {
    const c = cue instanceof SubtitleCue ? cue : new SubtitleCue(cue);
    this.cues.push(c);
    this.sort();
    return c;
  }

  remove(id) {
    const i = this.cues.findIndex(c => c.id === id);
    if (i >= 0) this.cues.splice(i, 1);
  }

  sort() { this.cues.sort((a, b) => a.start - b.start); }

  /** 找出 t 时刻正在显示的字幕 */
  at(t) {
    return this.cues.find(c => c.contains(t)) || null;
  }

  /** 下一个 / 上一个字幕（翻页用） */
  next(t) { return this.cues.find(c => c.start > t) || null; }
  prev(t) {
    for (let i = this.cues.length - 1; i >= 0; i--) if (this.cues[i].start < t) return this.cues[i];
    return null;
  }

  styleOf(id) { return this.styles.find(s => s.id === id) || this.styles[0]; }

  get duration() {
    return this.cues.reduce((m, c) => Math.max(m, c.end), 0);
  }

  /** 导出为纯数据（进 IR / JSON 工程） */
  toJSON() {
    return { id: this.id, name: this.name, cues: this.cues.map(c => c.toJSON()), styles: this.styles };
  }

  static fromJSON(j) {
    // styles 缺省或为 null 时用内置样式模板，避免样式选择框是空的
    const styles = (j.styles && j.styles.length) ? j.styles.map(cloneStyle) : defaultStyles();
    const t = new SubtitleTrack({ id: j.id, name: j.name, styles });
    t.cues = (j.cues || []).map(c => new SubtitleCue(c));
    return t;
  }

  /* ---------- 校验：爆字数告警 / 重叠 / 越界 ---------- */
  validate(opts = {}) {
    const issues = [];
    const maxChars = opts.maxChars || 18;        // 单行字数上限（中文）
    const maxLines = opts.maxLines || 2;
    const duration = opts.duration || Infinity;
    for (const c of this.cues) {
      const len = [...c.text].length;
      if (len > maxChars * maxLines) {
        issues.push({ id: c.id, level: 'warn', kind: 'tooLong', msg: `字幕过长（${len} 字，建议 ≤${maxChars * maxLines}）`, cue: c });
      } else if (len > maxChars * maxLines * 0.85) {
        issues.push({ id: c.id, level: 'info', kind: 'nearLimit', msg: `字幕接近上限（${len}/${maxChars * maxLines}）`, cue: c });
      }
      if (c.start < 0) issues.push({ id: c.id, level: 'error', kind: 'negative', msg: '开始时间为负', cue: c });
      if (c.end < c.start) issues.push({ id: c.id, level: 'error', kind: 'empty', msg: '时长为负', cue: c });
      if (c.end > duration + 0.01) issues.push({ id: c.id, level: 'warn', kind: 'overflow', msg: '超出工程时长', cue: c });
      if (c.duration > 8) issues.push({ id: c.id, level: 'warn', kind: 'slow', msg: '停留过久（>8s），观众会走神', cue: c });
      if (c.duration < 0.4) issues.push({ id: c.id, level: 'warn', kind: 'fast', msg: '闪现太快（<0.4s）', cue: c });
    }
    for (let i = 1; i < this.cues.length; i++) {
      if (this.cues[i].start < this.cues[i - 1].end - 0.01) {
        issues.push({
          id: this.cues[i].id, level: 'warn', kind: 'overlap',
          msg: `与上一条重叠 ${(this.cues[i - 1].end - this.cues[i].start).toFixed(2)}s`, cue: this.cues[i],
        });
      }
    }
    return issues;
  }

  /** 自动吸附：把字幕对齐到最近的音节/节拍，减少手动微调 */
  snapTo(anchors, tolerance = 0.25) {
    if (!anchors || !anchors.length) return 0;
    let n = 0;
    for (const c of this.cues) {
      const s = nearest(anchors, c.start, tolerance);
      if (s != null) { c.start = s; n++; }
      const e = nearest(anchors, c.end, tolerance);
      if (e != null && e > c.start) { c.end = e; n++; }
    }
    this.sort();
    return n;
  }

  /** 从「按标点分句的台词卡」生成字幕（ASR 结果的通用结构） */
  static fromLines(lines, opts = {}) {
    const t = new SubtitleTrack({ name: opts.name || '字幕' });
    const cps = opts.cps || 5.5;              // 每秒字数（中文字幕节奏）
    const minDur = opts.minDur || 0.8;
    const gap = opts.gap == null ? 0.12 : opts.gap;
    let cursor = opts.startAt || 0;
    for (const raw of lines) {
      const text = String(raw).trim();
      if (!text) { cursor += gap; continue; }
      const dur = Math.max(minDur, [...text].length / cps);
      t.add(new SubtitleCue({ start: cursor, end: cursor + dur, text }));
      cursor += dur + gap;
    }
    return t;
  }
}

/* ============================================================
   样式模板（复用文字引擎属性）
   ============================================================ */
export function defaultStyles() {
  return [
    {
      id: 'default', label: '默认字幕',
      fontSize: 64, fontWeight: 700, fill: '#ffffff',
      stroke: '#000000', strokeWidth: 6, shadow: 12,
      x: 960, y: 900, align: 'center',
      background: '', backgroundOpacity: 0.5, padding: 12, radius: 8,
      anim: 'none',          // none | pop | wipe | typewriter | path
      secondarySize: 48, secondaryColor: '#b9c2d4',
    },
    {
      id: 'karaoke', label: '卡拉OK高亮',
      fontSize: 68, fontWeight: 800, fill: '#ffffff',
      stroke: '#0d1017', strokeWidth: 8, shadow: 16,
      x: 960, y: 880, align: 'center',
      background: '', backgroundOpacity: 0.5, padding: 12, radius: 8,
      anim: 'karaoke', highlightColor: '#38ffd1',
      secondarySize: 48, secondaryColor: '#b9c2d4',
    },
    {
      id: 'pop', label: '弹跳大字',
      fontSize: 96, fontWeight: 900, fill: '#ffffff',
      stroke: '#000000', strokeWidth: 8, shadow: 24,
      x: 960, y: 840, align: 'center',
      background: '', backgroundOpacity: 0.5, padding: 16, radius: 12,
      anim: 'pop',
      secondarySize: 56, secondaryColor: '#ffd166',
    },
    {
      id: 'lower', label: '下三分之一·双语',
      fontSize: 52, fontWeight: 600, fill: '#ffffff',
      stroke: '#000000', strokeWidth: 4, shadow: 8,
      x: 960, y: 960, align: 'center',
      background: '#000000', backgroundOpacity: 0.6, padding: 10, radius: 6,
      anim: 'none',
      secondarySize: 38, secondaryColor: '#9aa4b8',
    },
  ];
}
function cloneStyle(s) { return Object.assign({}, s); }

/* ============================================================
   导入 / 导出
   ============================================================ */
const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

function fmtSrtTime(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), ms = Math.round((t % 1) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms).padStart(3, '0')}`;
}
function fmtVttTime(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), ms = Math.round((t % 1) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${String(ms).padStart(3, '0')}`;
}
function fmtAssTime(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.round((t % 1) * 100);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

function parseTime(str) {
  const s = String(str).trim().replace(',', '.');
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  const h = m[1] ? +m[1] : 0, mi = +m[2], sec = +m[3];
  const frac = m[4] ? +('0.' + m[4]) : 0;
  return h * 3600 + mi * 60 + sec + frac;
}

/** 导出 SRT */
export function toSRT(track) {
  return track.cues.map((c, i) => {
    const body = c.secondary ? `${c.text}\n${c.secondary}` : c.text;
    return `${i + 1}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}\n${body}\n`;
  }).join('\n');
}

/** 导出 VTT */
export function toVTT(track) {
  const head = 'WEBVTT\n\n';
  const body = track.cues.map(c => {
    const txt = c.secondary ? `${c.text}\n${c.secondary}` : c.text;
    return `${fmtVttTime(c.start)} --> ${fmtVttTime(c.end)}\n${txt}\n`;
  }).join('\n');
  return head + body;
}

/** 导出 ASS（含样式与逐词高亮标记） */
export function toASS(track, opts = {}) {
  const W = opts.width || 1920, H = opts.height || 1080;
  const style = track.styleOf(track.cues[0] ? track.cues[0].styleId : 'default');
  const hex = (c) => '&H' + String(c || '#ffffff').replace('#', '').toUpperCase().split('')
    .reverse().join('') + '&';
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: ' + W,
    'PlayResY: ' + H,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${style.label},${Math.round(style.fontSize * H / 1080)},${hex(style.fill)},${hex(style.secondaryColor || '#ffffff')},${hex(style.stroke || '#000000')},&H80000000,${style.fontWeight >= 600 ? -1 : 0},0,0,0,100,100,0,0,1,${Math.round(style.strokeWidth * H / 1080)},${Math.round(style.shadow * H / 1080)},2,${Math.round(W * 0.08)},${Math.round(W * 0.08)},${Math.round(H - style.y * H / 1080)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const events = track.cues.map(c => {
    let text = c.text;
    // 逐词高亮：{\k<centiseconds>} 前缀
    if (c.words && c.words.length && (style.anim === 'karaoke' || opts.forceKaraoke)) {
      text = c.words.map(w => {
        const cs = Math.max(1, Math.round((w.end - w.start) * 100));
        return `{\\k${cs}}${w.word}`;
      }).join('');
    }
    if (c.secondary) text = text + '\\N' + c.secondary;
    return `Dialogue: 0,${fmtAssTime(c.start)},${fmtAssTime(c.end)},${style.id === 'karaoke' ? 'Default' : 'Default'},,0,0,0,,${text}`;
  }).join('\n');

  return header + '\n' + events + '\n';
}

/** 导入：自动识别 SRT / VTT / ASS */
export function importSubtitles(text, opts = {}) {
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const name = opts.name || '字幕';
  if (/^\s*\[Script Info\]/i.test(src)) return parseASS(src, name);
  if (/^\s*WEBVTT/i.test(src)) return parseVTT(src, name);
  if (/-->/.test(src) && /\d+:\d+:\d+[,.]\d+\s*-->/.test(src)) return parseSRT(src, name);
  return parseSRT(src, name);
}

export function parseSRT(text, name = '字幕') {
  const t = new SubtitleTrack({ name });
  const blocks = text.split(/\n\s*\n/).filter(b => b.trim());
  for (const b of blocks) {
    const lines = b.split('\n').filter(l => l.trim() !== '');
    let ti = lines.findIndex(l => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->').map(x => x.trim());
    const start = parseTime(a), end = parseTime(z);
    if (start == null || end == null) continue;
    const body = lines.slice(ti + 1).join('\n');
    const parts = body.split('\n');
    t.add(new SubtitleCue({
      start, end,
      text: (parts[0] || '').trim(),
      secondary: parts.length > 1 ? parts.slice(1).join('\n').trim() : '',
    }));
  }
  return t;
}

export function parseVTT(text, name = '字幕') {
  const t = new SubtitleTrack({ name });
  const body = text.replace(/^WEBVTT.*?\n/s, '');
  const blocks = body.split(/\n\s*\n/).filter(b => b.trim());
  for (const b of blocks) {
    const lines = b.split('\n').filter(l => l.trim() !== '');
    let ti = lines.findIndex(l => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->').map(x => x.trim());
    const start = parseTime(a), end = parseTime(z);
    if (start == null || end == null) continue;
    const parts = lines.slice(ti + 1).join('\n').split('\n');
    t.add(new SubtitleCue({ start, end, text: (parts[0] || '').trim(), secondary: parts.length > 1 ? parts.slice(1).join('\n').trim() : '' }));
  }
  return t;
}

export function parseASS(text, name = '字幕') {
  const t = new SubtitleTrack({ name });
  const lines = text.split('\n');
  let inEvents = false;
  for (const line of lines) {
    if (/^\[Events\]/i.test(line)) { inEvents = true; continue; }
    if (/^\[/.test(line)) { inEvents = false; continue; }
    if (!inEvents) continue;
    if (!/^Dialogue:/i.test(line)) continue;
    const m = line.replace(/^Dialogue:\s*/i, '').split(',');
    if (m.length < 10) continue;
    const start = parseTime(m[1]), end = parseTime(m[2]);
    if (start == null || end == null) continue;
    let body = m.slice(9).join(',').trim();
    // 去 ASS 覆写码，还原为纯文本
    const words = [];
    let cursor = start;
    const karaoke = /\{\\k(\d+)\}/g;
    let last = 0, km;
    let plain = '';
    while ((km = karaoke.exec(body)) !== null) {
      plain += body.slice(last, km.index).replace(/\{\\[^}]*\}/g, '');
      const dur = (+km[1]) / 100;
      const w = body.slice(km.index + km[0].length).split(/\{/)[0];
      words.push({ word: w, start: cursor, end: cursor + dur });
      cursor += dur;
      last = km.index + km[0].length;
      plain += w;
    }
    plain += body.slice(last).replace(/\{\\[^}]*\}/g, '');
    const [main, sub] = plain.split('\\N');
    t.add(new SubtitleCue({
      start, end,
      text: (main || '').trim(),
      secondary: sub ? sub.trim() : '',
      words: words.length ? words : [],
    }));
  }
  return t;
}

/* ============================================================
   逐词时间码：把整句按时长按字数比例分配
   （真实 ASR 会给出词级时间码；这里在没有 ASR 时给出可用的近似）
   ============================================================ */
export function distributeWords(cue, opts = {}) {
  const text = cue.text || '';
  if (!text) return [];
  const tokens = text.match(/[一-龥]|[A-Za-z0-9']+|\s+|[^\s]/g) || [];
  const weights = tokens.map(t => (/\s/.test(t) ? 0.35 : 1));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const dur = cue.duration;
  const lead = opts.lead || 0;
  let acc = 0;
  const words = tokens.map(t => {
    const d = (weights[acc] / total) * dur;
    const w = { word: t, start: cue.start + acc / total * dur, end: cue.start + (acc / total) * dur + d };
    acc++;
    return w;
  });
  void lead;
  return words;
}

/** 为整轨补齐逐词时间码 */
export function fillWordTimings(track) {
  let n = 0;
  for (const c of track.cues) {
    if (!c.words || !c.words.length) { c.words = distributeWords(c); n++; }
  }
  return n;
}

/* ============================================================
   字幕驱动画面：按字幕切分场景
   ------------------------------------------------------------
   规划：「字幕轨决定场景切分，改字幕即改时间轴」。
   这里把字幕边界转成一组「场景锚点」，供积木的「在标记点」消费。
   ============================================================ */
export function cueAnchors(track, opts = {}) {
  const out = [];
  for (let i = 0; i < track.cues.length; i++) {
    const c = track.cues[i];
    out.push({ id: 'cue_' + i, time: c.start, label: c.text.slice(0, 12) || `字幕${i + 1}`, kind: 'cue' });
    if (i > 0 && c.start - track.cues[i - 1].end > (opts.minGap || 0.5)) {
      out.push({ id: 'gap_' + i, time: (track.cues[i - 1].end + c.start) / 2, label: '停顿', kind: 'gap' });
    }
  }
  return out;
}

/** 按字数把长句拆成多条（避免爆字数） */
export function splitCue(cue, maxChars = 16) {
  const text = cue.text;
  if ([...text].length <= maxChars) return [];
  const parts = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    // 在标点处优先断开
    if ([...buf].length >= maxChars * 0.6 && '，。！？；、,.!?; '.includes(ch)) {
      parts.push(buf); buf = '';
    } else if ([...buf].length >= maxChars) {
      parts.push(buf); buf = '';
    }
  }
  if (buf) parts.push(buf);
  if (parts.length < 2) return [];
  const out = [];
  const total = cue.duration;
  const per = total / parts.length;
  parts.forEach((p, i) => {
    out.push(new SubtitleCue({
      start: cue.start + i * per,
      end: cue.start + (i + 1) * per - 0.02,
      text: p,
      styleId: cue.styleId,
    }));
  });
  return out;
}

function nearest(list, t, tol) {
  let best = null, bd = tol;
  for (const x of list) {
    const d = Math.abs(x - t);
    if (d <= bd) { bd = d; best = x; }
  }
  return best;
}