/* ============================================================
   test-contrast.mjs · 积木文字对比度守门
   ------------------------------------------------------------
   浅色模式看不清积木字的根因是「白字 + 亮分类色」。
   这里对 CATS、全部积木颜色、图层头和表达式芯片逐一验证：
     · 主文字 >= 4.5:1（WCAG AA 普通文字）
     · 次级文字 >= 3:1
     · 面色相对分类色只允许 <=8 个百分点的 HSL 明度偏移
   新分类如果颜色不达标，这个测试会直接失败，而不是悄悄放行。
   用法：node test-contrast.mjs
   ============================================================ */

import { CATS, BLOCK_DEFS, LAYER_HEAD_COLORS } from './src/blocks.js';
import {
  bestTextOn, contrastRatio, contrastVars, mixHex,
  normalizeHex, parseHex, readableFace, readableInk, rgbToHsl,
} from './src/contrast.js';

let fail = 0;
const ok = (c, m, extra = '') => {
  console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}${extra ? '  → ' + extra : ''}`);
  if (!c) fail++;
};

console.log('\n=== 积木对比度断言 ===');

ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 0.01, '黑白对比度为 21:1');
ok(contrastRatio('#9966ff', '#0f172a') === contrastRatio('#0f172a', '#9966ff'), '对比度计算对称');

const entries = Object.entries(CATS).map(([key, cat]) => ({
  bg: cat.color, label: `分类 ${key}`, cat: true,
}));

const blockColors = new Map();
for (const def of BLOCK_DEFS) {
  if (!blockColors.has(def.color)) blockColors.set(def.color, []);
  blockColors.get(def.color).push(def.op);
}
for (const [color, ops] of blockColors) {
  entries.push({ bg: color, label: `积木 ${ops.slice(0, 3).join('/')}${ops.length > 3 ? ` +${ops.length - 3}` : ''}` });
}

const headColors = new Map();
for (const [type, color] of Object.entries(LAYER_HEAD_COLORS)) {
  if (!headColors.has(color)) headColors.set(color, []);
  headColors.get(color).push(type);
}
for (const [color, types] of headColors) {
  entries.push({ bg: color, label: `图层头 ${types.join('/')}` });
}
entries.push({ bg: '#cf63cf', label: '表达式芯片（音频分类色）' });

for (const { bg, label, cat } of entries) {
  const { face, fg, ratio, shift } = readableFace(bg);
  const dim = readableInk(face, fg, 3);
  const faceNorm = normalizeHex(bg);
  const faceShift = Math.abs(rgbToHsl(parseHex(face)).l - rgbToHsl(parseHex(faceNorm)).l) * 100;

  ok(ratio >= 4.5, `${label} ${bg} 主文字 ${fg}`, `${ratio.toFixed(2)}:1`);
  ok(dim.ratio >= 3, `${label} 次级文字`, `${dim.ratio.toFixed(2)}:1`);
  ok(faceShift <= 8.01, `${label} 面色偏移`, `${faceShift.toFixed(2)}%`);
  ok(shift <= 8.01, `${label} readableFace 报告的偏移`, `${shift.toFixed(2)}%`);

  if (cat) {
    const lightTint = mixHex(bg, '#f2f6fb', 0.82);
    const ink = bestTextOn(lightTint);
    const inkRatio = contrastRatio(lightTint, ink);
    ok(inkRatio >= 3, `${label} 浅色色轨图标`, `${inkRatio.toFixed(2)}:1`);
    ok(contrastRatio(bg, bestTextOn(bg)) >= 3, `${label} 选中色轨图标`, `${contrastRatio(bg, bestTextOn(bg)).toFixed(2)}:1`);
  }
}

const vars = contrastVars('#ffab19');
ok(vars['--bc-fg'] === '#0f172a', '黄色积木使用深色文字', vars['--bc-fg']);
ok(vars['--bc-shadow'] === 'none', '深色文字不再加暗影', vars['--bc-shadow']);
ok(/^#[0-9a-f]{8}$/.test(vars['--bc-dim']), '次级文字带 alpha', vars['--bc-dim']);
ok(contrastVars('#6b7280')['--bc-face'].startsWith('#'), '未知 op 的灰色兜底可用');

console.log(fail === 0 ? '\n积木对比度全部达标 ✓\n' : `\n${fail} 项对比度不达标 ✗\n`);
process.exit(fail === 0 ? 0 : 1);
