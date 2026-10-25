/* ============================================================
   test-goldens.mjs · 旧模板逐帧绘制回归
   ------------------------------------------------------------
   重放所有官方模板的每一帧，与 fixtures/legacy-golden.json
   里的绘制指令摘要对比。任何非预期变化都会在这里失败。
   确认变化是有意的之后，用 node scripts/make-goldens.mjs 更新基线。
   ============================================================ */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureAll } from './scripts/golden.mjs';
import { TEMPLATES } from './src/templates.js';

const root = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const ok = (c, m, x = '') => {
  console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}${x ? '  → ' + x : ''}`);
  if (!c) fail++;
};

console.log('\n=== 旧模板绘制回归 ===');
const golden = JSON.parse(await readFile(join(root, 'fixtures', 'legacy-golden.json'), 'utf8'));
const live = captureAll();

const keys = TEMPLATES.map(t => t.key);
ok(Object.keys(golden.templates).sort().join(',') === keys.slice().sort().join(','),
  `基线覆盖全部 ${keys.length} 个官方模板`,
  `基线 ${Object.keys(golden.templates).join(',')} / 当前 ${keys.join(',')}`);

let compared = 0;
for (const key of keys) {
  const want = golden.templates[key];
  const got = live.templates[key];
  if (!want || !got) { ok(false, `${key} 缺少基线或实时结果`); continue; }
  ok(want.frames === got.frames && want.fps === got.fps,
    `${key} 帧数/帧率一致（${got.frames} 帧 @ ${got.fps}fps）`,
    want.frames !== got.frames ? `基线 ${want.frames} / 当前 ${got.frames}` : '');

  const bad = [];
  for (let i = 0; i < Math.min(want.digests.length, got.digests.length); i++) {
    compared++;
    if (want.digests[i] !== got.digests[i]) bad.push(i);
  }
  ok(bad.length === 0, `${key} 全部 ${got.digests.length} 帧绘制一致`,
    bad.length ? `${bad.length} 帧不同，首个在第 ${bad[0]} 帧（t=${(bad[0] / got.fps).toFixed(3)}s）` : '');
}

console.log(`\n  共比较 ${compared} 帧绘制指令`);
console.log(fail === 0 ? '\n旧模板绘制全部一致 ✓\n' : `\n${fail} 项不一致 ✗\n`);
process.exit(fail === 0 ? 0 : 1);
