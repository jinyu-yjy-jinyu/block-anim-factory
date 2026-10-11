/* ============================================================
   scripts/test-all.mjs · 一键跑完全部测试
   用法：npm test
   ============================================================ */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  { name: '纯逻辑自测', file: 'run-tests.mjs', desc: '缓动/颜色/噪声/IR 往返/求值/纯函数性/渲染管线' },
  { name: '音频内核', file: 'test-audio.mjs', desc: 'WAV/FFT/响度/节拍/波形编辑/去静默/闪避' },
  { name: '统一音源与视频导出', file: 'test-video.mjs', desc: '合成/真实音频统一接口/踩点/格式能力探测/WAV 封装' },
  { name: '自定义积木', file: 'test-custom.mjs', desc: '函数定义/宏展开/形参替换/递归保护/跨项目库' },
  { name: '字幕场景文字', file: 'test-scene.mjs', desc: 'SRT/ASS/VTT 往返/场景树/复用实例/文字排版' },
  { name: '节点与批量', file: 'test-node-batch.mjs', desc: '积木↔节点互转/数据绑定/批量队列/参数/插件' },
  { name: '管线集成', file: 'test-pipeline.mjs', desc: 'GIF 编码器字节结构 / ZIP 结构 / 全链路' },
  { name: '浏览器端到端', file: 'test-browser.mjs', desc: '真实 Chrome 驱动 UI：渲染/交互/导出/往返', timeout: 240000 },
  { name: '画面内容断言', file: 'test-visual.mjs', desc: '用像素验证每个模板真的画出了该画的东西', timeout: 180000 },
];

const hasChrome = existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  || existsSync(process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe')
  || existsSync(process.env.PROGRAMFILES + '\\Microsoft\\Edge\\Application\\msedge.exe');

/** 跑一个测试文件；超时则杀掉并标记失败（避免整套卡住） */
function run(file, timeout = 180000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(root, file)], { cwd: root, stdio: 'pipe' });
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
      out += `\n[测试超时] ${file} 超过 ${Math.round(timeout / 1000)}s 未结束，已中止`;
      try { p.kill('SIGKILL'); } catch { /* 已退出 */ }
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

for (const s of SUITES) {
  if (!hasChrome && (s.file === 'test-browser.mjs' || s.file === 'test-visual.mjs')) {
    console.log(`⏭  ${s.name} —— 未检测到 Chrome/Edge，跳过\n`);
    results.push({ ...s, code: 0, skipped: true });
    continue;
  }
  process.stdout.write(`▶  ${s.name}  —  ${s.desc}\n`);
  const t0 = Date.now();
  const r = await run(s.file, s.timeout);
  const ms = Date.now() - t0;
  const passed = r.code === 0;
  if (!passed) failed++;
  results.push({ ...s, code: r.code, ms, out: r.out });
  // 只回显失败详情，全过则保持安静
  if (!passed) {
    const lines = r.out.split('\n')
      .filter(l => /FAIL|✗|失败|Error|超时|错误/.test(l))
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
console.log(failed === 0 ? '\n  全部通过 ✓\n' : `\n  ${failed} 个测试套件失败 ✗\n`);
process.exit(failed === 0 ? 0 : 1);