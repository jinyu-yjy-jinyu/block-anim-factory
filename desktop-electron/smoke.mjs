/* ============================================================
   desktop-electron/smoke.mjs · 云端无头冒烟（CI 用）
   ------------------------------------------------------------
   本机环境不可信（安装/打包类结果不能作判据），所以「Electron 真的能
   起窗口 + 真的能从 asar 读文件」这两步只在云端 runner 上验。

   验五件事，每条 PASS/FAIL 打日志，失败退出码 1：
     1 Electron 能启动（app.whenReady）
     2 本地服务能起（port 0 系统分配）
     3 页面能加载（did-finish-load）
     4 渲染进程里 VideoEncoder 可用 + 真编码一帧
     5 目录穿越在**当前 root** 下被挡住（root 可能是 asar 虚拟路径）

   第 5 条是关键：普通目录下第二道校验就够用了，但 asar 虚拟路径下
   `startsWith` 可能失效，那时只有「原始路径含 ..」这一道能挡。
   本机测不出这个差异，必须在这里测。
   ============================================================ */

import electronPkg from 'electron';
const { app, BrowserWindow } = electronPkg;
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, resolveInsideRoot } from './server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ' → ' + detail : ''}`);
}

// 无头环境可能永远不 resolve，不能让 job 挂满 360 分钟
const watchdog = setTimeout(() => {
  console.log('FAIL: 总超时（90s 内未完成）');
  app.exit(1);
}, 90_000);
watchdog.unref?.();

let win = null;
let server = null;

/** 定位 web 根：打包后是 asar 内部，开发时是仓库根。
 *  CI 探针会通过 ELECTRON_SMOKE_ASAR 显式指定一个 .asar 文件，
 *  让 root 变成真正的 asar 虚拟路径 —— 那样才验得到 startsWith 的行为。 */
function resolveWebRoot() {
  const fromEnv = process.env.ELECTRON_SMOKE_ASAR;
  if (fromEnv) {
    const abs = path.resolve(fromEnv);
    console.log(`使用环境变量指定的 asar root: ${abs}`);
    return abs;
  }
  const cands = [
    __dirname,                       // 打包后：asar 根
    path.join(__dirname, '..'),      // 开发时：仓库根
  ];
  for (const c of cands) {
    try {
      if (fs.existsSync(path.join(c, 'index.html'))) return c;
    } catch { /* asar 路径异常，继续试 */ }
  }
  return null;
}

async function main() {
  console.log(`electron=${process.versions.electron} chrome=${process.versions.chrome} node=${process.versions.node}`);
  console.log(`platform=${process.platform} arch=${process.arch}`);

  // ---- 1 app.whenReady ----
  try {
    await app.whenReady();
    report('1 app.whenReady()', true, `isReady=${app.isReady()}`);
  } catch (e) {
    report('1 app.whenReady()', false, String(e && e.message || e));
    return finish();
  }

  const webRoot = resolveWebRoot();
  console.log(`webRoot=${webRoot}`);
  console.log(`__dirname=${__dirname}`);
  console.log(`app.isPackaged=${app.isPackaged}`);
  if (!webRoot) {
    report('2 本地服务能起', false, '找不到 index.html（打包后应在 asar 根）');
    return finish();
  }

  // ---- 2 服务 ----
  try {
    server = await startServer({ root: webRoot, port: 0 });
    report('2 本地服务能起', true, `port=${server.port} url=${server.url}`);
  } catch (e) {
    report('2 本地服务能起', false, String(e && e.message || e));
    return finish();
  }

  // ---- 5 穿越防护（在真实 root 下，可能是 asar）----
  // 直接调纯函数，避免被 fetch 的客户端规范化干扰
  {
    const probes = [
      ['/../package.json', false],
      ['/%2e%2e/package.json', false],
      ['/a/../%2e%2e/package.json', false],
      ['/..\\package.json', false],
      ['/index.html', true],
      ['/src/main.js', true],
    ];
    let allOk = true;
    const detail = [];
    for (const [p, wantOk] of probes) {
      const r = resolveInsideRoot(webRoot, p);
      const ok = r.ok === wantOk;
      if (!ok) allOk = false;
      detail.push(`${p}→${r.ok ? 'allow' : 'deny'}`);
    }
    report('5 目录穿越在当前 root 下被挡', allOk, detail.join(' '));
  }

  // ---- 3 窗口 + 页面加载 ----
  try {
    win = new BrowserWindow({
      width: 480, height: 360, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
  } catch (e) {
    report('3 页面能加载', false, 'new BrowserWindow 抛错: ' + (e && e.message || e));
    return finish();
  }

  const loaded = await new Promise((resolve) => {
    let settled = false;
    const done = (ok, d) => { if (!settled) { settled = true; resolve({ ok, d }); } };
    win.webContents.once('did-finish-load', () => done(true, 'did-finish-load 已触发'));
    win.webContents.once('did-fail-load', (_e, code, desc, url) =>
      done(false, `did-fail-load code=${code} desc=${desc} url=${url}`));
    win.loadURL(server.url).catch((e) => done(false, 'loadURL 抛错: ' + (e && e.message || e)));
    setTimeout(() => done(false, '20s 内未触发 did-finish-load'), 20_000).unref?.();
  });
  report('3 页面能加载', loaded.ok, loaded.d);
  if (!loaded.ok) return finish();

  // 顺便确认渲染进程真的拿到了页面（标题或 DOM 存在）
  const domOk = await win.webContents.executeJavaScript(
    `({ title: document.title, hasCanvas: !!document.querySelector('canvas, #stage, .app'), bodyLen: document.body ? document.body.innerHTML.length : 0 })`
  ).catch(e => ({ err: String(e && e.message || e) }));
  console.log('渲染进程 DOM:', JSON.stringify(domOk));

  // ---- 4 WebCodecs ----
  const probe = await win.webContents.executeJavaScript(`(async () => {
    const out = {
      secure: window.isSecureContext,
      ve: typeof VideoEncoder === 'function',
      vd: typeof VideoDecoder === 'function',
      oc: typeof OffscreenCanvas === 'function',
      mr: typeof MediaRecorder === 'function',
    };
    if (out.ve) {
      try {
        const chunks = [];
        const enc = new VideoEncoder({ output: c => chunks.push(c.byteLength), error: () => {} });
        enc.configure({ codec: 'avc1.42001f', width: 320, height: 180, bitrate: 2000000, framerate: 30 });
        const cv = new OffscreenCanvas(320, 180);
        cv.getContext('2d').fillRect(0, 0, 80, 80);
        const vf = new VideoFrame(cv, { timestamp: 0 });
        enc.encode(vf, { keyFrame: true });
        vf.close();
        await enc.flush();
        enc.close();
        out.realEncode = chunks.length;
      } catch (e) { out.encErr = String(e && e.message || e); }
    }
    return out;
  })()`).catch(e => ({ err: String(e && e.message || e) }));

  report('4 VideoEncoder 可用且真编码成功',
    !!(probe && probe.ve && probe.realEncode > 0),
    `ve=${probe && probe.ve} vd=${probe && probe.vd} secure=${probe && probe.secure} realEncode=${probe && probe.realEncode}` +
    (probe && probe.encErr ? ` encErr=${probe.encErr}` : '') +
    (probe && probe.err ? ` err=${probe.err}` : ''));

  finish();
}

async function finish() {
  clearTimeout(watchdog);
  const failed = results.filter(r => !r.pass);
  console.log('\n===== 汇总 =====');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(`总计 ${results.length} 条，失败 ${failed.length} 条`);
  try { if (win) win.destroy(); } catch { }
  try { if (server) await server.close(); } catch { }
  app.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL: 未捕获异常 → ' + (e && e.stack || e));
  app.exit(1);
});

app.on('window-all-closed', () => { /* 交给 finish 显式退出 */ });
