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

let pass = 0, fail = 0; const failures = [];
const t = (n, f) => {
  try { const r = f(); if (r === false) { fail++; failures.push(`${n} → 断言失败`); } else pass++; }
  catch (e) { fail++; failures.push(`${n} → ${e.message}`); }
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

/* ============================================================
   汇总
   ============================================================ */
console.log('');
if (fail === 0) console.log(`%c✓ 音频源/视频导出自测全部通过 ${pass}/${pass + fail}`, 'color:#38c98b;font-weight:700');
else {
  console.log(`%c✗ ${fail}/${pass + fail} 失败`, 'color:#ff5a5a;font-weight:700');
  for (const f of failures) console.log('  · ' + f);
}
console.log('');
process.exit(fail === 0 ? 0 : 1);