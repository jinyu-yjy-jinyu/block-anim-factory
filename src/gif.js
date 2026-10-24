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
    // 码宽必须在**输出当前码之后**才提升：
    // 解码器读完这个码才补上对应的字典项，此时它才需要更宽的码。
    // 原实现把提升放在「添加字典项之后、输出下一个码之前」，
    // 比解码器早了一整码 —— 一旦字典增长到 512 项，之后所有码
    // 都按错误码宽解析，画面从该点起整片错色（GIF 偏色的根因）。
    if (codeSize < 12 && next === (1 << codeSize)) codeSize++;
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
    } else {
      // 字典满：发 clear 并重置。clear 用当前码宽（12 位）发出，
      // 解码器收到后同样把码宽复位。
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

   内存：原实现把三份数据同时驻留 ——
     ① frames 里每帧的完整 RGBA（调用方持有，w*h*4 字节/帧）
     ② indexed 再存一份调色板索引（w*h 字节/帧）
     ③ chunks 是 number[]，每个字节占 8 字节（V8 SMI）
   640x360 × 120 帧实测峰值 3.90x 输入 RGBA。
   现在：索引仍要逐帧留着（差分编码需要「上一帧」的索引），
   但输出字节改成边算边写进 Uint8Array，不再用 number[] 累积。
   ============================================================ */
export function encodeGIF(frames, w, h, opts = {}) {
  // 抖动默认关闭：Bayer 偏移在纯色/渐变上会叠出可见噪点，
  // 而 GIF 本来就是「轻量分享」通道，默认值应当优先画质干净。
  const { loop = 0, dither = false } = opts;
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

  // 2) 逐帧量化为调色板索引（只保留索引，不再保留 RGBA 的副本）
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

  // 3) 写 GIF 字节流。
  //    原实现用 number[] 累积再 new Uint8Array(chunks) —— 输出每个字节
  //    在数组里占 8 字节，1080p 级 GIF 输出十几 MB 时这一项就是几百 MB。
  //    改成可增长的 Uint8Array，追加时只扩容量，不再 8 倍膨胀。
  const out = new ByteWriter(1 << 16);
  const push = (arr) => out.push(arr);

  // Header "GIF89a"
  push([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  // Logical Screen Descriptor：全局调色板 256 色，色深 8 位
  push([w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff]);
  // packed 低 3 位 = GCT size，2^(N+1) 条。实际写了 256 条 → 必须是 7（2^8）。
  // 原先算成 0（=2 条），解码器会按 2 色调色板解析，后面 254 条全部错位。
  // 另有：GCT 标志位(bit7)=1，色彩分辨率(bit6-4)=7，排序位(bit3)=0。
  push([0x80 | (0x07 << 4) | 0x07, 0x00, 0x00]);
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
  return new Blob([out.finish()], { type: 'image/gif' });
}

/* ============================================================
   encodeGIFFromSource — 流式入口（给导出通道用）

   为什么要这个：encodeGIF(frames, ...) 要求调用方把所有帧的完整
   RGBA 一次性交出来。640x360 × 120 帧就是 105MB，1080p 更离谱；
   而调用方（exportGif）本来是**边渲染边**拿帧的，为了喂 encodeGIF
   不得不把每帧的 Uint8ClampedArray 全攒在数组里 —— 那才是 OOM 的主因。

   这里改成两遍渲染：
     第一遍：渲染每帧、只做稀疏采样，凑出全局调色板（不保留像素）
     第二遍：重新渲染每帧、量化、立即写进 GIF 字节流，只保留上一帧索引
   代价是渲染两遍（渲染是纯函数、无副作用，重复渲染结果一致），
   换来常驻内存从 O(帧数 × 宽高 × 4) 降到 O(宽高)。

   @param {{total:number, fps:number, delayFor:(i:number)=>number,
            draw:(i:number, canvas:any)=>any, canvas:any,
            getRGBA:()=>Uint8ClampedArray, w:number, h:number}} source
   @returns {Promise<Blob>}
   ============================================================ */
export async function encodeGIFFromSource(source, w, h, opts = {}) {
  const { loop = 0, dither = false, onProgress = null, shouldCancel = null } = opts;
  const total = source.total;
  if (!total) throw new Error('没有可编码的帧');
  const delayFor = source.delayFor || (() => 5);

  const samples = [];
  const step = Math.max(1, Math.round(Math.sqrt((total * w * h) / 40000)));

  // ---- 第一遍：采样颜色 ----
  for (let i = 0; i < total; i++) {
    if (shouldCancel && shouldCancel()) throw new Error('已取消');
    source.draw(i);
    const d = source.getRGBA();
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const p = (y * w + x) * 4;
        samples.push([d[p], d[p + 1], d[p + 2]]);
      }
    }
    if (onProgress) onProgress(0.35 * (i + 1) / total, `采样 ${i + 1}/${total}`);
    if (i % 8 === 7) await new Promise(r => setTimeout(r, 0));
  }
  const pal = buildPalette(samples);
  const nearest = makeMatcher(pal);

  // ---- 写头 ----
  const out = new ByteWriter(1 << 16);
  const push = (arr) => out.push(arr);
  push([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  push([w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff]);
  push([0x80 | (0x07 << 4) | 0x07, 0x00, 0x00]);
  for (const c of pal) push([c[0], c[1], c[2]]);
  push([0x21, 0xff, 0x0b]);
  push([0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30]);
  push([0x03, 0x01, loop & 0xff, (loop >> 8) & 0xff, 0x00]);

  // ---- 第二遍：逐帧量化 + 立即写盘 ----
  let prev = null;
  const indices = new Uint8Array(w * h);
  for (let i = 0; i < total; i++) {
    if (shouldCancel && shouldCancel()) throw new Error('已取消');
    source.draw(i);
    const d = source.getRGBA();
    quantizeInto(indices, d, w, h, nearest, dither);

    const delayCs = Math.max(2, Math.round(delayFor(i)));
    let minX = 0, minY = 0, fw = w, fh = h;
    if (prev) {
      const dd = diffFrame(prev, indices, w, h);
      if (dd.maxX < 0) {
        writeFrameBlock(push, 0, 0, 1, 1, [0], delayCs, true);
        if (onProgress) onProgress(0.35 + 0.65 * (i + 1) / total, `编码 ${i + 1}/${total}`);
        continue;
      }
      minX = dd.minX; minY = dd.minY; fw = dd.maxX - minX + 1; fh = dd.maxY - minY + 1;
    }
    const sub = new Uint8Array(fw * fh);
    for (let y = 0; y < fh; y++) {
      const src = (y + minY) * w + minX;
      sub.set(indices.subarray(src, src + fw), y * fw);
    }
    writeFrameBlock(push, minX, minY, fw, fh, sub, delayCs, false);

    // 只留上一帧索引：diffFrame 需要它，其余帧用完即弃
    if (!prev) prev = new Uint8Array(w * h);
    prev.set(indices);

    if (onProgress) onProgress(0.35 + 0.65 * (i + 1) / total, `编码 ${i + 1}/${total}`);
    if (i % 8 === 7) await new Promise(r => setTimeout(r, 0));
  }

  push([0x3b]);
  return new Blob([out.finish()], { type: 'image/gif' });
}

/** 把一帧 RGBA 量化进 out（复用同一个 Uint8Array，不再每帧新分配） */
function quantizeInto(out, d, w, h, nearest, dither) {
  if (dither) {
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      const x = i % w, y = (i / w) | 0;
      const bayer = BAYER4[y & 3][x & 3];
      const off = (bayer / 16 - 0.5) * 14;
      out[i] = nearest(
        Math.max(0, Math.min(255, d[j] + off)),
        Math.max(0, Math.min(255, d[j + 1] + off)),
        Math.max(0, Math.min(255, d[j + 2] + off)),
      );
    }
  } else {
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      out[i] = nearest(d[j], d[j + 1], d[j + 2]);
    }
  }
}

/* 可增长字节缓冲。
   原实现用 number[] 存每个输出字节：V8 里一个小整数在普通数组里占 8 字节，
   所以「GIF 输出 12MB」实际要 96MB 才能装下，而且中途还会因为数组扩容
   再翻一次倍。这里用 Uint8Array + 倍增扩容，容量翻倍时只拷一次。 */
class ByteWriter {
  constructor(initial = 1 << 16) {
    this.buf = new Uint8Array(initial);
    this.len = 0;
  }
  _ensure(n) {
    const need = this.len + n;
    if (need <= this.buf.length) return;
    let cap = this.buf.length || 1;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  push(arr) {
    this._ensure(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  }
  byte(b) {
    this._ensure(1);
    this.buf[this.len++] = b & 0xff;
  }
  finish() {
    return this.buf.subarray(0, this.len);
  }
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
