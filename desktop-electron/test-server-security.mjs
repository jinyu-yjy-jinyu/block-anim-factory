/* 目录穿越安全测试（server.mjs）
   ------------------------------------------------------------
   Chief 实测指出的问题：Electron 里 root 是 app.asar 虚拟路径，
   一旦 p 带 `..`，规范化后的路径可能跑出 asar 边界落到真实磁盘，
   于是 http://127.0.0.1:端口/../xxx 能读到任意文件。

   这里既测纯函数 resolveInsideRoot（快、可精确断言），
   也测真实 HTTP 服务（端到端）。 */
import { startServer, resolveInsideRoot } from './server.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, sep } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0; const failures = [];
const t = (n, f) => { try { f(); pass++; } catch (e) { fail++; failures.push(`${n} → ${e.message}`); } };
const eq = (a, b, m) => { if (String(a) !== String(b)) throw new Error(`${m || ''} 期望 ${b}，实际 ${a}`); };
const ok = (v, m) => { if (!v) throw new Error(m || '期望为真'); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', 'src');
console.log('测试根目录:', ROOT);

/* ---------- 一、纯函数：resolveInsideRoot ---------- */
t('穿越: /../package.json 被拒', () => {
  eq(resolveInsideRoot(ROOT, '/../package.json').ok, false);
});
t('穿越: /a/../../x 被拒', () => {
  eq(resolveInsideRoot(ROOT, '/a/../../package.json').ok, false);
});
t('穿越: URL 编码的 %2e%2e 被拒（decode 后）', () => {
  // 服务端会先 decodeURIComponent 再判断，这里直接喂 decode 后的结果
  eq(resolveInsideRoot(ROOT, '/%2e%2e/package.json'.replace(/%2e/gi, '.')).ok, false);
});
t('穿越: 反斜杠 ..\\ 被拒（Windows 也能穿越）', () => {
  eq(resolveInsideRoot(ROOT, '\\..\\package.json').ok, false);
});
t('穿越: 多个 .. 段被拒', () => {
  eq(resolveInsideRoot(ROOT, '/../../../../etc/passwd').ok, false);
});
t('正常: /main.js 允许', () => {
  const r = resolveInsideRoot(ROOT, '/main.js');
  ok(r.ok, '应允许');
  ok(r.file.endsWith('main.js'), `路径不对: ${r.file}`);
});
t('正常: 子目录 /sub/x.js 允许', () => {
  ok(resolveInsideRoot(ROOT, '/sub/x.js').ok);
});
t('正常: 深层子目录允许', () => {
  ok(resolveInsideRoot(ROOT, '/a/b/c/d.js').ok);
});
t('边界: 前缀相同但不同目录不误放行', () => {
  // /a/bc 不应被当成 /a/b 的子路径
  const r = resolveInsideRoot(ROOT, '/../donghua-evil/x.js');
  eq(r.ok, false, '前缀伪装必须被拒');
});

/* ---------- 二、端到端：真实 HTTP 服务 ---------- */
const tmp = mkdtempSync(join(tmpdir(), 'traversal-'));
const webRoot = join(tmp, 'web');
mkdirSync(webRoot, { recursive: true });
writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>ok</title>');
writeFileSync(join(webRoot, 'app.js'), 'export const x = 1;');
mkdirSync(join(webRoot, 'sub'), { recursive: true });
writeFileSync(join(webRoot, 'sub', 'mod.js'), 'export const y = 2;');
// 根目录之外放一个「机密」文件，穿越成功就会读到它
writeFileSync(join(tmp, 'secret.txt'), 'TOP-SECRET');

const srv = await startServer({ root: webRoot, port: 0 });
console.log('服务端口:', srv.port, '（0 = 系统分配）');

/* 注意：不能用 fetch 测穿越。
   WHATWG URL 会在**客户端**就把 `/../secret.txt` 规范化成 `/secret.txt`，
   服务端根本收不到 `..`，于是测出来永远是「没穿越」的假安全。
   必须用原始 socket 发出未经规范化的请求行，才能验到服务端自己的判断。 */
import { connect } from 'node:net';

function rawGet(port, rawPath) {
  return new Promise((res, rej) => {
    const sock = connect(port, '127.0.0.1');
    let buf = '';
    sock.setTimeout(5000, () => { sock.destroy(); rej(new Error('timeout')); });
    sock.on('connect', () => {
      // 直接写原始请求行，path 不做任何规范化
      sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.on('end', () => {
      const status = Number((buf.match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 0);
      const body = buf.slice(buf.indexOf('\r\n\r\n') + 4);
      res({ status, text: body });
    });
    sock.on('error', rej);
  });
}

const get = async (path) => rawGet(srv.port, path);

const cases = [
  ['/index.html', 200],
  ['/', 200],
  ['/app.js', 200],
  ['/sub/mod.js', 200],
  // 下面这些必须走原始请求才能验到服务端的判断
  ['/../secret.txt', 403],
  ['/a/../../secret.txt', 403],
  ['/%2e%2e/secret.txt', 403],
  ['/%2E%2E/secret.txt', 403],
  ['/..%2fsecret.txt', 403],
  ['/sub/..%2f..%2fsecret.txt', 403],
  ['/..\\secret.txt', 403],
  ['/nonexistent.js', 404],
];

console.log('\n请求结果：');
for (const [path, want] of cases) {
  const r = await get(path);
  const mark = r.status === want ? '✓' : '✗';
  const leaked = r.text.includes('TOP-SECRET') ? '  ⚠ 泄露了 secret!' : '';
  console.log(`  ${mark} ${path.padEnd(28)} → ${r.status}（期望 ${want}）${leaked}`);
  t(`HTTP ${path} → ${want}`, () => {
    eq(r.status, want, `实际 ${r.status}`);
    ok(!r.text.includes('TOP-SECRET'), '读到了根目录之外的文件');
  });
}

await srv.close();
console.log('\n服务已关闭');

console.log('');
if (fail === 0) console.log(`✓ 目录穿越防护全部通过 ${pass}/${pass + fail}`);
else {
  console.log(`✗ ${fail}/${pass + fail} 失败`);
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail === 0 ? 0 : 1);
