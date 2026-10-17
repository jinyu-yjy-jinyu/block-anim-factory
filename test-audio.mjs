/* 套件 5：音频内核（P0-A/B/C/E、P1-C/D） */
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const U = (p) => pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), p)).href;

const A = await import(U('src/audio-core.js'));
const R = await import(U('src/recorder.js'));
const AD = await import(U('src/audiodesk.js'));

let pass = 0, fail = 0; const failures = [];
// 异步用例必须被等待：原实现把 fn() 返回的 Promise 直接当成「非 false」计为通过，
// 于是 async 用例里的断言从未执行也会记为通过。
const pendingTests = [];
const t = (name, fn) => {
  const good = (r) => { if (r === false) { fail++; failures.push(`${name} → 断言失败`); } else pass++; };
  const bad = (e) => { fail++; failures.push(`${name} → ${e.message}`); };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') { pendingTests.push(r.then(good, bad)); return; }
    good(r);
  } catch (e) { bad(e); }
};
const eq = (a, b, m) => { if (String(a) !== String(b)) throw new Error(`${m || ''} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const near = (a, b, e, m) => { if (!(Math.abs(a - b) <= (e == null ? 1e-6 : e))) throw new Error(`${m || ''} 期望 ≈${b}，实际 ${a}`); };
const ok = (v, m) => { if (!v) throw new Error(m || '期望为真'); };

const SR = 48000;

/* ---------- WAV 编解码 ---------- */
t('WAV:编码后可解码且样本一致', () => {
  const n = 4800;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin(i / 48000 * 2 * Math.PI * 440) * 0.8;
  const buf = A.encodeWav(s, SR);
  const d = A.decodeWav(buf);
  eq(d.sampleRate, SR);
  eq(d.samples.length, n);
  let maxErr = 0;
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(d.samples[i] - s[i]));
  // 16bit 量化：步长 1/32767，最大误差半个步长
  ok(maxErr <= 1 / 32767 + 1e-9, `量化误差 ${maxErr} 超过 16bit 上限`);
});
t('WAV:拒绝非法文件', () => {
  let threw = false;
  try { A.decodeWav(new ArrayBuffer(100)); } catch { threw = true; }
  ok(threw);
});
t('重采样:44.1k → 48k 长度正确', () => {
  const a = new Float32Array(44100);
  for (let i = 0; i < a.length; i++) a[i] = Math.sin(i / 44100 * 2 * Math.PI * 440);
  const b = A.resample(a, 44100, 48000);
  ok(Math.abs(b.length - 48000) <= 3, `长度 ${b.length}`);
  ok(b.every(v => isFinite(v) && Math.abs(v) <= 1.01));
});

/* ---------- FFT ---------- */
t('FFT:单频能量集中在一个 bin', () => {
  const N = 1024, bin = 64, f0 = bin * SR / N;
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = Math.cos(2 * Math.PI * f0 * i / SR);
  A.fft(re, im);
  let best = 0, bestM = 0;
  for (let b = 1; b < N / 2; b++) {
    const m = Math.hypot(re[b], im[b]);
    if (m > bestM) { bestM = m; best = b; }
  }
  eq(best, bin, `峰值 bin`);
  ok(bestM > 400, `峰值幅度 ${bestM}`);
});
t('FFT:与朴素 DFT 对齐', () => {
  const N = 32;
  const re = new Float32Array(N), im = new Float32Array(N);
  const src = new Float32Array(N);
  for (let i = 0; i < N; i++) { src[i] = Math.sin(i * 0.7) + 0.4 * Math.cos(i * 2.1); re[i] = src[i]; }
  A.fft(re, im);
  for (const b of [0, 1, 5, 11]) {
    let dr = 0, di = 0;
    for (let n = 0; n < N; n++) {
      const ang = -2 * Math.PI * b * n / N;
      dr += src[n] * Math.cos(ang);
      di += src[n] * Math.sin(ang);
    }
    near(re[b], dr, 1e-3, `bin ${b} 实部`);
    near(im[b], di, 1e-3, `bin ${b} 虚部`);
  }
});

/* ---------- 音轨操作 ---------- */
function makeSpeech(dur = 3) {
  // 模拟口播：静音段 + 有声段
  const n = Math.floor(SR * dur);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    if (t > 0.6 && t < 1.6) v = Math.sin(2 * Math.PI * 180 * t) * 0.5 + Math.sin(2 * Math.PI * 320 * t) * 0.3;
    else if (t > 2.2) v = Math.sin(2 * Math.PI * 200 * t) * 0.4;
    s[i] = v + (Math.random() - 0.5) * 0.01;
  }
  return new A.AudioTrack({ samples: s, sampleRate: SR, name: '测试口播' });
}
t('音轨:时长正确', () => eq(makeSpeech(3).duration, 3));
t('音轨:切片', () => {
  const tr = makeSpeech(3);
  const sl = tr.slice(0.5, 1.5);
  near(sl.length / SR, 1.0, 0.001);
});
t('音轨:拼接与增益', () => {
  const tr = makeSpeech(1);
  const before = tr.duration;
  tr.concat(makeSpeech(1));
  near(tr.duration, 2, 0.001);
  tr.applyGain(0.5);
  ok(tr.samples.every(v => Math.abs(v) <= 0.51), '增益后幅度未超');
  ok(before === 1);
});
t('音轨:归一化到目标峰值', () => {
  const tr = makeSpeech(1);
  tr.normalize(0.9);
  let peak = 0;
  for (const v of tr.samples) peak = Math.max(peak, Math.abs(v));
  near(peak, 0.9, 0.01);
});
t('音轨:淡入淡出端点为 0', () => {
  const tr = makeSpeech(1);
  tr.fade(0, tr.duration, tr.duration, 0.1);
  near(Math.abs(tr.samples[0]), 0, 1e-3, '起点');
  near(Math.abs(tr.samples[tr.samples.length - 1]), 0, 1e-3, '终点');
});

/* ---------- 峰值 / 分析 ---------- */
t('分析:峰值包络长度与范围', () => {
  const tr = makeSpeech(2);
  const p = A.computePeaks(tr.samples, SR, 100);
  eq(p.min.length, p.max.length);
  ok(p.min.length > 150 && p.min.length < 250, `桶数 ${p.min.length}`);
  ok(p.rms.every(v => v >= 0));
  for (let i = 0; i < p.min.length; i++) ok(p.min[i] <= p.max[i], `min<=max @${i}`);
});
t('分析:频段能量有界', () => {
  const tr = makeSpeech(2);
  const b = A.computeBandEnergies(tr.samples, SR, { fps: 60 });
  eq(b.amp.length, 120);
  for (const k of ['amp', 'bass', 'mid', 'treble', 'rms']) {
    ok(b[k].every(v => isFinite(v) && v >= 0 && v <= 1.0001), `${k} 越界`);
  }
});
t('分析:低音信号 bass > treble', () => {
  const n = SR * 2;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin(2 * Math.PI * 80 * i / SR) * 0.6;
  const b = A.computeBandEnergies(s, SR, { fps: 60 });
  const avg = (arr) => arr.reduce((a, c) => a + c, 0) / arr.length;
  ok(avg(b.bass) > avg(b.treble) * 3, `bass=${avg(b.bass).toFixed(3)} treble=${avg(b.treble).toFixed(3)}`);
});
t('分析:低频信号 bass 显著', () => {
  const n = SR * 2;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin(2 * Math.PI * 60 * i / SR) * 0.7;
  const b = A.computeBandEnergies(s, SR, { fps: 60 });
  const avg = b.bass.reduce((a, c) => a + c, 0) / b.bass.length;
  ok(avg > 0.15, `bass 平均 ${avg.toFixed(3)}`);
});
t('分析:高通信号 treble 显著', () => {
  const n = SR * 2;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin(2 * Math.PI * 6000 * i / SR) * 0.5;
  const b = A.computeBandEnergies(s, SR, { fps: 60 });
  const avgT = b.treble.reduce((a, c) => a + c, 0) / b.treble.length;
  const avgB = b.bass.reduce((a, c) => a + c, 0) / b.bass.length;
  ok(avgT > avgB * 2, `treble=${avgT.toFixed(3)} bass=${avgB.toFixed(3)}`);
});
t('分析:同样的输入结果一致（确定性）', () => {
  const tr = makeSpeech(2);
  const a1 = A.computeBandEnergies(tr.samples, SR, { fps: 60 });
  const a2 = A.computeBandEnergies(tr.samples, SR, { fps: 60 });
  eq(a1.amp.join(','), a2.amp.join(','));
});
t('分析:静音段能量显著低于有声段', () => {
  const tr = makeSpeech(3);
  const a = tr.ensureAnalysis();
  // peaks.rms 是每 5ms 一个桶的时间域 RMS，最直接反映「有没有声音」
  const pps = a.peaks.bucketsPerSecond;
  const at = (t0, t1) => {
    const i0 = Math.floor(t0 * pps), i1 = Math.min(a.peaks.rms.length, Math.floor(t1 * pps));
    let s = 0;
    for (let i = i0; i < i1; i++) s += a.peaks.rms[i];
    return s / Math.max(1, i1 - i0);
  };
  const silent = at(0.1, 0.5);       // 0~0.6 是静音
  const voiced = at(0.8, 1.4);       // 0.6~1.6 是有声
  ok(voiced > silent * 5, `有声 ${voiced.toFixed(4)} vs 静音 ${silent.toFixed(4)}`);
});

/* ---------- 静音检测 ---------- */
t('静音检测:找到两段静音', () => {
  const tr = makeSpeech(3);
  const r = A.detectSilence(tr.samples, SR, { thresholdDb: -40, minSilence: 0.3 });
  eq(r.length, 2, '静音段数');
  ok(Math.abs(r[0].start - 0) < 0.05, `第一段起点 ${r[0].start}`);
  ok(Math.abs(r[0].end - 0.6) < 0.08, `第一段终点 ${r[0].end.toFixed(2)}`);
  ok(Math.abs(r[1].start - 1.6) < 0.08, `第二段起点 ${r[1].start.toFixed(2)}`);
});
t('静音检测:阈值提高则检出更少', () => {
  const tr = makeSpeech(3);
  const lo = A.detectSilence(tr.samples, SR, { thresholdDb: -50, minSilence: 0.3 }).length;
  const hi = A.detectSilence(tr.samples, SR, { thresholdDb: -10, minSilence: 0.3 }).length;
  ok(hi <= lo, `-50dB→${lo} 段，-10dB→${hi} 段`);
});
t('静音检测:全有声时无检出', () => {
  const n = SR * 2;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin(2 * Math.PI * 300 * i / SR) * 0.5;
  eq(A.detectSilence(s, SR, { thresholdDb: -40, minSilence: 0.2 }).length, 0);
});

/* ---------- 响度（EBU R128） ---------- */
/* 参考模型：峰值 P dBFS 的 1kHz 正弦 ⇒ RMS = P - 3.01 dBFS
   K 加权在 1kHz 约 +0.67dB，再减 0.691 偏置 ⇒ LUFS ≈ P - 3.03 */
t('响度:校准 -23dBFS 峰值 1kHz ⇒ -26 LUFS', () => {
  const n = SR * 8;
  const a = Math.pow(10, -23 / 20);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = a * Math.sin(2 * Math.PI * 1000 * i / SR);
  const m = A.measureLoudness(s, SR);
  ok(Math.abs(m.lufs - (-26.03)) < 0.4, `LUFS=${m.lufs}（期望 -26.03±0.4）`);
});
t('响度:符合 K 加权模型（峰值 dBFS → LUFS）', () => {
  const n = SR * 6;
  const mk = (peakDb) => {
    const a = Math.pow(10, peakDb / 20);
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = a * Math.sin(2 * Math.PI * 1000 * i / SR);
    return A.measureLoudness(s, SR);
  };
  const x = mk(-20), y = mk(-30);
  ok(Math.abs((x.lufs - y.lufs) - 10) < 0.6, `LUFS 差 ${(x.lufs - y.lufs).toFixed(2)}（应≈10）`);
  ok(Math.abs(x.lufs - (-23.03)) < 0.4, `-20dBFS峰值 → ${x.lufs}（应≈-23.03）`);
});
t('响度:多采样率一致', () => {
  const vals = [];
  for (const rate of [44100, 48000]) {
    const n = rate * 6;
    const a = Math.pow(10, -23 / 20);
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = a * Math.sin(2 * Math.PI * 1000 * i / rate);
    vals.push(A.measureLoudness(s, rate).lufs);
  }
  ok(Math.abs(vals[0] - vals[1]) < 0.9, `44100=${vals[0]} 48000=${vals[1]}`);
  ok(Math.abs(vals[0] - (-26.03)) < 0.9, `44100 → ${vals[0]}`);
});
t('响度:更响的信号 LUFS 更高', () => {
  const mk = (db) => {
    const n = SR * 3; const amp = Math.pow(10, db / 20) / Math.sqrt(2);
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = amp * Math.sin(2 * Math.PI * 1000 * i / SR);
    return A.measureLoudness(s, SR).lufs;
  };
  ok(mk(-10) > mk(-20), '高电平应更响');
});
t('响度:峰值与 truePeakDb 一致', () => {
  const s = new Float32Array(SR).fill(0);
  s[500] = 0.8;
  const m = A.measureLoudness(s, SR);
  near(m.peak, 0.8, 1e-6);
  near(m.truePeakDb, 20 * Math.log10(0.8), 1e-3);
});
t('响度:标准化到 -14 LUFS', () => {
  const n = SR * 4;
  const a = Math.pow(10, -23 / 20);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = a * Math.sin(2 * Math.PI * 1000 * i / SR);
  const tr = new A.AudioTrack({ samples: s, sampleRate: SR });
  const r = A.normalizeLoudness(tr, -14);
  ok(Math.abs(r.after.lufs - (-14)) < 1.0, `标准化后 ${r.after.lufs} LUFS`);
});
t('响度:标准化不会削波', () => {
  const n = SR * 4;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin(2 * Math.PI * 1000 * i / SR) * 0.02;
  const tr = new A.AudioTrack({ samples: s, sampleRate: SR });
  A.normalizeLoudness(tr, -14, { ceilingDb: -1 });
  let peak = 0;
  for (const v of tr.samples) peak = Math.max(peak, Math.abs(v));
  ok(peak <= Math.pow(10, -1 / 20) + 1e-6, `峰值 ${peak.toFixed(3)} 超过天花板`);
});
t('响度:平台预设齐全', () => {
  for (const k of ['douyin', 'bilibili', 'youtube', 'wechat', 'podcast']) {
    const p = A.LOUDNESS_PRESETS[k];
    ok(p && typeof p.lufs === 'number' && p.lufs < 0, `缺少预设 ${k}`);
  }
  eq(A.LOUDNESS_PRESETS.douyin.lufs, -14);
});

/* ---------- 节拍检测（P1-C） ---------- */
function makeBeatTrack(bpm = 120, dur = 6) {
  const n = SR * dur;
  const s = new Float32Array(n);
  const spb = 60 / bpm;
  for (let k = 0; k * spb < dur; k++) {
    const at = Math.floor(k * spb * SR);
    const len = Math.floor(0.08 * SR);
    for (let i = 0; i < len && at + i < n; i++) {
      const env = Math.exp(-i / (len * 0.25));
      s[at + i] += Math.sin(2 * Math.PI * 60 * i / SR) * env * 0.8;
    }
  }
  return new A.AudioTrack({ samples: s, sampleRate: SR });
}
t('节拍:检出 120BPM', () => {
  const tr = makeBeatTrack(120, 8);
  const bands = A.computeBandEnergies(tr.samples, SR, { fps: 100 });
  const r = A.detectBeats(bands.amp, 100);
  ok(r.beats.length >= 10, `检出 ${r.beats.length} 个节拍`);
  ok(Math.abs(r.bpm - 120) <= 3, `BPM=${r.bpm}`);
});
t('节拍:90BPM 也能检出', () => {
  const tr = makeBeatTrack(90, 10);
  const bands = A.computeBandEnergies(tr.samples, SR, { fps: 100 });
  const r = A.detectBeats(bands.amp, 100);
  ok(Math.abs(r.bpm - 90) <= 4, `BPM=${r.bpm}`);
});
t('节拍:时间点递增且在范围内', () => {
  const tr = makeBeatTrack(120, 5);
  const bands = A.computeBandEnergies(tr.samples, SR, { fps: 100 });
  const r = A.detectBeats(bands.amp, 100);
  for (let i = 1; i < r.beats.length; i++) ok(r.beats[i].time > r.beats[i - 1].time, '时间未递增');
  ok(r.beats[r.beats.length - 1].time < 5.2, '超出时长');
});
t('节拍:确定性', () => {
  const tr = makeBeatTrack(128, 6);
  const b1 = A.computeBandEnergies(tr.samples, SR, { fps: 60 });
  const b2 = A.computeBandEnergies(tr.samples, SR, { fps: 60 });
  eq(A.detectBeats(b1.amp, 60).bpm, A.detectBeats(b2.amp, 60).bpm);
});

/* ---------- 混音 + 闪避（P1-E） ---------- */
t('混音:多轨相加', () => {
  const a = new A.AudioTrack({ samples: new Float32Array(SR).fill(0.3), sampleRate: SR });
  const b = new A.AudioTrack({ samples: new Float32Array(SR).fill(0.2), sampleRate: SR });
  const m = A.mixTracks([a, b], 1, { ducking: false });
  near(m[100], 0.5, 1e-6);
});
t('混音:软限幅不超出天花板', () => {
  const a = new A.AudioTrack({ samples: new Float32Array(SR).fill(0.9), sampleRate: SR });
  const b = new A.AudioTrack({ samples: new Float32Array(SR).fill(0.9), sampleRate: SR });
  const m = A.mixTracks([a, b], 1, { ducking: false, ceilingDb: -1 });
  const ceil = Math.pow(10, -1 / 20);
  ok(m.every(v => Math.abs(v) <= ceil + 1e-6), '超限');
});
t('混音:静音轨被忽略', () => {
  const a = new A.AudioTrack({ samples: new Float32Array(SR).fill(0.5), sampleRate: SR });
  const b = new A.AudioTrack({ samples: new Float32Array(SR).fill(0.5), sampleRate: SR });
  b.muted = true;
  const m = A.mixTracks([a, b], 1, { ducking: false });
  near(m[100], 0.5, 1e-6);
});
t('闪避:人声出现时音乐被压低', () => {
  const n = SR * 3;
  const music = new A.AudioTrack({ samples: new Float32Array(n).fill(0.5), sampleRate: SR, kind: 'music' });
  const voice = new A.AudioTrack({ samples: new Float32Array(n), sampleRate: SR, kind: 'voice' });
  for (let i = Math.floor(SR * 1); i < Math.floor(SR * 2); i++) voice.samples[i] = 0.6 * Math.sin(i / SR * 2 * Math.PI * 300);
  music.duckTo = 0.8;
  const m = A.mixTracks([music, voice], 3, { ducking: true });
  const at = (t) => m[Math.floor(t * SR)];
  ok(at(0.5) > at(1.5) * 1.5, `无人声 ${at(0.5).toFixed(3)} vs 有人声 ${at(1.5).toFixed(3)}`);
});
t('闪避:关闭后音乐音量恒定', () => {
  const n = SR * 3;
  const music = new A.AudioTrack({ samples: new Float32Array(n).fill(0.5), sampleRate: SR, kind: 'music' });
  const voice = new A.AudioTrack({ samples: new Float32Array(n).fill(0.5), sampleRate: SR, kind: 'voice' });
  const m = A.mixTracks([music, voice], 3, { ducking: false, ceilingDb: 0 });
  ok(Math.abs(m[100] - 1.0) < 1e-6, `实际 ${m[100]}`);
});
t('取样:sampleAt 返回峰值', () => {
  const s = new Float32Array(SR);
  s[500] = 0.9;
  const tr = new A.AudioTrack({ samples: s, sampleRate: SR });
  near(A.sampleAt([tr], 500 / SR).peak, 0.9, 1e-6);
});

/* ---------- 波形编辑（P0-B/C） ---------- */
t('编辑:删除区间', () => {
  const tr = makeSpeech(3);
  const ed = new R.WaveEditor(tr);
  ed.delete(1, 2);
  near(tr.duration, 2, 0.01);
  ed.reset();
  near(tr.duration, 3, 0.001, 'reset 未还原');
});
t('编辑:静音保留长度', () => {
  const tr = makeSpeech(3);
  const ed = new R.WaveEditor(tr);
  ed.silence(1, 2);
  near(tr.duration, 3, 0.001);
  let peak = 0;
  for (let i = Math.floor(1.05 * SR); i < Math.floor(1.95 * SR); i++) peak = Math.max(peak, Math.abs(tr.samples[i]));
  near(peak, 0, 1e-6);
  ed.undo();
  ok(tr.samples.some(v => Math.abs(v) > 0.1), 'undo 未还原');
});
t('编辑:切割', () => {
  const tr = makeSpeech(3);
  const ed = new R.WaveEditor(tr);
  const op = ed.splitAt(1.5);
  ok(op && op.type === 'split');
  near(tr.duration, 1.5, 0.01);
});
t('编辑:区间增益与撤销', () => {
  const tr = makeSpeech(2);
  const ed = new R.WaveEditor(tr);
  const before = tr.samples[Math.floor(0.8 * SR)];
  ed.gain(0.7, 0.9, 0.25);
  const after = tr.samples[Math.floor(0.8 * SR)];
  near(after, before * 0.25, 1e-5);
  ed.undo();
  near(tr.samples[Math.floor(0.8 * SR)], before, 1e-6);
});
t('编辑:淡入淡出', () => {
  const tr = makeSpeech(2);
  const ed = new R.WaveEditor(tr);
  ed.fadeEdges(0.5, 1.5, 0.1);
  near(Math.abs(tr.samples[Math.floor(0.5 * SR)]), 0, 1e-4);
});
t('编辑:粘贴并淡化', () => {
  const tr = makeSpeech(2);
  const ed = new R.WaveEditor(tr);
  const clip = ed.copyRange();
  ed.delete(0.5, 1.0);
  const d = tr.duration;
  ed.pasteWithFade(clip, 0.5, 0.05);
  ok(tr.duration >= d - 0.01, '粘贴后变短了');
  ok(tr.samples.every(v => isFinite(v)), '出现 NaN');
});
t('编辑:一键去静默确实缩短音频', () => {
  const tr = makeSpeech(4);        // 静音段约 0~0.6 与 1.6~2.2
  const ed = new R.WaveEditor(tr);
  const before = tr.duration;
  const res = ed.removeSilence({ thresholdDb: -40, minSilence: 0.3 });
  eq(res.removed, 2, '静音段数');
  ok(tr.duration < before - 0.8, `时长 ${before} → ${tr.duration}`);
  ok(tr.duration > 1.5, '删太多了');
});
t('编辑:去静默可撤销', () => {
  const tr = makeSpeech(4);
  const ed = new R.WaveEditor(tr);
  const before = tr.duration;
  ed.removeSilence({ thresholdDb: -40, minSilence: 0.3 });
  ed.undo();
  near(tr.duration, before, 0.001, '撤销未还原');
});
t('编辑:去静默保留有声内容', () => {
  const tr = makeSpeech(4);
  const ed = new R.WaveEditor(tr);
  ed.removeSilence({ thresholdDb: -40, minSilence: 0.3 });
  let peak = 0;
  for (const v of tr.samples) peak = Math.max(peak, Math.abs(v));
  ok(peak > 0.2, `有声内容被误删，峰值仅 ${peak}`);
});
t('编辑:全静音输入不崩', () => {
  const tr = new A.AudioTrack({ samples: new Float32Array(SR * 2), sampleRate: SR });
  const ed = new R.WaveEditor(tr);
  const r = ed.removeSilence({ thresholdDb: -40, minSilence: 0.3 });
  ok(r.removed > 0);
  ok(tr.duration <= 0.2, `残留 ${tr.duration}`);
});
t('编辑:裁剪后可撤销且不丢音频', () => {
  // 回归：trimTo 原实现借用 delete 记账（{type:'delete', t0:0, t1:duration+1}），
  // undo 里 delete 走 _restoreFromOps 重放，重放这条伪 delete 会把整轨清空 ——
  // 裁剪后一按撤销，音频全没了。
  const tr = makeSpeech(2);
  const ed = new R.WaveEditor(tr);
  const before = tr.duration;
  ed.trimTo(0.5, 1.5);
  near(tr.duration, 1, 0.01, '裁剪未生效');
  ed.undo();
  near(tr.duration, before, 0.001, '撤销裁剪未还原长度');
  let peak = 0;
  for (const v of tr.samples) peak = Math.max(peak, Math.abs(v));
  ok(peak > 0.1, `撤销裁剪后音频为空，峰值仅 ${peak}`);
});
t('编辑:裁剪后继续编辑再撤销，音频不丢', () => {
  // 回归：裁剪之后的所有结构性操作都会触发 _restoreFromOps 从 original 重放，
  // 伪 delete 在这一步同样会把整轨清空。
  const tr = makeSpeech(2);
  const ed = new R.WaveEditor(tr);
  ed.trimTo(0.5, 1.5);
  const afterTrim = tr.duration;
  ed.delete(0, 0.1);
  ed.undo();                       // 只撤销这次 delete
  near(tr.duration, afterTrim, 0.01, '撤销 delete 时把 trim 结果也弄丢了');
  let peak = 0;
  for (const v of tr.samples) peak = Math.max(peak, Math.abs(v));
  ok(peak > 0.1, `音频被清空，峰值仅 ${peak}`);
});
t('编辑:撤销粘贴不把内容换成静音', () => {
  // 回归：paste 的 op 只存了长度，_restoreFromOps 用 _clipByLen(len) 造一段
  // 全零数组贴回去 → 撤销一次粘贴，贴入的内容变成等长静音，原音频不可恢复。
  const tr = makeSpeech(3);
  const ed = new R.WaveEditor(tr);
  const clip = tr.slice(1.0, 2.0);
  let clipPeak = 0;
  for (const v of clip) clipPeak = Math.max(clipPeak, Math.abs(v));
  ok(clipPeak > 0.1, '测试素材本身的片段就是静音');
  ed.paste(clip, 0.3);
  const at = Math.floor(0.35 * SR);
  const afterPaste = tr.samples[at];
  ed.delete(0, 0.05);              // 触发结构重放
  ed.undo();
  near(tr.samples[at], afterPaste, 1e-6, '重放后粘贴的样本变了');
  let pastedPeak = 0;
  for (let i = Math.floor(0.3 * SR); i < Math.floor(1.2 * SR); i++) pastedPeak = Math.max(pastedPeak, Math.abs(tr.samples[i]));
  ok(pastedPeak > 0.1, `粘贴内容被换成静音，峰值仅 ${pastedPeak}`);
});
t('编辑:撤销淡化粘贴不把内容换成静音', () => {
  const tr = makeSpeech(3);
  const ed = new R.WaveEditor(tr);
  const clip = tr.slice(1.0, 2.0);
  ed.pasteWithFade(clip, 0.5, 0.05);
  const at = Math.floor(1.2 * SR);
  const before = tr.samples[at];
  ed.delete(0, 0.05);
  ed.undo();
  near(tr.samples[at], before, 1e-6, '重放后样本变了');
  let peak = 0;
  for (let i = Math.floor(1.0 * SR); i < Math.floor(1.5 * SR); i++) peak = Math.max(peak, Math.abs(tr.samples[i]));
  ok(peak > 0.1, `淡化粘贴内容被换成静音，峰值仅 ${peak}`);
});

/* ---------- 时间拉伸 ---------- */
t('变速:变慢后时长变长', () => {
  const n = SR * 2;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin(2 * Math.PI * 220 * i / SR) * 0.5;
  const out = R.timeStretch(s, 1.5);
  ok(out.length > n * 1.3, `长度 ${out.length}`);
});
t('变速:变快后时长变短', () => {
  const n = SR * 2;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin(2 * Math.PI * 220 * i / SR) * 0.5;
  const out = R.timeStretch(s, 0.7);
  ok(out.length < n * 0.85, `长度 ${out.length}`);
});
t('变速:输出无 NaN', () => {
  const s = new Float32Array(SR).map((_, i) => Math.sin(i / 30) * 0.4);
  const out = R.timeStretch(s, 1.3);
  ok(out.every(v => isFinite(v)));
});
t('变速:ratio=1 原样返回', () => {
  const s = new Float32Array(1000).fill(0.3);
  eq(R.timeStretch(s, 1).length, 1000);
});

/* ---------- 预设 ---------- */
t('预设:响度标准化', () => {
  const tr = makeSpeech(2);
  const label = R.applyPreset(tr, 'normalize', { lufs: -16 });
  eq(label, '响度标准化');
  const m = A.measureLoudness(tr.samples, SR);
  ok(m.lufs > -30, `LUFS=${m.lufs}`);
});
t('预设:去爆音', () => {
  const tr = makeSpeech(1);
  tr.samples[1000] = 0.99; tr.samples[1001] = -0.99;
  R.applyPreset(tr, 'dePop');
  ok(tr.samples.every(v => isFinite(v)));
  ok(Math.abs(tr.samples[1000] - tr.samples[1001]) < 0.5, '尖峰未削平');
});
t('预设:压缩降低峰值', () => {
  const tr = makeSpeech(2);
  let before = 0;
  for (const v of tr.samples) before = Math.max(before, Math.abs(v));
  R.applyPreset(tr, 'compress');
  let after = 0;
  for (const v of tr.samples) after = Math.max(after, Math.abs(v));
  ok(after <= before + 1e-6, `峰值 ${before} → ${after}`);
});
t('预设:未知名称报错', () => {
  let threw = false;
  try { R.applyPreset(makeSpeech(1), 'nope'); } catch { threw = true; }
  ok(threw);
});
t('预设:降噪不产生 NaN', () => {
  const tr = makeSpeech(2);
  R.applyPreset(tr, 'denoise');
  ok(tr.samples.every(v => isFinite(v)));
});

/* ---------- 回归：第一批修复的缺陷 ---------- */
/* 这些用例的判据必须比「长度对」「不抛错」更严，
   否则同一个 bug 会静默复发（频谱全零、混音全空都能骗过宽松断言）。 */

/** 手工拼一个指定 format/bits 的 WAV，用于验证解码分支 */
function makeWav(format, bits, channels, sampleRate, samples) {
  const bytesPer = bits / 8;
  const n = samples.length;
  const dataLen = n * bytesPer * channels;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, format, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * bytesPer, true);
  dv.setUint16(32, channels * bytesPer, true);
  dv.setUint16(34, bits, true);
  str(36, 'data'); dv.setUint32(40, dataLen, true);
  for (let i = 0; i < n; i++) {
    const off = 44 + i * bytesPer;
    if (format === 3) dv.setFloat32(off, samples[i], true);
    else if (bits === 16) dv.setInt16(off, Math.round(samples[i] * 32767), true);
    else if (bits === 24) {
      const v = Math.round(samples[i] * 0x7fffff) & 0xffffff;
      dv.setUint8(off, v & 0xff); dv.setUint8(off + 1, (v >> 8) & 0xff); dv.setUint8(off + 2, (v >> 16) & 0xff);
    } else if (bits === 32) dv.setInt32(off, Math.round(samples[i] * 0x7fffffff), true);
  }
  return { buf, dataOffset: 44, bytesPer };
}
const RAMP = new Float32Array([-0.75, -0.25, 0, 0.25, 0.75]);

t('WAV:24bit 能解出真实样本（不是静默全零）', () => {
  const { buf } = makeWav(1, 24, 1, SR, RAMP);
  const d = A.decodeWav(buf);
  eq(d.samples.length, RAMP.length);
  let maxErr = 0;
  for (let i = 0; i < RAMP.length; i++) maxErr = Math.max(maxErr, Math.abs(d.samples[i] - RAMP[i]));
  ok(maxErr <= 1 / 0x7fffff + 1e-9, `24bit 量化误差 ${maxErr} 过大`);
  ok(d.samples.some(v => v > 0.1), '24bit 解出来全零 —— 走了没有对应分支的 else 链');
  ok(d.samples.some(v => v < -0.1), '24bit 负样本丢失（符号扩展错了）');
});
t('WAV:32bit 浮点被当浮点解（不是当 int32）', () => {
  const { buf } = makeWav(3, 32, 1, SR, RAMP);
  const d = A.decodeWav(buf);
  for (let i = 0; i < RAMP.length; i++) near(d.samples[i], RAMP[i], 1e-6, `样本 ${i}`);
});
t('WAV:16bit 回归', () => {
  const { buf } = makeWav(1, 16, 1, SR, RAMP);
  const d = A.decodeWav(buf);
  for (let i = 0; i < RAMP.length; i++) near(d.samples[i], RAMP[i], 1 / 32767 + 1e-9, `样本 ${i}`);
});

t('混音:漏传 duration 不返回空数组（按轨道推算）', () => {
  const a = new A.AudioTrack({ samples: new Float32Array(SR).fill(0.3), sampleRate: SR });
  const m = A.mixTracks([a]);
  ok(m.length > 0, '漏传 duration 得到长度 0 的数组');
  near(m.length, SR, 3, `长度 ${m.length}`);
  near(m[100], 0.3, 1e-6);
});
t('混音:mixDuration 取起点+长度的最大值', () => {
  const a = new A.AudioTrack({ samples: new Float32Array(SR), sampleRate: SR });
  const b = new A.AudioTrack({ samples: new Float32Array(SR), sampleRate: SR });
  b.start = 2;
  near(A.mixDuration([a, b]), 3, 1e-6);
  near(A.mixDuration([]), 0, 1e-6);
});
t('响度:短音频早退分支也带 truePeakDb', () => {
  const m = A.measureLoudness(new Float32Array(10), SR);
  eq(m.lufs, -70);
  ok('truePeakDb' in m, '早退分支缺 truePeakDb，返回形状不一致');
});

/* ---------- 回归：一键达标必须真的改变导出结果 ---------- */
/* 原来 normalizeToPreset 只返回一份算好的副本，没人用它 ——
   用户看到「已归一到 −14 LUFS」的提示，导出链（main.js 读 App.audioTracks
   重新混音）拿到的却还是原始音量的轨道。比崩溃更隐蔽：静默地说谎。
   下面验「轨道样本真的变了」「能撤销」「报的是导出会得到的响度」。 */
const toneTrack = (sec, amp, kind = 'voice', freq = 220) => {
  const n = Math.round(sec * SR);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin(i / SR * 2 * Math.PI * freq) * amp;
  return new A.AudioTrack({ samples: s, sampleRate: SR, kind });
};

t('归一:轨道样本被真正修改（不再只返回副本）', () => {
  const tr = toneTrack(1, 0.02);
  const orig = tr.samples.slice();
  const desk = new AD.AudioDesk({});
  desk.setTracks([tr]);
  const res = desk.normalizeToPreset('douyin');
  ok(res, '应返回结果');
  let changed = 0;
  for (let i = 0; i < orig.length; i++) if (Math.abs(tr.samples[i] - orig[i]) > 1e-9) changed++;
  ok(changed > orig.length * 0.9, `轨道样本几乎没变（${changed}/${orig.length}）——归一没落到轨道上`);
  // 导出读的就是轨道，所以混音后的响度必须真的接近目标
  const mixed = A.mixTracks([tr], A.mixDuration([tr]));
  near(A.measureLoudness(mixed, SR).lufs, -14, 0.01, '归一后的混音响度');
});

t('归一:返回值报告的响度就是导出会得到的', () => {
  const tr = toneTrack(1, 0.02);
  const desk = new AD.AudioDesk({});
  desk.setTracks([tr]);
  const res = desk.normalizeToPreset('douyin');
  const mixed = A.mixTracks([tr], A.mixDuration([tr]));
  near(res.lufs, A.measureLoudness(mixed, SR).lufs, 0.01, '报告值与实际混音不一致');
  ok(res.before < res.lufs, `原始 ${res.before} 应低于归一后 ${res.lufs}`);
});

t('归一:可以撤销回原始样本', () => {
  const tr = toneTrack(1, 0.02);
  const orig = tr.samples.slice();
  const desk = new AD.AudioDesk({});
  desk.setTracks([tr]);
  desk.normalizeToPreset('douyin');
  eq(desk.editor.ops.length, 1, '操作数');
  eq(desk.editor.ops[0].type, 'gain', '栈顶类型应为 gain（undo 按 backup 还原）');
  desk.editor.undo();
  let diff = 0;
  for (let i = 0; i < orig.length; i++) diff = Math.max(diff, Math.abs(tr.samples[i] - orig[i]));
  eq(diff, 0, '撤销后样本未完全还原');
});

t('归一:多条轨道各自乘 gain（否则下次混音输入还是老的）', () => {
  const v = toneTrack(1, 0.02, 'voice', 220);
  const m = toneTrack(1, 0.03, 'music', 330);
  const mb = A.measureLoudness(m.samples, SR).lufs;
  const desk = new AD.AudioDesk({});
  desk.setTracks([v, m]);
  const res = desk.normalizeToPreset('douyin');
  eq(res.tracks, 2, '参与归一的轨道数');
  ok(A.measureLoudness(m.samples, SR).lufs > mb + 3, 'music 轨道没被抬升');
  eq(v.editor.ops.length, 1, 'voice 的编辑器栈');
  eq(m.editor.ops.length, 1, 'music 的编辑器栈');
});

t('归一:静音/空轨道/无效预设名都不动手', () => {
  const silent = new A.AudioTrack({ samples: new Float32Array(SR), sampleRate: SR });
  const d1 = new AD.AudioDesk({});
  d1.setTracks([silent]);
  eq(d1.normalizeToPreset('douyin'), null, '全静音应返回 null');
  eq(d1.editor.ops.length, 0, '全静音不该污染撤销栈');
  const d2 = new AD.AudioDesk({});
  d2.setTracks([]);
  eq(d2.normalizeToPreset('douyin'), null, '空轨道应返回 null');
  const d3 = new AD.AudioDesk({});
  d3.setTracks([toneTrack(1, 0.02)]);
  eq(d3.normalizeToPreset('不存在的预设'), null, '无效预设名应返回 null');
  eq(d3.editor.ops.length, 0, '无效预设名不该改轨道');
});

/* ---------- 汇总 ---------- */
await Promise.all(pendingTests);   // 等所有异步用例真正跑完再统计
console.log('');
if (fail === 0) console.log(`%c✓ 音频内核自测全部通过 ${pass}/${pass + fail}`, 'color:#38c98b;font-weight:700');
else {
  console.log(`%c✗ ${fail}/${pass + fail} 失败`, 'color:#ff5a5a;font-weight:700');
  for (const f of failures) console.log('  · ' + f);
}
console.log('');
process.exit(fail === 0 ? 0 : 1);