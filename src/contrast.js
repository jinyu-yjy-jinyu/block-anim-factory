/* ============================================================
   contrast.js · 按积木底色计算可读文字色
   ------------------------------------------------------------
   积木底色来自分类色，深浅主题共用同一组颜色。这里不按主题硬编码
   白字，而是用 WCAG 相对亮度选深/浅文字，并在必要时微调面色。
   ============================================================ */

const DARK_INK = '#0f172a';
const WHITE_INK = '#ffffff';
const MIN_TEXT = 4.5;
const MIN_DIM = 3;

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export function parseHex(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function normalizeHex(hex, fallback = '#000000') {
  const p = parseHex(hex) || parseHex(fallback);
  return '#' + [p.r, p.g, p.b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function channelToLinear(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex) {
  const p = parseHex(hex) || parseHex('#000000');
  return 0.2126 * channelToLinear(p.r)
    + 0.7152 * channelToLinear(p.g)
    + 0.0722 * channelToLinear(p.b);
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function mixHex(a, b, t) {
  const pa = parseHex(a) || parseHex('#000000');
  const pb = parseHex(b) || parseHex('#000000');
  const k = clamp01(Number(t) || 0);
  const c = {
    r: Math.round(pa.r + (pb.r - pa.r) * k),
    g: Math.round(pa.g + (pb.g - pa.g) * k),
    b: Math.round(pa.b + (pb.b - pa.b) * k),
  };
  return '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('');
}

export function rgbToHsl({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

export function hslToHex({ h, s, l }) {
  const hue = ((h % 1) + 1) % 1;
  const sat = clamp01(s);
  const light = clamp01(l);
  let r, g, b;
  if (sat === 0) {
    r = g = b = light;
  } else {
    const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
    const p = 2 * light - q;
    const funnel = (t) => {
      let x = t;
      if (x < 0) x += 1;
      if (x > 1) x -= 1;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    r = funnel(hue + 1 / 3);
    g = funnel(hue);
    b = funnel(hue - 1 / 3);
  }
  return '#' + [r, g, b].map(v => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');
}

export function bestTextOn(bg) {
  const face = normalizeHex(bg);
  return contrastRatio(face, DARK_INK) >= contrastRatio(face, WHITE_INK)
    ? DARK_INK
    : WHITE_INK;
}

/* 面色只在不达标时移动，且最多 8 个百分点，保持分类色相可识别。 */
export function readableFace(bg, min = MIN_TEXT) {
  const start = normalizeHex(bg);
  const fg = bestTextOn(start);
  const startRatio = contrastRatio(start, fg);
  if (startRatio >= min) return { face: start, fg, ratio: startRatio, shift: 0 };

  const hsl = rgbToHsl(parseHex(start));
  const step = 0.01;
  const maxSteps = 8;
  let best = { face: start, ratio: startRatio, shift: 0 };
  for (let i = 1; i <= maxSteps; i++) {
    const next = hslToHex({
      h: hsl.h,
      s: hsl.s,
      l: hsl.l + (fg === WHITE_INK ? -i * step : i * step),
    });
    const ratio = contrastRatio(next, fg);
    const shift = Math.abs(rgbToHsl(parseHex(next)).l - hsl.l) * 100;
    if (ratio > best.ratio) best = { face: next, ratio, shift };
    if (ratio >= min) break;
  }
  return { face: best.face, fg, ratio: best.ratio, shift: best.shift };
}

export function withAlpha(hex, alpha) {
  const p = parseHex(hex) || parseHex('#000000');
  const a = Math.round(clamp01(Number(alpha)) * 255).toString(16).padStart(2, '0');
  return normalizeHex(hex) + a;
}

/* 次级文字/图标：fg 以 alpha 叠在 face 上，直到 >= min。 */
export function readableInk(face, fg, min = MIN_DIM, startAlpha = 0.72) {
  const bg = normalizeHex(face);
  let alpha = clamp01(Number(startAlpha));
  for (;;) {
    const color = withAlpha(fg, alpha);
    const ratio = contrastRatio(mixHex(bg, fg, alpha), bg);
    if (ratio >= min || alpha >= 1) return { color, alpha, ratio };
    alpha = Math.min(1, Math.round((alpha + 0.02) * 100) / 100);
  }
}

export function contrastVars(bg) {
  const { face, fg } = readableFace(bg);
  const dim = readableInk(face, fg, MIN_DIM);
  const dot = readableInk(face, fg, 1.5, 0.32);
  return {
    '--bc-face': face,
    '--bc-fg': fg,
    '--bc-dim': dim.color,
    '--bc-dot': dot.color,
    '--bc-shadow': fg === WHITE_INK ? '0 1px 0 rgba(0,0,0,.28)' : 'none',
  };
}

export function applyContrastVars(el, bg) {
  const vars = contrastVars(bg);
  for (const [key, value] of Object.entries(vars)) el.style.setProperty(key, value);
  return vars;
}
