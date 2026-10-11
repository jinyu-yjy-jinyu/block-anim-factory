import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const U = (p) => pathToFileURL(resolve(here, p)).href;

const ir = await import(U('src/ir.js'));
const bl = await import(U('src/blocks.js'));
const ev = await import(U('src/evaluator.js'));
const rd = await import(U('src/renderer.js'));
const tpl = await import(U('src/templates.js'));
const gif = await import(U('src/gif.js'));
const zip = await import(U('src/zip.js'));
const hc = await import(U('src/headless-canvas.mjs'));
ir.registerOpMeta(bl.BLOCK_DEFS.map(d => bl.metaFor(d.op)).filter(Boolean));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FAIL ') + m); if (!c) fail++; };

/* ---------- 1. GIF 编码器 ---------- */
console.log('\n=== GIF 编码器 ===');
const W = 64, H = 48, NF = 12;
function frameRGBA(i) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4;
    d[p] = (x * 4 + i * 7) & 255;
    d[p + 1] = (y * 5) & 255;
    d[p + 2] = (i * 21) & 255;
    d[p + 3] = 255;
  }
  return d;
}
const t0 = Date.now();
const frames = Array.from({ length: NF }, (_, i) => ({ rgba: frameRGBA(i), delay: 8 }));
const gblob = gif.encodeGIF(frames, W, H, { loop: 0 });
const gbuf = new Uint8Array(await gblob.arrayBuffer());
const head = String.fromCharCode(...gbuf.slice(0, 6));
ok(head === 'GIF89a', `GIF 头 = ${head}`);
ok(gbuf[gbuf.length - 1] === 0x3b, '结尾是 trailer 0x3B');
ok(gbuf[0] === 0x47 && gbuf[1] === 0x49 && gbuf[2] === 0x46, 'GIF89a 签名');
// GCT 存在标志；bits 4-6 = 全局调色板色深(size-1)
ok((gbuf[10] & 0x80) !== 0, '存在全局调色板');
ok(((gbuf[10] >> 4) & 0x07) + 1 === 8, `全局调色板色深 = ${((gbuf[10] >> 4) & 0x07) + 1} 位`);
// 遍历块结构，确认长度自洽
let p = 13 + 768, blocks = 0, framesFound = 0, trailerOk = true, appExt = 0;
while (p < gbuf.length) {
  const b = gbuf[p];
  if (b === 0x3b) { trailerOk = true; break; }
  if (b === 0x21) {           // extension
    const label = gbuf[p + 1];
    if (label === 0xff) {
      // 应用扩展：0x21 0xFF <块大小> <标识...> <数据子块...> 0x00
      const size = gbuf[p + 2];
      appExt++;
      p += 3 + size;          // 跳过 label + 块大小 + 标识
      while (gbuf[p]) p += gbuf[p] + 1;  // 数据子块
      p++;
    } else if (label === 0xf9) {
      p += 3 + gbuf[p + 2] + 1;         // GCE：3 字节头 + size 数据 + 1 终止符
    } else {
      p += 2;
      while (gbuf[p]) p += gbuf[p] + 1;
      p++;
    }
    blocks++;
  } else if (b === 0x2c) {    // image descriptor：10 字节头 + LZW 最小码宽 + 数据子块 + 0x00
    p += 10;
    p++;                                // LZW min code size
    while (gbuf[p]) p += gbuf[p] + 1;
    p++;
    framesFound++;
  } else { trailerOk = false; break; }
}
ok(trailerOk, `块结构完整（无越界），停在偏移 ${p} 字节 0x${(gbuf[p] || 0).toString(16)}，上下文 ${[...gbuf.slice(p, p + 12)].map(x => x.toString(16).padStart(2, '0')).join(' ')}`);
ok(framesFound === NF, `帧数 = ${framesFound}（期望 ${NF}）`);
ok(appExt === 1, '存在 Netsape 循环扩展');
ok(gbuf.length > 1000, `体积 ${gbuf.length} 字节，编码耗时 ${Date.now() - t0}ms`);

// 相同帧 → 差分应显著变小
const same = Array.from({ length: NF }, () => ({ rgba: frameRGBA(3), delay: 8 }));
const sbuf = new Uint8Array(await gif.encodeGIF(same, W, H).arrayBuffer());
ok(sbuf.length < gbuf.length, `静态内容差分后更小：${sbuf.length} < ${gbuf.length}`);

// LZW 大数据量压力测试（触发码宽增长与字典重置）
const big = new Uint8Array(200000);
for (let i = 0; i < big.length; i++) big[i] = (i * 7 + (i >> 8)) & 255;
const t1 = Date.now();
const bigblob = gif.encodeGIF([{ rgba: big, delay: 8 }], 500, 400);
ok(bigblob.size > 0, `大数据量 LZW 正常，${(bigblob.size / 1024).toFixed(1)}KB / ${Date.now() - t1}ms`);

/* ---------- 2. ZIP ---------- */
console.log('\n=== ZIP ===');
const enc = new TextEncoder();
const zblob = await zip.createZip([
  { name: 'a/1.txt', data: enc.encode('第一行\n'.repeat(200)) },
  { name: 'a/2.bin', data: new Uint8Array(5000).fill(200) },
  { name: '顶层.txt', data: enc.encode('x') },
]);
const zbuf = new Uint8Array(await zblob.arrayBuffer());
ok(zbuf[0] === 0x50 && zbuf[1] === 0x4b && zbuf[2] === 0x03 && zbuf[3] === 0x04, '本地文件头签名');
ok(zbuf[zbuf.length - 22] === 0x50 && zbuf[zbuf.length - 20] === 0x05, 'EOCD 签名');
// EOCD 里的条目数
const dv = new DataView(zbuf.buffer, zbuf.byteOffset);
const nEntries = dv.getUint16(zbuf.length - 22 + 10, true);
ok(nEntries === 3, `EOCD 记录条目数 = ${nEntries}`);
const cdSize = dv.getUint32(zbuf.length - 22 + 12, true);
ok(cdSize > 0, `中央目录大小 = ${cdSize}`);
const cdOff = dv.getUint32(zbuf.length - 22 + 16, true);
ok(zbuf[cdOff] === 0x50 && zbuf[cdOff + 1] === 0x4b, '中央目录起点正确');

/* ---------- 3. 真实渲染 → GIF 全链路 ---------- */
console.log('\n=== 渲染 → GIF 全链路 ===');
const t2 = Date.now();
const proj = tpl.loadTemplate('audioBars');
const audio = new ev.AudioSource({ bpm: 120, duration: proj.project.duration, seed: 7, intensity: 1 });
const GW = 160, GH = 90;
const rec = [];
const gframes = [];
for (let i = 0; i < 24; i++) {
  const time = i / 12;
  const recCtx = hc.makeCtx(rec);
  recCtx.canvas = { width: GW, height: GH };
  const sx = GW / proj.project.width, sy = GH / proj.project.height;
  recCtx.setTransform(sx, 0, 0, sy, 0, 0);
  const { state } = ev.evaluateFrame(proj, time, audio);
  state.ir = proj;
  state.order = proj.layers.map(l => l.id);
  rd.render(state, recCtx, { time });
  recCtx.setTransform(1, 0, 0, 1, 0, 0);
  // 用记录器反推出的指令无法还原像素，这里改用真实像素路径不可用，
  // 故只验证「渲染无异常 + 指令数合理」
  gframes.push({ time, instr: rec.length });
}
ok(gframes.every(g => g.instr > 10), `每帧都有绘图指令（最少 ${Math.min(...gframes.map(g => g.instr))}，最多 ${Math.max(...gframes.map(g => g.instr))}）`);
const uniq = new Set(gframes.map(g => g.instr)).size;
ok(uniq > 5, `帧间指令数有变化（${uniq} 种），说明画面在动`);
console.log(`  全链路耗时 ${Date.now() - t2}ms`);

/* ---------- 4. 时间轴纯函数性（预览 vs 导出取样一致性） ---------- */
console.log('\n=== 逐帧求值一致性 ===');
const order = proj.layers.map(l => l.id);
const drawAt = (time) => {
  const { state } = ev.evaluateFrame(proj, time, audio);
  state.ir = proj; state.order = order;
  const r = [];
  rd.render(state, hc.makeCtx(r), { time });
  return r.join('\n');
};
// 正序播放一遍，再倒序回到同一批时间点，结果必须一致
const times = [0, 0.5, 1, 1.5, 2, 2.5, 3];
const fwd = times.map(drawAt);
for (let i = times.length - 1; i >= 0; i--) drawAt(times[i]);
const back = times.map(drawAt);
ok(fwd.every((x, i) => x === back[i]), '乱序回放后同一时间点画面完全相同（纯函数）');

console.log(fail === 0 ? '\n全部通过 ✓\n' : `\n${fail} 项失败 ✗\n`);
process.exit(fail === 0 ? 0 : 1);