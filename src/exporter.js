/* ============================================================
   exporter.js · 导出通道
   ------------------------------------------------------------
   关键原则：导出走与预览**完全相同**的 render()。
   这里只做「把 canvas 换成成片尺寸 → 逐帧求值 → 取像素」。
   ============================================================ */

import { evaluateFrame } from './evaluator.js';
import { render } from './renderer.js';
import { encodeGIF } from './gif.js';
import { createZip } from './zip.js';
import { toText, validate } from './ir.js';

/* 离屏画布：浏览器里优先用 OffscreenCanvas（更快、不占 DOM） */
function offscreen(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/* OffscreenCanvas 用 convertToBlob()，HTMLCanvasElement 用 toBlob()。
   这里统一成一个 Promise<Blob>，并支持取消。 */
export function toBlob(canvas, type = 'image/png') {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 返回空'))), type);
  });
}

function drawFrame(ir, audio, t, canvas, scale = 1, env = {}) {
  const w = Math.round(ir.project.width * scale);
  const h = Math.round(ir.project.height * scale);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const { state } = evaluateFrame(ir, t, audio);
  state.ir = ir;
  state.order = ir.layers.map(l => l.id);
  render(state, ctx, Object.assign({ time: t }, env));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------- 单帧 PNG ---------- */
export async function exportPNG(ir, audio, t, scale = 1) {
  const c = offscreen(
    Math.round(ir.project.width * scale),
    Math.round(ir.project.height * scale),
  );
  drawFrame(ir, audio, t, c, scale, {});
  return toBlob(c, 'image/png');
}

/* ---------- PNG 序列帧（ZIP，带 Alpha） ---------- */
export async function exportFrames(ir, audio, opts, onProgress, shouldCancel) {
  const fps = opts.fps || ir.project.fps;
  const scale = opts.scale || 1;
  const from = Math.floor(opts.from * fps);
  const to = Math.ceil(opts.to * fps);
  const total = Math.max(0, to - from);
  if (!total) throw new Error('帧区间为空');

  const c = offscreen(Math.round(ir.project.width * scale), Math.round(ir.project.height * scale));
  const entries = [];
  const pad = String(total).length;

  for (let f = from; f < to; f++) {
    if (shouldCancel && shouldCancel()) throw new Error('已取消');
    const t = f / fps;
    drawFrame(ir, audio, t, c, scale, {});
    const blob = await toBlob(c, 'image/png');
    const buf = new Uint8Array(await blob.arrayBuffer());
    entries.push({ name: `frames/${opts.name || 'frame'}_${String(f).padStart(pad, '0')}.png`, data: buf });
    if (onProgress) onProgress((f - from + 1) / total, `${f - from + 1}/${total} 帧`);
  }
  entries.push({ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(ir, null, 2)) });
  entries.push({ name: 'blocks.txt', data: new TextEncoder().encode(toText(ir)) });
  entries.push({ name: 'README.txt', data: new TextEncoder().encode(readmeText(ir, fps, total, scale)) });
  return createZip(entries, (p, n) => { if (onProgress) onProgress(0.98, '打包 ' + n); });
}

/* ---------- GIF（自带编码器） ---------- */
export async function exportGIF(ir, audio, opts, onProgress, shouldCancel) {
  // GIF 尺寸上限：宽度 ≤ 800 保证量化质量与体积
  let w = Math.round(ir.project.width * (opts.scale || 1));
  let h = Math.round(ir.project.height * (opts.scale || 1));
  const maxW = 640;
  if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
  w -= w % 2; h -= h % 2;
  if (w < 2) w = 2; if (h < 2) h = 2;

  const fps = opts.fps || 12;
  const from = Math.floor(opts.from * fps);
  const to = Math.ceil(opts.to * fps);
  const total = Math.max(1, to - from);

  const c = offscreen(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const sx = w / ir.project.width, sy = h / ir.project.height;

  const frames = [];
  for (let f = from; f < to; f++) {
    if (shouldCancel && shouldCancel()) throw new Error('已取消');
    const t = f / fps;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    const { state } = evaluateFrame(ir, t, audio);
    state.ir = ir;
    state.order = ir.layers.map(l => l.id);
    render(state, ctx, { time: t });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    frames.push({ rgba: img.data, delay: Math.round(100 / fps) });
    if (onProgress) onProgress((f - from + 1) / total * 0.85, `${f - from + 1}/${total} 帧`);
    if (frames.length % 4 === 0) await new Promise(r => setTimeout(r, 0));
  }
  const blob = encodeGIF(frames, w, h, { loop: 0 });
  if (onProgress) onProgress(1, '编码完成');
  return blob;
}

/* ---------- 工程 JSON / 积木文本 ---------- */
export function exportJSON(ir) {
  const errs = validate(ir);
  if (errs.length) throw new Error('工程校验失败：' + errs.join('；'));
  return new Blob([JSON.stringify(ir, null, 2)], { type: 'application/json' });
}
export function exportBlocksText(ir) {
  return new Blob([toText(ir)], { type: 'text/plain' });
}

function readmeText(ir, fps, total, scale) {
  return [
    `工程：${ir.project.name}`,
    `画布：${ir.project.width}x${ir.project.height}  帧率：${fps}fps  帧数：${total}  缩放：${scale}`,
    '',
    '帧序列由「积木动画工厂」V0 逐帧求值导出。',
    '预览与导出共用同一 render() 实现，因此逐帧一致。',
    '',
    'frame_*.png    带 Alpha 的 PNG 序列帧，可直接导入剪映 / PR / AE',
    'project.json   完整 IR 工程，可重新载入编辑器',
    'blocks.txt     缩进式积木文本，适合版本管理',
    '',
    '音频响度目标：' + ir.project.loudnessTarget + ' LUFS',
  ].join('\n');
}

export { download };
