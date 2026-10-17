/* ============================================================
   scripts/serve.mjs · 本地开发服务器
   用法：npm start  → http://localhost:5173
   （ES Modules 不能用 file:// 打开，必须走 http）
   ============================================================ */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* 端口解析。原写法是 `Number(process.env.PORT) || 5173`，
   而 `Number('0') || 5173` 里 0 被当成「无值」回退成 5173 —— 于是
   注释许诺的「PORT=0 让系统分配空闲端口」从未成立（实测传 PORT=0
   仍然监听 5173）。这里改成显式判空，并顺带堵两个坑：
     · PORT=''   → 不能当成 0（CI 里空变量很常见）
     · PORT='  ' → Number('  ') 是 0，会被误当成「随机端口」
     · PORT='abc' → NaN，直接传给 listen 会抛错
   只有 0~65535 的整数才采用，其余一律回退 5173。 */
const rawPort = process.env.PORT;
const parsedPort = rawPort !== undefined && rawPort.trim() !== '' ? Number(rawPort) : NaN;
const PORT = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535
  ? parsedPort
  : 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    // 防目录穿越
    const file = normalize(join(root, p));
    if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
    const s = await stat(file);
    if (s.isDirectory()) { res.writeHead(403); res.end('forbidden'); return; }
    const buf = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

/* 端口被占是常事：上一次 npm start 没退干净、或本机 5173 已被别的服务用着。
   没有 error 监听的话，EADDRINUSE 会变成未捕获异常直接把进程带走，
   用户只看到一句看不懂的 ENOENT/EADDRINUSE，README 又让所有人 npm start。
   这里给出可操作的提示，并支持 PORT=0（让系统分配空闲端口）。 */
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗ 端口 ${PORT} 已被占用。`);
    console.error('    换一个端口：  PORT=5174 npm start');
    console.error('    或先停掉占用该端口的程序。\n');
  } else {
    console.error('\n  ✗ 服务器启动失败：', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, () => {
  const actual = server.address().port;
  console.log(`\n  积木动画工厂 · V0 原型`);
  console.log(`  → http://localhost:${actual}\n`);
  console.log(`  自测：在页面控制台执行 import('./src/selftest.js').then(m => m.run())`);
  console.log(`  快捷键：空格播放 · F10 单步 · F9 断点 · Ctrl+Z 撤销\n`);
});

// 端口 0 时把实际端口打印出来，便于脚本抓取
if (PORT === 0) console.log('PORT=' + server.address().port);