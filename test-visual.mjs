/* ============================================================
   test-visual.mjs · 画面内容断言（用像素而不是肉眼）
   ------------------------------------------------------------
   对每个模板，在指定时间点检查画布上是否真的出现了应有的内容：
     · 标题模板  → 画面中部有亮白文字像素
     · 波形柱    → 底部有多根竖直的彩色柱
     · 柱状图    → 下半部有绿色系矩形
     · 环形频谱  → 中心是空的，四周有环状像素（radial profile）
     · 逐词高亮  → 底部有文字，且有高亮色与普通色两种
   ============================================================ */

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

/* 浏览器定位：优先 CHROME_PATH（由 test-all.mjs 传入），
   其次 playwright 自带的 chromium（CI 上 npx playwright install chromium 装的就是它），
   最后退到系统安装。写死 Windows 路径的话 ubuntu runner 上必然启动失败。 */
function resolveChrome() {
  const env = process.env.CHROME_PATH;
  if (env && existsSync(env)) return env;
  try { const p = chromium.executablePath(); if (p && existsSync(p)) return p; } catch { /* 继续找 */ }
  const la = process.env.LOCALAPPDATA, pf = process.env.PROGRAMFILES;
  const cands = process.platform === 'win32'
    ? [la && join(la, 'Google\\Chrome\\Application\\chrome.exe'), pf && join(pf, 'Google\\Chrome\\Application\\chrome.exe'), pf && join(pf, 'Microsoft\\Edge\\Application\\msedge.exe')]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  const found = cands.filter(Boolean).find(p => existsSync(p));
  if (!found) throw new Error('未找到可用的浏览器，请运行 npx playwright install chromium');
  return found;
}

const here = dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const srv = createServer(async (q, s) => {
  try {
    let p = decodeURIComponent(q.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = join(here, p); await stat(f);
    s.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
    s.end(await readFile(f));
  } catch { s.writeHead(404); s.end(); }
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: resolveChrome(), headless: true });
const page = await (await browser.newContext({ viewport: { width: 1680, height: 1000 } })).newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto('http://127.0.0.1:' + srv.address().port + '/', { waitUntil: 'load' });
// 等应用真正 boot 完，而不是死等固定时长
await page.waitForFunction(() => window.BlockAnim && window.BlockAnim.ready, null, { timeout: 30000 })
  .catch(async () => { await page.waitForTimeout(1000); });   // 没有 ready 标记就退回等一会儿

let fail = 0;
const ok = (c, m, x = '') => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}${x ? '  → ' + x : ''}`); if (!c) fail++; };

/* 载入模板并跳到指定时间。
   不用固定 waitForTimeout：慢机器上 250ms 不够（假失败），
   快机器上又是白等，而且等待时长和实际渲染完成没有必然关系。
   改成等「画布内容确实发生变化」这个真实信号。 */
async function waitForRepaint(page, prevSig) {
  // 画布每一帧都在动，所以不能用「内容稳定」判断；
  // 改成等 requestAnimationFrame 连续跑过若干帧 —— 一帧绘制完成即代表
  // 布局、样式、字体都已就绪，这正是固定 sleep 想赌的东西。
  await page.evaluate(() => new Promise(resolve => {
    let n = 0;
    const tick = () => (++n >= 3 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));
  return page.evaluate(() => {
    const c = document.getElementById('stage');
    const d = c.getContext('2d').getImageData(0, 0, Math.min(c.width, 64), Math.min(c.height, 64)).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s = (s * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0;
    return s;
  });
}

async function load(key, time) {
  await page.evaluate((k) => window.BlockAnim.loadTemplate(k), key);
  // 字体在不同系统上回退到不同字族，字形抗锯齿会让「纯白像素」数量波动；
  // 等字体真正就绪再采样，避免把字体加载竞态当成画面缺失。
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await waitForRepaint(page);
  await page.evaluate((t) => window.BlockAnim.setTime(t), time);
  await waitForRepaint(page);
}

/* 读画布像素做区域统计 */
async function probe() {
  return page.evaluate(() => {
    const c = document.getElementById('stage');
    const W = c.width, H = c.height;
    const d = c.getContext('2d').getImageData(0, 0, W, H).data;
    const px = (x, y) => { const i = ((y | 0) * W + (x | 0)) * 4; return [d[i], d[i + 1], d[i + 2]]; };
    const bg = px(3, 3);
    // 与背景差异明显的像素
    const diff = (p) => Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]);
    // 1) 径向剖面：以中心为心，各环带的「非背景占比」
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2;
    const bands = new Array(10).fill(0), bandTot = new Array(10).fill(0);
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      const r = Math.hypot(x - cx, y - cy) / R;
      const b = Math.min(9, Math.floor(r * 10));
      bandTot[b]++;
      if (diff(px(x, y)) > 40) bands[b]++;
    }
    // 2) 竖直列投影：每列的非背景像素数（看有没有「柱」）
    const colCount = new Array(40).fill(0);
    for (let x = 0; x < W; x++) {
      let n = 0;
      for (let y = 0; y < H; y += 2) if (diff(px(x, y)) > 40) n++;
      colCount[Math.min(39, Math.floor(x / W * 40))] += n;
    }
    // 3) 上下分区：上 1/3 / 中 1/3 / 下 1/3 的非背景占比
    const zones = [0, 0, 0], zoneTot = [0, 0, 0];
    for (let y = 0; y < H; y += 2) {
      const z = Math.min(2, Math.floor(y / H * 3));
      for (let x = 0; x < W; x += 2) { zoneTot[z]++; if (diff(px(x, y)) > 40) zones[z]++; }
    }
    // 4) 高亮色像素（接近 #ffd166 / #38ffd1）
    let bright = 0, highlight = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (r > 200 && g > 200 && b > 200) bright++;
      if ((Math.abs(r - 255) < 60 && Math.abs(g - 209) < 60 && Math.abs(b - 102) < 70) ||
          (Math.abs(r - 56) < 60 && g > 200 && Math.abs(b - 209) < 70)) highlight++;
    }
    return {
      W, H, bg,
      bands: bands.map((v, i) => bandTot[i] ? v / bandTot[i] : 0),
      colCount, zones: zones.map((v, i) => zoneTot[i] ? v / zoneTot[i] : 0),
      bright, highlight,
    };
  });
}

console.log('\n=== 画面内容断言 ===');

/* 1. 逐字弹入标题 @1.5s：中部应有大量亮白像素（文字） */
await load('popTitle', 1.5);
let p = await probe();
const midBright = p.bright;
ok(midBright > 800, `标题模板 @1.5s 有 ${midBright} 个亮白像素（文字已弹出）`);
ok(p.zones[1] > p.zones[0] * 1.5, `中部内容比上部多（上 ${(p.zones[0] * 100).toFixed(1)}% / 中 ${(p.zones[1] * 100).toFixed(1)}%）`);

/* 2. 波形柱 @2s：底部应有多根柱（列投影有多个高值） */
await load('audioBars', 2);
p = await probe();
const highCols = p.colCount.filter(v => v > p.H * 0.10).length;
ok(highCols >= 6, `波形柱 ${highCols} 列明显有内容（应 ≥6）`);
ok(p.zones[2] > 0.05, `下半部有柱状内容 ${(p.zones[2] * 100).toFixed(1)}%`);

/* 3. 数据榜单 @3s：下半部矩形，中心上方/下方有轴 */
await load('barChart', 3);
p = await probe();
const barCols = p.colCount.filter(v => v > p.H * 0.12).length;
ok(barCols >= 3, `柱状图 ${barCols} 根柱子可见`);
ok(p.zones[2] > 0.08, `下部柱体占比 ${(p.zones[2] * 100).toFixed(1)}%`);

/* 4. 环形频谱 @2s：中心应比环带空 */
await load('ring', 2);
p = await probe();
const centerBand = p.bands[0];
const midBands = p.bands.slice(3, 7).reduce((a, b) => a + b, 0) / 4;
ok(centerBand < midBands, `环形频谱中心比环带空（中心 ${(centerBand * 100).toFixed(1)}% < 环带 ${(midBands * 100).toFixed(1)}%）`);
const ringCols = p.colCount.filter(v => v > p.H * 0.10).length;
ok(ringCols >= 6, `频谱条 ${ringCols} 根可见`);

/* 5. 逐词高亮 @3s：底部文字 + 高亮色 */
await load('karaoke', 3);
p = await probe();
const textPx = p.bright + p.highlight;
ok(textPx > 800, `底部字幕有 ${p.bright} 个亮像素 + ${p.highlight} 个高亮像素`);
ok(p.highlight > 60, `有 ${p.highlight} 个高亮色像素（逐词高亮生效）`);
/* 6. 字幕面板：列表与校验结果都渲染出来 */
await page.evaluate(async () => {
  const A = window.BlockAnim;
  A.loadSubtitles({
    id: 'ST1', name: '字幕', styles: null,
    cues: [
      { id: 'c1', start: 0.2, end: 2.4, text: '第一条字幕', secondary: '', styleId: 'karaoke', words: [] },
      { id: 'c2', start: 2.5, end: 4.8, text: '第二条字幕', secondary: 'Second line', styleId: 'karaoke', words: [] },
      { id: 'c3', start: 5.0, end: 7.6, text: '这一句特别特别特别长长长长长长长长长长长长长长用来演示爆字数告警提示的效果啊哈哈哈', secondary: '', styleId: 'karaoke', words: [] },
    ],
  });
  document.querySelector('.tab[data-tab="subtitle"]').click();
  await new Promise(r => setTimeout(r, 200));
  document.querySelector('[data-act="sub.validate"]').click();
  await new Promise(r => setTimeout(r, 250));
});
const subUI = await page.evaluate(() => ({
  rows: document.querySelectorAll('#subList .sub-item').length,
  inputs: document.querySelectorAll('#subList .sub-item input').length,
  issues: document.querySelectorAll('#subIssues div').length,
  styles: document.querySelectorAll('#subStyle option').length,
  hasWarn: !!document.querySelector('#subIssues .warn'),
}));
ok(subUI.rows === 3, `字幕列表 ${subUI.rows} 条`);
ok(subUI.inputs === 6, `主行 + 双语行输入框共 ${subUI.inputs} 个`);
ok(subUI.styles >= 4, `样式下拉 ${subUI.styles} 项`);
ok(subUI.hasWarn, '爆字数告警应出现');

/* 7. 节点图：真的画出了节点与连线 */
await page.evaluate(async () => {
  const A = window.BlockAnim;
  // popTitle 的标题图层有 4 个块、若干连线，最能体现投影效果
  A.loadTemplate('popTitle');
  await new Promise(r => setTimeout(r, 400));
  A.selectLayer(A.ir.layers[1].id);
  await new Promise(r => setTimeout(r, 150));
  document.querySelector('[data-act="node.fromBlocks"]').click();
  await new Promise(r => setTimeout(r, 300));
});
const nodeUI = await page.evaluate(() => ({
  nodes: document.querySelectorAll('#nodeLayer .nnode').length,
  paths: document.querySelectorAll('#nodeSvg path').length,
  arrows: document.querySelectorAll('#nodeSvg polygon').length,
  ports: document.querySelectorAll('#nodeLayer .nport').length,
  report: (document.querySelector('#nodeReport') || {}).textContent || '',
}));
ok(nodeUI.nodes >= 4, `画出了 ${nodeUI.nodes} 个节点`);
ok(nodeUI.paths >= 3, `画出了 ${nodeUI.paths} 条连线`);
ok(nodeUI.arrows >= 3, `画出了 ${nodeUI.arrows} 个箭头`);
ok(nodeUI.ports >= 6, `画出了 ${nodeUI.ports} 个端口`);
ok(nodeUI.report.length > 0, '往返报告应有内容');

/* 8. 音频台：波形真的画出来了，响度/峰值/BPM 都有值 */
await page.evaluate(async () => {
  const A = window.BlockAnim;
  const sr = 48000, dur = 12, n = sr * dur;
  const buf = new Float32Array(n);
  // 120 BPM 的鼓点（每 0.5s 一次）+ 间歇人声段，中间留白让节拍检测能分辨
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const ph = (t % 0.5) / 0.5;
    let v = Math.sin(2 * Math.PI * 60 * t) * Math.exp(-ph * 12) * 0.8;
    const inVoice = (t > 1.6 && t < 4.4) || (t > 6.6 && t < 9.4);
    if (inVoice) v += Math.sin(2 * Math.PI * 220 * t) * 0.18;
    buf[i] = Math.max(-1, Math.min(1, v));
  }
  A.setAudio(buf, sr, { name: '测试', kind: 'music' });
  document.querySelector('.tab[data-tab="audio"]').click();
  await new Promise(r => setTimeout(r, 400));
});
const waveUI = await page.evaluate(() => {
  const cv = document.querySelector('#waveCanvas');
  const ctx = cv.getContext('2d');
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4 * 7) {
    if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
  }
  return {
    lit,
    bpm: document.querySelector('#bpmVal').textContent,
    loud: document.querySelector('#loudVal').textContent,
    peak: document.querySelector('#peakVal').textContent,
    status: window.BlockAnim.audioStatus(),
  };
});
ok(waveUI.lit > 100, `波形画布上有 ${waveUI.lit} 个采样点被点亮`);
ok(/^\d+$/.test(waveUI.bpm), `BPM 显示「${waveUI.bpm}」`);
ok(Math.abs(waveUI.status.bpm - 120) <= 6, `检出 BPM ${waveUI.status.bpm}，应接近 120`);
ok(/LUFS/.test(waveUI.loud), `响度显示「${waveUI.loud}」`);
ok(/dB/.test(waveUI.peak), `峰值显示「${waveUI.peak}」`);
ok(waveUI.status.peak < 0 && waveUI.status.peak > -40, `峰值 ${waveUI.status.peak} dB 在合理范围`);

/* 9. 数据面板：表格真的渲染了单元格 */
await page.evaluate(async () => {
  const A = window.BlockAnim;
  A.loadTemplate('barChart');
  document.querySelector('.tab[data-tab="data"]').click();
  document.querySelector('[data-act="data.paste"]').click();
  await new Promise(r => setTimeout(r, 200));
  document.querySelector('#modalBody textarea').value =
    '产品,价格,销量\n星火,99,12800\n声波,149,6400';
  const btns = [...document.querySelectorAll('#modalFoot button')];
  btns[btns.length - 1].click();
  await new Promise(r => setTimeout(r, 300));
  A.scanDataBindings();
  await new Promise(r => setTimeout(r, 200));
});
const dataUI2 = await page.evaluate(() => ({
  cells: document.querySelectorAll('#dataPreview .data-table td').length,
  headers: [...document.querySelectorAll('#dataPreview .data-table th')].map(t => t.textContent),
  numCells: document.querySelectorAll('#dataPreview .data-table td.num').length,
  binds: document.querySelectorAll('#bindList .bind-row').length,
}));
ok(dataUI2.cells === 6, `表格 ${dataUI2.cells} 个数据单元格`);
ok(dataUI2.headers.join(',') === '产品,价格,销量', `表头「${dataUI2.headers.join(',')}」`);
ok(dataUI2.numCells === 4, `${dataUI2.numCells} 个数值列`);
ok(dataUI2.binds > 0, `列出 ${dataUI2.binds} 个可绑定位置`);

/* 10. 场景树：组与实例在树上可见 */
await page.evaluate(async () => {
  const A = window.BlockAnim;
  A.loadTemplate('popTitle');
  await new Promise(r => setTimeout(r, 300));
  A.selectLayer(A.ir.layers[1].id);
  document.querySelector('[data-act="scene.group"]').click();
  await new Promise(r => setTimeout(r, 200));
  A.selectLayer(A.ir.layers[1].id);
  document.querySelector('[data-act="scene.instance"]').click();
  await new Promise(r => setTimeout(r, 200));
  document.querySelector('[data-act="scene.place"]').click();
  await new Promise(r => setTimeout(r, 300));
});
const sceneUI2 = await page.evaluate(() => ({
  groups: document.querySelectorAll('#layerTree .tree-row.is-group').length,
  children: document.querySelectorAll('#layerTree .tree-child').length,
  instances: window.BlockAnim.sceneMasters().length,
  layers: window.BlockAnim.ir.layers.length,
}));
ok(sceneUI2.groups >= 1, `树上显示 ${sceneUI2.groups} 个组`);
ok(sceneUI2.children >= 1, `组下显示 ${sceneUI2.children} 个子节点`);
ok(sceneUI2.instances >= 1, `登记了 ${sceneUI2.instances} 个主组件`);
ok(sceneUI2.layers === 4, `插入实例后 ${sceneUI2.layers} 个图层`);

ok(errs.length === 0, '全程无 JS 报错', errs.slice(0, 2).join(' | '));

await browser.close(); srv.close();
console.log(fail === 0 ? '\n画面内容全部符合预期 ✓\n' : `\n${fail} 项不符合 ✗\n`);
process.exit(fail === 0 ? 0 : 1);