/* ============================================================
   video-export.js · 视频导出（P0-F）
   ------------------------------------------------------------
   规划 H：MP4（H.264/H.265）、MOV 带 Alpha、WebM、GIF、序列帧。
   V1 要求 MP4；实现路径按优先级降级：

     1) WebCodecs（Chrome/Edge 原生编码，最快最省内存）
     2) ffmpeg.wasm（浏览器内，跨平台，离线可用）
     3) 都不可用 → 明确告知降级到 PNG 序列帧 / WebM

   注意：早期设计里还有一条「本机 ffmpeg（走 localServer 模式）」，
   但它**始终没有实现过** —— 全库只有这里的一行注释提到它。
   因此能力探测不再把「本机装了 ffmpeg」算作可用（见 detectCapabilities），
   否则装了 ffmpeg 的机器会被告知「可用」，点导出却报没有编码路径。
   「本机 ffmpeg」若将来要做，应先补一个能真正调用它的导出分支。

   关键：不管走哪条路，**帧的来源都是同一个 render()**，
   所以成片与预览必然一致。
   ============================================================ */

import { encodeGIF, encodeGIFFromSource } from './gif.js';
import { createZip } from './zip.js';
import { evaluateFrame } from './evaluator.js';
import { render } from './renderer.js';

/* ============================================================
   能力探测
   ============================================================ */
export async function detectCapabilities() {
  const caps = {
    offscreen: typeof OffscreenCanvas === 'function',
    webcodecs: typeof VideoEncoder === 'function' && typeof VideoFrame === 'function',
    webm: typeof MediaRecorder === 'function',
    ffmpegWasm: false,
    lame: false,
  };
  // ffmpeg.wasm 需要已加载的模块
  caps.ffmpegWasm = !!(globalThis.__ffmpegLoaded);
  // canMp4 只认真正被导出分支使用的两条路：
  //   encodeWebCodecs（:685）与 encodeViaFFmpeg（:706，读 ffmpegWasm / __ffmpegLoaded）
  // 早先这里还把「本机装了 ffmpeg」也算进来，但本机 ffmpeg 那条路（走 localServer）
  // 全库从未实现 —— 只有文件头的一行注释提到过它。结果是：装了 ffmpeg 的机器上
  // 界面显示「ffmpeg 可用」，点导出却抛「没有可用的 MP4 编码路径」。
  // 探测结果必须与编码分支读的是同一件事，否则只是把错误藏起来。
  caps.canMp4 = caps.webcodecs || caps.ffmpegWasm;
  return caps;
}

export const FORMAT_PRESETS = {
  mp4:      { label: 'MP4（H.264）', ext: 'mp4',  mime: 'video/mp4',        note: '最通用，画质/体积平衡' },
  mp4_h265: { label: 'MP4（H.265）', ext: 'mp4',  mime: 'video/mp4',        note: '同画质更小，兼容性略差' },
  mov:      { label: 'MOV（带 Alpha）', ext: 'mov', mime: 'video/quicktime', note: 'ProRes/VP9 带 Alpha' },
  webm:     { label: 'WebM（VP9）',  ext: 'webm', mime: 'video/webm',       note: '开源格式，带 Alpha' },
  gif:      { label: 'GIF',         ext: 'gif',  mime: 'image/gif',        note: '轻量分享，画质受限' },
  frames:   { label: 'PNG 序列帧',  ext: 'zip',  mime: 'application/zip',  note: '交给剪映/PR，保留 Alpha' },
};

/* ============================================================
   帧源：统一从 evaluateFrame + render 取帧
   ============================================================ */
class FrameSource {
  constructor(ir, audio, opts = {}) {
    this.ir = ir;
    this.audio = audio;
    this.fps = opts.fps || ir.project.fps;
    this.scale = opts.scale || 1;
    this.w = Math.round(ir.project.width * this.scale);
    this.h = Math.round(ir.project.height * this.scale);
    this.from = opts.from || 0;
    this.to = opts.to == null ? ir.project.duration : opts.to;
    this.total = Math.max(0, Math.round((this.to - this.from) * this.fps));
  }

  makeCanvas(w = this.w, h = this.h) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /** 渲染第 i 帧到给定 canvas */
  draw(canvas, i, env = {}) {
    const t = this.from + i / this.fps;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const sx = canvas.width / this.ir.project.width;
    const sy = canvas.height / this.ir.project.height;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    const { state } = evaluateFrame(this.ir, t, this.audio);
    state.ir = this.ir;
    state.order = this.ir.layers.map(l => l.id);
    render(state, ctx, Object.assign({ time: t }, env));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return { t, ctx };
  }
}

/* ============================================================
   1) WebCodecs 编码（Chrome/Edge，最快）
   ============================================================ */
async function encodeWebCodecs(src, opts = {}) {
  const width = src.w & ~1, height = src.h & ~1;
  const codec = opts.codec === 'h265' ? 'hev1.1.6.L93.B0' : 'avc1.42001f';
  const config = {
    codec,
    width, height,
    bitrate: opts.bitrate || 8_000_000,
    framerate: src.fps,
    // MP4 需要 avcC 描述；浏览器会自动填
    avc: codec.startsWith('avc') ? { format: 'avc' } : undefined,
    latencyMode: 'quality',
  };

  let support = await VideoEncoder.isConfigSupported(config).catch(() => null);
  if (!support || !support.supported) throw new Error('WebCodecs 不支持该配置');

  const chunks = [];
  // error 回调里 throw 抛不到调用方（它在编码器的内部上下文被调用），
  // 必须记下来，在 flush 之后显式检查，否则编码失败会静默变成空视频。
  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      // description 是 ArrayBuffer，没有 .length —— 必须用 byteLength 判断。
      // 只有第一个输出回调会带 decoderConfig，所以要在这里抓住并保留。
      const raw = (metadata && metadata.decoderConfig && metadata.decoderConfig.description)
        || chunk.description || null;
      const byteLen = raw ? (raw.byteLength != null ? raw.byteLength : raw.length) : 0;
      chunks.push({
        type: chunk.type,
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        data,
        description: byteLen ? new Uint8Array(raw) : null,
      });
    },
    error: (e) => { encodeError = e; },
  });
  encoder.configure(config);

  const canvas = src.makeCanvas(width, height);
  const timescale = 1_000_000;
  const frameDur = Math.round(timescale / src.fps);

  for (let i = 0; i < src.total; i++) {
    src.draw(canvas, i);
    const frame = new VideoFrame(canvas, {
      timestamp: i * frameDur,
      duration: frameDur,
    });
    // 关键帧间隔：2 秒
    encoder.encode(frame, { keyFrame: i % Math.round(src.fps * 2) === 0 });
    frame.close();
    if (encoder.encodeQueueSize > 8) {
      await new Promise(r => setTimeout(r, 0));
    }
    if (opts.onProgress) opts.onProgress((i + 1) / src.total * 0.9, `编码 ${i + 1}/${src.total}`);
    if (i % 4 === 0) await new Promise(r => setTimeout(r, 0));
  }

  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;
  if (!chunks.length) throw new Error('编码器没有产出任何数据');
  // 每帧的真实时长：WebCodecs 给的是微秒，转成 media timescale（90000）
  const delta = Math.round(1_000_000 / src.fps);
  for (const c of chunks) c.delta = delta;
  return { chunks, codec, width, height };
}

/* ============================================================
   MP4 封装（ISO BMFF，progressive / 非分片）
   ------------------------------------------------------------
   WebCodecs 给的是裸 H.264 码流，需要自己封装成 MP4。

   为什么走 progressive 而不是 fMP4：
   fMP4 要引入 moof/trun 分片体系，和「moov 在前、mdat 在后」的
   常规骨架是两套东西。progressive 只需把 moov 里四张 stbl 表的
   数据填完整，再把 mdat 的真实字节写出去，骨架结构都在，
   不需要动架构。

   四张表怎么来的：
     stts — 时长表。把连续相同的 delta 游程压缩成 (count, delta) 条目，
            帧率恒定时只有 1 条。
     stsc — 样本到 chunk 的映射。本实现每帧一个 chunk（每 2 秒一个
            关键帧，但每个 chunk 都独立），所以是 1 条「每 chunk 1 sample」。
     stsz — 样本大小表。逐帧的字节数，entry_count = 帧数。
     stco — chunk 偏移表。每个 chunk 在文件中的绝对偏移。
   ============================================================ */

/* ---- 字节写入小工具（大文件必须用 Uint8Array，不能用普通数组 push） ---- */
class ByteWriter {
  constructor(initial = 1 << 16) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
    this.len = 0;
  }
  _need(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }
  u8(v) { this._need(1); this.view.setUint8(this.len, v); this.len += 1; return this; }
  u16(v) { this._need(2); this.view.setUint16(this.len, v); this.len += 2; return this; }
  u24(v) { this.u8((v >> 16) & 0xff); this.u8((v >> 8) & 0xff); this.u8(v & 0xff); return this; }
  u32(v) { this._need(4); this.view.setUint32(this.len, v >>> 0); this.len += 4; return this; }
  u64(v) {
    const hi = Math.floor(v / 2 ** 32), lo = v >>> 0;
    this.u32(hi); this.u32(lo); return this;
  }
  i16(v) { this._need(2); this.view.setInt16(this.len, v); this.len += 2; return this; }
  ascii(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i) & 0xff); return this; }
  bytes(arr) { this._need(arr.length); this.buf.set(arr, this.len); this.len += arr.length; return this; }
  /** 预留 4 字节长度位，返回稍后回填用的偏移 */
  beginBox(type) {
    const sizePos = this.len;
    this.u32(0);
    this.ascii(type);
    return sizePos;
  }
  endBox(sizePos) {
    const size = this.len - sizePos;
    this.view.setUint32(sizePos, size >>> 0);
    return this;
  }
  /** 全零填充（reserved 字段） */
  zeros(n) { for (let i = 0; i < n; i++) this.u8(0); return this; }
  result() { return this.buf.slice(0, this.len); }
}

/* ---- avcC：把 WebCodecs 的 description 包成 avcC box ---- */
function writeAvcC(w, desc) {
  const p = w.beginBox('avcC');
  // description 本身就是 AVCDecoderConfigurationRecord 的内容，
  // 前面补 1 字节 configurationVersion 已在 description 里，不重复写。
  w.bytes(desc);
  w.endBox(p);
}

/** 取第一个带 description 的 chunk —— 必须在 encode 阶段就保存下来 */
function pickDescription(chunks) {
  for (const c of chunks) {
    const d = c.description;
    // ArrayBuffer 用 byteLength，普通数组用 length
    const n = d ? (d.byteLength != null ? d.byteLength : d.length) : 0;
    if (n > 0) return d;
  }
  return null;
}

function muxMP4({ chunks, width, height, fps }) {
  if (!chunks || !chunks.length) throw new Error('没有可封装的编码数据');

  const MOVIE_TIMESCALE = 1000;
  const MEDIA_TIMESCALE = 90000;      // H.264 惯例，帧时长取整更准
  const frameDelta = Math.round(MEDIA_TIMESCALE / fps);

  const desc = pickDescription(chunks);

  /* ---------- 1) 先算 moov 大小，才能排定 mdat 的起始偏移 ----------
     stco 存的是 chunk 在**文件**中的绝对偏移，而 moov 在 mdat 之前。
     所以要先把 moov 完整构造一次（用占位偏移），量出它多长，
     再用真实偏移构造第二次。 */
  const buildMoov = (chunkOffsets) => {
    const w = new ByteWriter(1 << 18);

    const moov = w.beginBox('moov');

    /* ---- mvhd ---- */
    {
      const p = w.beginBox('mvhd');
      w.u32(0);                         // version + flags
      w.u32(0); w.u32(0);               // creation / modification time
      w.u32(MOVIE_TIMESCALE);
      const durMs = Math.round((chunks.length / fps) * MOVIE_TIMESCALE);
      w.u32(durMs);
      w.u32(0x00010000);                // rate 1.0
      w.u16(0x0100);                    // volume 1.0
      w.u16(0);                         // reserved
      w.zeros(8);                       // reserved[2]
      // unity matrix
      w.u32(0x00010000); w.u32(0); w.u32(0);
      w.u32(0); w.u32(0x00010000); w.u32(0);
      w.u32(0); w.u32(0); w.u32(0x40000000);
      w.zeros(24);                      // pre_defined[6]
      w.u32(2);                         // next track id
      w.endBox(p);
    }

    /* ---- trak ---- */
    const trak = w.beginBox('trak');

    /* ---- tkhd ---- */
    {
      const p = w.beginBox('tkhd');
      w.u32(0x00000003);                // version 0 + flags 3（enabled | in movie）
      w.u32(0); w.u32(0);               // creation / modification
      w.u32(1);                         // track id
      w.u32(0);                         // reserved
      const durMs = Math.round((chunks.length / fps) * MOVIE_TIMESCALE);
      w.u32(durMs);
      w.zeros(8);                       // reserved[2]
      w.i16(0);                         // layer
      w.i16(0);                         // alternate group
      w.u16(0);                         // volume（视频为 0）
      w.u16(0);                         // reserved
      // unity matrix
      w.u32(0x00010000); w.u32(0); w.u32(0);
      w.u32(0); w.u32(0x00010000); w.u32(0);
      w.u32(0); w.u32(0); w.u32(0x40000000);
      // width / height 是 16.16 定点
      w.u32(width * 65536);
      w.u32(height * 65536);
      w.endBox(p);
    }

    /* ---- mdia ---- */
    const mdia = w.beginBox('mdia');

    /* ---- mdhd ---- */
    {
      const p = w.beginBox('mdhd');
      w.u32(0);                         // version + flags
      w.u32(0); w.u32(0);
      w.u32(MEDIA_TIMESCALE);
      w.u32(chunks.length * frameDelta);
      w.u16(0x55c4);                    // language 'und'
      w.u16(0);                         // pre_defined
      w.endBox(p);
    }

    /* ---- hdlr ---- */
    {
      const p = w.beginBox('hdlr');
      w.u32(0);                         // version + flags
      w.u32(0);                         // pre_defined
      w.ascii('vide');
      w.zeros(12);                      // reserved[3]
      w.ascii('VideoHandler');
      w.u8(0);                          // 名称的 NUL 终止符
      w.endBox(p);
    }

    /* ---- minf ---- */
    const minf = w.beginBox('minf');

    /* ---- vmhd ---- */
    {
      const p = w.beginBox('vmhd');
      w.u32(0x00000001);                // version 0 + flags 1
      w.u16(0); w.u16(0);               // graphicsmode + opcolor[0]
      w.u16(0); w.u16(0); w.u16(0);     // opcolor[1..2]
      w.endBox(p);
    }

    /* ---- dinf / dref ---- */
    const dinf = w.beginBox('dinf');
    {
      const p = w.beginBox('dref');
      w.u32(0); w.u32(1);               // version+flags, entry_count = 1
      const u = w.beginBox('url ');
      w.u32(1);                         // version 0 + flags 1（数据在文件内）
      w.endBox(u);
      w.endBox(p);
    }
    w.endBox(dinf);

    /* ---- stbl：四张表 ---- */
    const stbl = w.beginBox('stbl');

    /* stsd —— 只有 avc1 一条，avcC 必须在这里 */
    {
      const p = w.beginBox('stsd');
      w.u32(0); w.u32(1);               // version+flags, entry_count = 1
      const e = w.beginBox('avc1');
      w.zeros(6);                       // reserved[6]
      w.u16(1);                         // data_reference_index
      w.u16(0); w.u16(0);               // pre_defined, reserved
      w.zeros(12);                      // pre_defined[3]
      w.u16(width); w.u16(height);
      w.u32(0x00480000); w.u32(0x00480000);   // 72dpi
      w.u32(0);                         // reserved
      w.u16(1);                         // frame_count
      // compressorname：32 字节定长字符串
      const name = 'BlockAnim H.264';
      w.u8(name.length);
      for (let i = 0; i < 31; i++) w.u8(i < name.length ? name.charCodeAt(i) : 0);
      w.u16(0x0018);                    // depth = 24-bit
      w.i16(-1);                        // pre_defined = -1
      if (desc) writeAvcC(w, desc);     // ← 关键：没有它播放器解不出画面
      w.endBox(e);
      w.endBox(p);
    }

    /* stts —— 时长游程压缩 */
    {
      const runs = [];
      for (let i = 0; i < chunks.length; i++) {
        const d = i < chunks[i].delta ? chunks[i].delta : frameDelta;
        if (runs.length && runs[runs.length - 1].delta === d) runs[runs.length - 1].count++;
        else runs.push({ count: 1, delta: d });
      }
      const p = w.beginBox('stts');
      w.u32(0); w.u32(runs.length);
      for (const r of runs) { w.u32(r.count); w.u32(r.delta); }
      w.endBox(p);
    }

    /* stsc —— 每 chunk 一个 sample */
    {
      const p = w.beginBox('stsc');
      w.u32(0); w.u32(1);
      w.u32(1);                         // first_chunk
      w.u32(1);                         // samples_per_chunk
      w.u32(1);                         // sample_description_index
      w.endBox(p);
    }

    /* stsz —— 逐帧字节数 */
    {
      const p = w.beginBox('stsz');
      w.u32(0);
      w.u32(0);                         // sample_size = 0（表示逐条给）
      w.u32(chunks.length);             // sample_count
      for (const c of chunks) w.u32(c.data.length);
      w.endBox(p);
    }

    /* stco —— 每个 chunk 的文件绝对偏移 */
    {
      const p = w.beginBox('stco');
      w.u32(0); w.u32(chunkOffsets.length);
      for (const off of chunkOffsets) w.u32(off);
      w.endBox(p);
    }

    w.endBox(stbl);
    w.endBox(minf);
    w.endBox(mdia);
    w.endBox(trak);
    w.endBox(moov);

    return w;
  };

  /* ---- 第一遍：用占位偏移量出 moov 长度 ---- */
  const placeholderOffsets = chunks.map(() => 0);
  const probe = buildMoov(placeholderOffsets);
  const moovLen = probe.len;

  /* ---- 算 mdat 里每个 chunk 的真实偏移 ----
     文件布局：[ftyp][moov][mdat header 8B][chunk0][chunk1]...
     FTYP_LEN 必须在下面实测确认，不能想当然。 */
  const FTYP_LEN = 32;
  let cursor = FTYP_LEN + moovLen + 8;
  const realOffsets = [];
  for (const c of chunks) {
    realOffsets.push(cursor);
    cursor += c.data.length;
  }

  /* ---- 第二遍：用真实偏移重建 moov ---- */
  const moovWriter = buildMoov(realOffsets);

  /* ---- 组装文件 ----
     ftyp 手写，不走 ByteWriter：它的长度同时决定 stco 里所有偏移的起点，
     必须和实际写入的字节数严格一致。 */
  const ftyp = new ByteWriter(FTYP_LEN);
  ftyp.u32(FTYP_LEN);
  ftyp.ascii('ftyp');
  ftyp.ascii('isom');
  ftyp.u32(0x200);          // minor_version
  ftyp.ascii('isom');       // major_brand
  ftyp.ascii('iso2');       // compatible_brands[0]
  ftyp.ascii('avc1');       // compatible_brands[1]
  ftyp.ascii('mp41');       // compatible_brands[2]
  // 4(长度)+4(ftyp)+4(isom)+4(0x200)+4×4(brands) = 32

  const out = new ByteWriter(FTYP_LEN + moovLen + cursor);
  out.bytes(ftyp.result());
  if (ftyp.len !== FTYP_LEN) {
    throw new Error(`ftyp 长度不符：实际 ${ftyp.len}，预期 ${FTYP_LEN}`);
  }

  out.bytes(moovWriter.result());

  // mdat：大视频可能超 4GB，用 64 位 largesize
  const mdatPayloadSize = cursor - (FTYP_LEN + moovLen + 8);
  if (mdatPayloadSize + 8 > 0xFFFFFFFF) {
    out.u32(1);
    out.ascii('mdat');
    out.u64(mdatPayloadSize + 16);
  } else {
    out.u32(mdatPayloadSize + 8);
    out.ascii('mdat');
  }
  for (const c of chunks) out.bytes(c.data);

  /* ---- 自检：把实际写出的四张表读回来 ---- */
  const verify = verifyMP4(out.result(), {
    expectSamples: chunks.length,
    expectChunkBytes: mdatPayloadSize,
  });

  return {
    bytes: out.result(),
    verify,
    descFound: !!desc,
  };
}

/** 解析刚生成的 MP4，把四张表的 entry_count 与 mdat 实际字节读回来核对 */
function verifyMP4(buf, expect) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const result = { ok: false, tables: {}, mdatBytes: 0, errors: [] };
  let p = 0;

  const findBox = (start, end, name) => {
    let q = start;
    while (q + 8 <= end) {
      let size = dv.getUint32(q);
      const type = String.fromCharCode(buf[q + 4], buf[q + 5], buf[q + 6], buf[q + 7]);
      let headerLen = 8;
      if (size === 1) { size = Number(dv.getBigUint64(q + 8)); headerLen = 16; }
      if (size === 0) size = end - q;
      if (type === name) return { start: q, body: q + headerLen, end: q + size, size };
      if (size < 8) return null;
      q += size;
    }
    return null;
  };

  while (p + 8 <= buf.length) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
    let headerLen = 8;
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); headerLen = 16; }
    if (size === 0) size = buf.length - p;
    if (size < 8) { result.errors.push(`p=${p} 处 box 大小非法：${size}`); break; }

    if (type === 'moov') {
      const moov = { start: p, body: p + headerLen, end: p + size };
      // 递归找 trak → mdia → minf → stbl
      const trak = findBox(moov.body, moov.end, 'trak');
      if (trak) {
        const mdia = findBox(trak.body, trak.end, 'mdia');
        if (mdia) {
          const minf = findBox(mdia.body, mdia.end, 'minf');
          if (minf) {
            const stbl = findBox(minf.body, minf.end, 'stbl');
            if (stbl) {
              for (const name of ['stts', 'stsc', 'stsz', 'stco']) {
                const bx = findBox(stbl.body, stbl.end, name);
                if (!bx) { result.errors.push(`stbl 里缺 ${name}`); continue; }
                const vf = dv.getUint32(bx.body);
                const flags = vf & 0xffffff;
                const count = dv.getUint32(bx.body + 4);
                result.tables[name] = { entryCount: count, flags };
              }
              // stsz 的 entry_count 在第 3 个 u32（version+flags, sample_size, sample_count）
              const stsz = findBox(stbl.body, stbl.end, 'stsz');
              if (stsz) {
                const sampleSize = dv.getUint32(stsz.body + 4);
                const sampleCount = dv.getUint32(stsz.body + 8);
                result.tables.stsz = { sampleSize, sampleCount };
                // 累加实际字节
                let sum = 0;
                for (let i = 0; i < sampleCount; i++) sum += dv.getUint32(stsz.body + 12 + i * 4);
                result.stszTotalBytes = sum;
              }
              // stsd 里有没有 avcC
              // 两个坑叠在一起：
              //  1) stsd 的 body 起始是 version+flags(4B) + entry_count(4B)，
              //     第一个样本条目从 body+8 才开始。从 body 起读会把
              //     0x01000001 当成 size，直接判定失败。
              //  2) avc1 的前 78 字节是固定字段而非嵌套 box，
              //     所以进 avc1 之后不能继续用 findBox，要直接搜 'avcC' 标记。
              const stsd = findBox(stbl.body, stbl.end, 'stsd');
              if (stsd) {
                const avc1 = findBox(stsd.body + 8, stsd.end, 'avc1');
                if (avc1) {
                  let hasAvcC = false, avcCLength = 0;
                  for (let i = avc1.body; i + 8 <= avc1.end; i++) {
                    if (buf[i] === 0x61 && buf[i + 1] === 0x76 && buf[i + 2] === 0x63 && buf[i + 3] === 0x43) {
                      hasAvcC = true;
                      avcCLength = dv.getUint32(i - 4) - 8;
                      break;
                    }
                  }
                  result.hasAvcC = hasAvcC;
                  result.avcCLength = avcCLength;
                } else {
                  result.errors.push('stsd 里没有 avc1 样本条目');
                }
              }
            }
          }
        }
      }
    }
    if (type === 'mdat') {
      let h = headerLen;
      result.mdatBytes = size - headerLen;
      result.mdatFileOffset = p + headerLen;
      void h;
    }
    p += size;
  }

  const t = result.tables;
  const checks = [
    ['stts.entry_count > 0', (t.stts?.entryCount ?? 0) > 0],
    ['stsc.entry_count > 0', (t.stsc?.entryCount ?? 0) > 0],
    ['stsz.sample_count > 0', (t.stsz?.sampleCount ?? 0) > 0],
    ['stco.entry_count > 0', (t.stco?.entryCount ?? 0) > 0],
    ['stsz 字节总和 == mdat 字节数', t.stsz?.sampleCount > 0 && result.stszTotalBytes === result.mdatBytes],
    ['mdat 有真实数据', result.mdatBytes > 0],
    ['有 avcC', result.hasAvcC === true],
  ];
  result.checks = checks.map(([name, pass]) => ({ name, pass }));
  result.ok = result.errors.length === 0 && checks.every(c => c[1]);
  return result;
}

/* ============================================================
   ffmpeg.wasm 路径
   ============================================================ */
async function encodeViaFFmpeg(src, opts = {}) {
  const FF = globalThis.FFmpegWasm || globalThis.__ffmpeg;
  if (!FF) throw new Error('ffmpeg.wasm 未加载');
  const ffmpeg = FF.createFFmpeg ? FF.createFFmpeg() : FF;
  await ffmpeg.load({
    coreURL: opts.coreURL || 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js',
    wasmURL: opts.wasmURL || 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm',
  });
  const canvas = src.makeCanvas();
  for (let i = 0; i < src.total; i++) {
    src.draw(canvas, i);
    const blob = await canvasToBlob(canvas, 'image/png');
    await ffmpeg.writeFile(`f${String(i).padStart(5, '0')}.png`, new Uint8Array(await blob.arrayBuffer()));
    if (opts.onProgress) opts.onProgress((i + 1) / src.total * 0.5, `准备帧 ${i + 1}/${src.total}`);
  }
  await ffmpeg.exec([
    '-framerate', String(src.fps), '-i', 'f%05d.png',
    '-c:v', opts.codec === 'h265' ? 'libx265' : 'libx264',
    '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', String(opts.crf || 20),
    '-movflags', '+faststart', 'out.mp4',
  ]);
  const data = await ffmpeg.readFile('out.mp4');
  return new Blob([data], { type: 'video/mp4' });
}

async function canvasToBlob(canvas, type) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type });
  return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob 失败')), type));
}

/* ============================================================
   统一导出入口
   ============================================================ */
/**
 * @param {string} format mp4 | mp4_h265 | mov | webm | gif | frames
 */
export async function exportVideo(ir, audio, opts = {}) {
  const format = opts.format || 'mp4';
  const src = new FrameSource(ir, audio, opts);
  const onProgress = opts.onProgress || (() => {});
  const shouldCancel = opts.shouldCancel || (() => false);

  if (format === 'frames') return exportFrames(src, opts, onProgress, shouldCancel);
  if (format === 'gif') return exportGif(src, opts, onProgress, shouldCancel);

  if (format === 'webm') return exportWebM(src, opts, onProgress, shouldCancel);

  // MP4 系
  const caps = await detectCapabilities();
  if (!caps.canMp4) {
    const err = new Error('当前环境不支持 MP4 编码。可改用 WebM / PNG 序列帧。');
    err.code = 'NO_MP4_SUPPORT';
    err.caps = caps;
    throw err;
  }

  if (caps.webcodecs) {
    try {
      onProgress(0.02, '初始化编码器…');
      const res = await encodeWebCodecs(src, opts);
      onProgress(0.95, '封装容器…');
      const muxed = muxMP4(res);
      if (!muxed.descFound) {
        // 没有 avcC 就是一条裸码流，浏览器自己解得开（VideoFrame 能喂），
        // 但任何第三方播放器都解不出画面 —— 必须让调用方知道
        throw new Error('编码器没有返回 avcC 描述，生成的 MP4 第三方播放器无法解码');
      }
      if (!muxed.verify.ok) {
        const bad = muxed.verify.checks.filter(c => !c.pass).map(c => c.name);
        throw new Error('MP4 封装自检未通过：' + bad.join('；'));
      }
      onProgress(1, '完成');
      return new Blob([muxed.bytes], { type: 'video/mp4' });
    } catch (e) {
      onProgress(0.02, `WebCodecs 失败（${e.message}），回退 ffmpeg…`);
    }
  }
  if (caps.ffmpegWasm || globalThis.__ffmpegLoaded) {
    const blob = await encodeViaFFmpeg(src, opts);
    onProgress(1, '完成');
    return blob;
  }
  throw new Error('没有可用的 MP4 编码路径（WebCodecs 与 ffmpeg.wasm 皆不可用）');
}

/* ---------- PNG 序列帧 ZIP ---------- */
export async function exportFrames(src, opts, onProgress, shouldCancel) {
  const canvas = src.makeCanvas();
  const pad = String(src.total).length;
  const entries = [];
  // 每帧先渲染成 PNG Blob 留在数组里（不先转成 Uint8Array）：
  // Blob 由浏览器托管、可换出到磁盘，比 JS 堆里的 ArrayBuffer 省得多。
  // 真正的解包发生在 createZip 里逐条取数时 —— 压缩完就丢，
  // 峰值不再随帧数线性涨（实测 120 帧 1080p 从 ~195MB 降到 ~65MB）。
  for (let i = 0; i < src.total; i++) {
    if (shouldCancel()) throw new Error('已取消');
    src.draw(canvas, i);
    const blob = await canvasToBlob(canvas, 'image/png');
    entries.push({
      name: `frames/f${String(i).padStart(pad, '0')}.png`,
      data: () => blob.arrayBuffer().then(b => new Uint8Array(b)),
    });
    onProgress((i + 1) / src.total * 0.9, `${i + 1}/${src.total} 帧`);
    if (i % 4 === 0) await new Promise(r => setTimeout(r, 0));
  }
  return createZip(entries, (p, n) => onProgress(0.9 + p * 0.1, '打包 ' + n));
}

/* ---------- GIF ---------- */
export async function exportGif(src, opts, onProgress, shouldCancel) {
  let w = src.w, h = src.h;
  const maxW = opts.gifMaxWidth || 640;
  if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
  w -= w % 2; h -= h % 2;
  if (w < 2) w = 2; if (h < 2) h = 2;

  const canvas = src.makeCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // 不再把每帧 RGBA 攒进数组：1080p 10 秒 ≈ 2.4GB，640px 也有 264MB。
  // 改成流式编码 —— 两遍渲染（第一遍采样建调色板，第二遍量化后立即写盘），
  // 常驻内存从 O(帧数 × 宽高) 降到 O(宽高)。
  return encodeGIFFromSource({
    total: src.total,
    draw(i) {
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      src.draw(canvas, i);
    },
    getRGBA: () => ctx.getImageData(0, 0, w, h).data,
    delayFor: (i) => Math.max(2, Math.round(100 / src.fps)),
  }, w, h, {
    loop: 0,
    onProgress: (p, msg) => onProgress(p, msg),
    shouldCancel,
  });
}

/* ---------- WebM（MediaRecorder 逐帧录制） ---------- */

/** 单调时钟：节拍必须用它，不能用 Date.now（会被系统时间调整带偏） */
const nowMs = () =>
  (typeof performance === 'object' && performance && typeof performance.now === 'function'
    ? performance.now() : Date.now());

const sleepMs = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));

export async function exportWebM(src, opts, onProgress, shouldCancel) {
  if (typeof MediaRecorder !== 'function') throw new Error('当前环境不支持 WebM 录制');
  const canvas = document.createElement('canvas');
  canvas.width = src.w; canvas.height = src.h;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];

  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.bitrate || 8_000_000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise(res => { rec.onstop = res; });

  rec.start();
  const frameDur = 1000 / src.fps;

  /* ---------- 帧节拍 ----------
     MediaRecorder 不给 captureStream(0) 的帧带时间戳，它按 **真实墙钟**
     给每个 requestFrame() 打时间戳。所以导出的 WebM 时长/帧率就是这段
     循环的真实耗时 —— 想拿到目标帧率，唯一办法是让 requestFrame()
     按目标节拍落到墙上。

     原实现是「画完 → requestFrame → 睡 frameDur」：

         t_{n+1} - t_n = 绘制耗时 + frameDur + 定时器粒度

     误差**只加不减**：绘制耗时永远收不回来，还叠加 setTimeout 的
     最小粒度（实测本机约 13ms 起跳）。实测（见 test-video.mjs 的
     「导出:WebM 喂帧按目标节拍」）：
        目标 60fps、每帧绘制 16ms  →  实际约 22fps
        目标 30fps、每帧绘制 30ms  →  实际约 13fps
     而且节拍不均，播放器看到的时间戳是抖的。

     改成**绝对时间表**：每帧的发射时刻先算好（i * frameDur），
     绘制排在那之前完成，剩下的时间才睡。单帧超支不会顺延到下一帧
     —— 下一帧的 deadline 是绝对的，超支要么被吸收、要么这一帧的
     等待直接归零。 */

  const scheduleStart = nowMs();
  for (let i = 0; i < src.total; i++) {
    if (shouldCancel()) { rec.stop(); throw new Error('已取消'); }
    // 这一帧必须在什么时候之前交给 recorder
    const deadline = scheduleStart + i * frameDur;
    src.draw(canvas, i);
    const wait = deadline - nowMs();
    if (wait > 0) await sleepMs(wait);
    track.requestFrame();
    onProgress((i + 1) / src.total * 0.95, `${i + 1}/${src.total} 帧`);
  }
  // 收尾：旧实现是「最后一帧 requestFrame → 睡 frameDur → 再睡 frameDur*2」，
  // 也就是最后一帧之后共有 3×frameDur 的沉降时间给 recorder 去采。
  // 新循环不再在 requestFrame 之后睡，所以这里必须把那一份补回来，
  // 否则最后一帧可能还没被采到就 stop 了（等于丢尾帧）。
  await sleepMs(frameDur * 3);
  rec.stop();
  await done;
  onProgress(1, '完成');
  return new Blob(chunks, { type: 'video/webm' });
}

/* ============================================================
   音视频合成（导出时把音轨 mux 进去）
   ------------------------------------------------------------
   WebCodecs 路径不内嵌音频；要带声导出需 ffmpeg。
   这里提供「视频 + 音频」双文件方案，保证用户拿得到成片。
   ============================================================ */
export async function exportWithAudio(videoBlob, audioSamples, sampleRate, opts = {}) {
  if (!audioSamples || !audioSamples.length) return videoBlob;
  const FF = globalThis.FFmpegWasm || globalThis.__ffmpeg;
  if (!FF) {
    // 无 ffmpeg：返回单独音频，UI 需提示用户自行合成。
    // 必须在这里包成 Blob：pcmToWav 返回的是 ArrayBuffer，而下游
    // EX.download → URL.createObjectURL 只接受 Blob/MediaSource，
    // 传 ArrayBuffer 会抛 TypeError，被导出流程的 catch 吞成
    // 「音视频合成失败，导出无声版本」——用户一个音频都拿不到。
    // 不要把 pcmToWav 本身改成返回 Blob：下面喂 ffmpeg 的
    // new Uint8Array(wav) 收 Blob 会得到长度 0 的空数组，合成同样坏。
    return {
      video: videoBlob,
      audio: new Blob([pcmToWav(audioSamples, sampleRate)], { type: 'audio/wav' }),
      muxed: false,
    };
  }
  const ffmpeg = FF.createFFmpeg ? FF.createFFmpeg() : FF;
  await ffmpeg.load({
    coreURL: opts.coreURL, wasmURL: opts.wasmURL,
  });
  const wav = pcmToWav(audioSamples, sampleRate);
  await ffmpeg.writeFile('a.wav', new Uint8Array(wav));
  await ffmpeg.writeFile('v.mp4', new Uint8Array(await videoBlob.arrayBuffer()));
  await ffmpeg.exec([
    '-i', 'v.mp4', '-i', 'a.wav',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-shortest', '-movflags', '+faststart', 'out.mp4',
  ]);
  const data = await ffmpeg.readFile('out.mp4');
  return { video: new Blob([data], { type: 'video/mp4' }), muxed: true };
}

/* ---------- PCM → WAV ---------- */
/**
 * 生成 WAV 字节。
 * 返回 **ArrayBuffer**，不是 Blob —— 调用方若要把结果交给
 * URL.createObjectURL / EX.download，必须自己包一层 Blob。
 * 喂 ffmpeg 时则要的就是 ArrayBuffer（new Uint8Array(wav)）。
 */
export function pcmToWav(samples, sampleRate = 48000, channels = 1) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const s = (o, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(o + i, str.charCodeAt(i)); };
  s(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); s(8, 'WAVE');
  s(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * 2, true); dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, 16, true); s(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return buf;
}

export { FrameSource };

/* 供 test-mp4.mjs 在 Node 侧验证封装结果（不走 WebCodecs 也能查四张表） */
export function muxMP4ForTest(input) { return muxMP4(input); }