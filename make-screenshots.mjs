/* 截图：把关键界面抓下来，便于人工确认视觉是否正确 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'screenshots');
await mkdir(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const srv = createServer(async (q, s) => {
  try {
    let p = decodeURIComponent(q.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = join(here, p);
    await stat(f);
    s.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
    s.end(await readFile(f));
  } catch { s.writeHead(404); s.end(); }
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 2 })).newPage();
await page.goto('http://127.0.0.1:' + srv.address().port + '/', { waitUntil: 'load' });
await page.waitForTimeout(1200);

// 1. 默认视图（逐字弹入标题，t=0）
await page.screenshot({ path: join(OUT, '01-初始.png') });

// 2. 播放到标题弹完 + 副标题入场
await page.evaluate(() => {
  const inp = document.getElementById('durationInput');
  inp.value = '6'; inp.dispatchEvent(new Event('change'));
});
for (let i = 0; i < 45; i++) await page.keyboard.press('Period');
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '02-标题弹入.png') });

// 3. 音频驱动波形柱模板
await page.evaluate(() => document.querySelector('[data-act="tpl.open"]').click());
await page.waitForTimeout(400);
const cards = page.locator('#tplList > div');
for (let i = 0; i < await cards.count(); i++) {
  if ((await cards.nth(i).textContent()).includes('音频驱动波形柱')) { await cards.nth(i).click(); break; }
}
await page.waitForTimeout(700);
for (let i = 0; i < 50; i++) await page.keyboard.press('Period');
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '03-音频波形柱.png') });

// 4. 数据榜单
await page.evaluate(() => document.querySelector('[data-act="tpl.open"]').click());
await page.waitForTimeout(400);
for (let i = 0; i < await cards.count(); i++) {
  if ((await cards.nth(i).textContent()).includes('数据榜单')) { await cards.nth(i).click(); break; }
}
await page.waitForTimeout(700);
for (let i = 0; i < 120; i++) await page.keyboard.press('Period');
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '04-数据榜单.png') });

// 5. 环形频谱
await page.evaluate(() => document.querySelector('[data-act="tpl.open"]').click());
await page.waitForTimeout(400);
for (let i = 0; i < await cards.count(); i++) {
  if ((await cards.nth(i).textContent()).includes('环形频谱')) { await cards.nth(i).click(); break; }
}
await page.waitForTimeout(700);
for (let i = 0; i < 60; i++) await page.keyboard.press('Period');
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '05-环形频谱.png') });

// 6. 口播逐词高亮字幕
await page.evaluate(() => document.querySelector('[data-act="tpl.open"]').click());
await page.waitForTimeout(400);
for (let i = 0; i < await cards.count(); i++) {
  if ((await cards.nth(i).textContent()).includes('口播逐词高亮')) { await cards.nth(i).click(); break; }
}
await page.waitForTimeout(700);
for (let i = 0; i < 90; i++) await page.keyboard.press('Period');
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '06-逐词高亮.png') });

// 7. 调试器 + 属性面板
await page.evaluate(() => {
  document.querySelector('[data-act="tpl.open"]').click();
});
await page.waitForTimeout(400);
for (let i = 0; i < await cards.count(); i++) {
  if ((await cards.nth(i).textContent()).includes('逐字弹入标题')) { await cards.nth(i).click(); break; }
}
await page.waitForTimeout(600);
await page.evaluate(() => document.querySelector('[data-act="debug.panel"]').click());
await page.waitForTimeout(300);
await page.locator('#blockCanvas .block').first().click();
await page.waitForTimeout(200);
await page.locator('#rightTabs .tab[data-tab="inspector"]').click();
await page.waitForTimeout(200);
for (let i = 0; i < 3; i++) { await page.keyboard.press('F10'); await page.waitForTimeout(150); }
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '07-调试器.png') });

// 8. 积木库抽屉
await page.locator('#rightTabs .tab[data-tab="blocks"]').click();
await page.waitForTimeout(200);
await page.evaluate(() => document.querySelector('[data-act="palette.close"]').click());
await page.waitForTimeout(100);
await page.evaluate(() => { document.getElementById('paletteDrawer').classList.remove('hidden'); });
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '08-积木库.png') });

// 9. 帮助 / IR 规范
await page.evaluate(() => document.querySelector('[data-act="palette.close"]').click());
await page.waitForTimeout(200);
await page.evaluate(() => document.querySelector('[data-act="help.ir"]').click());
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, '09-IR规范.png') });

// 10. 竖屏 9:16
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.evaluate(() => document.querySelector('[data-act="tpl.open"]').click());
await page.waitForTimeout(400);
for (let i = 0; i < await cards.count(); i++) {
  if ((await cards.nth(i).textContent()).includes('口播逐词高亮')) { await cards.nth(i).click(); break; }
}
await page.waitForTimeout(600);
await page.selectOption('#presetSelect', '1080x1920');
await page.waitForTimeout(700);
for (let i = 0; i < 90; i++) await page.keyboard.press('Period');
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '10-竖屏字幕.png') });

/* ============================================================
   11~15 · V1/V2 新增面板
   ============================================================ */

// 11. 节点图（积木 ↔ 节点 的同源投影）
await page.evaluate(async () => {
  const A = window.BlockAnim;
  A.loadTemplate('audioBars');
  await new Promise(r => setTimeout(r, 400));
  document.querySelector('[data-act="node.fromBlocks"]').click();
  await new Promise(r => setTimeout(r, 200));
  document.querySelector('[data-act="node.toBlocks"]').click();
  await new Promise(r => setTimeout(r, 300));
});
await page.waitForTimeout(700);
await page.screenshot({ path: join(OUT, '11-节点图.png') });

// 12. 字幕面板：导入 + 校验
await page.evaluate(async () => {
  const A = window.BlockAnim;
  A.loadTemplate('karaoke');
  A.loadSubtitles({
    id: 'ST1', name: '字幕',
    styles: null,
    cues: [
      { id: 'c1', start: 0.2, end: 2.4, text: '做动画，其实不用写代码', secondary: '', styleId: 'karaoke', words: [] },
      { id: 'c2', start: 2.5, end: 4.8, text: '拖几个积木，动画就出来了', secondary: '', styleId: 'karaoke', words: [] },
      { id: 'c3', start: 5.0, end: 7.6, text: '还能跟着音乐节奏自己动', secondary: '', styleId: 'karaoke', words: [] },
      { id: 'c4', start: 7.8, end: 11.0, text: '一键导出视频，直接发出去', secondary: '', styleId: 'karaoke', words: [] },
      { id: 'c5', start: 11.2, end: 16.0, text: '这一句故意写得很长很长很长用来演示爆字数告警', secondary: '', styleId: 'karaoke', words: [] },
    ],
  });
  document.querySelector('.tab[data-tab="subtitle"]').click();
  document.querySelector('[data-act="sub.words"]').click();
  await new Promise(r => setTimeout(r, 200));
  document.querySelector('[data-act="sub.validate"]').click();
  await new Promise(r => setTimeout(r, 300));
});
await page.waitForTimeout(600);
await page.screenshot({ path: join(OUT, '12-字幕面板.png') });

// 13. 音频台（塞一段测试音频 → 波形 + 响度 + 节拍线）
await page.evaluate(async () => {
  const A = window.BlockAnim;
  A.loadTemplate('audioBars');
  // 造一段 12 秒、带节拍与人声频段的音频
  const sr = 48000, dur = 12;
  const n = sr * dur;
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    // 每 0.5 秒一个节拍（120 BPM）
    const ph = (t % 0.5) / 0.5;
    v += Math.sin(2 * Math.PI * 60 * t) * Math.exp(-ph * 9) * 0.55;
    // 人声段
    if (t > 1.5 && t < 5.5) v += Math.sin(2 * Math.PI * 210 * t) * 0.22 * (0.6 + 0.4 * Math.sin(t * 5));
    if (t > 6.5 && t < 10.5) v += Math.sin(2 * Math.PI * 260 * t) * 0.2;
    buf[i] = Math.max(-1, Math.min(1, v * (0.8 + 0.2 * Math.sin(t * 0.7))));
  }
  A.setAudio(buf, sr, { name: '演示音轨.mp3', kind: 'music' });
  document.querySelector('.tab[data-tab="audio"]').click();
  await new Promise(r => setTimeout(r, 400));
});
await page.waitForTimeout(700);
await page.screenshot({ path: join(OUT, '13-录音台与波形.png') });

// 14. 数据驱动面板（粘贴数据 → 预览 + 绑定）
await page.evaluate(async () => {
  const A = window.BlockAnim;
  A.loadTemplate('barChart');
  document.querySelector('.tab[data-tab="data"]').click();
  document.querySelector('[data-act="data.paste"]').click();
  await new Promise(r => setTimeout(r, 200));
  const ta = document.querySelector('#modalBody textarea');
  ta.value = [
    '产品,价格,销量,评分',
    '星火剪辑器,99,12800,4.9',
    '声波分析,149,6400,4.7',
    '字幕工厂,69,22100,4.8',
    '批量渲染,299,3200,4.6',
    '插件市场,199,8900,4.9',
  ].join('\n');
  const btns = [...document.querySelectorAll('#modalFoot button')];
  btns[btns.length - 1].click();
  await new Promise(r => setTimeout(r, 300));
  A.scanDataBindings();
  await new Promise(r => setTimeout(r, 200));
});
await page.waitForTimeout(600);
await page.screenshot({ path: join(OUT, '14-数据驱动.png') });

// 15. 场景树：编组 + 主组件 + 实例
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
await page.waitForTimeout(700);
await page.screenshot({ path: join(OUT, '15-场景树与实例.png') });

// 16. 导出对话框（格式卡片 + 能力探测）
await page.evaluate(() => document.querySelector('[data-act="export.frames"]').click());
await page.waitForTimeout(600);
await page.screenshot({ path: join(OUT, '16-导出格式.png') });

await browser.close();
srv.close();
console.log('截图已输出到 screenshots/（16 张）');