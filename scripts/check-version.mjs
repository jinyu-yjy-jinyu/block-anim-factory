/* ============================================================
   scripts/check-version.mjs · 版本号三处一致性校验
   ------------------------------------------------------------
   检查 package.json / desktop/BlockAnim.csproj / desktop/installer.iss
   三处版本号是否一致。CI 里调用，不一致直接退出码 1。
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

console.log('package.json        :', pkgVer);
console.log('BlockAnim.csproj    :', csVer);
console.log('installer.iss       :', issVer);

if (!pkgVer || !csVer || !issVer) {
  console.error('版本号解析失败');
  process.exit(1);
}
if (pkgVer !== csVer || pkgVer !== issVer) {
  console.error('版本号不一致');
  process.exit(1);
}
console.log('✓ 版本号一致：', pkgVer);
