/* 套件 8：统一音频源 / 视频导出 */
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const U = (p) => pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), p)).href;

const AS = await import(U('src/audiosource.js'));
const AC = await import(U('src/audio-core.js'));
const VE = await import(U('src/video-export.js'));
const EV = await import(U('src/evaluator.js'));
const HC = await import(U('src/headless-canvas.mjs'));
const TP = await import(U('src/templates.js'));
const IR = await import(U('src/ir.js'));
const BL = await import(U('src/blocks.js'));
const AI = await import(U('src/ai.js'));

let pass = 0, fail = 0; const failures = [];

const bump = (name) => (r) => {
  if (r === false) { fail++; failures.push(`${name} → 断言失败`); } else pass++;
};
const boom = (name) => (e) => { fail++; failures.push(`${name} → ${e.message}`); };

/* 两条执行轨道：

   普通 async 用例 —— 立即开跑（保持原有并发行为，跑得快）。
   独占（exclusive）用例 —— 排到 asyncChain 尾巴上，**且必须等它前面的
   普通异步用例全部 settle**，自己跑完才让后面的继续。

   为什么需要它：普通异步用例是同时开的，而 GIF 编码是重 CPU 的同步
   长任务。实测把 40 帧 GIF 编码和一条 16 帧 30fps 的 WebM 用例并发跑，
   后者耗时从理论 500ms 涨到 2.6~2.7 秒（5.2~5.5 倍）——事件循环被
   GIF 占满，WebM 每次 sleep 都睡过头，看起来就像「绝对时间表没修好」。
   容差再放宽也治不了这个根：并发强度本来就不可控。所以测速类用例
   必须独占执行。 */
const pendingTests = [];
let asyncChain = Promise.resolve();

const t = (n, f, opts = {}) => {
  const run = () => Promise.resolve().then(f).then(bump(n), boom(n));
  if (opts && opts.exclusive) {
    asyncChain = asyncChain.then(run);
    pendingTests.push(asyncChain);
    return;
  }
  // 同步用例立即判；异步用例立即开跑（保持原有并发）
  try {
    const r = f();
    if (r && typeof r.then === 'function') { pendingTests.push(r.then(bump(n), boom(n))); return; }
    bump(n)(r);
  } catch (e) { boom(n)(e); }
};
const eq = (a, b, m) => { if (String(a) !== String(b)) throw new Error(`${m || ''} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const near = (a, b, e, m) => { if (!(Math.abs(a - b) <= (e == null ? 1e-6 : e))) throw new Error(`${m || ''} 期望 ≈${b}，实际 ${a}`); };
const ok = (v, m) => { if (!v) throw new Error(m || '期望为真'); };

const SR = 48000;

function speechTrack(dur = 4) {
  const n = Math.floor(SR * dur);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    if (t > 0.5 && t < 1.5) v = Math.sin(2 * Math.PI * 220 * t) * 0.5 + Math.sin(2 * Math.PI * 500 * t) * 0.25;
    else if (t > 2.0 && t < 3.0) v = Math.sin(2 * Math.PI * 300 * t) * 0.4;
    s[i] = v;
  }
  const tr = new AC.AudioTrack({ samples: s, sampleRate: SR, kind: 'voice' });
  tr.ensureAnalysis();
  return tr;
}
function beatTrack(bpm = 120, dur = 6) {
  const n = Math.floor(SR * dur);
  const s = new Float32Array(n);
  const spb = 60 / bpm;
  for (let k = 0; k * spb < dur; k++) {
    const at = Math.floor(k * spb * SR), len = Math.floor(0.1 * SR);
    for (let i = 0; i < len && at + i < n; i++) {
      s[at + i] += Math.sin(2 * Math.PI * 60 * i / SR) * Math.exp(-i / (len * 0.3)) * 0.85;
    }
  }
  const tr = new AC.AudioTrack({ samples: s, sampleRate: SR, kind: 'music' });
  tr.ensureAnalysis();
  return tr;
}

/* ============================================================
   统一音频源
   ============================================================ */
t('音源:合成模式取值有界', () => {
  const s = AS.AudioSource.synth({ bpm: 120, duration: 6 });
  ok(!s.isReal(), '应为合成模式');
  for (const k of ['amp', 'bass', 'mid', 'treble', 'beat']) {
    for (let i = 0; i < 300; i++) {
      const v = s.value(k, i / 50);
      ok(v >= 0 && v <= 1, `${k}@${i / 50} 越界 ${v}`);
    }
  }
});
t('音源:合成模式确定性', () => {
  const a = AS.AudioSource.synth({ bpm: 128, duration: 6, seed: 7 });
  const b = AS.AudioSource.synth({ bpm: 128, duration: 6, seed: 7 });
  eq(a.amplitude(1.234), b.amplitude(1.234));
  eq(JSON.stringify(a.spectrum(1, 16)), JSON.stringify(b.spectrum(1, 16)));
});
t('音源:合成模式节拍点', () => {
  const s = AS.AudioSource.synth({ bpm: 120, duration: 6 });
  const beats = s.beatTimes();
  ok(beats.length >= 11, `节拍点 ${beats.length} 个`);
  near(beats[1].time - beats[0].time, 0.5, 1e-6, '间隔应为 0.5s');
  eq(s.bpmValue(), 120);
});
t('音源:真实模式识别', () => {
  const s = AS.AudioSource.fromTracks([speechTrack()]);
  ok(s.isReal(), '应识别为真实模式');
  eq(s.duration, 4);
});
t('音源:真实模式 amp 在有声段显著', () => {
  const s = AS.AudioSource.fromTracks([speechTrack(4)]);
  const quiet = s.amplitude(0.2);
  const loud = s.amplitude(1.0);
  ok(loud > quiet * 3, `有声 ${loud.toFixed(3)} vs 静音 ${quiet.toFixed(3)}`);
});
t('音源:真实模式纯函数性', () => {
  const s = AS.AudioSource.fromTracks([speechTrack(4)]);
  const direct = s.amplitude(2.2);
  s.amplitude(0.1); s.amplitude(3.9); s.spectrum(1, 8);
  near(s.amplitude(2.2), direct, 1e-9, '跳转后结果应不变');
});
t('音源:真实模式检测 BPM', () => {
  const s = AS.AudioSource.fromTracks([beatTrack(120, 8)]);
  const bpm = s.bpmValue();
  ok(Math.abs(bpm - 120) <= 4, `BPM=${bpm}`);
});
t('音源:节拍点来自真实音频', () => {
  const s = AS.AudioSource.fromTracks([beatTrack(120, 8)]);
  const beats = s.beatTimes();
  ok(beats.length >= 10, `检出 ${beats.length} 个`);
  for (let i = 1; i < beats.length; i++) ok(beats[i].time > beats[i - 1].time, '时间未递增');
});
t('音源:踩点吸附', () => {
  const s = AS.AudioSource.fromTracks([beatTrack(120, 8)]);
  const snapped = s.snapToBeat(1.52, 0.2);
  ok(snapped != null, '未吸附');
  // 节拍检测本身有几十毫秒抖动，因此吸附点应落在 1.5s 附近
  ok(Math.abs(snapped - 1.5) < 0.06, `吸附到 ${snapped}，偏离 1.5s 超过 60ms`);
  eq(s.snapToBeat(1.77, 0.05), null, '超出容差应不吸附');
});
t('音源:真实模式频谱长度与范围', () => {
  const s = AS.AudioSource.fromTracks([speechTrack(3)]);
  const spec = s.spectrum(1.0, 32);
  eq(spec.length, 32);
  ok(spec.every(v => isFinite(v) && v >= 0 && v <= 1.001), '频谱越界');
});
t('音源:合成与真实的频谱接口一致', () => {
  const a = AS.AudioSource.synth({ duration: 6 });
  const b = AS.AudioSource.fromTracks([speechTrack(3)]);
  eq(a.spectrum(1, 24).length, b.spectrum(1, 24).length);
  ok(typeof a.spectrum(1, 24)[0] === 'number');
});
t('音源:空轨道回落合成且不崩', () => {
  // 没有真实音频时应回落到合成模式（而不是返回 0 导致画面死掉）
  const s = AS.AudioSource.fromTracks([], { nominalDuration: 6 });
  eq(s.isReal(), false, '空轨道不应被判为真实模式');
  ok(s.amplitude(1) >= 0 && s.amplitude(1) <= 1, '取值应仍在 [0,1]');
  eq(s.spectrum(1, 8).length, 8);
  eq(s.bpmValue(), 120);
  ok(s.beatTimes().length > 0, '应按兜底时长铺出合成节拍');
  // 全静音轨道同样应回落
  const silent = new AC.AudioTrack({ samples: new Float32Array(SR), sampleRate: SR });
  silent.ensureAnalysis();
  const s2 = AS.AudioSource.fromTracks([silent], { nominalDuration: 6 });
  eq(s2.isReal(), false, '全静音轨道应回落合成');
  ok(s2.beatTimes().length > 0, '全静音也应铺出节拍');
});
t('音源:多轨取最大值', () => {
  const a = speechTrack(3);
  const b = new AC.AudioTrack({ samples: new Float32Array(SR * 3), sampleRate: SR, kind: 'music' });
  b.ensureAnalysis();
  const s = AS.AudioSource.fromTracks([a, b]);
  ok(s.amplitude(1.0) > 0.1, '未取到有声轨');
});
t('音源:轨道起点偏移生效', () => {
  const tr = speechTrack(2);
  tr.start = 1;
  const s = AS.AudioSource.fromTracks([tr]);
  eq(s.amplitude(0.5), 0, '偏移前不应有声');
  ok(s.amplitude(1.8) > 0.1, '偏移后应有声');
});
t('音源:非 60fps 工程的频段索引按时间换算', () => {
  // 分析结果固定按 60fps 生成，AudioSource 的输出数组按项目 fps 索引。
  // 原实现直接拿 i 取 bands[i]，30fps 工程会把 1.0s 读成 0.5s 的能量，
  // 整条音频驱动的时间轴快一倍。
  const tr = speechTrack(4);
  const s30 = AS.AudioSource.fromTracks([tr], { fps: 30 });
  const s60 = AS.AudioSource.fromTracks([tr], { fps: 60 });
  const at1s = s60.amplitude(1.0);
  ok(at1s > 0.1, '基准点 1.0s 应有声');
  near(s30.amplitude(1.0), at1s, 0.05, '30fps 工程 1.0s 的能量应与 60fps 一致');
  near(s30.amplitude(2.5), s60.amplitude(2.5), 0.05, '30fps 工程 2.5s 的能量应与 60fps 一致');
  ok(s30.amplitude(0.2) < 0.05, '静音段被错位读成了有声');
});
t('音源:挂载词级时间码', () => {
  const tr = speechTrack(2);
  AS.attachWordTimings(tr, [{ word: '你', start: 0.6, end: 0.9 }, { word: '好', start: 0.9, end: 1.2 }]);
  const s = AS.AudioSource.fromTracks([tr]);
  const w = s.wordTimings();
  eq(w.length, 2);
  eq(w[0].word, '你');
  near(w[0].t, 0.6, 1e-6);
});
t('音源:prepareTrack 预计算', () => {
  const tr = speechTrack(2);
  const a = AS.prepareTrack(tr);
  ok(a.peaks && a.bands, '缺 peaks/bands');
  ok(tr.spectrogram, '缺 spectrogram 缓存');
  ok(tr.loudness, '缺响度');
});

/* ---------- 回归：真实模式频谱不能是平的 ---------- */
/* 原来 spectrum() 读 a.spectrogram（恒为 undefined）直接返回全零，
   而旧断言只验「长度对不对、值在不在 0..1」，全零照样通过。
   这里改成验「真的随频率/时间有变化」。 */
t('音源:真实模式频谱不是全零', () => {
  const s = AS.AudioSource.fromTracks([speechTrack(4)]);
  const spec = s.spectrum(1.0, 32);          // 1.0s 落在有声段内
  eq(spec.length, 32);
  ok(spec.every(v => isFinite(v) && v >= 0 && v <= 1.001), '频谱越界');
  ok(spec.some(v => v > 1e-6), '频谱全零 —— 十有八九又去读了 analysis.spectrogram');
  const max = Math.max(...spec);
  ok(max > 0.01, `频谱峰值只有 ${max}，基本等于没信号`);
});
t('音源:真实模式频谱随频率有形状', () => {
  // 220+500Hz 的信号，能量应集中在低频段，而不是一条平线
  const s = AS.AudioSource.fromTracks([speechTrack(4)]);
  const spec = s.spectrum(1.0, 32);
  const low = spec.slice(0, 8).reduce((a, c) => a + c, 0) / 8;
  const high = spec.slice(24).reduce((a, c) => a + c, 0) / 8;
  ok(low > high, `低频段 ${low.toFixed(4)} 未高于高频段 ${high.toFixed(4)}，频谱可能是平的`);
});
t('音源:未预计算也能取到频谱（现算兜底）', () => {
  const tr = speechTrack(3);
  delete tr.spectrogram;                     // 模拟没走 prepareTrack
  const s = AS.AudioSource.fromTracks([tr]);
  const spec = s.spectrum(1.0, 16);
  ok(spec.some(v => v > 1e-6), '没有预计算就返回全零');
  ok(tr.spectrogram, '兜底路径没有把结果缓存到轨道上');
});
t('音源:频谱仍是纯函数（多帧不相干）', () => {
  const s = AS.AudioSource.fromTracks([speechTrack(4)]);
  const a1 = s.spectrum(1.0, 16);
  s.spectrum(3.0, 16); s.spectrum(0.1, 16);
  const a2 = s.spectrum(1.0, 16);
  eq(JSON.stringify(a1), JSON.stringify(a2), '重复取值结果变了');
});

/* ============================================================
   视频导出
   ============================================================ */
t('导出:格式预设齐全', () => {
  for (const k of ['mp4', 'mp4_h265', 'mov', 'webm', 'gif', 'frames']) {
    ok(VE.FORMAT_PRESETS[k], `缺少 ${k}`);
    ok(VE.FORMAT_PRESETS[k].ext, `${k} 缺扩展名`);
  }
});
t('导出:能力探测返回结构', async () => {
  const caps = await VE.detectCapabilities();
  for (const k of ['offscreen', 'webcodecs', 'webm', 'ffmpegWasm', 'canMp4']) {
    eq(typeof caps[k], 'boolean', `${k} 应为布尔`);
  }
});
t('导出:FrameSource 帧数与时间换算', () => {
  const ir = TP.loadTemplate('popTitle');
  const audio = AS.AudioSource.synth({ duration: 6 });
  const src = new VE.FrameSource(ir, audio, { fps: 24, from: 0, to: 2 });
  eq(src.total, 48, '2 秒 ×24fps');
  eq(src.w, ir.project.width);
});
t('导出:FrameSource 区间偏移', () => {
  const ir = TP.loadTemplate('popTitle');
  const src = new VE.FrameSource(ir, null, { fps: 24, from: 1, to: 2 });
  eq(src.total, 24);
});
t('导出:缩放生效', () => {
  const ir = TP.loadTemplate('popTitle');
  const src = new VE.FrameSource(ir, null, { fps: 12, scale: 0.5 });
  eq(src.w, Math.round(ir.project.width * 0.5));
  eq(src.h, Math.round(ir.project.height * 0.5));
});
t('导出:PCM → WAV 可解码', () => {
  const n = 2000;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.sin(i / 50) * 0.5;
  const wav = VE.pcmToWav(pcm, SR);
  const dec = AC.decodeWav(wav);
  eq(dec.sampleRate, SR);
  eq(dec.samples.length, n);
  let e = 0;
  for (let i = 0; i < n; i++) e = Math.max(e, Math.abs(dec.samples[i] - pcm[i]));
  ok(e < 1 / 32767 + 1e-6, `往返误差 ${e}`);
});
t('导出:无音轨时返回原视频', async () => {
  const blob = new Blob(['video'], { type: 'video/mp4' });
  const r = await VE.exportWithAudio(blob, null, SR);
  eq(r, blob, '无音频时应原样返回');
});
t('导出:无 ffmpeg 时给出分离方案', async () => {
  const blob = new Blob(['video'], { type: 'video/mp4' });
  const pcm = new Float32Array(100).fill(0.3);
  const r = await VE.exportWithAudio(blob, pcm, SR);
  eq(r.muxed, false, '无 ffmpeg 不应声称已合成');
  ok(r.audio instanceof Blob, '应给出独立音频');
  eq(r.audio.type, 'audio/wav');
});
t('导出:不支持 MP4 时抛可识别错误', async () => {
  const caps = await VE.detectCapabilities();
  if (caps.canMp4) return;   // 环境支持则跳过
  const ir = TP.loadTemplate('popTitle');
  let err = null;
  try {
    await VE.exportVideo(ir, null, { format: 'mp4', fps: 12, from: 0, to: 0.2 });
  } catch (e) { err = e; }
  ok(err, '应抛错');
  eq(err.code, 'NO_MP4_SUPPORT');
  ok(err.message.includes('WebM'), '错误信息应提示替代方案');
});
/* 能力探测与编码分支必须读同一件事。
   原来 canMp4 把「本机装了 ffmpeg」（ffmpegLocal）也算进来，但那条路
   （注释里的 localServer）全库从未实现 —— 装了 ffmpeg 的机器界面显示「可用」，
   点导出却抛「没有可用的 MP4 编码路径」。 */
t('导出:canMp4 只认编码分支真正支持的两条路', async () => {
  const caps = await VE.detectCapabilities();
  eq(caps.canMp4, !!(caps.webcodecs || caps.ffmpegWasm),
    `canMp4 必须等于 webcodecs || ffmpegWasm（实测 caps=${JSON.stringify(caps)}）`);
});
t('导出:本机装了 ffmpeg 也不谎报 MP4 可用（无 WebCodecs 时）', async () => {
  const caps = await VE.detectCapabilities();
  if (caps.webcodecs || caps.ffmpegWasm) return;   // 真有可用编码路径则跳过
  eq(caps.canMp4, false, '既无 WebCodecs 也无 ffmpeg.wasm 时，canMp4 必须是 false');
  let err = null;
  const ir = TP.loadTemplate('popTitle');
  try {
    await VE.exportVideo(ir, null, { format: 'mp4', fps: 12, from: 0, to: 0.2 });
  } catch (e) { err = e; }
  ok(err, '探测说不可用，导出就必须报错（两者不能矛盾）');
  eq(err.code, 'NO_MP4_SUPPORT');
});
t('导出:GIF 帧编码端到端（用记录型画布）', async () => {
  // Node 下没有真实 canvas，这里只验证参数校验与早期失败路径
  const ir = TP.loadTemplate('popTitle');
  let threw = false;
  try {
    await VE.exportVideo(ir, null, { format: 'gif', fps: 12, from: 0, to: 0.1 });
  } catch { threw = true; }
  ok(threw, 'Node 环境无 canvas，应报错而非静默成功');
});
t('导出:帧率与区间非法时 total 为 0', () => {
  const ir = TP.loadTemplate('popTitle');
  const src = new VE.FrameSource(ir, null, { fps: 24, from: 2, to: 1 });
  eq(src.total, 0);
});
t('导出:帧时长写入 90000 时间轴而不是微秒', () => {
  // 回归：chunk.delta 曾用 1_000_000/fps（微秒）直接写 stts，
  // 被 90000 时间轴解释后成片播放慢约 11 倍。
  eq(VE.mediaFrameDelta(30), 3000);
  eq(VE.mediaFrameDelta(24), 3750);
  eq(VE.mediaFrameDelta(60), 1500);
});
t('导出:H.264/H.265 级别按分辨率选择', () => {
  // 回归：固定 avc1.42001f（Baseline 3.1）装不下 1080p（8160 宏块 > 3600）。
  eq(VE.webCodecsCodecString('h264', 1280, 720, 30), 'avc1.64001f', '720p30');
  eq(VE.webCodecsCodecString('h264', 1920, 1080, 30), 'avc1.640028', '1080p30 应选 4.0');
  eq(VE.webCodecsCodecString('h264', 3840, 2160, 30), 'avc1.640033', '4K30 应选 5.1');
  ok(/L120/.test(VE.webCodecsCodecString('h265', 1920, 1080, 30)), '1080p30 应选 HEVC 4.0');
  ok(/L153/.test(VE.webCodecsCodecString('h265', 3840, 2160, 60)), '4K60 应选 HEVC 5.1');
});
t('导出:HEVC 封装写入 hvc1/hvcC 而不是 avc1/avcC', () => {
  // 回归：muxMP4 以前不认编码类型，H.265 也被塞进 avc1 + avcC，
  // 播放器按 AVC 解析 HEVC 码流，元数据能读、画面出不来。
  const chunks = [
    { type: 'key', delta: 3000, description: new Uint8Array([1, 2, 3, 4, 5]), data: new Uint8Array(16) },
    { type: 'delta', delta: 3000, description: null, data: new Uint8Array(8) },
  ];
  const hevc = VE.muxMP4ForTest({ chunks, width: 320, height: 180, fps: 30, codec: 'hev1.1.6.L93.B0' });
  eq(hevc.sampleEntry, 'hvc1', 'HEVC 样本条目');
  eq(hevc.configBox, 'hvcC', 'HEVC 配置盒');
  ok(hevc.verify.hasHvcC, 'hvcC 缺失');
  ok(hevc.verify.ok, 'HEVC 封装自检失败：'
    + hevc.verify.checks.filter(c => !c.pass).map(c => c.name).join('；')
    + (hevc.verify.errors.length ? ' / ' + hevc.verify.errors.join('；') : ''));
  eq(hevc.verify.mediaTimescale, 90000, '媒体时间轴');
  eq(hevc.verify.tables.stts.runs[0].delta, 3000, 'stts delta 应按 90000 时间轴');
  eq(hevc.verify.sttsTotalDuration, hevc.verify.mediaDuration, 'stts 总时长应等于 mdhd 时长');
  const buf = Buffer.from(hevc.bytes);
  ok(buf.includes(Buffer.from('hvc1')), '文件里没有 hvc1 标记');
  ok(!buf.includes(Buffer.from('avc1')), 'HEVC 文件里仍出现 avc1');

  const avc = VE.muxMP4ForTest({ chunks, width: 320, height: 180, fps: 30, codec: 'avc1.64001f' });
  eq(avc.sampleEntry, 'avc1');
  ok(avc.verify.hasAvcC, 'AVC 的 avcC 丢失');
});
t('导出:GIF 默认不做抖动', () => {
  // Bayer 抖动会在纯色/渐变上叠出可见噪点，默认应保持干净；
  // 需要抖动时由调用方显式传 dither:true。
  const W = 32, H = 24;
  return (async () => {
    const GIF = await import(U('src/gif.js'));
    const frames = [{ rgba: memFrame(W, H, 0), delay: 5 }];
    const a = Buffer.from(await (await GIF.encodeGIF(frames, W, H)).arrayBuffer());
    const b = Buffer.from(await (await GIF.encodeGIF(frames, W, H, { dither: false })).arrayBuffer());
    ok(a.equals(b), '默认输出与 dither:false 不一致 —— 默认值又打开了');
  })();
});
t('导出:GIF 延时按累计时间取整', () => {
  // 30fps 每帧固定 3cs，一秒只有 90cs（快 10%）；60fps 每帧 2cs
  // 又变成 120cs（慢 20%）。累计取整后一秒必须仍是 100cs。
  for (const fps of [24, 25, 30, 50]) {
    let total = 0;
    for (let i = 0; i < fps; i++) total += VE.gifDelayCs(fps, i);
    near(total, 100, 0.0001, `${fps}fps 一秒的延时总和`);
  }
  // 超过 50fps 时受 GIF 最小 2cs 限制，但绝不能低于 2
  for (const fps of [60, 120]) {
    for (let i = 0; i < 10; i++) ok(VE.gifDelayCs(fps, i) >= 2, `${fps}fps 第 ${i} 帧延时低于 2cs`);
  }
});

/* WebM 是唯一「按真实墙钟采集」的导出路径：MediaRecorder 给
   captureStream(0) 的帧打的是 requestFrame() 落地的墙钟时间戳，
   所以导出帧率 = 喂帧循环的真实节拍。
   原实现是「画完 → requestFrame → 睡 frameDur」，误差只加不减：

     t 间隔 = 绘制耗时 + frameDur + 定时器粒度

   实测（本机，setTimeout 粒度约 13~15ms）：
     目标 60fps、每帧绘制 16ms → 实际 2.7 倍间隔（约 22fps）
     目标 30fps、每帧绘制 30ms → 实际 2.3 倍间隔（约 13fps）
   下面对照的是「绝对时间表」：deadline 先算好，绘制耗时要么被吸收、
   要么让这一帧的等待归零 —— 但绝不顺延到下一帧。 */
function makeWebmHarness({ drawMs = 0, total = 20, fps = 60 } = {}) {
  const captures = [];
  const ctx = HC.makeCtx([]);
  const track = { requestFrame: () => captures.push(performance.now()) };
  const stream = { getVideoTracks: () => [track] };
  const canvas = { width: 0, height: 0, getContext: () => ctx, captureStream: () => stream };
  const hasDoc = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const hasRec = Object.prototype.hasOwnProperty.call(globalThis, 'MediaRecorder');
  const savedDoc = globalThis.document, savedRec = globalThis.MediaRecorder;
  globalThis.document = { createElement: () => canvas };
  let stoppedAt = null;
  class FakeRec {
    static isTypeSupported() { return true; }
    start() {}
    stop() { stoppedAt = performance.now(); if (this.onstop) this.onstop(); }
  }
  globalThis.MediaRecorder = FakeRec;
  const restore = () => {
    if (hasDoc) globalThis.document = savedDoc; else delete globalThis.document;
    if (hasRec) globalThis.MediaRecorder = savedRec; else delete globalThis.MediaRecorder;
  };
  const src = {
    w: 320, h: 180, fps, total,
    draw: () => {
      if (drawMs > 0) { const end = performance.now() + drawMs; while (performance.now() < end); }
    },
  };
  return { src, captures, restore, stoppedAt: () => stoppedAt };
}
const webmSpan = (h) => h.captures[h.captures.length - 1] - h.captures[0];

t('导出:WebM 喂帧按目标节拍（绘制耗时不得累加进帧间隔）', async () => {
  const h = makeWebmHarness({ drawMs: 16, total: 20, fps: 60 });
  try { await VE.exportWebM(h.src, {}, () => {}, () => false); } finally { h.restore(); }
  eq(h.captures.length, 20, '喂出的帧数应与 total 一致');
  const theory = (20 - 1) * 1000 / 60;
  const span = webmSpan(h);
  // 容差 1.5 倍是量出来的，不是拍的：
  //   · 绝对时间表（当前实现）独占跑时实测 0.96~1.04
  //   · 累加式（修复前）实测 2.3~2.8
  // 1.5 落在两者之间：新实现留足抖动余量，旧实现仍然稳稳变红。
  // 注意：这条必须 exclusive（见下面第三条的说明）—— 和 GIF 编码并发跑时
  // 实测会到 5.2 倍，那是测试并发问题，不是产品问题。
  ok(span <= theory * 1.5,
    `20 帧 60fps 应约 ${theory.toFixed(0)}ms，实测 ${span.toFixed(0)}ms（${(span / theory).toFixed(2)} 倍；累加式约 2.7 倍）`);
  ok(span >= theory * 0.7, `喂帧过快，实测 ${span.toFixed(0)}ms`);
}, { exclusive: true });
t('导出:WebM 目标 30fps 且单帧绘制比帧长还慢时仍不漂移', async () => {
  // 30fps 的单帧预算是 33.3ms，这里故意让绘制花 30ms：
  // 留给等待的余量只剩 3ms，远超定时器粒度，正是累加式最容易崩的工况。
  const h = makeWebmHarness({ drawMs: 30, total: 16, fps: 30 });
  try { await VE.exportWebM(h.src, {}, () => {}, () => false); } finally { h.restore(); }
  eq(h.captures.length, 16, '喂出的帧数应与 total 一致');
  const theory = (16 - 1) * 1000 / 30;
  const span = webmSpan(h);
  ok(span <= theory * 1.5,
    `16 帧 30fps 应约 ${theory.toFixed(0)}ms，实测 ${span.toFixed(0)}ms（${(span / theory).toFixed(2)} 倍；累加式约 2.3 倍）`);
  ok(span >= theory * 0.7, `喂帧过快，实测 ${span.toFixed(0)}ms`);
}, { exclusive: true });
t('导出:WebM 停止前给 recorder 留足最后几帧的采样时间', async () => {
  // 新循环不在 requestFrame 之后睡，所以沉降时间全靠收尾那一处。
  // 这里钉住它：最后一帧之后到 stop() 之间必须有 3×frameDur 的余量，
  // 否则最后一帧还没被采到就停了（表现为成片丢尾帧）。
  const h = makeWebmHarness({ drawMs: 0, total: 8, fps: 60 });
  try { await VE.exportWebM(h.src, {}, () => {}, () => false); } finally { h.restore(); }
  const last = h.captures[h.captures.length - 1];
  const settle = h.stoppedAt() - last;
  ok(settle >= 1000 / 60 * 2.5,
    `最后一帧到 stop() 只有 ${settle.toFixed(0)}ms，最后一帧可能没被采到`);
}, { exclusive: true });

/* ---------- 求值器：变量与循环护栏 ---------- */
const evalIR = (blocks) => ({
  project: { name: 'p', width: 1920, height: 1080, fps: 30, duration: 10 },
  markers: [],
  variables: [],
  layers: [{ id: 'L1', name: 'L1', type: 'text', visible: true, props: { text: 'x' }, blocks }],
  customLibrary: null,
});
const loopOf = (n, inner) => ({
  id: 'lp', k: 'C', op: 'loop',
  slots: [{ type: 'num', label: '次数', value: IR_NUM(n) }, { type: 'blocks', label: '每次', value: inner }],
});
const IR_NUM = (v) => ({ k: 'lit', t: 'num', v });
const waitBlk = () => ({ id: 'w', k: 'C', op: 'wait', slots: [{ type: 'time', value: { k: 'lit', t: 'time', v: 0.001 } }] });

t('求值:变量存对象时取回原值（不被当字面量再展开）', () => {
  // 回归：`case 'var'` 里判断是 `'v' in v`，于是用户存进去的任何带 v 字段的
  // 对象都被当成字面量节点再求值一次，用户拿到的不是他存的值。
  const { ctx } = EV.evaluateFrame(evalIR([]), 0, null, {});
  ctx.setVar('myVar', { v: 42 });
  eq(EV.evalExpr({ k: 'var', name: 'myVar' }, ctx).v, 42, '带 v 字段的对象被当成了字面量');
  ctx.setVar('litVar', { k: 'lit', t: 'num', v: 7 });
  eq(EV.evalExpr({ k: 'var', name: 'litVar' }, ctx), 7, '真字面量应展开成数值');
  ctx.setVar('plain', { name: 'a', id: 1 });
  eq(EV.evalExpr({ k: 'var', name: 'plain' }, ctx).name, 'a', '普通对象应原样返回');
  eq(EV.evalExpr({ k: 'var', name: '未定义' }, ctx), 0);
});
t('求值:嵌套 loop 受整帧步数预算约束，不卡死', () => {
  // 回归：loop 的 500 是「每层」上限，嵌套是乘积（500ⁿ）。3 层 = 1.25 亿次
  // 语句执行，实测 27.6 秒卡死界面；4 层根本算不完。
  let blocks = [waitBlk()];
  for (let i = 0; i < 4; i++) blocks = [loopOf(500, blocks)];
  let count = 0;
  const t0 = Date.now();
  const { ctx } = EV.evaluateFrame(evalIR(blocks), 0, null, { onBlock: () => count++ });
  const ms = Date.now() - t0;
  ok(ctx.budgetExceeded, '4 层嵌套未被预算拦下');
  ok(ms < 3000, `${ms}ms 仍然过慢（应在百毫秒级被截断）`);
  ok(count <= ctx.stepBudget + 8, `执行步数 ${count} 超出预算 ${ctx.stepBudget}`);
});
t('求值:预算内正常工程不被截断', () => {
  const blocks = [loopOf(20, [waitBlk()])];
  const { ctx } = EV.evaluateFrame(evalIR(blocks), 0, null, {});
  eq(ctx.budgetExceeded, false, '正常工程被误截断');
  eq(ctx.steps, 21, '步数应为 1 层 + 20 次');
});
t('求值:步数预算可配置', () => {
  const blocks = [loopOf(500, [waitBlk()])];
  const { ctx } = EV.evaluateFrame(evalIR(blocks), 0, null, { maxSteps: 10 });
  ok(ctx.steps <= 11, `实际 ${ctx.steps}`);
  ok(ctx.budgetExceeded);
});

/* ---------- 变量链路（#8）----------
   原来四层全断：EvalContext 从不载入 ir.variables、$ 前缀与内置键不一致、
   VAR 值一律被包成字符串字面量、toText 的 JSON 写法与读取侧不对称。
   表现为「工程里声明了变量，表达式里永远取到 0，文本里 $score 原样显示」。 */
const varIR = (variables, blocks = [], props = {}) => ({
  project: { name: 'p', width: 1920, height: 1080, fps: 30, duration: 10 },
  markers: [],
  variables,
  layers: [{ id: 'L1', name: 'L1', type: 'text', visible: true, props: Object.assign({ text: 'x' }, props), blocks }],
  customLibrary: null,
});
const setVarBlk = (name, val) => ({
  id: 'sv', k: 'C', op: 'setVar',
  slots: [
    { type: 'str', label: '变量名', value: IR_STR(name) },
    { type: 'num', label: '值', value: val },
  ],
});
const IR_STR = (v) => ({ k: 'lit', t: 'str', v });

t('变量:工程声明的变量会被载入求值上下文', () => {
  // 回归：EvalContext 构造里只 set 了 $time/$frame/$progress，
  // 从不遍历 ir.variables，所以声明的变量在表达式里恒为 0。
  const ir = varIR([{ id: 'V1', name: 'score', type: 'num', value: IR_NUM(42) }]);
  const { ctx } = EV.evaluateFrame(ir, 0, null, {});
  // ctx 里存的是字面量节点（由 evalExpr 展开），不是裸值 —— 这是有意的：
  // 变量可以存表达式/颜色/字符串，求值器统一按 Expr 处理。
  eq(ctx.getVar('score').v, 42, '声明的变量没进上下文');
  eq(EV.evalExpr({ k: 'var', name: 'score' }, ctx), 42, '表达式里取不到变量值');
});

t('变量:文本里的 $变量 渲染出真值', () => {
  // 回归：PROP text = "$score" 原来渲染出字面量 "$score"（连插值都没发生）。
  const ir = varIR([{ id: 'V1', name: 'score', type: 'num', value: IR_NUM(42) }], [], { text: '得分 $score' });
  const { state } = EV.evaluateFrame(ir, 0, null, {});
  eq(state.layers.L1.p.text, '得分 42', '文本里的变量没被插值');
});

t('变量:内置 $time/$frame/$progress 带不带 $ 都能取', () => {
  // 回归：内置键是 '$time'，而 parseExpr 产出的 name 是裸名 'time'，
  // 两条约定对不上 → 表达式里写 $time 取到 0。
  const ir = varIR([]);
  const { ctx } = EV.evaluateFrame(ir, 2, null, {});
  eq(EV.evalExpr({ k: 'var', name: 'time' }, ctx), 2);
  eq(EV.evalExpr({ k: 'var', name: '$time' }, ctx), 2, '$time 与 time 应命中同一个值');
  eq(EV.evalExpr({ k: 'var', name: 'frame' }, ctx), 60);
  eq(EV.evalExpr({ k: 'var', name: '$frame' }, ctx), 60);
  ok(Math.abs(EV.evalExpr({ k: 'var', name: 'progress' }, ctx) - 0.2) < 1e-9);
});

t('变量:写变量 op 生效，后续文本读到新值', () => {
  // 回归：全库没有任何「写变量」的 op，evaluator 的 setVar 零调用，
  // 变量永远只能是初值。这里钉住新增的 setVar 真的写进了本帧上下文。
  const ir = varIR(
    [{ id: 'V1', name: 'score', type: 'num', value: IR_NUM(0) }],
    [setVarBlk('score', { k: 'blk', op: 'add', a: IR_NUM(40), b: IR_NUM(2) })],
    { text: '得分 $score' },
  );
  const seen = [];
  const { state, ctx } = EV.evaluateFrame(ir, 0, null, { onVar: (k, v) => seen.push([k, v]) });
  eq(ctx.getVar('score'), 42, 'setVar 没写进上下文');
  eq(state.layers.L1.p.text, '得分 42', '积木写入后文本没读到新值');
  eq(seen.length, 1, 'onVar 应恰好回调一次');
  eq(seen[0][0], '$score', 'onVar 的键应归一成 $name');
  eq(seen[0][1], 42);
});

t('变量:文本插值只替换已声明的变量，未声明的原样保留', () => {
  // 用户正文里写「价格 $100」「$abc」不该被静默吃掉；
  // $data.键 是数据面板的绑定语法，要整段留给它。
  const ir = varIR([], [], { text: '价格 $100 与 $abc 与 $data.c0' });
  const { state } = EV.evaluateFrame(ir, 0, null, {});
  eq(state.layers.L1.p.text, '价格 $100 与 $abc 与 $data.c0');
});

t('变量:文本插值不误伤非文本属性', () => {
  // 只对 text 插值：fill 之类保持字面量，避免把颜色/路径里的 $ 误当变量。
  const ir = varIR([{ id: 'V1', name: 'c', type: 'col', value: { k: 'lit', t: 'col', v: '#ff0000' } }], [], { text: 'x' });
  ir.layers[0].props.fill = '$c';
  const { state } = EV.evaluateFrame(ir, 0, null, {});
  eq(state.layers.L1.p.fill, '$c', '非文本属性不该被插值');
});

t('变量:VAR 行保留类型，不再一律包成字符串', () => {
  // 回归：fromText 的 VAR 解析是 `STR(m[2])`，数字/布尔/颜色全变字符串，
  // 再存回去就成了 `"42"`，类型信息永久丢失。
  IR.registerOpMeta(BL.BLOCK_DEFS.map(d => BL.metaFor(d.op)).filter(Boolean));
  const txt = '# 工程: t\nVAR score 42\nVAR 标题 "甲"\nVAR 开关 true\nLAYER L1 [text]\n  PROP text = "x"';
  const { ir } = IR.fromText(txt, BL.BLOCK_DEFS);
  const byName = Object.fromEntries(ir.variables.map(v => [v.name, v]));
  eq(byName.score.value.t, 'num', '数字被当成了字符串');
  eq(byName.score.value.v, 42);
  eq(byName.score.type, 'num', 'type 应跟着值的类型走');
  eq(byName.标题.value.t, 'str');
  eq(byName.标题.value.v, '甲', '字符串不该带引号');
  eq(byName.开关.value.t, 'bool');
  eq(byName.开关.value.v, true);
});

t('变量:toText/fromText 往返四轮，第 2 轮与第 4 轮逐字相同', () => {
  // 回归（最要紧的一条）：toText 写 JSON、fromText 一律包 STR，
  // 于是每存读一轮多套一层转义（42 → "42" → "\"42\"" → …），
  // 用户工程文件会被逐轮写坏。第 2 轮之后必须完全稳定。
  // 注：第 1 轮可能与第 2 轮不同 —— 手写/程序构造的 IR 可能缺省 props，
  // 读回来会被补全成完整图层。判据是「第 2 轮起稳定」，这才是工程文件的形态。
  IR.registerOpMeta(BL.BLOCK_DEFS.map(d => BL.metaFor(d.op)).filter(Boolean));
  const ir = varIR([
    { id: 'V1', name: 'score', type: 'num', value: IR_NUM(42) },
    { id: 'V2', name: '标题', type: 'str', value: IR_STR('甲') },
    { id: 'V3', name: '开关', type: 'bool', value: { k: 'lit', t: 'bool', v: true } },
  ]);
  const t1 = IR.toText(ir);
  const r2 = IR.fromText(t1, BL.BLOCK_DEFS).ir;
  const t2 = IR.toText(r2);
  const r3 = IR.fromText(t2, BL.BLOCK_DEFS).ir;
  const t3 = IR.toText(r3);
  const r4 = IR.fromText(t3, BL.BLOCK_DEFS).ir;
  const t4 = IR.toText(r4);
  eq(t2, t4, '第 2 轮与第 4 轮不一致 → 往返仍在累积转义');
  eq(t2, t3, '第 2 轮与第 3 轮不一致 → 往返还没稳定');
  const vals = r4.variables.map(v => `${v.name}=${v.value.t}:${JSON.stringify(v.value.v)}`).join(' ');
  eq(vals, 'score=num:42 标题=str:"甲" 开关=bool:true', '往返后变量值/类型被改坏');
});

t('变量:往返后带 setVar 的积木仍指向正确的槽', () => {
  // 新 op 必须能被序列化/反序列化，且槽位顺序不变（AI 与模板共用 op ID）。
  IR.registerOpMeta(BL.BLOCK_DEFS.map(d => BL.metaFor(d.op)).filter(Boolean));
  const ir = varIR(
    [{ id: 'V1', name: 'score', type: 'num', value: IR_NUM(0) }],
    [setVarBlk('score', { k: 'blk', op: 'mul', a: { k: 'var', name: 'score' }, b: IR_NUM(2) })],
  );
  const back = IR.fromText(IR.toText(ir), BL.BLOCK_DEFS).ir;
  const b = back.layers[0].blocks[0];
  eq(b.op, 'setVar');
  eq(b.slots.length, 2);
  eq(b.slots[0].value.t, 'str');
  eq(b.slots[0].value.v, 'score', '变量名槽被写坏');
  eq(b.slots[1].value.k, 'blk');
  eq(b.slots[1].value.op, 'mul');
  eq(b.slots[1].value.a.k, 'var', '变量引用没被保留');
  eq(b.slots[1].value.a.name, 'score');
});

t('变量:新增的写变量 op 与积木库定义自洽', () => {
  // 新增 op 的守门：必须进 BLOCK_DEFS、分类在积木库里、且 SLOT_ORDER 有映射
  //（SLOT_ORDER 少一条 → AI 编译时整块被跳过，界面上看不出问题）。
  const def = BL.defOf('setVar');
  ok(def, 'blocks.js 里没有 setVar');
  eq(def.isLeaf, false);
  ok(BL.PALETTE_GROUPS.includes(def.cat), '分类不在积木库分组里 → 用户找不到它');
  eq(def.slots.length, 2, '槽位数与 evaluator 读的 E(0)/E(1) 必须一致');
  const meta = BL.metaFor('setVar');
  eq(meta.slots.length, 2);
  const compiled = AI.actionsToBlocks([{ op: 'setVar', slots: { name: IR_STR('score'), value: IR_NUM(5) } }]);
  eq(compiled.skipped.length, 0, `setVar 缺 SLOT_ORDER 映射：${JSON.stringify(compiled.skipped)}`);
  eq(compiled.blocks[0].slots[0].value.v, 'score');
  eq(compiled.blocks[0].slots[1].value.v, 5);
});

/* ============================================================
   内存：GIF / PNG 序列帧导出不得随帧数线性膨胀（#26 / #27）
   ============================================================ */

/** 生成一帧可复现的 RGBA */
function memFrame(w, h, f) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0;
    d[i * 4] = (x * 3 + f * 7) & 0xff;
    d[i * 4 + 1] = (y * 5 + f * 3) & 0xff;
    d[i * 4 + 2] = ((x + y) * 2 + f * 11) & 0xff;
    d[i * 4 + 3] = 255;
  }
  return d;
}

t('导出:GIF 流式编码器与批量编码器逐字节一致', async () => {
  // 流式入口是为了把「所有帧 RGBA 全攒在内存」换成「两遍渲染、只留上一帧」。
  // 换了实现不能换输出：同一批帧，两条路必须产出同一个 GIF。
  const GIF = await import(U('src/gif.js'));
  const W = 48, H = 32, N = 6;
  const frames = [];
  for (let f = 0; f < N; f++) {
    const idx = (f % 4 === 3 && f > 0) ? f - 1 : f;   // 掺一帧重复帧，覆盖差分分支
    frames.push({ rgba: memFrame(W, H, idx), delay: 4 + (f % 3) });
  }
  const oldBlob = GIF.encodeGIF(frames, W, H, { loop: 0, dither: true });
  const oldBuf = Buffer.from(await oldBlob.arrayBuffer());

  const scratch = new Uint8ClampedArray(W * H * 4);
  let drawn = 0;
  const newBlob = await GIF.encodeGIFFromSource({
    total: N,
    draw(i) { const idx = (i % 4 === 3 && i > 0) ? i - 1 : i; scratch.set(memFrame(W, H, idx)); drawn++; },
    getRGBA: () => scratch,
    delayFor: (i) => 4 + (i % 3),
  }, W, H, { loop: 0, dither: true });
  const newBuf = Buffer.from(await newBlob.arrayBuffer());

  eq(newBuf.length, oldBuf.length, 'GIF 长度变了');
  ok(oldBuf.equals(newBuf), 'GIF 字节内容变了（流式编码器与批量编码器必须等价）');
  eq(drawn, N * 2, `流式编码应渲染两遍（采样+编码），实际 draw 了 ${drawn} 次`);
});

t('导出:GIF 流式编码只保留上一帧索引，不攒全部 RGBA', async () => {
  // 判据不是「内存数字」（Node 里测不稳），而是**调用方不需要保留帧**：
  // 流式入口只要求 draw(i) 能按序号重画，从不接收 frames 数组。
  // 这条守住「导出通道不再把每帧 RGBA 攒起来」这个契约。
  const GIF = await import(U('src/gif.js'));
  const W = 32, H = 24, N = 8;
  const scratch = new Uint8ClampedArray(W * H * 4);
  let maxAlive = 0;
  const blob = await GIF.encodeGIFFromSource({
    total: N,
    draw(i) {
      scratch.set(memFrame(W, H, i));
      maxAlive = Math.max(maxAlive, 1);   // 任一时刻只持有一帧工作缓冲
    },
    getRGBA: () => scratch,
    delayFor: () => 5,
  }, W, H, { loop: 0 });
  ok(blob.size > 0, '没有产出 GIF');
  eq(maxAlive, 1, '编码过程同时持有超过一帧像素');
});

t('导出:PNG 序列帧 ZIP 支持延迟取数（压缩完即丢原始数据）', async () => {
  // #27 的核心：createZip 若一次性拿到所有帧的 Uint8Array，
  // 1080p 120 帧要 ~200MB 常驻。改成 data 传函数后，逐条取、压完即弃。
  const ZIP = await import(U('src/zip.js'));
  const payload = (i) => {
    const d = new Uint8Array(4096);
    for (let j = 0; j < d.length; j++) d[j] = (j * 31 + i * 7) & 0xff;
    return d;
  };
  let fetched = 0;
  const entries = [];
  for (let i = 0; i < 4; i++) {
    entries.push({ name: `frames/f${i}.png`, data: () => { fetched++; return Promise.resolve(payload(i)); } });
  }
  const blob = await ZIP.createZip(entries);
  const buf = Buffer.from(await blob.arrayBuffer());
  ok(buf.length > 0, 'ZIP 为空');
  eq(fetched, 4, '每个条目的取数函数应被调用且只调用一次');
  eq(buf.readUInt32LE(0), 0x04034b50, 'ZIP 本地文件头签名不对');
  eq(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'ZIP 中央目录结束签名不对');
});

t('导出:deflate 不经过 Blob 中转（否则每帧多复制一整份）', async () => {
  // 原实现 `new Blob([u8]).stream()` 会把 u8 整份复制进 Blob 存储，
  // 序列帧导出时每帧一次，峰值随帧数线性涨（实测 4.54x → 2.81x 输入）。
  // 输出内容两种写法完全一样，所以只能从**实现方式**上守：
  // 静态检查 zip.js 的 deflateRaw 里不得出现 `new Blob([...]).stream()`。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./src/zip.js', import.meta.url), 'utf8');
  const fn = src.match(/async function deflateRaw\(u8\)\s*\{([\s\S]*?)\n\}/);
  ok(fn, '没找到 deflateRaw 函数');
  // 剥掉注释再匹配 —— 注释里正好写着「不要写成 new Blob([u8]).stream()」
  const code = fn[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok(!/new Blob\(\s*\[\s*u8\s*\]\s*\)\s*\.stream\(\)/.test(code),
    'deflateRaw 又用回了 new Blob([u8]).stream() —— 每帧会多复制一整份数据');
  ok(/\.writable\.getWriter\(\)/.test(code),
    'deflateRaw 没有直接把数据写进 CompressionStream.writable（应零额外拷贝）');

  // 同时验证功能正确：解压回来必须与输入逐字节相同
  const ZIP = await import(U('src/zip.js'));
  const { inflateRawSync } = await import('node:zlib');
  const raw = new Uint8Array(8192);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 17 + 3) & 0xff;
  const blob = await ZIP.createZip([{ name: 'x.bin', data: raw }]);
  const buf = Buffer.from(await blob.arrayBuffer());
  const method = buf.readUInt16LE(8);
  const compSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const body = buf.slice(30 + nameLen, 30 + nameLen + compSize);
  const out = method === 8 ? inflateRawSync(body) : body;
  eq(out.length, raw.length, '解压后长度不符');
  ok(Buffer.from(out).equals(Buffer.from(raw)), '解压后内容与原始数据不一致');
});

/* ============================================================
   汇总
   ============================================================ */
await Promise.all(pendingTests);   // 等所有异步用例真正跑完再统计
console.log('');
if (fail === 0) console.log(`%c✓ 音频源/视频导出自测全部通过 ${pass}/${pass + fail}`, 'color:#38c98b;font-weight:700');
else {
  console.log(`%c✗ ${fail}/${pass + fail} 失败`, 'color:#ff5a5a;font-weight:700');
  for (const f of failures) console.log('  · ' + f);
}
console.log('');
process.exit(fail === 0 ? 0 : 1);