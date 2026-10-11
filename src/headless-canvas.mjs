/* ============================================================
   headless-canvas.mjs · Node 下的 Canvas2D 记录桩
   ------------------------------------------------------------
   目的：在没有浏览器的环境里验证渲染管线。
   它不画真实像素，而是「记录」所有绘图调用，
   因此可以断言：
     · render() 在所有模板 / 所有帧上不抛异常
     · 相邻帧的绘图指令确实不同（画面在动）
     · 预览态与导出态产生完全一致的指令序列（渲染一致性）
   ============================================================ */

/** 创建一个「指令记录型」的 2D 上下文 */
export function makeCtx(record = []) {
  let cur = null;
  const saveStack = [];

  const rec = (name, args) => {
    const a = args || [];
    record.push(cur ? `${cur}|${name}(${fmt(a)})` : `${name}(${fmt(a)})`);
  };

  const ctx = {
    canvas: { width: 1920, height: 1080 },
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    shadowColor: 'rgba(0,0,0,0)',
    shadowBlur: 0,
    shadowOffsetY: 0,
    setLineDash: (d) => rec('setLineDash', [d]),
    measureText: (t) => {
      // 近似排版度量：CJK 按 1em，ASCII 按 0.55em
      let w = 0;
      for (const ch of String(t)) w += /[⺀-鿿＀-￯]/.test(ch) ? 1 : 0.55;
      return { width: w * parseFloat(ctx.font) };
    },
    save: () => { rec('save'); saveStack.push({ ga: ctx.globalAlpha, f: ctx.fillStyle, s: ctx.strokeStyle, fo: ctx.font }); },
    restore: () => {
      rec('restore');
      const st = saveStack.pop();
      if (st) { ctx.globalAlpha = st.ga; ctx.fillStyle = st.f; ctx.strokeStyle = st.s; ctx.font = st.fo; }
    },
    translate: (x, y) => rec('translate', [x, y]),
    scale: (x, y) => rec('scale', [x, y]),
    rotate: (a) => rec('rotate', [a]),
    clearRect: (...a) => rec('clearRect', a),
    // 带上当前画笔状态，测试才能断言「用什么颜色画了什么」
    fillRect: (...a) => rec('fillRect', [ctx.fillStyle, ...a]),
    strokeRect: (...a) => rec('strokeRect', [ctx.strokeStyle, ...a]),
    fillText: (t, x, y) => rec('fillText', [ctx.fillStyle, ctx.font, ctx.globalAlpha, t, x, y]),
    fill: () => rec('fill', [ctx.fillStyle]),
    stroke: () => rec('stroke', [ctx.strokeStyle, ctx.lineWidth]),
    beginPath: () => rec('beginPath'),
    closePath: () => rec('closePath'),
    moveTo: (...a) => rec('moveTo', a),
    lineTo: (...a) => rec('lineTo', a),
    arc: (...a) => rec('arc', a),
    rect: (...a) => rec('rect', a),
    arcTo: (...a) => rec('arcTo', a),
    setTransform: (...a) => rec('setTransform', a),
    transform: (...a) => rec('transform', a),
    createLinearGradient: () => ({ addColorStop() {} }),
    drawImage: () => rec('drawImage'),
    clip: () => rec('clip'),
  };
  return ctx;
}

function fmt(args) {
  return (args || []).map(a => (typeof a === 'number' ? round(a) : safe(a))).join(',');
}
function safe(a) {
  if (a === undefined) return 'undefined';
  if (a === null) return 'null';
  if (typeof a === 'object') {
    if (a.rgba) return 'Gradient';
    if (typeof a.width === 'number') return JSON.stringify({ width: round(a.width) });
    try { return JSON.stringify(a); } catch { return 'Object'; }
  }
  return JSON.stringify(a);
}
function round(n) { return Math.abs(n) < 1e-4 ? 0 : Math.round(n * 100) / 100; }