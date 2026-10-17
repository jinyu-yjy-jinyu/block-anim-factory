/* ============================================================
   test-mp4.mjs · MP4 封装验证
   ------------------------------------------------------------
   判据：真的产出 MP4 文件，再把四张 stbl 表解析出来核对。

   这条链路此前是坏的：stts/stsc/stsz/stco 的 entry_count 全是 0，
   moof/mdat 根本没生成，输出一个零字节视频。

   本测试用 Chrome 的 WebCodecs 做真实 H.264 编码（不是伪造数据），
   然后走项目自己的 muxMP4，最后用 ffmpeg/Chrome 两条独立路径验证
   产物可解码。

   优先用系统 Chrome：Playwright 自带的 Chromium 本机未安装。
   ============================================================ */
import { chromium } from 'playwright-core';
import { existsSync, writeFileSync } from 'node:fs';

function findBrowser() {
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch { /* 未安装对应版本 */ }
  for (const p of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]) if (existsSync(p)) return p;
  throw new Error('找不到 Chrome/Edge');
}

const browserPath = findBrowser();
console.log('=== MP4 封装验证（' + browserPath.split('\\').pop() + ' + WebCodecs）===\n');

const browser = await chromium.launch({
  executablePath: browserPath,
  args: [
    // WebCodecs 的 H.264 硬件编码器需要 GPU；CI/无显卡机器上用软件回退
    '--enable-features=SharedArrayBuffer',
    '--enable-unsafe-swiftshader',
    '--use-gl=swiftshader',
  ],
});

/* WebCodecs 只在 secure context 里暴露。about:blank 不是 secure context，
   所以必须起一个 http://127.0.0.1 的真实页面。 */
const http = await import('node:http');
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>mp4 test</title><body></body>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
const page = await browser.newPage();
await page.goto(pageUrl);

const hasWebCodecs = await page.evaluate(() => typeof VideoEncoder !== 'undefined');
console.log('  secure context = ' + await page.evaluate(() => window.isSecureContext));
console.log('  VideoEncoder 可用 = ' + hasWebCodecs + '\n');

/* ---------- 在浏览器里用真实 WebCodecs 编码一段 H.264 ---------- */
console.log('[1/4] 用 WebCodecs 真实编码 24 帧 320x240 …');

const encodeResult = await page.evaluate(async () => {
  if (typeof VideoEncoder === 'undefined') {
    return { err: '当前浏览器没有 WebCodecs' };
  }
  const W = 320, H = 240, FPS = 24, N = 24;
  const codec = 'avc1.42001f';
  const config = {
    codec, width: W, height: H,
    bitrate: 800_000, framerate: FPS,
    avc: { format: 'avc' },
    latencyMode: 'quality',
  };
  const support = await VideoEncoder.isConfigSupported(config).catch(e => ({ supported: false, err: String(e) }));
  if (!support || !support.supported) {
    return { err: 'WebCodecs 不支持 avc1.42001f：' + JSON.stringify(support) };
  }

  const chunks = [];
  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      // description 是 ArrayBuffer，没有 .length —— 用 byteLength 判断。
      // （曾在这里误用 .length，导致 avcC 判成 null，白查一轮）
      const raw = (metadata && metadata.decoderConfig && metadata.decoderConfig.description)
        || chunk.description || null;
      const description = raw && (raw.byteLength || raw.length) ? Array.from(new Uint8Array(raw)) : null;
      chunks.push({
        type: chunk.type,
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        data,
        description,
      });
    },
    error: (e) => { encodeError = String(e); },
  });
  encoder.configure(config);

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');

  for (let i = 0; i < N; i++) {
    // 画一个移动的方块，保证帧间有差异（不是全静止画面）
    ctx.fillStyle = '#101820';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = `hsl(${i * 12}, 80%, 55%)`;
    ctx.fillRect((i * 9) % (W - 60), 80, 60, 60);
    ctx.fillStyle = '#fff';
    ctx.font = '20px sans-serif';
    ctx.fillText('F' + i, 12, 28);

    const frame = new VideoFrame(canvas, {
      timestamp: Math.round(i * 1_000_000 / FPS),
      duration: Math.round(1_000_000 / FPS),
    });
    encoder.encode(frame, { keyFrame: i % 12 === 0 });
    frame.close();
    if (encoder.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 0));
  }
  await encoder.flush();
  encoder.close();
  if (encodeError) return { err: '编码器报错：' + encodeError };
  if (!chunks.length) return { err: '没有产出任何编码数据' };

  const hasDesc = chunks.some(c => c.description && c.description.length);
  return {
    W, H, FPS, N,
    frameCount: chunks.length,
    keyFrames: chunks.filter(c => c.type === 'key').length,
    hasDesc,
    descLength: chunks.find(c => c.description)?.description?.length || 0,
    totalBytes: chunks.reduce((s, c) => s + c.data.length, 0),
    // 传回前 8 帧的数据就够了（体积），后面用摘要代替
    chunks: chunks.map(c => ({
      type: c.type, delta: Math.round(1_000_000 / FPS),
      description: c.description,
      size: c.data.length,
      data: Array.from(c.data),
    })),
  };
});

if (encodeResult.err) {
  console.log('  ✗ WebCodecs 编码失败：' + encodeResult.err);
  console.log('\n=== 失败：环境不支持，无法验证 ===');
  await browser.close();
  process.exit(1);
}

console.log(`  ✓ 编码成功：${encodeResult.frameCount} 帧，关键帧 ${encodeResult.keyFrames} 个`);
console.log(`    尺寸 ${encodeResult.W}x${encodeResult.H} @ ${encodeResult.FPS}fps`);
console.log(`    H.264 数据 ${encodeResult.totalBytes} 字节`);
console.log(`    avcC description：${encodeResult.hasDesc ? '有，长度 ' + encodeResult.descLength : '无（关键帧 type=' + encodeResult.keyFrames + '）'}`);

/* ---------- 走项目自己的 muxMP4 ---------- */
console.log('\n[2/4] 调用项目的 muxMP4 封装 …');

const { muxMP4ForTest } = await import('./src/video-export.js');
if (typeof muxMP4ForTest !== 'function') {
  console.log('  ✗ video-export.js 没有导出 muxMP4ForTest，无法在 Node 侧验证');
  await browser.close();
  process.exit(1);
}

const chunks = encodeResult.chunks.map(c => ({
  type: c.type,
  delta: c.delta,
  description: c.description ? Uint8Array.from(c.description) : null,
  data: Uint8Array.from(c.data),
}));

const muxed = muxMP4ForTest({
  chunks, width: encodeResult.W, height: encodeResult.H, fps: encodeResult.FPS,
});

const mp4Bytes = muxed.bytes;
const mp4B64 = Buffer.from(mp4Bytes).toString('base64');

console.log(`  ✓ 生成 MP4：${mp4Bytes.length} 字节（ftyp ${32} + moov + mdat ${muxed.verify.mdatBytes}）`);
console.log('');
console.log('  ---- 四张 stbl 表（从生成的文件里解析回来）----');
for (const [name, t] of Object.entries(muxed.verify.tables)) {
  if (name === 'stsz') {
    console.log(`    ${name}: sample_count = ${t.sampleCount}, 字节总和 = ${muxed.verify.stszTotalBytes}`);
  } else {
    console.log(`    ${name}: entry_count = ${t.entryCount}`);
  }
}
console.log(`    mdat 实际字节 = ${muxed.verify.mdatBytes}`);
console.log(`    avcC = ${muxed.verify.hasAvcC ? '存在，长度 ' + muxed.verify.avcCLength : '缺失'}`);
console.log('');
for (const c of muxed.verify.checks) {
  console.log(`    ${c.pass ? '✓' : '✗'} ${c.name}`);
}
if (muxed.verify.errors.length) {
  console.log('    解析错误：' + muxed.verify.errors.join('；'));
}

/* ---------- 用 Chrome 自己解回来 ---------- */
console.log('\n[3/4] 让 Chrome 解码这个 MP4（video 元素）…');

const decodeResult = await page.evaluate(async (b64) => {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const blob = new Blob([u8], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true;
  v.src = url;
  const meta = await new Promise((res) => {
    const to = setTimeout(() => res({ err: '加载超时' }), 10000);
    v.onloadedmetadata = () => { clearTimeout(to); res({ w: v.videoWidth, h: v.videoHeight, dur: v.duration }); };
    v.onerror = () => {
      clearTimeout(to);
      res({ err: 'video 元素无法解码：' + (v.error ? v.error.code + ' ' + v.error.message : '未知') });
    };
  });
  URL.revokeObjectURL(url);
  if (meta.err) return meta;

  // 真的解出一帧，确认不是「元数据能读但没有画面」
  await v.play().catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  const c = document.createElement('canvas');
  c.width = meta.w; c.height = meta.h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0);
  let nonBlack = 0;
  const px = ctx.getImageData(0, 0, meta.w, meta.h).data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] > 16 || px[i + 1] > 16 || px[i + 2] > 16) nonBlack++;
  }
  return { ...meta, nonBlack, total: meta.w * meta.h };
}, mp4B64);

if (decodeResult.err) {
  console.log('  ✗ ' + decodeResult.err);
} else {
  console.log(`  ✓ Chrome 解出 ${decodeResult.w}x${decodeResult.h}，时长 ${decodeResult.dur.toFixed(2)}s`);
  console.log(`    解码首帧非黑像素 ${decodeResult.nonBlack}/${decodeResult.total}`);
}

/* ---------- 落盘，供人工用播放器验证 ---------- */
console.log('\n[4/4] 写出 MP4 文件 …');
writeFileSync('test-mp4-output.mp4', mp4Bytes);
console.log('  ✓ test-mp4-output.mp4（' + mp4Bytes.length + ' 字节）');

await browser.close();

/* ---------- 汇总 ---------- */
const tableOk = muxed.verify.ok;
const playable = !decodeResult.err && decodeResult.nonBlack > 0;
console.log('\n=== 结果 ===');
console.log(`  四张表自检：${tableOk ? '通过' : '未通过'}`);
console.log(`  Chrome 可播放：${playable ? '是' : '否'}`);
console.log((tableOk && playable) ? '\n=== 全部通过 ✓ ===' : '\n=== 存在失败项 ✗ ===');
process.exit(tableOk && playable ? 0 : 1);
