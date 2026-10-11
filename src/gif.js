/* ============================================================
   gif.js · 自包含 GIF89a 编码器（无任何依赖）
   ------------------------------------------------------------
   V0 原型的导出通道要求离线可用，因此不依赖 ffmpeg.wasm /
   任何 CDN。实现要点：
   · LZW 压缩（中文字幕缩到 640px 内仍可用）
   · 全局调色板 + NeuQuant 量化（对 256 色动画足够）
   · 帧延时（centisecond）→ 可精确控制 fps
   体积较大，所以 UI 上同时提供 PNG 序列帧 ZIP 通道。
   ============================================================ */

/* ---------- CRC16 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c & 0xff;
  }
  return t;
})();
function crc16(buf, start = 0) {
  let c = 0xffff;
  for (let i = start; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c & 0xffff;
}

/* ---------- LZW（GIF 变体：LSB first，初始码宽 minCodeSize+1） ---------- */
function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let next = eoiCode + 1;

  const bits = [];
  const emit = (code) => {
    for (let i = 0; i < codeSize; i++) bits.push((code >> i) & 1);
  };

  let dict = new Map();
  emit(clearCode);

  if (!indices.length) {
    emit(eoiCode);
    return packBits(bits);
  }

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 4096 + k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }

    emit(prefix);
    if (next < 4096) {
      dict.set(key, next);
      next++;
      if (next > (1 << codeSize)) {
        if (codeSize < 12) codeSize++;
        else {
          // 字典满：发 clear 并重置
          emit(clearCode);
          dict = new Map();
          codeSize = minCodeSize + 1;
          next = eoiCode + 1;
        }
      }
    } else {
      emit(clearCode);
      dict = new Map();
      codeSize = minCodeSize + 1;
      next = eoiCode + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoiCode);
  return packBits(bits);
}

function packBits(bits) {
  const bytes = [];
  let cur = 0, n = 0;
  for (const b of bits) {
    cur |= b << n;
    n++;
    if (n === 8) { bytes.push(cur & 0xff); cur = 0; n = 0; }
  }
  if (n > 0) bytes.push(cur & 0xff);
  return bytes;
}

/* ---------- 颜色量化 ---------- */
function buildPalette(samples) {
  // samples: array of [r,g,b]
  const buckets = new Map();
  for (let i = 0; i < samples.length; i++) {
    const r = samples[i][0], g = samples[i][1], b = samples[i][2];
    // 5-5-5 直方图（32768 桶），保留更多层次
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let e = buckets.get(key);
    if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(key, e); }
    e.n++; e.r += r; e.g += g; e.b += b;
  }
  let entries = [...buckets.values()].map(e => ({ n: e.n, r: e.r / e.n, g: e.g / e.n, b: e.b / e.n }));
  entries.sort((a, b) => b.n - a.n);
  const pal = entries.slice(0, 256).map(e => [Math.round(e.r), Math.round(e.g), Math.round(e.b)]);
  while (pal.length < 256) pal.push([0, 0, 0]);
  return pal;
}

/* 查找器：把 (r,g,b) 量化到 5-5-5 后缓存结果，
   避免每个像素都做一次 256 色线性扫描（千万级像素时这是决定性优化） */
function makeMatcher(pal) {
  const cache = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const hit = cache[key];
    if (hit >= 0) return hit;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < pal.length; i++) {
      const p = pal[i];
      const dr = r - p[0], dg = g - p[1], db = b - p[2];
      const d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
      if (d < bestD) { bestD = d; best = i; if (d === 0) break; }
    }
    cache[key] = best;
    return best;
  };
  return nearest;
}

/* 4x4 Bayer 有序抖动矩阵 */
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/* ---------- 帧差分：只重画变化的矩形区域 ---------- */
function diffFrame(prev, cur, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (prev[i] === cur[i]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/* ============================================================
   encodeGIF — 主入口
   frames: [{ rgba: Uint8ClampedArray(w*h*4), delay: cs }]
   w, h, loop, quality
   返回 Blob(GIF)
   ============================================================ */
export function encodeGIF(frames, w, h, opts = {}) {
  const { loop = 0, dither = true } = opts;
  if (!frames || !frames.length) throw new Error('没有可编码的帧');

  // 1) 采样所有帧的像素，统计主色
  const samples = [];
  const step = Math.max(1, Math.round(Math.sqrt((frames.length * w * h) / 40000)));
  for (const f of frames) {
    const d = f.rgba;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        samples.push([d[i], d[i + 1], d[i + 2]]);
      }
    }
  }
  const pal = buildPalette(samples);
  const nearest = makeMatcher(pal);

  // 2) 逐帧量化为调色板索引
  const indexed = frames.map(f => {
    const out = new Uint8Array(w * h);
    const d = f.rgba;
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      if (dither) {
        const x = i % w, y = (i / w) | 0;
        const bayer = BAYER4[y & 3][x & 3];
        const off = (bayer / 16 - 0.5) * 14;
        out[i] = nearest(
          Math.max(0, Math.min(255, d[j] + off)),
          Math.max(0, Math.min(255, d[j + 1] + off)),
          Math.max(0, Math.min(255, d[j + 2] + off)),
        );
      } else {
        out[i] = nearest(d[j], d[j + 1], d[j + 2]);
      }
    }
    return { indices: out };
  });

  // 3) 写 GIF 字节流
  const chunks = [];
  const push = (arr) => { for (let i = 0; i < arr.length; i++) chunks.push(arr[i] & 0xff); };

  // Header "GIF89a"
  push([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  // Logical Screen Descriptor：全局调色板 256 色，色深 8 位
  push([w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff]);
  push([0x80 | ((8 - 1) << 4), 0x00, 0x00]);
  // Global Color Table
  for (const c of pal) push([c[0], c[1], c[2]]);

  // Netscape 循环扩展
  push([0x21, 0xff, 0x0b]);
  push([0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30]);
  push([0x03, 0x01, loop & 0xff, (loop >> 8) & 0xff, 0x00]);

  // 帧
  let prev = null;
  for (let fi = 0; fi < indexed.length; fi++) {
    const fr = indexed[fi];
    const delayCs = Math.max(2, Math.round(frames[fi].delay || 5));

    let minX = 0, minY = 0, fw = w, fh = h;
    if (prev) {
      const d = diffFrame(prev, fr.indices, w, h);
      if (d.maxX < 0) {
        // 与上一帧完全相同：写 1×1 全透明帧维持时序
        writeFrameBlock(push, 0, 0, 1, 1, [0], delayCs, true);
        continue;
      }
      minX = d.minX; minY = d.minY; fw = d.maxX - minX + 1; fh = d.maxY - minY + 1;
    }

    const sub = new Uint8Array(fw * fh);
    for (let y = 0; y < fh; y++) {
      const src = (y + minY) * w + minX;
      sub.set(fr.indices.subarray(src, src + fw), y * fw);
    }
    writeFrameBlock(push, minX, minY, fw, fh, sub, delayCs, false);
    prev = fr.indices;
  }

  // Trailer
  push([0x3b]);
  return new Blob([new Uint8Array(chunks)], { type: 'image/gif' });
}

function writeFrameBlock(push, x, y, w, h, indices, delayCs, transparent) {
  // Graphic Control Extension
  // 结构：0x21 0xF9 <块大小=4> <packed> <delayLo> <delayHi> <透明色索引> 0x00
  // 「块大小=4」意味着其后恰好 4 字节数据，最后跟 1 字节块结束符。
  push([0x21, 0xf9, 0x04]);
  const flags = (transparent ? 0x01 : 0x00) | 0x04;   // bit0 透明标志 | bit2-4 处置方式=1(不处置)
  push([flags]);
  push([delayCs & 0xff, (delayCs >> 8) & 0xff]);       // 延时（1/100 秒）
  push([0x00]);                                         // 透明色索引 = 0
  push([0x00]);                                         // 块结束符

  // Image Descriptor
  push([0x2c]);
  push([x & 0xff, (x >> 8) & 0xff, y & 0xff, (y >> 8) & 0xff]);
  push([w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff]);
  push([0x00]);                                     // 无局部调色板，非隔行

  // LZW 数据（子块，每块 ≤255 字节）
  const minCodeSize = 8;
  push([minCodeSize]);
  const data = lzwEncode(indices, minCodeSize);
  for (let i = 0; i < data.length; i += 255) {
    const len = Math.min(255, data.length - i);
    push([len]);
    for (let j = 0; j < len; j++) push([data[i + j]]);
  }
  push([0x00]); // 块结束
}
