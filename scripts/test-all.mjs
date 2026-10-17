/* ============================================================
   scripts/test-all.mjs · 一键跑完全部测试
   用法：npm test
   ============================================================ */

import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  { name: '纯逻辑自测', file: 'run-tests.mjs', desc: '缓动/颜色/噪声/IR 往返/求值/纯函数性/渲染管线' },
  { name: '音频内核', file: 'test-audio.mjs', desc: 'WAV/FFT/响度/节拍/波形编辑/去静默/闪避' },
  { name: '统一音源与视频导出', file: 'test-video.mjs', desc: '合成/真实音频统一接口/踩点/格式能力探测/WAV 封装' },
  { name: '自定义积木', file: 'test-custom.mjs', desc: '函数定义/宏展开/形参替换/递归保护/跨项目库' },
  { name: '字幕场景文字', file: 'test-scene.mjs', desc: 'SRT/ASS/VTT 往返/场景树/复用实例/文字排版' },
  { name: '节点与批量', file: 'test-node-batch.mjs', desc: '积木↔节点互转/数据绑定/批量队列/参数/插件' },
  { name: 'V3/V4 市场与 AI', file: 'test-v3v4.mjs', desc: '模板市场与分成/素材库/AI 转积木与分镜/版本分支与合并' },
  { name: '管线集成', file: 'test-pipeline.mjs', desc: 'GIF 编码器字节结构 / ZIP 结构 / 全链路' },
  { name: '未保存状态', file: 'test-markdirty.mjs', desc: 'markDirty 不清 dirty / beforeunload 拦截 / batch.js 单次导入 / 标记点撤销' },
  { name: '图片缓存', file: 'test-renderer-img.mjs', desc: '加载失败写回缓存 / 失败重试窗口 / 成功后正常绘制' },
  { name: '浏览器端到端', file: 'test-browser.mjs', desc: '真实 Chromium 驱动 UI：渲染/交互/导出/往返', timeout: 240000, needsBrowser: true },
  { name: '画面内容断言', file: 'test-visual.mjs', desc: '用像素验证每个模板真的画出了该画的东西', timeout: 180000, needsBrowser: true },
];

/* ============================================================
   浏览器定位：跨平台，优先级 chromium 自带 → 系统 Chrome/Edge
   ------------------------------------------------------------
   以前只认 Windows 的 Chrome/Edge 三个硬编码路径，
   于是 ubuntu runner 上永远判成「无浏览器」→ 跳过并记为通过。
   CI 里跑 `npx playwright install chromium` 之后，
   PLAYWRIGHT 自带的 chromium 就可用，测试-all 不该再把它跳掉。
   ============================================================ */
function resolveChromePath() {
  // 1) playwright 自带的 chromium（CI 装了就有）
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch { /* 没装就继续找 */ }
  // 2) 环境变量显式指定
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

  const localApp = process.env.LOCALAPPDATA;
  const programFiles = process.env.PROGRAMFILES;
  const cands = [];
  if (process.platform === 'win32') {
    if (localApp) cands.push(join(localApp, 'Google\\Chrome\\Application\\chrome.exe'));
    if (programFiles) cands.push(join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'));
    if (programFiles) cands.push(join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe'));
    if (localApp) cands.push(join(localApp, 'Microsoft\\Edge\\Application\\msedge.exe'));
  } else if (process.platform === 'darwin') {
    cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    cands.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']) {
      cands.push(p);
    }
  }
  return cands.find(p => existsSync(p)) || null;
}

const CHROME_PATH = resolveChromePath();
const hasChrome = !!CHROME_PATH;

if (!hasChrome) {
  console.log('\n  ⚠ 未找到可用的 Chrome/Chromium/Edge');
  console.log('    浏览器端到端与画面内容断言这两个套件将被跳过。');
  console.log('    想让它们真正执行：');
  console.log('      npx playwright install chromium');
  console.log('    或指定 CHROME_PATH 环境变量指向已有浏览器。\n');
}

/** 杀进程树，不只是直接子进程。
 *  只 p.kill() 的话，浏览器套件超时后它拉起的 Chrome 会继续活着，
 *  占着端口和内存，后面几个套件跟着受影响。 */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    // taskkill /T 连子孙一起杀；杀不掉也不能抛，主流程已经在收尾了
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
  } else {
    // 负 pid = 整个进程组。子进程用 detached:true 起，见下。
    try { process.kill(-pid, 'SIGKILL'); } catch { /* 已退出 */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }
}

/** 跑一个测试文件；超时则杀掉整棵进程树并标记失败（避免整套卡住） */
function run(file, timeout = 180000, extraEnv = {}) {
  return new Promise((resolve) => {
    // detached 让子进程自成进程组，超时时才能一次杀干净
    const p = spawn(process.execPath, [join(root, file)], {
      cwd: root, stdio: 'pipe',
      detached: process.platform !== 'win32',
      env: { ...process.env, ...extraEnv },
    });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => out += d);

    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out });
    };

    const timer = setTimeout(() => {
      out += `\n[测试超时] ${file} 超过 ${Math.round(timeout / 1000)}s 未结束，已中止（含子进程）`;
      killTree(p.pid);
      finish(124);                       // 124 = 超时
    }, timeout);

    p.on('close', code => finish(code));
    p.on('error', e => { out += '\n[启动失败] ' + e.message; finish(1); });
  });
}

console.log('\n' + '═'.repeat(66));
console.log('  积木动画工厂 · 完整测试');
console.log('═'.repeat(66) + '\n');

let failed = 0;
const results = [];

// ALLOW_SKIP_BROWSER=1 时允许跳过（本地没装浏览器的开发者用）。
// 默认不跳过：CI 里静默跳过并记为「通过」是最危险的一种失败。
const allowSkip = process.env.ALLOW_SKIP_BROWSER === '1';

for (const s of SUITES) {
  if (s.needsBrowser && !hasChrome) {
    if (allowSkip) {
      console.log(`⏭  ${s.name} —— 未检测到浏览器，ALLOW_SKIP_BROWSER=1 已允许跳过\n`);
      results.push({ ...s, code: 0, skipped: true });
      continue;
    }
    console.log(`✗  ${s.name} —— 未检测到浏览器，判定失败\n`);
    failed++;
    results.push({ ...s, code: 127, ms: 0, out: '未找到 Chrome/Chromium/Edge' });
    continue;
  }
  process.stdout.write(`▶  ${s.name}  —  ${s.desc}\n`);
  const t0 = Date.now();
  // 把定位到的浏览器路径传给子进程，test-browser / test-visual 用它，
  // 避免它们各自硬编码 Windows 路径而在 CI 上启动失败。
  const r = await run(s.file, s.timeout, hasChrome ? { CHROME_PATH } : {});
  const ms = Date.now() - t0;
  const passed = r.code === 0;
  if (!passed) failed++;
  results.push({ ...s, code: r.code, ms, out: r.out });
  // 只回显失败详情，全过则保持安静。
  // 过滤不能只认 FAIL/✗/失败/Error 这类关键词：各套件自己打印失败明细的
  // 前缀并不统一（例如 test-markdirty / test-renderer-img 用「  · 」开头），
  // 按关键词过滤会让「套件失败但一条明细都不显示」，比不显示更糟。
  // 现在只在失败时才回显，且保留所有非空行（仍限 12 行）。
  if (!passed) {
    const lines = r.out.split('\n')
      .filter(l => l.trim().length > 0)
      .slice(0, 12);
    if (lines.length) console.log(lines.map(l => '   ' + l).join('\n'));
  }
  console.log(`   ${passed ? '✓ 通过' : '✗ 失败'}  (${(ms / 1000).toFixed(1)}s)\n`);
}

console.log('═'.repeat(66));
for (const r of results) {
  const mark = r.skipped ? '⏭' : r.code === 0 ? '✓' : '✗';
  console.log(`  ${mark} ${r.name.padEnd(12, '　')} ${r.skipped ? '跳过' : (r.ms / 1000).toFixed(1) + 's'}`);
}
console.log('═'.repeat(66));

const skipped = results.filter(r => r.skipped).length;
if (failed === 0 && skipped === 0) {
  console.log('\n  全部通过 ✓（无跳过）\n');
} else if (failed === 0) {
  console.log(`\n  全部通过，但有 ${skipped} 个套件被跳过 —— 这不等于「测过了」\n`);
} else {
  console.log(`\n  ${failed} 个测试套件失败 ✗\n`);
}
process.exit(failed === 0 ? 0 : 1);