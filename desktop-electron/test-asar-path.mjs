/* asar 路径形态下的穿越防护（纯逻辑，本机可信）
   ------------------------------------------------------------
   本机环境不可信的是「安装/打包类」结果，纯路径计算是可信的。
   这里专门验 asar 虚拟路径（形如 /path/app.asar）作为 root 时，
   resolveInsideRoot 的两道校验是否仍然成立。

   为什么必须单独验：
     普通目录下 normalize(join(root, p)) 自己就能吃掉 `..`，
     所以第二道校验看起来「总是通过」。但在 asar 虚拟路径下，
     路径字符串不是真实文件系统语义，startsWith 的行为需要单独确认。
     而第一道（原始路径含 ..）是不依赖任何路径语义的，asar 下仍然有效 ——
     这才是它真正的价值。
   ============================================================ */

import { resolveInsideRoot } from 'file:///D:/project/donghua/desktop-electron/server.mjs';
import { resolve, sep, posix } from 'node:path';

let pass = 0, fail = 0; const failures = [];
const t = (n, f) => { try { f(); pass++; } catch (e) { fail++; failures.push(`${n} → ${e.message}`); } };
const eq = (a, b, m) => { if (String(a) !== String(b)) throw new Error(`${m || ''} 期望 ${b}，实际 ${a}`); };
const ok = (v, m) => { if (!v) throw new Error(m || '期望为真'); };

/* 模拟 asar 虚拟路径。注意：在 Windows 上 path.resolve 会把 / 转成 \，
   而 asar 在跨平台时两边写法都有，所以测两个形态。 */
const ASAR_WIN = resolve('D:/project/donghua/desktop-electron/out/app.asar');
const ASAR_POSIX = '/opt/app/resources/app.asar';

console.log('asar root (win 形态):', ASAR_WIN);
console.log('asar root (posix 形态):', ASAR_POSIX);

for (const [label, root] of [['win', ASAR_WIN], ['posix', ASAR_POSIX]]) {
  console.log(`\n--- ${label} 形态 ---`);

  t(`${label}: asar 根内正常文件放行`, () => {
    ok(resolveInsideRoot(root, '/index.html').ok, '/index.html 应放行');
    ok(resolveInsideRoot(root, '/src/main.js').ok, '/src/main.js 应放行');
  });

  t(`${label}: /../x 被拒`, () => {
    eq(resolveInsideRoot(root, '/../package.json').ok, false);
  });

  t(`${label}: /a/../../x 被拒`, () => {
    eq(resolveInsideRoot(root, '/a/../../package.json').ok, false);
  });

  t(`${label}: URL 编码 %2e%2e 被拒`, () => {
    eq(resolveInsideRoot(root, '/%2e%2e/package.json'.replace(/%2e/gi, '.')).ok, false);
  });

  t(`${label}: 反斜杠 ..\\ 被拒`, () => {
    eq(resolveInsideRoot(root, '\\..\\package.json').ok, false);
  });

  t(`${label}: 多个 .. 被拒`, () => {
    eq(resolveInsideRoot(root, '/../../../../../etc/passwd').ok, false);
  });

  t(`${label}: 试图跳出 asar 到相邻文件被拒`, () => {
    // 从 app.asar 跳到 resources/ 下的真实文件
    eq(resolveInsideRoot(root, '/../secret.txt').ok, false);
  });
}

/* 额外：确认第一道（原始 .. 检查）不依赖路径语义 —— 这是 asar 下的真正防线 */
t('第一道不依赖路径语义（纯字符串判断）', () => {
  // 用一个完全假的 root，只要原始路径含 .. 就必须拒
  const fakeRoot = '/this/is/a/fake/app.asar';
  eq(resolveInsideRoot(fakeRoot, '/../anything').ok, false, '假 asar 路径下也必须拒');
  eq(resolveInsideRoot(fakeRoot, '/nominal.js').ok, true, '正常路径应放行');
});

console.log('');
if (fail === 0) console.log(`✓ asar 路径形态下的穿越防护全部通过 ${pass}/${pass + fail}`);
else {
  console.log(`✗ ${fail}/${pass + fail} 失败`);
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail === 0 ? 0 : 1);
