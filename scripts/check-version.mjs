/* ============================================================
   scripts/check-version.mjs · 版本号四处一致性校验
   ------------------------------------------------------------
   检查 package.json / desktop/BlockAnim.csproj / desktop/installer.iss /
   desktop-electron/package.json 四处版本号是否一致。
   CI 里调用，不一致直接退出码 1。

   Electron 的发行标签与产物版本取自 desktop-electron/package.json，
   漏检它会让「网页版发了 vX、Electron 产物挂到 vY」静默发生。
   ============================================================ */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readText(p) { return readFileSync(join(root, p), 'utf8'); }

const pkg = JSON.parse(readText('package.json'));
const pkgVer = pkg.version;

const csproj = readText('desktop/BlockAnim.csproj');
const csMatch = csproj.match(/<Version>\s*([^<\s]+)\s*<\/Version>/);
const csVer = csMatch ? csMatch[1] : null;

const iss = readText('desktop/installer.iss');
const issMatch = iss.match(/#define\s+AppVersion\s+"([^"]+)"/);
const issVer = issMatch ? issMatch[1] : null;

const electronPkg = JSON.parse(readText('desktop-electron/package.json'));
const electronVer = electronPkg.version;

console.log('package.json        :', pkgVer);
console.log('BlockAnim.csproj    :', csVer);
console.log('installer.iss       :', issVer);
console.log('desktop-electron    :', electronVer);

if (!pkgVer || !csVer || !issVer || !electronVer) {
  console.error('版本号解析失败');
  process.exit(1);
}
if (pkgVer !== csVer || pkgVer !== issVer || pkgVer !== electronVer) {
  console.error('版本号不一致');
  process.exit(1);
}
console.log('✓ 版本号一致：', pkgVer);
