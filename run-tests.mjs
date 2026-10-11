/* ============================================================
   run-tests.mjs · 在 Node 里跑纯逻辑自测
   ------------------------------------------------------------
   用法：node run-tests.mjs
   只需 stub 极少量 DOM（本套件只触及 Blob/TextEncoder，
   而 Node 18+ 原生具备），其余全部是纯函数。
   ============================================================ */

import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/* ---- 最小全局 stub：只补 Node 里可能缺的 ---- */
if (typeof globalThis.CompressionStream === 'undefined') {
  // Node 18+ 有；极端情况下退化为不压缩
  globalThis.CompressionStream = undefined;
}

const mod = await import(pathToFileURL(resolve(here, 'src/selftest.js')).href);

console.log('\n=== 积木动画工厂 · 自测 ===\n');
const r = mod.run();
console.log('');
const z = await mod.runAsync();
console.log('');

const ok = r.fail === 0 && z !== false;
console.log(ok ? '\n全部通过 ✓\n' : '\n存在失败 ✗\n');
process.exit(ok ? 0 : 1);
