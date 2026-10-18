/* ============================================================
   desktop-electron/traversal-under-asar.mjs · asar 路径下的穿越实测
   ------------------------------------------------------------
   被 main.js 在「探针模式」下调用，不单独作为入口 —— 因为
   `npx electron 某文件.mjs` 的入口解析行为依赖 Electron 版本，
   不如统一走 app 入口稳。

   调用方式（云端 CI）：
     ELECTRON_SMOKE_ASAR=/abs/path/app.asar ELECTRON_TRAVERSAL=1 npx electron .

   为什么必须用原始 socket：
     fetch / WHATWG URL 会在**客户端**就把 `/../x` 规范化成 `/x`，
     服务端根本收不到 `..`，测出来永远是「没穿越」的假安全。
   ============================================================ */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { connect } from 'node:net';
import { startServer } from './server.mjs';

const results = [];
const report = (n, pass, detail) => {
  results.push({ n, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${n}${detail ? ' → ' + detail : ''}`);
};

const watchdog = setTimeout(() => { console.log('FAIL: 超时'); app.exit(1); }, 60_000);
watchdog.unref?.();

function rawGet(port, rawPath) {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1');
    let buf = '';
    sock.setTimeout(8000, () => { sock.destroy(); resolve({ status: 0, text: 'TIMEOUT' }); });
    sock.on('connect', () => {
      sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.on('end', () => {
      const status = Number((buf.match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 0);
      const body = buf.slice(buf.indexOf('\r\n\r\n') + 4);
      resolve({ status, text: body });
    });
    sock.on('error', () => resolve({ status: 0, text: 'ERR' }));
  });
}

async function main() {
  const asarRoot = process.env.ELECTRON_SMOKE_ASAR;
  console.log(`asarRoot=${asarRoot}`);
  console.log(`exists=${fs.existsSync(asarRoot)}`);
  console.log(`index 可读=${(() => { try { return fs.existsSync(path.join(asarRoot, 'index.html')); } catch (e) { return 'ERR:' + e.message; } })()}`);

  // 在 root 之外放一个带唯一签名的文件，穿越成功就会读到它
  const SIGNATURE = 'LEAKED-' + Date.now() + '-SECRET';
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), SIGNATURE);
  console.log(`诱饵文件: ${path.join(outsideDir, 'secret.txt')} 签名=${SIGNATURE}`);

  const server = await startServer({ root: asarRoot, port: 0 });
  console.log(`服务: ${server.url}`);

  // 先确认正常路径是通的（否则「全部 403」可能是服务根本没工作）
  const normal = await rawGet(server.port, '/index.html');
  report('正常路径 /index.html 返回 200', normal.status === 200,
    `status=${normal.status} len=${normal.text.length}`);

  // 穿越请求：全部必须 403，且零泄露
  const evil = [
    '/../secret.txt',
    '/../../secret.txt',
    '/a/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2E%2E/secret.txt',
    '/..%2fsecret.txt',
    '/..%5csecret.txt',
    '/sub/..%2f..%2fsecret.txt',
    '/..\\secret.txt',
    `/../${path.basename(outsideDir)}/secret.txt`,
  ];
  let allBlocked = true;
  let leaked = false;
  console.log('\n--- 穿越请求实测 ---');
  for (const p of evil) {
    const r = await rawGet(server.port, p);
    const isLeak = r.text.includes(SIGNATURE);
    if (r.status !== 403) allBlocked = false;
    if (isLeak) leaked = true;
    console.log(`  ${r.status === 403 && !isLeak ? '✓' : '✗'} ${p.padEnd(30)} → ${r.status}${isLeak ? '  ⚠ 泄露!' : ''}`);
  }
  report('穿越全部 403', allBlocked);
  report('零泄露（未读到诱饵文件）', !leaked);

  await server.close();

  const failed = results.filter(r => !r.pass);
  console.log('\n===== 汇总 =====');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`);
  console.log(`总计 ${results.length} 条，失败 ${failed.length} 条`);
  app.exit(failed.length === 0 ? 0 : 1);
}

export { main };
