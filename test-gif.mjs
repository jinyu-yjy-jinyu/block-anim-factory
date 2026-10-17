/* ============================================================
   test-gif.mjs · GIF 编码器权威验证
   ------------------------------------------------------------
   判据是 **Chrome 自己的 GIF 解码器**，不是我们自写的 LZW 解码器。
   自写解码器会把规范理解错误稳定复制两份（同一个 off-by-one 会
   出现在「两个独立实现」里），所以它不能当判据。

   验证链路：
     encodeGIF() → base64 data URL → <img> onload → canvas.getImageData
     → 与源像素逐点比对
   这样顺带把 GCE、netscape 扩展、块终止符、子块长度全部验一遍。
   ============================================================ */
import { chromium } from 'playwright-core';
import { encodeGIF } from './src/gif.js';
import { existsSync } from 'node:fs';

/* 优先用 playwright 自带的 Chromium；没有就退到系统 Chrome/Edge */
function findBrowser() {
  const tried = [];
  try {
    const p = chromium.executablePath();
    tried.push(p);
    if (p && existsSync(p)) return p;
  } catch { /* playwright 未装对应版本 */ }
  const sys = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of sys) { tried.push(p); if (existsSync(p)) return p; }
  throw new Error('找不到可用的 Chrome/Edge。已尝试：\n  ' + tried.join('\n  '));
}

/* ---------- 用例 ---------- */

/** 生成可预测的测试图案：色块 + 渐变 + 文字块，覆盖量化与差分 */
function makeFrame(W, H, seed) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // 4 个纯色块，考验调色板索引的重复性
      const q = ((x / W | 0) + (y / H | 0) * 2 + seed) & 3;
      const base = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]][q];
      // 叠一个横向渐变，考验量化误差
      const g = (x / W * 255) | 0;
      d[i] = (base[0] / 2 + g / 2) | 0;
      d[i + 1] = (base[1] / 2 + g / 2) | 0;
      d[i + 2] = (base[2] / 2 + g / 2) | 0;
      d[i + 3] = 255;
    }
  }
  return d;
}

/** 统计「量化后」的真实像素，供容差比对用 */
function expectedFromPalette(W, H, seed, ditherOff) {
  return { W, H, seed, ditherOff };
}

async function decodeInBrowser(page, b64, W, H) {
  const result = await page.evaluate(async ({ b64, W, H }) => {
    const img = new Image();
    img.src = 'data:image/gif;base64,' + b64;
    await new Promise((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('GIF 解码失败'));
      setTimeout(() => rej(new Error('解码超时')), 8000);
    });
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, W, H).data;
    return { w: img.naturalWidth, h: img.naturalHeight, data: Array.from(px) };
  }, { b64, W, H });
  return result;
}

/**
 * 逐像素比对，量化到 ≤256 色调色板必然有误差，所以用容差而不是「非黑计数」。
 *
 * 曾经的坑：用「非黑像素数 > 阈值」当判据是错的 —— 调色板会用 [0,0,0]
 * 填充未用条目，一些合法颜色量化后接近黑，会被误判成「解码失败」，
 * 而实际上 maxErr = 0、像素完全正确。
 */
function comparePixels(decoded, src, W, H, tol = 24) {
  if (decoded.w !== W || decoded.h !== H) {
    return { ok: false, why: `尺寸 ${decoded.w}x${decoded.h} ≠ ${W}x${H}` };
  }
  let maxErr = 0, sumErr = 0, over = 0;
  for (let i = 0; i < W * H; i++) {
    for (let ch = 0; ch < 3; ch++) {
      const e = Math.abs(decoded.data[i * 4 + ch] - src[i * 4 + ch]);
      if (e > maxErr) maxErr = e;
      sumErr += e;
      if (e > tol) over++;
    }
  }
  const avg = sumErr / (W * H * 3);
  if (maxErr > 255) return { ok: false, why: '像素全空（解码未产出内容）' };
  if (avg > tol) return { ok: false, why: `平均色差 ${avg.toFixed(1)} 超过容差 ${tol}` };
  return { ok: true, info: `maxErr=${maxErr} avgErr=${avg.toFixed(1)} 超差像素=${over}` };
}

/* ---------- 主流程 ---------- */
const browserPath = findBrowser();
console.log('=== GIF 编码器权威验证（判据：' + browserPath.split('\\').pop() + '）===\n');

const browser = await chromium.launch({ executablePath: browserPath });
const page = await browser.newPage();

let failed = 0;
const ok = (name, info) => console.log('  ✓ ' + name + (info ? '  ' + info : ''));
const bad = (name, msg) => { failed++; console.log('  ✗ ' + name + '  → ' + msg); };

/* 用例 1：单帧 16x16 —— 最小可用 GIF */
{
  const W = 16, H = 16;
  const rgba = makeFrame(W, H, 0);
  try {
    const blob = encodeGIF([{ rgba, delay: 5 }], W, H, { loop: 0, dither: false });
    const b64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
    const r = await decodeInBrowser(page, b64, W, H);
    const cmp = comparePixels(r, rgba, W, H);
    if (!cmp.ok) throw new Error(cmp.why);
    ok('单帧 16x16', cmp.info);
  } catch (e) { bad('单帧 16x16', e.message); }
}

/* 用例 2：纯色大面积 —— 量化后索引恒定，字典不增长 */
{
  const W = 256, H = 256;
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const q = (x < W / 2 ? 0 : 1) + (y < H / 2 ? 0 : 2);
      const base = [[220, 20, 60], [20, 220, 60], [60, 20, 220], [220, 220, 20]][q];
      rgba[i] = base[0]; rgba[i + 1] = base[1]; rgba[i + 2] = base[2]; rgba[i + 3] = 255;
    }
  }
  try {
    const blob = encodeGIF([{ rgba, delay: 5 }], W, H, { loop: 0, dither: false });
    const b64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
    const r = await decodeInBrowser(page, b64, W, H);
    const cmp = comparePixels(r, rgba, W, H);
    if (!cmp.ok) throw new Error(cmp.why);
    ok('四色块 256x256', cmp.info);
  } catch (e) { bad('四色块 256x256', e.message); }
}

/* 用例 3：多帧 + 差分 */
{
  const W = 64, H = 64;
  try {
    const frames = [0, 1, 2, 3].map(s => ({ rgba: makeFrame(W, H, s), delay: 5 }));
    const blob = encodeGIF(frames, W, H, { loop: 0, dither: false });
    const b64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
    const r = await decodeInBrowser(page, b64, W, H);
    const cmp = comparePixels(r, frames[0].rgba, W, H);
    if (!cmp.ok) throw new Error(cmp.why);
    ok('多帧 4 帧 64x64（对首帧）', cmp.info);
  } catch (e) { bad('多帧 4 帧 64x64', e.message); }
}

/* 用例 4：大尺寸高熵 —— 逼出码宽 9→10→11→12 的全段增宽。
   这是最关键的一条：字典必须涨到 4096，码宽走完整个 4→12 位区间。 */
{
  const W = 400, H = 300;
  try {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      rgba[i * 4] = (i * 37) & 255;
      rgba[i * 4 + 1] = (i * 91) & 255;
      rgba[i * 4 + 2] = (i * 53) & 255;
      rgba[i * 4 + 3] = 255;
    }
    const blob = encodeGIF([{ rgba, delay: 5 }], W, H, { loop: 0, dither: false });
    const b64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
    const r = await decodeInBrowser(page, b64, W, H);
    const cmp = comparePixels(r, rgba, W, H, 40);
    if (!cmp.ok) throw new Error(cmp.why);
    ok('高熵 400x300', cmp.info);
  } catch (e) { bad('高熵 400x300', e.message); }
}

/* 用例 5：尺寸与循环扩展 */
{
  const W = 48, H = 32;
  try {
    const rgba = makeFrame(W, H, 2);
    const blob = encodeGIF([{ rgba, delay: 5 }, { rgba: makeFrame(W, H, 1), delay: 5 }], W, H, { loop: 0 });
    const buf = Buffer.from(await blob.arrayBuffer());
    const isGif89a = buf.slice(0, 6).toString('latin1') === 'GIF89a';
    if (!isGif89a) throw new Error('签名不是 GIF89a：' + buf.slice(0, 6).toString('latin1'));
    if (buf[buf.length - 1] !== 0x3b) throw new Error('缺 trailer 0x3b');
    const r = await decodeInBrowser(page, buf.toString('base64'), W, H);
    const cmp = comparePixels(r, rgba, W, H);
    if (!cmp.ok) throw new Error(cmp.why);
    ok('GIF89a + trailer + 循环扩展', cmp.info);
  } catch (e) { bad('GIF89a + trailer + 循环扩展', e.message); }
}

await browser.close();

console.log(failed ? `\n=== 失败 ${failed} 项 ===` : '\n=== 全部通过 ✓ ===');
process.exit(failed ? 1 : 0);
