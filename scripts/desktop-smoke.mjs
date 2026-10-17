/* ============================================================
   scripts/desktop-smoke.mjs · 本地跑桌面版冒烟测试
   ------------------------------------------------------------
   为什么不用一条 npm script 直接调 exe：

   1. WinExe（GUI 子系统）从 cmd 直接调用拿不到退出码，
      `$LASTEXITCODE` 是空的 —— 断言全过也会被判失败，
      或者反过来失败也被当成功。desktop.yml:76-88 已经踩过这个坑
      并写了规避方法，本地脚本之前没同步。
   2. exe 不自行退出时没有超时，整条命令会一直挂��。
   3. 冒烟测试的真正判据是它写出的 smoke-exit.txt，
      不是进程退出码 —— 和 CI 保持同一套判据。

   用法：npm run desktop:test
   ============================================================ */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'desktop', 'out');

if (process.platform !== 'win32') {
  console.error('桌面版冒烟测试只能在 Windows 上跑（需要 WPF + WinExe）');
  process.exit(1);
}

/* ---------- 找 exe ---------- */
if (!existsSync(outDir)) {
  console.error(`没找到 ${outDir}`);
  console.error('先跑 npm run desktop:build');
  process.exit(1);
}
const exe = readdirSync(outDir).find(f => f.toLowerCase().endsWith('.exe'));
if (!exe) {
  console.error(`${outDir} 里没有 exe`);
  process.exit(1);
}
const exePath = join(outDir, exe);

/* ---------- 结果文件的三个可能位置 ----------
   程序会同时写「用户数据目录」和「exe 旁」两处，两个都查。 */
const candidates = [
  join(homedir(), 'AppData', 'Local', 'BlockAnimFactory', 'smoke-exit.txt'),
  join(homedir(), 'AppData', 'Roaming', 'BlockAnimFactory', 'smoke-exit.txt'),
  join(outDir, 'smoke-exit.txt'),
];

// 先清掉上一次的残留，否则读到的是旧结果，失败会被掩盖成通过
for (const f of candidates) {
  try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* 没有就算了 */ }
}

console.log(`运行 ${exe} --smoke`);

const TIMEOUT_MS = 120000;
const proc = spawn(exePath, ['--smoke'], { cwd: root, stdio: 'inherit', detached: true });

/* 超时后连子进程一起杀，避免留下占着 %TEMP% 的孤儿 */
const timer = setTimeout(() => {
  console.error(`\n冒烟测试超过 ${TIMEOUT_MS / 1000}s 未退出，强杀进程树`);
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }
  process.exit(1);
}, TIMEOUT_MS);

proc.on('error', (e) => {
  clearTimeout(timer);
  console.error('启动失败：' + e.message);
  process.exit(1);
});

proc.on('close', () => {
  clearTimeout(timer);

  const resultFile = candidates.find(f => existsSync(f));
  if (!resultFile) {
    console.error('\n冒烟测试没有写结果文件，可能连 Main 都没跑到');
    console.error('排查：桌面版需要 WebView2 Runtime，缺了会在启动时静默退出');
    process.exit(1);
  }

  const code = parseInt(readFileSync(resultFile, 'utf8').trim(), 10);
  console.log(`结果文件：${resultFile}（${code}）`);

  // 清理，别把测试残留留在用户目录里
  try { rmSync(resultFile, { force: true }); } catch { /* 忽略 */ }

  if (code !== 0) {
    console.error(`桌面版冒烟测试失败（退出码 ${code}）`);
    process.exit(1);
  }
  console.log('冒烟测试通过');
});
