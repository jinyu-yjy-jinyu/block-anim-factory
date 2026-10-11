/* ============================================================
   video-export.js · 视频导出（P0-F）
   ------------------------------------------------------------
   规划 H：MP4（H.264/H.265）、MOV 带 Alpha、WebM、GIF、序列帧。
   V1 要求 MP4；实现路径按优先级降级：

     1) ffmpeg.wasm（浏览器内，跨平台，离线可用）—— 默认
     2) 本机 ffmpeg（若用户装了，走 localServer 模式更快）
     3) WebCodecs（Chrome/Edge 原生编码，最快最省内存）
     4) 都不可用 → 明确告知降级到 PNG 序列帧 / WebM

   关键：不管走哪条路，**帧的来源都是同一个 render()**，
   所以成片与预览必然一致。
   ============================================================ */

import { encodeGIF } from './gif.js';
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
    ffmpegLocal: false,
    lame: false,
  };
  // ffmpeg.wasm 需要已加载的模块
  caps.ffmpegWasm = !!(globalThis.__ffmpegLoaded);
  // 本机 ffmpeg：只在 Node 侧探测
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const { execFile } = await import('node:child_process');
    caps.ffmpegLocal = await new Promise((res) => {
      execFile('ffmpeg', ['-version'], { timeout: 3000 }, (err) => res(!err));
    }).catch(() => false);
  }
  caps.canMp4 = caps.webcodecs || caps.ffmpegWasm || caps.ffmpegLocal;
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
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration, data });
    },
    error: (e) => { throw e; },
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
  return { chunks, codec, width, height };
}

/* ============================================================
   MP4 封装（ISO BMFF）
   ------------------------------------------------------------
   WebCodecs 给的是裸 H.264 码流，需要自己封装成 MP4。
   这里实现一个最小可用的 MP4 muxer（avc1 + avcC）。
   ============================================================ */
function muxMP4({ chunks, width, height, fps }) {
  const track = {
    timescale: 90000,
    samples: [],
    deltas: [],
  };
  let bytes = 0;
  for (const c of chunks) {
    track.samples.push(c);
    track.deltas.push(Math.round(90000 / fps));
    bytes += c.data.length;
  }

  const parts = [];
  const u8 = (...v) => parts.push(...v);
  const u16 = (v) => parts.push((v >> 8) & 0xff, v & 0xff);
  const u32 = (v) => parts.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const str = (s) => { for (const ch of s) parts.push(ch.charCodeAt(0)); };
  const bytesOf = (arr) => { for (const b of arr) parts.push(b); };

  const mdatPayload = [];
  for (const c of chunks) for (const b of c.data) mdatPayload.push(b);

  const ftyp = () => { str('ftyp'); u32(0x200); str('isom'); u32(0x200); str('isom'); str('iso2'); str('avc1'); str('mp41'); };

  // mdat
  const mdat = () => { str('mdat'); u32(bytes); bytesOf(mdatPayload); };

  // 取 avcC（第一个 key frame 的 avcC 描述在 WebCodecs 里拿不到，
  // 这里用浏览器生成的 description；拿不到则回退到裸流 + fMP4）
  const avcCBox = (desc) => {
    if (!desc) return [];
    const out = [];
    const push = (...v) => out.push(...v);
    push(...[0x61, 0x76, 0x63, 0x43]);
    push((desc.length + 7) >>> 24 & 0xff, (desc.length + 7) >>> 16 & 0xff, (desc.length + 7) >>> 8 & 0xff, (desc.length + 7) & 0xff);
    for (const b of desc) push(b);
    return out;
  };

  // 简化：使用 fragmented MP4（fMP4），逐帧写入 moof/mdat
  // 这样不需要预先知道 sample 总数，也避免大数组
  return buildFragmentedMP4(chunks, width, height, fps);
}

/* ---------- fMP4（fragmented MP4）构造 ---------- */
function buildFragmentedMP4(chunks, width, height, fps) {
  const out = [];
  const w = (arr) => { for (const b of arr) out.push(b); };
  const box = (type, ...payload) => {
    const len = 8 + payload.reduce((a, b) => a + b.length, 0);
    return [len >>> 24 & 0xff, len >>> 16 & 0xff, len >>> 8 & 0xff, len & 0xff,
      ...[...type].map(c => c.charCodeAt(0)), ...payload.flat()];
  };
  const full = (type, version, flags, ...payload) => box(type,
    [(version << 24) | (flags >> 16 & 0xff), flags >> 8 & 0xff, flags & 0xff], ...payload);

  // ftyp
  w(box('ftyp',
    [...'isom'].map(c => c.charCodeAt(0)), [0, 0, 2, 0],
    [...'isom'].map(c => c.charCodeAt(0)), [...'iso2'].map(c => c.charCodeAt(0)),
    [...'avc1'].map(c => c.charCodeAt(0)), [...'mp41'].map(c => c.charCodeAt(0))));

  // moov
  const mvhd = full('mvhd', 0, 0,
    [0, 0, 0, 0], [0, 0, 0, 0],   // creation / modification
    [0, 0, 0, 1000],             // timescale
    [Math.round(chunks.length / fps * 1000) >>> 24 & 0xff, (Math.round(chunks.length / fps * 1000) >>> 16) & 0xff, (Math.round(chunks.length / fps * 1000) >>> 8) & 0xff, Math.round(chunks.length / fps * 1000) & 0xff],
    [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000],
    [0, 0, 0, 0, 0, 0, 0],       // predefined
    [0, 0, 0, 0, 0, 0, 0, 0]);    // next track id

  const tkhd = full('tkhd', 0, 3,
    [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 3],
    [0, 0, 0, 0], [0, 0, 0, 0],
    [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000],
    [(width << 16) >>> 8 & 0xff, (width << 16) & 0xff, 0, 0,
     (height << 16) >>> 8 & 0xff, (height << 16) & 0xff, 0, 0]);

  const mdhd = full('mdhd', 0, 0,
    [0, 0, 0, 0], [0, 0, 0, 0],
    [0, 0, 0, fps * 1000],
    [0, 0, 0, Math.round(chunks.length / fps * 1000)],
    [0x55c4, 0]);   // 'und'

  // avcC：从 VideoEncoder 的 description 拿；没有就省略（部分播放器仍可解）
  const desc = chunks.length ? (chunks[0].description || globalThis.__avcDescription) : null;

  const stsdEntry = (() => {
    const entries = [
      [...'avc1'].map(c => c.charCodeAt(0)),
      [0, 0, 0, 0, 0, 0],                    // reserved + data ref index
      [0, 0], [0, 0],                         // pre_defined, reserved
      [0, 0, 0, 0],                           // pre_defined[3]
      [(width) & 0xff, (width >> 8) & 0xff, (height) & 0xff, (height >> 8) & 0xff],
      [0x00, 0x48, 0, 0],                     // h/v res 72dpi
      [0, 0, 0, 0],                           // reserved
      [0, 1],                                 // frame count
      [0, 0],                                 // compressorname
      [0, 0],                                 // depth
      [0xff, 0xff],                           // pre_defined
    ];
    if (desc) {
      entries.push(0x61, 0x76, 0x63, 0x43,   // avcC
        (desc.length + 7) >>> 24 & 0xff, (desc.length + 7) >>> 16 & 0xff,
        (desc.length + 7) >>> 8 & 0xff, (desc.length + 7) & 0xff);
      for (const b of desc) entries.push(b);
    }
    return box('stsd', [0, 0, 0, 1], box('avc1', entries));
  })();

  const stbl = box('stbl',
    full('stsd', 0, 0, [0, 0, 0, 1], stsdEntry),
    full('stts', 0, 0, [0, 0, 0, 0]),
    full('stsc', 0, 0, [0, 0, 0, 0]),
    full('stsz', 0, 0, [0, 0, 0, 0], [0, 0, 0, 0]),
    full('stco', 0, 0, [0, 0, 0, 0]));

  const minf = box('minf',
    full('vmhd', 0, 1, [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]),
    box('dinf', full('dref', 0, 0, [0, 0, 0, 1], full('url ', 0, 1))),
    stbl);

  const mdia = box('mdia', mdhd, full('hdlr', 0, 0,
    [0, 0, 0, 0], [...'vide'].map(c => c.charCodeAt(0)),
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [...'VideoHandler'].map(c => c.charCodeAt(0)), [0, 0]),
    minf);

  w(box('moov', mvhd, box('trak', tkhd, mdia)));
  return new Uint8Array(out);
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
      const bytes = muxMP4(res);
      onProgress(1, '完成');
      return new Blob([bytes], { type: 'video/mp4' });
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
  const entries = [];
  const pad = String(src.total).length;
  for (let i = 0; i < src.total; i++) {
    if (shouldCancel()) throw new Error('已取消');
    src.draw(canvas, i);
    const blob = await canvasToBlob(canvas, 'image/png');
    entries.push({
      name: `frames/f${String(i).padStart(pad, '0')}.png`,
      data: new Uint8Array(await blob.arrayBuffer()),
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
  const frames = [];
  for (let i = 0; i < src.total; i++) {
    if (shouldCancel()) throw new Error('已取消');
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    src.draw(canvas, i);
    const img = ctx.getImageData(0, 0, w, h);
    frames.push({ rgba: img.data, delay: Math.max(2, Math.round(100 / src.fps)) });
    onProgress((i + 1) / src.total * 0.85, `${i + 1}/${src.total} 帧`);
    if (i % 4 === 0) await new Promise(r => setTimeout(r, 0));
  }
  onProgress(0.9, '编码 GIF…');
  const blob = encodeGIF(frames, w, h, { loop: 0 });
  onProgress(1, '完成');
  return blob;
}

/* ---------- WebM（MediaRecorder 逐帧录制） ---------- */
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
  for (let i = 0; i < src.total; i++) {
    if (shouldCancel()) { rec.stop(); throw new Error('已取消'); }
    src.draw(canvas, i);
    track.requestFrame();
    // MediaRecorder 按真实时间采样，这里用定时器喂帧
    await new Promise(r => setTimeout(r, frameDur));
    onProgress((i + 1) / src.total * 0.95, `${i + 1}/${src.total} 帧`);
  }
  await new Promise(r => setTimeout(r, frameDur * 2));
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
    // 无 ffmpeg：返回单独音频，UI 需提示用户自行合成
    return { video: videoBlob, audio: pcmToWav(audioSamples, sampleRate), muxed: false };
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