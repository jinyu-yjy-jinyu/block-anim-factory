/* ============================================================
   desktop-electron/server.js · 可复用的本地静态服务
   ------------------------------------------------------------
   从 scripts/serve.mjs 抽出来的同一份实现 —— 网页版（npm start）
   和 Electron 桌面版共用它，避免「桌面版的服务」和「网页版的服务」
   各写一遍然后悄悄跑偏。

   为什么桌面版必须起 HTTP 服务而不是用 file://：
     ES Module / fetch / Worker 在 file:// 下全被 CORS 挡死
     （origin 是 null，报错只允许 chrome/http/data 等 scheme）。
     实测 file:// 是安全上下文、WebCodecs 可用，但模块一个都加载不了。

   与传统 HttpListener 方案的区别：这里用 Node 的 http 模块，
   不需要 HTTP.SYS 命名空间，没有 WPF 版那个「受限环境拿不到句柄」的坑。
   ============================================================ */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

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
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/**
 * 判断一个请求路径是否安全地落在 root 之内。
 *
 * 为什么要两道校验，而不是只靠 `normalize(join(root, p))`：
 *   在普通目录下 normalize 就能把 `..` 消掉，join 出来的路径跑不出 root，
 *   所以网页版原先那一行是安全的。但桌面版的 root 是 **app.asar 这个
 *   虚拟路径** —— 一旦 p 里带 `..`，规范化后的路径可能跑出 asar 边界、
 *   落到真实磁盘上，于是浏览器访问 `http://127.0.0.1:端口/../xxx`
 *   就能读到任意文件。这是安全边界，不能只靠 path 归一化的副作用。
 *
 * @param {string} rootAbs 根目录（可以未 resolve，内部会先规范化）
 * @param {string} p       请求路径（以 / 开头）。可以带 %2e%2e 这类编码 ——
 *                         函数内部会先解码再判断，调用方不必先解码。
 *                         这个容错是必须的：之前把 decodeURIComponent 只放在
 *                         startServer 里，凡是绕过 HTTP 直接调本函数的地方
 *                         （测试、将来的其它调用点）都会把 `%2e%2e` 当成普通
 *                         文件名放行 —— 云端实测就踩到了这个洞。
 * @returns {{ ok: boolean, file?: string, reason?: string }}
 */
export function resolveInsideRoot(rootAbs, p) {
  // 容错：允许调用方传入未 resolve 的 root（测试会这么用）。
  // 不统一规范化的话，posix 形态的 asar 路径在 Windows 上会拼成
  // 混合分隔符的字符串，startsWith 判断随之失真 —— 那是误报的来源。
  const rootResolved = resolve(rootAbs);
  const rootPrefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;

  // 先解码：`%2e%2e` 必须当成 `..` 来判。解码失败（畸形编码）直接拒绝。
  let decoded;
  try {
    decoded = decodeURIComponent(String(p));
  } catch {
    return { ok: false, reason: 'bad-encoding' };
  }

  // 第一道：原始路径里出现 `..` 段就直接拒绝。
  // 归一化之后 `..` 会消失，事后再查就查不到了，所以必须在归一化之前看。
  // 反斜杠也要当分隔符（Windows 上 `..\` 同样能穿越）。
  const segments = decoded.split(/[\\/]+/);
  if (segments.some((seg) => seg === '..')) {
    return { ok: false, reason: 'dotdot-segment' };
  }

  // 第二道：归一化后必须真的落在 root 里（兜底，防其它绕过写法）
  const file = normalize(join(rootResolved, decoded));
  if (file !== rootResolved && !file.startsWith(rootPrefix)) {
    return { ok: false, reason: 'outside-root' };
  }

  return { ok: true, file };
}

/**
 * 起一个只监听回环地址的静态文件服务。
 *
 * @param {object} opts
 * @param {string} opts.root            要服务的根目录（绝对路径）
 * @param {number} [opts.port=0]        0 = 让系统分配空闲端口（桌面版必须用 0）
 * @param {string} [opts.host='127.0.0.1'] 只监听回环，不要暴露到局域网
 * @returns {Promise<{port:number, host:string, url:string, close:()=>Promise<void>}>}
 */
export async function startServer({ root, port = 0, host = '127.0.0.1' } = {}) {
  if (!root) throw new Error('startServer 需要 root 参数');
  // 统一成绝对路径（末尾分隔符的处理在 resolveInsideRoot 里做）
  const rootAbs = resolve(root);

  const server = createServer(async (req, res) => {
    try {
      // 注意：这里**不做 decodeURIComponent**。
      // 解码统一由 resolveInsideRoot 负责 —— 两边都解会变成双重解码，
      // 而 `%252e%252e` 双重解码后正好是 `..`，等于自己开了一个洞。
      let p = String(req.url || '/').split('?')[0];
      if (p === '/') p = '/index.html';

      const chk = resolveInsideRoot(rootAbs, p);
      if (!chk.ok) {
        // 畸形编码按 400 处理，其余一律 403
        const code = chk.reason === 'bad-encoding' ? 400 : 403;
        res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(code === 400 ? 'bad request' : 'forbidden');
        return;
      }
      const file = chk.file;

      const s = await stat(file);
      if (s.isDirectory()) {
        // 不列出目录，避免把工程结构暴露出去
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('forbidden');
        return;
      }

      const buf = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    } catch {
      // 404 必须是纯文本，不能吞成 HTML —— 否则前端 fetch 到一个
      // 200 的 HTML，JSON.parse 报的错和真实原因完全无关
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    }
  });

  await new Promise((res, rej) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      rej(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      res();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const actual = server.address().port;
  return {
    port: actual,
    host,
    url: `http://${host}:${actual}/`,
    close: () => new Promise((res) => server.close(() => res())),
  };
}
