/* ============================================================
   desktop-electron/main.js · Electron 主进程（最小骨架）
   ------------------------------------------------------------
   职责顺序：
     1. 起本地静态服务（port 0，让系统分配）
     2. 建窗口，loadURL(服务的地址)
     3. 失败兜底：服务起不来 / 页面加载失败 → 显示可读的错误页
     4. 退出时关掉服务（不留孤儿端口）

   为什么起本地服务而不是 file://：
     ES Module / fetch / Worker 在 file:// 下全被 CORS 挡死
     （origin 是 null，只允许 chrome/http/data 等 scheme）。
     实测 file:// 是安全上下文、WebCodecs 可用，但模块一个都加载不了。

   为什么端口必须是 0：
     用户可能同时开两个实例。硬编码端口第二个就撞了。
     scripts/serve.mjs 里 PORT=0 的 bug 已修（commit 636ae31），
     server.js 的 startServer 直接透传 0 给 listen()。
   ============================================================ */

const { app, BrowserWindow, dialog, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

/* server.mjs 是 ESM（scripts/serve.mjs 要 import 它，网页版和桌面版共用
   同一份服务实现）。主进程这里是 CommonJS，不能在顶层 require 一个 ESM 模块，
   所以用动态 import() 在需要时加载 —— Electron 33 支持这么用。 */
let startServer = null;
async function loadServer() {
  if (!startServer) {
    ({ startServer } = await import('./server.mjs'));
  }
  return startServer;
}

/* 探针模式：CI 里用环境变量切换，不在代码里硬编码测试分支。
   ELECTRON_TRAVERSAL=1 → 只跑 asar 路径下的目录穿越实测然后退出，
   不建窗口。这样 Electron 的入口始终是 app 主入口（main.js），
   不依赖「npx electron 某文件.mjs」的入口解析行为。 */
if (process.env.ELECTRON_TRAVERSAL === '1') {
  app.whenReady().then(async () => {
    const mod = await import('./traversal-under-asar.mjs');
    await mod.main();
  }).catch((e) => {
    console.log('FAIL: 探针未捕获异常 → ' + (e && e.stack || e));
    app.exit(1);
  });
} else {

// 单实例锁：多开会变成两个服务 + 两个窗口，抢同一个工程文件
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow = null;
  let server = null;

  /* preload 的 desktopBridge.saveAs 通过这个通道请求主进程写盘。
     以前只有 preload 的 invoke，没有这里的 handler —— 页面一旦调用就报
     「No handler registered for 'desktop:save-as'」，大文件保存能力形同虚设。
     写盘路径必须由系统保存对话框选择；页面只提供内容与建议文件名，
     不能直接指定任意路径。 */
  ipcMain.handle('desktop:save-as', async (event, payload) => {
    try {
      const raw = payload && payload.buffer;
      if (!raw || typeof raw.byteLength !== 'number') {
        return { saved: false, reason: 'invalid-payload' };
      }

      const suggested = String(payload.suggestedName || '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .trim()
        .slice(0, 180) || '导出文件';

      const win = BrowserWindow.fromWebContents(event.sender);
      const opts = { title: '保存导出文件', defaultPath: suggested };
      const { canceled, filePath } = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts);
      if (canceled || !filePath) return { saved: false, reason: 'canceled' };

      await fs.promises.writeFile(filePath, Buffer.from(raw));
      return { saved: true, path: filePath };
    } catch (e) {
      return { saved: false, reason: String((e && e.message) || e) };
    }
  });

  /**
   * 找出要服务的 Web 根目录。
   *
   * 打包后：resources/app.asar 里含有 index.html 与 src/，
   *         __dirname 指向 app.asar 内部，直接用即可。
   * 开发时：本文件在 desktop-electron/ 下，仓库根在上一级。
   */
  function resolveWebRoot() {
    const candidates = [
      // 打包后：本文件被打进 asar 根，仓库的 index.html 与 src 也在根
      __dirname,
      // 开发时：仓库根
      path.join(__dirname, '..'),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(path.join(c, 'index.html'))) return c;
      } catch { /* asar 路径异常时继续试下一个 */ }
    }
    return null;
  }

  /** 显示一个可读的错误页，而不是留一个空白窗口 */
  function showErrorPage(win, title, detail) {
    const html = `<!doctype html><html><head><meta charset="utf-8">
<title>启动失败</title>
<style>
  body{margin:0;font:14px/1.7 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;
       background:#14161c;color:#e6e8ee;padding:40px}
  h1{font-size:20px;margin:0 0 16px;color:#ff6b6b}
  pre{background:#1d2029;padding:16px;border-radius:8px;overflow:auto;
      font-size:12px;line-height:1.6;color:#b9c0d0;white-space:pre-wrap}
  .hint{color:#8b93a6;margin-top:20px}
</style></head><body>
<h1>${title}</h1>
<pre>${String(detail).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>
<p class="hint">如果反复出现，请把上面的信息反馈给开发者。</p>
</body></html>`;
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  }

  async function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      center: true,
      minWidth: 1024,
      minHeight: 680,
      show: false,                    // 等 ready-to-show，避免白屏闪一下
      backgroundColor: '#14161c',
      title: '积木动画工厂',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        // 页面拿不到 require / process / fs —— 全部通过 preload 的
        // contextBridge 白名单暴露。这是 Electron 的安全基线，别动。
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,   // preload 需要 require('electron')，故关 sandbox
        // 导出大文件时会连续读画布，保留磁盘缓存有帮助
        backgroundThrottling: false,
      },
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());

    // 新窗口请求（target=_blank、外链）交给系统浏览器，不在应用里开
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    // ---- 起服务 ----
    const webRoot = resolveWebRoot();
    if (!webRoot) {
      showErrorPage(mainWindow,
        '找不到 Web 资源',
        '在以下位置都没有找到 index.html：\n' +
        `  ${__dirname}\n  ${path.join(__dirname, '..')}\n\n` +
        '如果你在开发环境运行，请确认从仓库根目录启动。');
      mainWindow.show();
      return;
    }

    try {
      // port: 0 → 让系统分配空闲端口，两个实例也不会撞
      const start = await loadServer();
      server = await start({ root: webRoot, port: 0 });
    } catch (e) {
      showErrorPage(mainWindow,
        '本地服务启动失败',
        `错误：${e && e.message}\n\n` +
        `Web 根目录：${webRoot}\n\n` +
        '常见原因：系统禁止监听回环地址、安全软件拦截。');
      mainWindow.show();
      return;
    }

    // ---- 导航白名单 ----
    // 页面只应停留在本地服务上。一旦被导航到外部站点，远端页面会继承
    // preload 暴露的 desktopBridge.saveAs，等于把写盘对话框交给陌生网页。
    // 外部链接一律交给系统浏览器。
    mainWindow.webContents.on('will-navigate', (event, url) => {
      try {
        const target = new URL(url);
        if (target.origin === new URL(server.url).origin) return;
        event.preventDefault();
        if (target.protocol === 'http:' || target.protocol === 'https:') {
          shell.openExternal(url);
        }
      } catch {
        event.preventDefault();
      }
    });

    // ---- 加载 ----
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      showErrorPage(mainWindow,
        '页面加载失败',
        `错误码：${code}\n说明：${desc}\n地址：${url}\n\n` +
        '常见原因：杀软拦截了回环连接、或资源没打进包里。');
    });

    await mainWindow.loadURL(server.url);
  }

  app.whenReady().then(async () => {
    await createWindow();

    // macOS：点 Dock 图标时如果没窗口就再建一个
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('second-instance', () => {
    // 用户重复点了图标：把已有窗口拉到前面，不要开第二个
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('window-all-closed', () => {
    // macOS 的惯例是关窗不退出，但这里是个"做视频的工具"，
    // 关掉主窗口就该退出（否则后台留一个占端口的进程）
    app.quit();
  });

  // 退出前关掉服务，别留孤儿端口
  let quitting = false;
  app.on('before-quit', async (e) => {
    if (quitting) return;
    if (!server) return;
    e.preventDefault();
    quitting = true;
    try { await server.close(); } catch { /* 已经关了 */ }
    server = null;
    app.quit();
  });

  process.on('uncaughtException', (err) => {
    try { dialog.showErrorBox('未捕获错误', String(err && err.stack || err)); } catch { }
    app.exit(1);
  });
}

}   // ← 结束「非探针模式」的 else 块

