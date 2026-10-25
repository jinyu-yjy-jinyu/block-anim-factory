/* ============================================================
   scripts/golden.mjs · 录制模板的绘制指令
   ------------------------------------------------------------
   用记录型 2D 上下文跑 renderer.render()，把每帧的绘制调用
   （含当时的样式状态）序列化后做 SHA-256。
   不采样真实像素：抗锯齿与字体回退会让像素在不同平台漂移，
   绘制指令则只取决于 IR + 渲染代码，跨平台稳定。
   ============================================================ */

import { createHash } from 'node:crypto';
import { render } from '../src/renderer.js';
import { evaluateFrame } from '../src/evaluator.js';
import { TEMPLATES, defaultAudio } from '../src/templates.js';

const STYLE_KEYS = [
  'fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth', 'font',
  'textAlign', 'textBaseline', 'lineJoin', 'lineCap',
  'shadowColor', 'shadowBlur', 'shadowOffsetY',
];

const round = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 1e6) / 1e6 : v);
const DEFAULT_STYLE = {
  fillStyle: '#000000', strokeStyle: '#000000', globalAlpha: 1, lineWidth: 1,
  font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
  lineJoin: 'miter', lineCap: 'butt', shadowColor: 'rgba(0,0,0,0)', shadowBlur: 0, shadowOffsetY: 0,
};

export function createRecordingContext() {
  const calls = [];
  const stack = [];
  let style = { ...DEFAULT_STYLE };
  let gradientSeq = 0;
  const gradients = new Map();

  const currentStyle = () => {
    const out = {};
    for (const k of STYLE_KEYS) out[k] = round(style[k]);
    return out;
  };
  const rec = (name, args = [], withStyle = false) => {
    const entry = { op: name, args: args.map(round) };
    if (withStyle) entry.style = currentStyle();
    calls.push(entry);
  };
  const ctx = {
    canvas: { width: 1920, height: 1080 },
    save() { stack.push({ ...style }); rec('save'); },
    restore() { if (stack.length) style = stack.pop(); rec('restore'); },
    clearRect(...a) { rec('clearRect', a); },
    fillRect(...a) { rec('fillRect', a, true); },
    strokeRect(...a) { rec('strokeRect', a, true); },
    setLineDash(a) { rec('setLineDash', [Array.from(a || []).map(round)]); },
    translate(...a) { rec('translate', a); },
    rotate(...a) { rec('rotate', a); },
    scale(...a) { rec('scale', a); },
    beginPath() { rec('beginPath'); },
    closePath() { rec('closePath'); },
    rect(...a) { rec('rect', a); },
    arc(...a) { rec('arc', a); },
    arcTo(...a) { rec('arcTo', a); },
    clip(...a) { rec('clip', a); },
    moveTo(...a) { rec('moveTo', a); },
    lineTo(...a) { rec('lineTo', a); },
    fill() { rec('fill', [], true); },
    stroke() { rec('stroke', [], true); },
    fillText(text, ...a) { rec('fillText', [String(text), ...a], true); },
    measureText(text) {
      const size = Number((String(style.font).match(/(\d+(?:\.\d+)?)px/) || [, 10])[1]) || 10;
      const chars = Array.from(String(text));
      return { width: chars.length * size * 0.6 };
    },
    createLinearGradient(...a) {
      const id = ++gradientSeq;
      const stops = [];
      gradients.set(id, stops);
      rec('createLinearGradient', a);
      return {
        __goldenGradient: id,
        addColorStop(pos, color) {
          stops.push([round(pos), String(color)]);
          rec('addColorStop', [id, pos, String(color)]);
        },
      };
    },
    drawImage(img, ...a) {
      rec('drawImage', [String((img && img.src) || 'image'), ...a]);
    },
  };

  for (const k of STYLE_KEYS) {
    Object.defineProperty(ctx, k, {
      get() { return style[k]; },
      set(v) {
        if (v && v.__goldenGradient) {
          const stops = gradients.get(v.__goldenGradient) || [];
          style[k] = `gradient(${v.__goldenGradient})[${stops.map(x => x.join(':')).join('|')}]`;
        } else {
          style[k] = typeof v === 'string' ? v : String(v);
        }
      },
    });
  }

  return { ctx, calls };
}

export function digestCalls(calls) {
  return createHash('sha256').update(JSON.stringify(calls)).digest('hex');
}

export function captureTemplate(template, opts = {}) {
  const ir = template.make();
  const fps = ir.project.fps;
  const total = Math.round(ir.project.duration * fps);
  const audio = defaultAudio(ir);
  const frames = [];
  const callLists = opts.withCalls ? [] : null;
  for (let f = 0; f <= total; f++) {
    const t = f / fps;
    const { state } = evaluateFrame(ir, t, audio);
    state.ir = ir;
    state.order = ir.layers.map(l => l.id);
    const { ctx, calls } = createRecordingContext();
    render(state, ctx, { time: t });
    frames.push(digestCalls(calls));
    if (callLists) callLists.push(calls);
  }
  return { fps, frames: total + 1, digests: frames, callLists };
}

export function captureAll() {
  const out = { version: 1, note: '每个模板逐帧的绘制指令 SHA-256（0..duration 含末帧）', templates: {} };
  for (const tpl of TEMPLATES) out.templates[tpl.key] = captureTemplate(tpl);
  return out;
}
