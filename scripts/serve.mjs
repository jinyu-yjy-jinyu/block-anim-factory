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
const PORT = Number(process.env.PORT) || 5173;

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

server.listen(PORT, () => {
  console.log(`\n  积木动画工厂 · V0 原型`);
  console.log(`  → http://localhost:${PORT}\n`);
  console.log(`  自测：在页面控制台执行 import('./src/selftest.js').then(m => m.run())`);
  console.log(`  快捷键：空格播放 · F10 单步 · F9 断点 · Ctrl+Z 撤销\n`);
});