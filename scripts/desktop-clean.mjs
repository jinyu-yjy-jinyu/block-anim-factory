/* ============================================================
   scripts/desktop-clean.mjs · 清理桌面版构建产物
   ------------------------------------------------------------
   `dotnet clean` 只清 obj/bin，管不到 `dotnet publish -o desktop/out`
   产出的发布目录。那个目录里全是上一版的 exe / dll / web 资源，
   不清掉就重新 publish，旧文件会混在新包里一起发给用户。

   改版本号重打时这个坑最容易踩：包里的 WebView2 资源是旧的，
   exe 版本号是新的，看起来一切正常但跑起来是旧界面。
   ============================================================ */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const project = join(root, 'desktop', 'BlockAnim.csproj');

/* ---------- 1. dotnet clean：清 obj/bin ---------- */
if (existsSync(project)) {
  console.log('dotnet clean …');
  const r = spawnSync('dotnet', ['clean', project], { cwd: root, stdio: 'inherit' });
  if (r.error) {
    // 没装 dotnet SDK 不该阻断清理，发布目录还是要清的
    console.warn('  跳过（dotnet 不可用：' + r.error.message + '）');
  }
} else {
  console.warn('没找到 ' + project + '，只清理发布目录');
}

/* ---------- 2. 删发布目录（dotnet clean 不管这个） ---------- */
const outDir = join(root, 'desktop', 'out');
if (existsSync(outDir)) {
  console.log('删除 ' + outDir);
  rmSync(outDir, { recursive: true, force: true });
}

// publish 时若换过输出目录，out-* 也一并清掉
for (const name of ['out-debug', 'out-release']) {
  const p = join(root, 'desktop', name);
  if (existsSync(p)) {
    console.log('删除 ' + p);
    rmSync(p, { recursive: true, force: true });
  }
}

// 冒烟测试残留
const smoke = join(outDir, 'smoke-exit.txt');
if (existsSync(smoke)) rmSync(smoke, { force: true });

console.log('清理完成');
