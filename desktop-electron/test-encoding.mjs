/* 双重解码 / 编码变体测试（本机纯逻辑，可信）
   ------------------------------------------------------------
   云端实测发现：resolveInsideRoot 单独调用时 %2e%2e 被当成普通文件名放行，
   因为解码只发生在 startServer 里。修复：把解码移进 resolveInsideRoot。

   这里额外验「双重解码」这个经典洞：
     %252e%252e → 解一次 = %2e%2e → 解两次 = ..
   如果 startServer 和 resolveInsideRoot 各解一次，就会正好变成 ..。
   */
import { resolveInsideRoot } from 'file:///D:/project/donghua/desktop-electron/server.mjs';
import { resolve, sep } from 'node:path';

let pass = 0, fail = 0; const failures = [];
const t = (n, f) => { try { f(); pass++; } catch (e) { fail++; failures.push(`${n} → ${e.message}`); } };
const eq = (a, b, m) => { if (String(a) !== String(b)) throw new Error(`${m || ''} 期望 ${b}，实际 ${a}`); };
const ok = (v, m) => { if (!v) throw new Error(m || '期望为真'); };

const ROOT = 'D:/project/donghua/desktop-electron';

t('编码: %2e%2e 被解码后拒绝（云端踩到的那个洞）', () => {
  eq(resolveInsideRoot(ROOT, '/%2e%2e/package.json').ok, false);
});
t('编码: %2E%2E 大写也拒绝', () => {
  eq(resolveInsideRoot(ROOT, '/%2E%2E/package.json').ok, false);
});
t('编码: 混合大小写 %2e%2E 拒绝', () => {
  eq(resolveInsideRoot(ROOT, '/%2e%2E/package.json').ok, false);
});
t('编码: %2e%2e 在中间也拒绝', () => {
  eq(resolveInsideRoot(ROOT, '/a/%2e%2e/b').ok, false);
});
t('双重编码: %252e%252e 不会被二次解码成 ..', () => {
  // 正确行为：解一次得到字面目录名 `%2e%2e`，它**留在 root 内**，
  // 后续 stat 找不到文件 → 404。关键断言是「没有跑出 root」，而不是「被拒」。
  // 之前我写成了 startsWith(正斜杠数组)，比较方式错了导致误报。
  const rootResolved = resolve(ROOT);
  for (const p of ['/%252e%252e/package.json', '/%252e%252e%252fpackage.json']) {
    const r = resolveInsideRoot(ROOT, p);
    if (!r.ok) continue;   // 直接拒了也行
    ok(r.file === rootResolved || r.file.startsWith(rootResolved + sep),
      `双重编码后跑出了 root: ${r.file}`);
  }
});
t('畸形编码: 单个 % 返回 bad-encoding', () => {
  const r = resolveInsideRoot(ROOT, '/%zz');
  eq(r.ok, false);
  eq(r.reason, 'bad-encoding');
});
t('正常: 编码过的中文名能放行', () => {
  const r = resolveInsideRoot(ROOT, '/%E4%B8%AD%E6%96%87.js');
  ok(r.ok, '中文文件名被误拒');
});
t('正常: 普通路径放行', () => {
  ok(resolveInsideRoot(ROOT, '/main.js').ok);
  ok(resolveInsideRoot(ROOT, '/server.mjs').ok);
});
t('普通: /../ 拒绝', () => {
  eq(resolveInsideRoot(ROOT, '/../package.json').ok, false);
});
t('反斜杠: ..\\ 拒绝', () => {
  eq(resolveInsideRoot(ROOT, '\\..\\package.json').ok, false);
});

console.log('');
if (fail === 0) console.log(`✓ 编码变体防护全部通过 ${pass}/${pass + fail}`);
else {
  console.log(`✗ ${fail}/${pass + fail} 失败`);
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail === 0 ? 0 : 1);
