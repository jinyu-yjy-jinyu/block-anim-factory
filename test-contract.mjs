/* ============================================================
   test-contract.mjs · 积木库与实现契约
   ------------------------------------------------------------
   守门规则：每个语句积木都必须有分类、调色板分组、执行实现、
   AI 位置映射；每个表达式积木都必须有参数槽定义。
   参数槽的默认值必须真正写进新块，而不是停在元数据里。
   ============================================================ */

import { readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLOCK_DEFS, CATS, PALETTE_GROUPS, LEAF_SLOTS, HAT_OPS, metaFor,
} from './src/blocks.js';
import { fromText, registerOpMeta, defaultForType } from './src/ir.js';
import { SLOT_ORDER } from './src/ai.js';

const root = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const ok = (c, m, x = '') => {
  console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}${x ? '  → ' + x : ''}`);
  if (!c) fail++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n=== 积木库契约 ===');

/* ---------- 分类与调色板 ---------- */
const catKeys = Object.keys(CATS);
ok(PALETTE_GROUPS.slice().sort().join(',') === catKeys.slice().sort().join(','),
  `调色板分组覆盖全部 ${catKeys.length} 个分类`,
  PALETTE_GROUPS.filter(k => !CATS[k]).map(k => `未定义:${k}`).concat(catKeys.filter(k => !PALETTE_GROUPS.includes(k)).map(k => `未上架:${k}`)).join(', '));

const ops = new Set();
const dup = [];
for (const d of BLOCK_DEFS) {
  if (ops.has(d.op)) dup.push(d.op);
  ops.add(d.op);
}
ok(dup.length === 0, `积木 op 无重复（共 ${BLOCK_DEFS.length} 个）`, dup.join(', '));

const badCat = BLOCK_DEFS.filter(d => !CATS[d.cat] || !PALETTE_GROUPS.includes(d.cat));
ok(badCat.length === 0, '每个积木都挂在已上架的分类下', badCat.map(d => `${d.op}:${d.cat}`).join(', '));
const named = BLOCK_DEFS.filter(d => !d.label || typeof d.desc !== 'string');
ok(named.length === 0, '每个积木都有可读名称');

/* ---------- 执行实现 ---------- */
let runtimeSource = '';
for (const f of ['evaluator.js', 'runtime.js', 'fxops.js']) {
  try { await access(join(root, 'src', f)); runtimeSource += await readFile(join(root, 'src', f), 'utf8'); } catch { /* 尚未引入该模块 */ }
}
const implemented = new Set([...runtimeSource.matchAll(/case '([A-Za-z0-9_]+)'/g)].map(m => m[1]));
for (const op of HAT_OPS) implemented.add(op); // 帽子积木由事件调度器启动，不进 exec 的 switch
const noImpl = BLOCK_DEFS.filter(d => !d.isLeaf && !implemented.has(d.op));
ok(noImpl.length === 0, '每个语句积木都有执行实现', noImpl.map(d => d.op).join(', '));

const hatMismatch = BLOCK_DEFS.filter(d => (!!d.hat !== HAT_OPS.has(d.op)));
ok(hatMismatch.length === 0, '帽子标记与 HAT_OPS 一致', hatMismatch.map(d => `${d.op}:hat=${!!d.hat}`).join(', '));
const badHat = BLOCK_DEFS.filter(d => HAT_OPS.has(d.op) && (d.isLeaf || !Array.isArray(d.slots) || !d.slots.some(s => Array.isArray(s.default))));
ok(badHat.length === 0, '每个帽子积木都带 C 槽', badHat.map(d => d.op).join(', '));

const noSlotOrder = BLOCK_DEFS.filter(d => !d.isLeaf && !Object.prototype.hasOwnProperty.call(SLOT_ORDER, d.op));
ok(noSlotOrder.length === 0, '每个语句积木都有 AI 位置映射', noSlotOrder.map(d => d.op).join(', '));

/* ---------- 参数元数据 ---------- */
const incomplete = [];
for (const d of BLOCK_DEFS) {
  const md = metaFor(d.op);
  if (!md) { incomplete.push(`${d.op}:无元数据`); continue; }
  if (d.isLeaf) {
    const specs = LEAF_SLOTS[d.op];
    if (!specs) { incomplete.push(`${d.op}:缺 LEAF_SLOTS`); continue; }
    if (md.slots.length !== specs.length) incomplete.push(`${d.op}:元数据槽数不符`);
    specs.forEach((sd, i) => {
      if (!sd[0] || !sd[1]) incomplete.push(`${d.op}.${i}:缺类型或名称`);
      if (sd.length < 3) incomplete.push(`${d.op}.${i}:缺默认值`);
      const s = md.slots[i];
      if (!s || s.type !== sd[0] || s.default !== sd[2]) incomplete.push(`${d.op}.${i}:默认值未进元数据`);
      if (sd[3] && typeof sd[3] !== 'string' && typeof sd[3] !== 'object') incomplete.push(`${d.op}.${i}:菜单描述非法`);
    });
    continue;
  }
  if (!Array.isArray(d.slots)) { incomplete.push(`${d.op}:缺参数槽`); continue; }
  d.slots.forEach((s, i) => {
    if (!s.type || !s.label) incomplete.push(`${d.op}.${i}:缺类型或名称`);
    if (s.menu != null && typeof s.menu !== 'string' && !Array.isArray(s.menu)) incomplete.push(`${d.op}.${i}:菜单描述非法`);
    const s2 = md.slots[i];
    if (!s2) return;
    const isSub = Array.isArray(s.default);
    if (s2.isSub !== isSub) incomplete.push(`${d.op}.${i}:子槽判定不一致`);
    if (!isSub && s2.default !== s.default) incomplete.push(`${d.op}.${i}:默认值未进元数据`);
    if (isSub && !same(s2.default, [])) incomplete.push(`${d.op}.${i}:子槽默认值不是数组`);
  });
}
ok(incomplete.length === 0, '参数槽都有类型/名称/默认值，并完整进入元数据', incomplete.slice(0, 8).join(' | '));

/* ---------- 默认值真的写进新块 ---------- */
registerOpMeta(BLOCK_DEFS.map(d => metaFor(d.op)).filter(Boolean));
const defaultMismatch = [];
for (const d of BLOCK_DEFS) {
  const text = `LAYER 契约测试 [rect]\n  @ ${d.op}`;
  let block;
  try { block = fromText(text).ir.layers[0].blocks[0]; } catch (e) { defaultMismatch.push(`${d.op}:解析抛错 ${e.message}`); continue; }
  if (!block || block.op !== d.op) { defaultMismatch.push(`${d.op}:未生成积木`); continue; }
  if (d.isLeaf) {
    const keys = ['a', 'b', 'c', 'p', 'p2'];
    (LEAF_SLOTS[d.op] || []).forEach((sd, i) => {
      const want = defaultForType(sd[0], sd[2]);
      if (!same(block[keys[i]], want)) defaultMismatch.push(`${d.op}.${keys[i]}:期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(block[keys[i]])}`);
    });
    continue;
  }
  (d.slots || []).forEach((s, i) => {
    const got = block.slots[i];
    if (!got) { defaultMismatch.push(`${d.op}.${i}:缺槽`); return; }
    if (Array.isArray(s.default)) {
      if (!same(got.value, [])) defaultMismatch.push(`${d.op}.${i}:子槽应为空数组`);
    } else {
      const want = defaultForType(s.type, s.default);
      if (!same(got.value, want)) defaultMismatch.push(`${d.op}.${i}:期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got.value)}`);
    }
  });
}
ok(defaultMismatch.length === 0, '文本解析生成的新块采用积木定义默认值', defaultMismatch.slice(0, 6).join(' | '));

console.log(fail === 0 ? '\n积木库契约全部满足 ✓\n' : `\n${fail} 项契约不满足 ✗\n`);
process.exit(fail === 0 ? 0 : 1);
