/* ============================================================
   desktop-electron/preload.js · 最小桥接
   ------------------------------------------------------------
   只暴露两个能力，其它一律不给：
     · isDesktop    页面据此判断"我在桌面壳里"（可用于调整 UI 文案）
     · saveAs       大文件保存对话框（避免 Blob 全量驻留内存）

   为什么不需要下载桥接：
     src/exporter.js 的 download() 用的是 URL.createObjectURL + <a download>，
     Electron 原生支持这套，会弹系统保存对话框，主进程里 14 处
     EX.download(...) 调用一行都不用改。所以 saveAs 只在导出超大文件
     （如 universal 打包的成片、PNG 序列帧 zip）时才用得上。

   安全边界：
     contextIsolation: true + nodeIntegration: false（见 main.js），
     所以页面拿不到 require / process / fs，只能通过这里的 contextBridge。
   ============================================================ */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBridge', {
  /** 页面据此显示"桌面版"标识、或调整与浏览器不同的文案 */
  isDesktop: true,
  /** 平台标识，界面上可能用于快捷键提示（Cmd vs Ctrl） */
  platform: process.platform,

  /**
   * 弹出系统保存对话框并把内容写到用户选的位置。
   * 适用于超大文件：页面只需传一个 Blob，主进程流式写入，
   * 不需要把整个文件留在渲染进程内存里。
   *
   * @param {Blob} blob
   * @param {string} suggestedName
   * @returns {Promise<{ saved: boolean, path?: string, reason?: string }>}
   */
  saveAs: async (blob, suggestedName) => {
    try {
      // 渲染进程无法直接把 Blob 传给主进程（IPC 只传结构化克隆能处理的），
      // 这里转成 ArrayBuffer 再传，主进程用 fs 写盘。
      const buf = await blob.arrayBuffer();
      return await ipcRenderer.invoke('desktop:save-as', {
        buffer: buf,
        suggestedName: String(suggestedName || '导出文件'),
      });
    } catch (e) {
      return { saved: false, reason: String(e && e.message || e) };
    }
  },
});
