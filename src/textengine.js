/* ============================================================
   textengine.js · 文字引擎增强（P0-H）
   ------------------------------------------------------------
   规划 B 的完整实现：
     · 可变字体（weight / slant 可动画化）
     · 路径文字、环形排版、竖排
     · 中英文断行与标点避头尾
     · 文本表达式（序号/日期/金额/字数/随机）—— 见 text-expr
   与 renderer.js 的关系：这里负责「排版计算」，
   renderer 只负责按算好的结果绘制 —— 保证预览/导出一致。
   ============================================================ */

import { NO_START, NO_END } from './layout-rules.js';

export { NO_START, NO_END };

/* ============================================================
   可变字体
   ------------------------------------------------------------
   可变字体的 weight / slant 是连续量，因此可以被打包进表达式积木，
   做出「字重随音频脉动」这类效果。
   浏览器端统一通过 font-variation-settings 表达；
   不支持可变字体的字体自动降级到最近字重。
   ============================================================ */

export function fontVariation({ family, size, weight = 400, slant = 0, width = 100, optical = null }) {
  const parts = [];
  if (family) parts.push(`"${family}"`);
  const base = `${slant !== 0 ? 'italic ' : ''}${weight >= 600 ? 'bold ' : ''}${size}px`;
  const css = `${base}${parts.length ? ' ' + parts.join(',') : ''}`;
  return {
    css,
    variation: `'wght' ${round2(weight)}, 'wdth' ${round2(width)}, 'slnt' ${round2(slant)}`,
    settings: `"wght" ${round2(weight)}, "wdth" ${round2(width)}, "slnt" ${round2(slant)}`,
  };
}
function round2(n) { return Math.round(n * 100) / 100; }

/* 可变字轴范围（典型值） */
export const VARIABLE_AXES = {
  wght: { min: 100, max: 900, default: 400, label: '字重' },
  wdth: { min: 50, max: 200, default: 100, label: '字宽' },
  slnt: { min: -10, max: 0, default: 0, label: '倾斜' },
  opsz: { min: 6, max: 144, default: 14, label: '光学尺寸' },
};

export function clampAxis(axis, v) {
  const a = VARIABLE_AXES[axis];
  if (!a) return v;
  return Math.max(a.min, Math.min(a.max, v));
}

/* ============================================================
   排版：把文本 + 样式算成「绘制指令」
   返回的 units 数组里每个元素都带自己的位置与样式，
   renderer 只需要照着画 —— 保证可复现。
   ============================================================ */

/**
 * @param {CanvasRenderingContext2D} ctx  用于测量（只用 measureText，不产生副作用）
 * @param {object} style
 * @param {string} text
 * @returns {{units: Array, lineCount: number, bbox: object}}
 */
export function layoutText(ctx, text, style = {}) {
  const size = style.fontSize || 96;
  const weight = style.fontWeight || 400;
  const family = style.fontFamily || '"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif';
  const slant = style.fontStyle === 'italic' || style.slant < 0 ? 'italic ' : '';
  ctx.font = `${slant}${weight} ${size}px ${family}`;
  const ls = style.letterSpacing || 0;
  const lineHeight = style.lineHeight || 1.25;

  if (style.vertical) return layoutVertical(ctx, String(text ?? ''), style, size, ls, lineHeight);
  if (style.ringText) return layoutRing(ctx, String(text ?? ''), style, size, ls, lineHeight);
  if (style.pathText) return layoutOnPath(ctx, String(text ?? ''), style, size, ls, lineHeight);
  return layoutHorizontal(ctx, String(text ?? ''), style, size, ls, lineHeight);
}

/* ---------- 横排 ---------- */
function layoutHorizontal(ctx, text, style, size, ls, lineHeight) {
  const paragraphs = text.split('\n');
  const lines = [];
  for (const p of paragraphs) lines.push(...breakLine(ctx, p, style, ls));

  const units = [];
  const lineH = size * lineHeight;
  let y = 0;
  for (const line of lines) {
    const { chars, widths } = measureRun(ctx, line, ls);
    let total = chars.reduce((a, c, i) => a + widths[i], 0);
    const align = style.align || 'left';
    let x = align === 'center' ? -total / 2 : align === 'right' ? -total : 0;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      // 避头尾：行首禁则字 → 前一个字后移一点点（模拟标点压缩）
      let dx = 0;
      if (i > 0 && NO_START.includes(ch)) dx = -size * 0.04;
      // 避尾：行尾不能是开引号类
      let dy = 0;
      if (i === chars.length - 1 && NO_END.includes(ch)) dy = -size * 0.04;
      units.push({
        char: ch, x: x + dx, y: y + dy,
        width: widths[i], size,
        fontSize: size * (unitScale(style, ch) || 1),
        index: i,
      });
      x += widths[i];
    }
    y += lineH;
  }
  return { units, lineCount: lines.length, lineHeight: lineH, height: y, layout: 'horizontal' };
}

/* ---------- 竖排 ---------- */
function layoutVertical(ctx, text, style, size, ls, lineHeight) {
  const paragraphs = text.split('\n');
  const colH = size * lineHeight;
  const units = [];
  let col = 0;
  for (const p of paragraphs) {
    const chars = Array.from(p);
    const width = size * 1.06;
    chars.forEach((ch, i) => {
      // 纵中横排：数字/字母横过来（可关闭）
      const isTateChuYoko = /[A-Za-z0-9]/.test(ch) && (style.tcy !== false);
      units.push({
        char: ch,
        x: -col * colH,
        y: -i * (size + (ls || 0)),
        width: isTateChuYoko ? 0 : width,
        size,
        rotate: isTateChuYoko ? Math.PI / 2 : 0,
        index: i,
        column: col,
      });
    });
    col++;
  }
  return { units, lineCount: col, lineHeight: colH, height: 0, layout: 'vertical' };
}

/* ---------- 环形排版 ---------- */
function layoutRing(ctx, text, style, size, ls, lineHeight) {
  const chars = Array.from(text).filter(c => c !== '\n');
  const R = style.ringText.radius || 300;
  const startAngle = ((style.ringText.startAngle || -90) * Math.PI) / 180;
  const dir = style.ringText.direction === 'counter' ? -1 : 1;
  const total = style.ringText.fullCircle ? 1 : 0.72;
  const span = Math.PI * 2 * total;

  // 量出总弧长，按比例分配角度
  const widths = chars.map(c => ctx.measureText(c).width + (ls || 0));
  const arcTotal = widths.reduce((a, b) => a + b, 0);
  const arcLen = span * R;

  const units = [];
  let acc = 0;
  for (let i = 0; i < chars.length; i++) {
    const frac = acc / arcTotal;
    const ang = startAngle + dir * span * frac;
    acc += widths[i];
    units.push({
      char: chars[i],
      // 坐标：把字符放在圆弧上，rotate 让字「立起来」
      x: Math.cos(ang) * R,
      y: Math.sin(ang) * R,
      rotate: ang + (dir > 0 ? Math.PI / 2 : -Math.PI / 2),
      size,
      width: widths[i],
      index: i,
      onRing: true,
    });
  }
  void arcLen;
  return { units, lineCount: 1, layout: 'ring', radius: R };
}

/* ---------- 路径文字 ---------- */
function layoutOnPath(ctx, text, style, size, ls, lineHeight) {
  const path = typeof style.pathText === 'string'
    ? { d: style.pathText, width: style.pathTextWidth || 600, height: style.pathTextHeight || 200 }
    : style.pathText;
  const chars = Array.from(text);
  const widths = chars.map(c => ctx.measureText(c).width + (ls || 0));
  const total = widths.reduce((a, b) => a + b, 0);

  const W = path.width || 600, H = path.height || 200;
  const amp = path.amplitude == null ? 40 : path.amplitude;
  const freq = path.frequency || 1.5;
  const startX = -W / 2 + (W - total) / 2;

  const units = [];
  let acc = 0;
  for (let i = 0; i < chars.length; i++) {
    const x = startX + acc;
    acc += widths[i];
    const t = (x + W / 2) / W;                    // 0..1
    const y = Math.sin(t * Math.PI * freq) * amp;
    const dy = Math.cos(t * Math.PI * freq) * Math.PI * freq / W * amp;
    units.push({
      char: chars[i], x, y,
      rotate: Math.atan(dy),
      size, width: widths[i], index: i, onPath: true,
    });
  }
  void lineHeight;
  return { units, lineCount: 1, layout: 'path', pathWidth: W };
}

/* ============================================================
   断行与标点避头尾
   ============================================================ */
function breakLine(ctx, para, style, ls) {
  const maxWidth = style.maxWidth || Infinity;
  if (!isFinite(maxWidth)) return [para];

  const chars = Array.from(para);
  const widths = chars.map(c => ctx.measureText(c).width + (ls || 0));
  const lines = [];
  let line = [], lineW = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    // 行首禁则：这些字不能出现在行首，试着把它拉到下一行
    if (line.length && NO_START.includes(ch) && lineW + widths[i] <= maxWidth) {
      line.push(ch); lineW += widths[i]; continue;
    }
    if (NO_START.includes(ch) && line.length === 0) {
      // 行首就是禁则字：强制塞进当前行（无处可去）
      line.push(ch); lineW += widths[i]; continue;
    }
    if (lineW + widths[i] > maxWidth && line.length) {
      // 行尾禁则：如果当前行最后一个是开引号类，挪到下一行
      let carry = '';
      if (line.length > 1 && NO_END.includes(line[line.length - 1])) {
        carry = line.pop();
      }
      lines.push(line.join(''));
      line = carry ? [carry] : [];
      lineW = carry ? widths[chars.indexOf(carry)] : 0;
    }
    line.push(ch); lineW += widths[i];
  }
  if (line.length) lines.push(line.join(''));
  return lines.length ? lines : [''];
}

/* ============================================================
   文本表达式（P0-H）
   ------------------------------------------------------------
   「序号、日期、金额格式化、字数统计、随机取值」
   这些在模板与批量渲染里非常常用。
   ============================================================ */
export const TEXT_FORMATS = {
  cnNumber: { label: '中文数字', fn: (n) => toChineseNumber(n) },
  comma: { label: '千分位', fn: (n) => formatComma(n) },
  currency: { label: '金额', fn: (n, opts = {}) => formatCurrency(n, opts) },
  compact: { label: '紧凑数值', fn: (n) => formatCompact(n) },
  percent: { label: '百分比', fn: (n, d = 0) => (n * 100).toFixed(d) + '%' },
  duration: { label: '时长', fn: (sec) => formatDuration(sec) },
  date: { label: '日期', fn: (t, fmt = 'YYYY-MM-DD') => formatDate(t, fmt) },
  ordinal: { label: '序数', fn: (n) => toOrdinal(n) },
  count: { label: '字数统计', fn: (s) => String(countChars(s)) },
};

export function applyTextFormat(text, fmt, arg) {
  const f = TEXT_FORMATS[fmt];
  if (!f) return text;
  try { return String(f.fn(arg)); } catch { return text; }
}

export function countChars(s) {
  const t = String(s ?? '');
  // 去掉所有空白后按 Unicode 码点计数
  return [...t.replace(/\s/g, '')].length;
}

export function toChineseNumber(n) {
  const v = Math.abs(Math.round(n));
  if (v === 0) return '零';
  const digits = '零一二三四五六七八九';
  const units = ['', '十', '百', '千'];
  const bigs = ['', '万', '亿', '兆'];
  let s = '', gi = 0, zero = false;
  let x = v;
  while (x > 0) {
    const seg = x % 10000;
    if (seg > 0) {
      let part = '', y = seg, ui = 0;
      let segZero = false;
      while (y > 0) {
        const d = y % 10;
        if (d === 0) { segZero = true; }
        else {
          part = digits[d] + units[ui] + (segZero && part ? '零' : '') + part;
          segZero = false;
        }
        y = Math.floor(y / 10); ui++;
      }
      // 十位上的「一十」在口语/字幕里通常写成「十」
      if (gi === 0 && part.startsWith('一十')) part = part.slice(1);
      s = part + bigs[gi] + (s ? (seg < 1000 && gi > 0 ? '零' : '') + s : '');
      zero = false;
    } else if (s && !zero) { s = '零' + s; zero = true; }
    x = Math.floor(x / 10000); gi++;
  }
  return (n < 0 ? '负' : '') + s;
}

export function formatComma(n, d = 0) {
  const v = Number(n) || 0;
  const [i, f] = Math.abs(v).toFixed(d).split('.');
  const s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (v < 0 ? '-' : '') + s + (f ? '.' + f : '');
}

export function formatCurrency(n, opts = {}) {
  const cur = opts.symbol || '¥';
  const d = opts.decimals == null ? 2 : opts.decimals;
  return cur + formatComma(n, d);
}

export function formatCompact(n) {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (a >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  if (a >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(v);
}

export function formatPercent(n, d = 0) {
  return (Number(n) * 100).toFixed(d) + '%';
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${pad2(m % 60)}:${pad2(s % 60)}`;
  }
  return `${m}:${pad2(s % 60)}`;
}

export function formatDate(t, fmt = 'YYYY-MM-DD') {
  const d = t instanceof Date ? t : new Date(t);
  if (isNaN(d.getTime())) return '';
  const map = {
    YYYY: String(d.getFullYear()),
    MM: pad2(d.getMonth() + 1),
    DD: pad2(d.getDate()),
    HH: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
    ss: pad2(d.getSeconds()),
  };
  return fmt.replace(/YYYY|MM|DD|HH|mm|ss/g, (m) => map[m] || m);
}

export function toOrdinal(n) {
  const v = Math.round(n);
  const s = ['th', 'st', 'nd', 'rd'];
  const x = v % 100;
  return v + (s[(x - 20) % 10] || s[x] || s[0]);
}

function pad2(n) { return String(n).padStart(2, '0'); }

/* 单元字号缩放（可做标点压缩） */
function unitScale(style, ch) {
  if (!style.punctCompact) return 1;
  if (/[\s]/.test(ch)) return 1;
  if ('，。！？；：、'.includes(ch)) return 0.85;
  if ('（【《'.includes(ch)) return 0.9;
  if ('）】》'.includes(ch)) return 0.9;
  return 1;
}

/* 量一段文字 */
function measureRun(ctx, text, ls) {
  const chars = Array.from(text);
  const widths = chars.map(c => ctx.measureText(c).width + (ls || 0) * Math.max(0, Array.from(c).length - 1));
  return { chars, widths };
}