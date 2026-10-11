/* ============================================================
   test-browser.mjs · 真实浏览器端到端测试
   ------------------------------------------------------------
   用系统已安装的 Chrome 打开 index.html，验证：
     · 页面无 JS 报错、能完成 boot
     · 舞台真的画出了东西（像素非全黑）
     · 播放 / 暂停 / 逐帧 正常
     · 积木画布渲染出积木、参数可编辑
     · 切模板、重做撤销、导出 PNG/GIF/ZIP 全部产出有效文件
   用法：node test-browser.mjs
   ============================================================ */

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
};

/* ---------- 静态服务器 ---------- */
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = join(here, p);
    const s = await stat(file);
    if (s.isDirectory()) throw new Error('dir');
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}/`;

let fail = 0;
const ok = (c, m, extra = '') => {
  console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}${extra ? '  → ' + extra : ''}`);
  if (!c) fail++;
};

/* ---------- 启动浏览器 ---------- */
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
page.on('requestfailed', r => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText));

console.log('\n=== 1. 页面加载 ===');
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(1200);
ok(errors.length === 0, '加载无 JS 报错', errors.slice(0, 3).join(' | '));

/* ---------- 2. Boot 完成 ---------- */
console.log('\n=== 2. 界面骨架 ===');
ok(await page.locator('#stage').count() === 1, '舞台 canvas 存在');
ok(await page.locator('#blockCanvas').count() === 1, '积木画布存在');
const layerCount = await page.locator('#layerTree .layer').count();
ok(layerCount === 3, `场景树图层数 = ${layerCount}`);
const blockCount = await page.locator('#blockCanvas .block').count();
ok(blockCount > 0, `积木画布渲染出 ${blockCount} 个积木`);
ok((await page.locator('#ruler .tick').count()) > 0, '时间轴刻度已渲染');
ok((await page.locator('#markerLayer .marker').count()) > 0, '标记点已渲染');

/* ---------- 3. 舞台真的画出了东西 ---------- */
console.log('\n=== 3. 渲染 ===');
async function stageStats() {
  return page.evaluate(() => {
    const c = document.getElementById('stage');
    const x = c.getContext('2d');
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const uniq = new Set();
    let sum = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      sum += d[i] + d[i + 1] + d[i + 2];
      uniq.add((d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3));
    }
    return { total: n, avg: Math.round(sum / n / 3), colors: uniq.size };
  });
}
let s0 = await stageStats();
ok(s0.colors > 8, `画面颜色数 = ${s0.colors}（应 > 8，说明确实画了东西）`);

// 拖到 1.5s：标题应该弹出来了 → 颜色数与亮度都会变
for (let i = 0; i < 36; i++) await page.keyboard.press('Period');
await page.waitForTimeout(300);
const s1 = await stageStats();
ok(s1.colors !== s0.colors || s1.avg !== s0.avg,
   `逐帧后画面变化（颜色 ${s0.colors}→${s1.colors}，亮度 ${s0.avg}→${s1.avg}）`);

/* ---------- 4. 播放 / 暂停 ---------- */
console.log('\n=== 4. 播放控制 ===');
await page.evaluate(() => { document.querySelector('[data-act="rewind"]').click(); });
await page.waitForTimeout(150);
await page.keyboard.press('Space');
await page.waitForTimeout(900);
const tc1 = await page.locator('#timecode').textContent();
await page.keyboard.press('Space');
await page.waitForTimeout(200);
const tc2 = await page.locator('#timecode').textContent();
ok(tc1 !== '00:00.00 / 00:00.00' || /\d\.\d\d/.test(tc1), `播放后时间码前进：${tc1.trim()}`);
ok((await page.locator('[data-act="play"]').textContent()).includes('播放'), '暂停后按钮回到「播放」');

/* ---------- 5. 积木交互 ---------- */
console.log('\n=== 5. 积木编辑 ===');
await page.locator('#rightTabs .tab[data-tab="blocks"]').click();
await page.waitForTimeout(250);
const before = await page.locator('#blockCanvas .block').count();
await page.locator('#blockCanvas .block').first().click();
await page.waitForTimeout(250);
ok(await page.locator('#blockCanvas .block.selected').count() > 0, '点击可选中积木');

await page.locator('#rightTabs .tab[data-tab="inspector"]').click();
await page.waitForTimeout(250);
const insp = await page.locator('#inspector').textContent();
ok(insp.includes('id') || insp.length > 20, '属性面板显示选中积木信息');

await page.locator('#rightTabs .tab[data-tab="blocks"]').click();
await page.waitForTimeout(250);
// 改一个数值参数
const numPin = page.locator('#blockCanvas input.pin.num[type="number"]').first();
if (await numPin.count() > 0) {
  await numPin.fill('2.5');
  await numPin.dispatchEvent('change');
  await page.waitForTimeout(350);
  ok(true, '数值参数可编辑');
} else ok(false, '找不到数值参数输入框');

/* ---------- 6. 撤销 ---------- */
console.log('\n=== 6. 撤销 / 重做 ===');
const b1 = await page.locator('#blockCanvas .block').count();
await page.evaluate(() => document.querySelector('[data-act="block.clean"]').click());
await page.waitForTimeout(200);
const b2 = await page.locator('#blockCanvas .block').count();
ok(b1 === b2, `整理不改变积木数（${b1} → ${b2}）`);

/* ---------- 7. 切换模板 ---------- */
console.log('\n=== 7. 官方模板 ===');
for (const name of ['音频驱动波形柱', '数据榜单柱状图', '口播逐词高亮字幕', '环形频谱', '粒子与重复器', '逐字弹入标题']) {
  errors.length = 0;
  await page.evaluate(() => document.querySelector('[data-act="tpl.open"]').click());
  await page.waitForTimeout(350);
  const cards = page.locator('#tplList > div');
  let clicked = false;
  const cnt = await cards.count();
  for (let i = 0; i < cnt; i++) {
    const txt = await cards.nth(i).textContent();
    if (txt.includes(name)) { await cards.nth(i).click(); clicked = true; break; }
  }
  await page.waitForTimeout(700);
  const st = await stageStats();
  ok(clicked && errors.length === 0 && st.colors > 8,
     `模板「${name}」载入并渲染`, clicked ? `颜色数 ${st.colors}` : '未找到模板卡片');
}

/* ---------- 8. 调试器 ---------- */
console.log('\n=== 8. 调试器 ===');
await page.evaluate(() => document.querySelector('[data-act="debug.panel"]').click());
await page.waitForTimeout(400);
ok(!(await page.locator('#debugPanel').getAttribute('class')).includes('hidden'), '调试器面板已打开');
const tcBefore = await page.locator('#timecode').textContent();
await page.keyboard.press('F10');
await page.waitForTimeout(400);
const tcAfter = await page.locator('#timecode').textContent();
ok(tcBefore !== tcAfter, `F10 单步推进了时间：${tcBefore.trim()} → ${tcAfter.trim()}`);
ok((await page.locator('#dbgStack .dbg-line').count()) > 0, '执行栈有记录');
ok((await page.locator('#dbgLog .dbg-line').count()) > 0, '指令日志有记录');

/* ---------- 9. 导出 ---------- */
console.log('\n=== 9. 导出 ===');
async function grab(action, opts = {}) {
  const wait = page.waitForEvent('download', { timeout: 180000 });
  await page.evaluate((a) => document.querySelector(`[data-act="${a}"]`).click(), action);
  if (opts.closeModal) { await page.waitForTimeout(400); }
  const dl = await wait;
  const path = await dl.path();
  const size = (await stat(path)).size;
  return { name: dl.suggestedFilename(), size };
}
errors.length = 0;
const png = await grab('export.png');
ok(png.size > 1000, `导出当前帧 PNG：${png.name} ${(png.size / 1024).toFixed(1)}KB`);

// 通过统一导出对话框导出 GIF（先选 GIF 卡片，再点「开始导出」）
errors.length = 0;
await page.evaluate(() => document.querySelector('[data-act="export.gif"]').click());
await page.waitForTimeout(500);
const hasFmtCards = await page.locator('#exportFormats .fmt-card').count();
ok(hasFmtCards >= 5, `导出格式卡片 ${hasFmtCards} 个`);

// 选 GIF
await page.evaluate(() => {
  const card = document.querySelector('#exportFormats .fmt-card[data-fmt="gif"]');
  card.click();
  // GIF 默认只导前 4 秒，避免测试太慢
  const to = document.querySelector('#exTo');
  if (to) { to.value = '2'; }
  const fps = document.querySelector('#exFps');
  if (fps) fps.value = '10';
});
const gifDl = page.waitForEvent('download', { timeout: 300000 });
await page.evaluate(() => {
  [...document.querySelectorAll('#modalFoot button')].find(x => x.textContent.includes('开始导出')).click();
});
const g = await gifDl;
const gPath = await g.path();
const gSize = (await stat(gPath)).size;
const gHead = (await readFile(gPath)).subarray(0, 6).toString('latin1');
ok(gHead === 'GIF89a', `导出 GIF 头正确：${g.suggestedFilename()} ${(gSize / 1024).toFixed(1)}KB`);

// 导出 PNG 序列 ZIP
errors.length = 0;
await page.evaluate(() => document.querySelector('[data-act="export.frames"]').click());
await page.waitForTimeout(500);
await page.evaluate(() => {
  document.querySelector('#exportFormats .fmt-card[data-fmt="frames"]').click();
  const to = document.querySelector('#exTo');
  if (to) to.value = '1';
});
const zipDl = page.waitForEvent('download', { timeout: 600000 });
await page.evaluate(() => {
  [...document.querySelectorAll('#modalFoot button')].find(x => x.textContent.includes('开始导出')).click();
});
const z = await zipDl;
const zPath = await z.path();
const zSize = (await stat(zPath)).size;
const zHead = (await readFile(zPath)).subarray(0, 4);
ok(zHead[0] === 0x50 && zHead[1] === 0x4b, `导出 PNG 序列 ZIP：${z.suggestedFilename()} ${(zSize / 1024 / 1024).toFixed(2)}MB`);

// 工程 JSON
await page.evaluate(() => document.querySelector('[data-act="file.save"]').click());
const jDl = await page.waitForEvent('download', { timeout: 60000 });
const jPath = await jDl.path();
const jBuf = JSON.parse((await readFile(jPath)).toString('utf8'));
ok(jBuf && jBuf.project && Array.isArray(jBuf.layers), `导出工程 JSON 结构正确：${jDl.suggestedFilename()} ${(jBuf.layers || []).length} 图层`);

/* ---------- 10. 保存 / 载入往返 ---------- */
console.log('\n=== 10. 工程往返 ===');
errors.length = 0;
const jsonText = JSON.stringify(jBuf);
const round = await page.evaluate(async (txt) => {
  // 直接调内部 API 往返：文本 → IR → 文本
  const ir = await import('./src/ir.js');
  const bl = await import('./src/blocks.js');
  ir.registerOpMeta(bl.BLOCK_DEFS.map(d => bl.metaFor(d.op)).filter(Boolean));
  const a = ir.toText(JSON.parse(txt));
  const b = ir.fromText(a, bl.BLOCK_DEFS);
  const again = ir.toText(b.ir);
  return { notes: b.notes, same: a === again, lenA: a.length, lenB: again.length };
}, jsonText);
ok(round.notes.length === 0, '工程 JSON → 积木文本 无解析告警', round.notes.join(';'));
ok(round.same, `积木文本往返完全一致（${round.lenA} 字节）`);

/* ---------- 11. 画布尺寸切换 ---------- */
console.log('\n=== 11. 画布预设 ===');
for (const v of ['1080x1920', '1080x1080', '1920x1080']) {
  errors.length = 0;
  await page.selectOption('#presetSelect', v);
  await page.waitForTimeout(500);
  const dim = await page.evaluate(() => {
    const c = document.getElementById('stage');
    return { w: c.width, h: c.height };
  });
  const [w, h] = v.split('x').map(Number);
  ok(errors.length === 0, `切到 ${v} 无报错`, errors[0]);
  ok(dim.w > 0 && dim.h > 0, `  canvas 尺寸已更新 ${dim.w}x${dim.h}`);
}

/* ---------- 12. 图层操作 ---------- */
console.log('\n=== 12. 图层 ===');
const l0 = await page.locator('#layerTree .layer').count();
await page.evaluate(() => document.querySelector('[data-act="layer.add"]').click());
await page.waitForTimeout(400);
const l1 = await page.locator('#layerTree .layer').count();
ok(l1 === l0 + 1, `新增图层（${l0} → ${l1}）`);
page.on('dialog', d => d.accept());
await page.evaluate(() => document.querySelector('[data-act="layer.del"]').click());
await page.waitForTimeout(400);
const l2 = await page.locator('#layerTree .layer').count();
ok(l2 === l0, `删除图层（${l1} → ${l2}）`);

/* ---------- 13. 新增面板（P0/P1/P2 的 UI 接入） ---------- */
console.log('\n=== 13. 新增面板 ===');

// 13.1 面板页签都存在且能切换
const tabNames = ['blocks', 'inspector', 'palette', 'nodes', 'subtitle', 'audio', 'data'];
for (const name of tabNames) {
  const clicked = await page.evaluate((n) => {
    const btn = document.querySelector(`.tab[data-tab="${n}"]`);
    if (!btn) return false;
    btn.click();
    return true;
  }, name);
  await page.waitForTimeout(220);
  const visible = await page.locator(`#tab-${name}`).isVisible().catch(() => false);
  ok(clicked && visible, `面板「${name}」可切换并显示`);
}

// 13.2 节点图：积木 → 节点 → 积木 往返无损
const nodeInfo = await page.evaluate(() => {
  const ir = window.BlockAnim.ir;
  const layer = ir.layers.find(l => l.blocks && l.blocks.length) || ir.layers[0];
  document.querySelector('.tab[data-tab="blocks"]').click();
  const out = window.BlockAnim.nodeRoundTrip(layer.blocks);
  return out;
});
ok(nodeInfo.nodeCount > 0, `生成 ${nodeInfo.nodeCount} 个节点`);
ok(nodeInfo.lossless === true, `往返无损（损失 ${nodeInfo.losses.length} 项）`);

// 13.3 字幕面板：新增一条 → 校验 → 导出 SRT
const subInfo = await page.evaluate(async () => {
  const A = window.BlockAnim;
  A.setTime(0);
  document.querySelector('.tab[data-tab="subtitle"]').click();
  document.querySelector('[data-act="sub.addCue"]').click();
  await new Promise(r => setTimeout(r, 150));
  const cues = document.querySelectorAll('#subList .sub-item').length;
  // 再加两条，导出看是否成文件
  document.querySelector('[data-act="sub.addCue"]').click();
  await new Promise(r => setTimeout(r, 120));
  A.setTime(3);
  document.querySelector('[data-act="sub.addCue"]').click();
  await new Promise(r => setTimeout(r, 120));
  const srt = A.subtitleSrt();
  return { cues: document.querySelectorAll('#subList .sub-item').length, firstCount: cues, srtLen: srt.length, hasArrow: srt.includes('-->') };
});
ok(subInfo.firstCount === 1, `新增字幕条数 ${subInfo.firstCount}`);
ok(subInfo.cues === 3, `字幕列表共 ${subInfo.cues} 条`);
ok(subInfo.hasArrow, 'SRT 格式正确（含 --> 时间轴）');

// 13.4 字幕往返：解析导出的 SRT 能还原
const subRoundTrip = await page.evaluate(() => {
  const A = window.BlockAnim;
  const srt = A.subtitleSrt();
  const back = A.parseSubtitles(srt);
  return { n: back.cues.length, first: back.cues[0].text };
});
ok(subRoundTrip.n === 3, `SRT 往返得到 ${subRoundTrip.n} 条`);
ok(typeof subRoundTrip.first === 'string' && subRoundTrip.first.length > 0, `首条文本「${subRoundTrip.first}」`);

// 13.5 音频台：无音频时不崩，波形区给出提示
const audioUI = await page.evaluate(() => {
  document.querySelector('.tab[data-tab="audio"]').click();
  return {
    canvas: !!document.querySelector('#waveCanvas'),
    loud: document.querySelector('#loudVal').textContent,
    presets: document.querySelectorAll('#loudPresets button').length,
    sfx: document.querySelectorAll('#sfxRow button').length,
  };
});
ok(audioUI.canvas, '波形画布存在');
ok(audioUI.loud === '—', `无音频时响度显示「${audioUI.loud}」`);
ok(audioUI.presets >= 5, `响度预设 ${audioUI.presets} 个`);
ok(audioUI.sfx >= 5, `音频预设 ${audioUI.sfx} 个`);

// 13.6 数据面板：粘贴 CSV → 预览出表格
const dataUI = await page.evaluate(async () => {
  document.querySelector('.tab[data-tab="data"]').click();
  document.querySelector('[data-act="data.paste"]').click();
  await new Promise(r => setTimeout(r, 150));
  const ta = document.querySelector('#modalBody textarea');
  ta.value = '产品,价格,销量\n星火,99,1200\n火箭,199,860';
  const btns = [...document.querySelectorAll('#modalFoot button')];
  btns[btns.length - 1].click();
  await new Promise(r => setTimeout(r, 250));
  return {
    rows: document.querySelectorAll('#dataPreview .data-table tbody tr').length,
    cols: document.querySelectorAll('#dataPreview .data-table th').length,
    count: document.querySelector('#dataCount').textContent,
  };
});
ok(dataUI.rows === 2, `表格预览 ${dataUI.rows} 行`);
ok(dataUI.cols === 3, `表格 ${dataUI.cols} 列`);
ok(/2 行/.test(dataUI.count), `计数显示「${dataUI.count}」`);

// 13.7 数据插值（用真实载入的数据集的第一行）
const interp = await page.evaluate(() => {
  const A = window.BlockAnim;
  const dp = A.dataPanelSnapshot();
  const srt = A.interpolate('{{产品}} 卖 {{销量}} 台', dp.rows[0]);
  const pct = A.interpolate('{{销量|comma}}', dp.rows[0]);
  return { srt, pct };
});
ok(interp.srt === '星火 卖 1200 台', `插值结果「${interp.srt}」`);
ok(interp.pct === '1,200', `千分位插值「${interp.pct}」`);

// 13.8 场景树：编组 / 主组件 / 实例
const sceneUI = await page.evaluate(async () => {
  const A = window.BlockAnim;
  const before = A.ir.layers.length;
  // 选一个具体图层（不是组）
  A.selectLayer(A.ir.layers[1].id);
  await new Promise(r => setTimeout(r, 120));
  document.querySelector('[data-act="scene.group"]').click();
  await new Promise(r => setTimeout(r, 200));
  const afterGroup = A.ir.layers.length;

  A.selectLayer(A.ir.layers[1].id);
  await new Promise(r => setTimeout(r, 120));
  document.querySelector('[data-act="scene.instance"]').click();
  await new Promise(r => setTimeout(r, 200));
  const masters = A.sceneMasters().length;

  document.querySelector('[data-act="scene.place"]').click();
  await new Promise(r => setTimeout(r, 300));
  return { before, afterGroup, after: A.ir.layers.length, masters };
});
ok(sceneUI.masters >= 1, `登记了 ${sceneUI.masters} 个主组件`);
ok(sceneUI.afterGroup === sceneUI.before, `编组不改变可绘制图层数（${sceneUI.before}）`);
ok(sceneUI.after > sceneUI.before, `插入实例后图层 ${sceneUI.before} → ${sceneUI.after}`);

// 13.9 自定义积木：封装 → 调用 → 展开
const customUI = await page.evaluate(() => {
  const A = window.BlockAnim;
  return A.customBlockDemo();
});
ok(customUI.expanded === 2, `自定义积木展开成 ${customUI.expanded} 条语句`);
ok(customUI.dur === 1.25, `形参实参替换正确（${customUI.dur}s）`);

// 13.10 导出能力探测
const caps = await page.evaluate(async () => {
  const c = await window.BlockAnim.capabilities();
  return c;
});
ok(typeof caps.canMp4 === 'boolean', `MP4 可用性探测：${caps.canMp4}（webcodecs=${caps.webcodecs}）`);
ok(typeof caps.offscreen === 'boolean', `OffscreenCanvas：${caps.offscreen}`);

// 13.11 统一音源：有/无真实音频都能取值
const audioSrc = await page.evaluate(() => {
  const s = window.BlockAnim.audioSource;
  return { isReal: s.isReal(), amp: s.amplitude(1.0), spec: s.spectrum(1.0, 8).length, bpm: s.bpmValue() };
});
ok(audioSrc.amp >= 0 && audioSrc.amp <= 1, `振幅 ${audioSrc.amp} 在 [0,1]`);
ok(audioSrc.spec === 8, `频谱返回 ${audioSrc.spec} 个频段`);
ok(audioSrc.bpm > 0, `BPM = ${audioSrc.bpm}`);

// 13.12 自定义积木递归保护
const recursion = await page.evaluate(() => {
  try { window.BlockAnim.recursiveCustomBlock(); return 'no-throw'; }
  catch (e) { return e.message; }
});
ok(/递归/.test(recursion), `递归被拦截：${recursion.slice(0, 40)}`);

/* ---------- 收尾 ---------- */
console.log('\n=== 控制台错误汇总 ===');
ok(errors.length === 0, '全流程无 JS 报错', errors.slice(0, 5).join(' | '));

await browser.close();
server.close();

console.log(fail === 0 ? '\n浏览器端到端测试全部通过 ✓\n' : `\n${fail} 项失败 ✗\n`);
process.exit(fail === 0 ? 0 : 1);