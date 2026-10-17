/* ============================================================
   renderer.js · 渲染引擎（编辑态与导出态唯一共用实现）
   ------------------------------------------------------------
   规划要求：编辑用 DOM/SVG、导出换一套实现 → 必然「预览和成片不一样」。
   因此这里只有一个 render(scene, ctx2d)：
   · 编辑态：把 canvas 缩放到屏幕尺寸，ctx.setTransform 做 DPR 适配
   · 导出态：把 canvas 设为成片尺寸，同一个 render
   唯一差别是分辨率，不存在两套绘图逻辑。
   ============================================================ */

import { clamp, clamp01, mixHex, ease } from './evaluator.js';
import { NO_START } from './layout-rules.js';

/* ---------- 文本排版 ---------- */
function fontStr(size, weight) {
  return `${weight || 700} ${size}px "PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif`;
}

/* 逐字/逐词绘制需要每单元独立推进 → 返回每单元的 x 偏移与宽 */
function layout(ctx, units, size, weight, ls, align) {
  const widths = units.map(u => ctx.measureText(u).width + ls * Math.max(0, Array.from(u).length - 1));
  let total = 0;
  for (const w of widths) total += w;
  const xs = [];
  let x = 0;
  for (const w of widths) { xs.push(x); x += w; }
  return { widths, xs, total };
}

/* ============================================================
   render — 主渲染入口
   scene: evaluateFrame 返回的 state
   env:   { time, selectedLayerId, showSafeArea, preview }
   ============================================================ */
export function render(scene, ctx, env) {
  const ir = scene.ir;
  ctx.save();
  ctx.clearRect(0, 0, ir.project.width, ir.project.height);

  // 背景
  ctx.fillStyle = ir.project.background || '#000';
  ctx.fillRect(0, 0, ir.project.width, ir.project.height);

  // 安全区参考线（仅编辑态）
  if (env && env.showSafeArea) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    ctx.setLineDash([8, 8]);
    ctx.lineWidth = 2;
    const m = ir.project.width * 0.05;
    ctx.strokeRect(m, m, ir.project.width - m * 2, ir.project.height - m * 2);
    ctx.restore();
  }

  const order = scene.order || Object.keys(scene.layers);
  for (const lid of order) {
    const ls = scene.layers[lid];
    if (!ls || !ls.visible) continue;
    drawLayer(ls, ctx, env);
  }

  // 选中高亮框（仅编辑态）
  if (env && env.selectedLayerId && scene.layers[env.selectedLayerId]) {
    const ls = scene.layers[env.selectedLayerId];
    if (ls.visible) drawSelection(ctx, ls, ir);
  }

  ctx.restore();
}

function drawSelection(ctx, ls, ir) {
  const b = bbox(ls, ir);
  const k = ir.project.width / 1920;
  ctx.save();
  ctx.strokeStyle = 'rgba(74,140,255,.9)';
  ctx.setLineDash([6 * k, 5 * k]);
  ctx.lineWidth = 2 * k;
  ctx.strokeRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(74,140,255,.9)';
  const s = 8 * k;
  for (const c of [[b.x - 6, b.y - 6], [b.x + b.w + 6, b.y - 6], [b.x - 6, b.y + b.h + 6], [b.x + b.w + 6, b.y + b.h + 6]]) {
    ctx.fillRect(c[0] - s / 2, c[1] - s / 2, s, s);
  }
  ctx.restore();
}

function bbox(ls, ir) {
  const p = ls.p;
  if (ls.data) {
    const base = ls.data.base || p;
    return { x: (base.x || 0) - 20, y: (base.y || 0) - 20, w: (base.w || 300), h: (base.h || 300) };
  }
  if (ls.type === 'text') {
    const size = p.fontSize || 96;
    const w = Math.max(120, String(p.text || '').length * size * 0.6);
    return { x: (p.x || 0) - w / 2, y: (p.y || 0) - size * 0.8, w, h: size * 1.6 };
  }
  return { x: (p.x || 0) - (p.w || 100) / 2, y: (p.y || 0) - (p.h || 100) / 2, w: p.w || 100, h: p.h || 100 };
}

/* ---------- 单个图层 ---------- */
function drawLayer(ls, ctx, env) {
  const p = ls.p;
  const alpha = clamp01(p.opacity == null ? 1 : p.opacity);
  if (alpha <= 0.001) return;
  // 缩放到 0 的图层不绘制（scaleIn 的起点）
  if (ls.fx.scale != null && ls.fx.scale <= 0.002) return;

  ctx.save();
  ctx.globalAlpha = alpha;

  if (ls.data) { drawData(ls, ctx, env); ctx.restore(); return; }

  const cx = p.x || 0, cy = p.y || 0;
  const rot = (p.rotation || 0) * Math.PI / 180;
  const sc = ls.fx.scale == null ? 1 : ls.fx.scale;

  ctx.translate(cx, cy);
  if (rot) ctx.rotate(rot);
  if (sc !== 1) ctx.scale(sc, sc);

  if (ls.type === 'text') drawText(ls, ctx, env);
  else if (ls.type === 'circle') {
    const w = p.w || 200, h = p.h || 200;
    ctx.beginPath();
    ctx.arc(0, 0, Math.min(w, h) / 2, 0, Math.PI * 2);
    fillAndStroke(ctx, p);
  } else if (ls.type === 'image') {
    drawImageLayer(ls, ctx);
  } else {
    const w = p.w || 100, h = p.h || 100;
    const r = clamp(p.radius || 0, 0, Math.min(w, h) / 2);
    roundRect(ctx, -w / 2, -h / 2, w, h, r);
    fillAndStroke(ctx, p);
  }

  ctx.restore();
}

function fillAndStroke(ctx, p) {
  if (p.fill && p.fill !== 'none') { ctx.fillStyle = p.fill; ctx.fill(); }
  if (p.stroke && p.strokeWidth > 0) {
    ctx.strokeStyle = p.stroke;
    ctx.lineWidth = p.strokeWidth;
    ctx.stroke();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (r <= 0) { ctx.rect(x, y, w, h); return; }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const _imgCache = new Map();

/* 失败重试间隔（毫秒）。失败的条目不是永久毒化：过了这个时间再取到它，
   会重新发一次加载请求 —— 用户改了图片地址、网络恢复、或只是当时断了一下，
   都不该让该槽位在本会话里永远画不出来。 */
const IMG_RETRY_MS = 2000;

/** 测试钩子：只读缓存，不暴露可写引用 */
export function _imageCacheInfo() {
  const out = [];
  for (const [src, img] of _imgCache) {
    out.push({ src, ok: !!img.ok, failed: !!img.failed, retries: img._retries || 0 });
  }
  return out;
}
/** 测试钩子：清空缓存（真实使用中不调用） */
export function _clearImageCache() { _imgCache.clear(); }

function drawImageLayer(ls, ctx) {
  const p = ls.p;
  if (!p.src) {
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.strokeStyle = 'rgba(255,255,255,.3)';
    ctx.lineWidth = 2;
    roundRect(ctx, -(p.w || 100) / 2, -(p.h || 100) / 2, p.w || 100, p.h || 100, p.radius || 0);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.font = fontStr(Math.min(28, (p.w || 100) / 6), 600);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('图片占位', 0, 0);
    ctx.restore();
    return;
  }
  let img = _imgCache.get(p.src);
  // 失败条目过了重试窗口就重新加载一次，避免一次失败永久毒化该槽位
  if (img && img.failed && img._retryAt && Date.now() >= img._retryAt) {
    img = undefined;
    _imgCache.delete(p.src);
  }
  if (img === undefined) {
    img = new Image();
    img.onload = () => { img.ok = true; img.failed = false; };
    // 失败要写回「缓存里的那个对象」，不能重新赋值局部变量。
    // 原实现 `img = { ok: false }` 只换了局部引用，缓存里仍是同一个
    // 未标记的 Image —— 该 src 之后每次取出来都走「未就绪」分支，
    // 永远修不好（用户重新填同一个地址也不会重试）。
    img.onerror = () => {
      img.ok = false;
      img.failed = true;
      img._retries = (img._retries || 0) + 1;
      img._retryAt = Date.now() + IMG_RETRY_MS;
    };
    img.src = p.src;
    _imgCache.set(p.src, img);
    if (!img.complete && img.naturalWidth) img.ok = true;
  }
  if (!img || !img.ok) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    roundRect(ctx, -(p.w || 100) / 2, -(p.h || 100) / 2, p.w || 100, p.h || 100, p.radius || 0);
    ctx.fill();
    ctx.restore();
    return;
  }
  const w = p.w || img.naturalWidth, h = p.h || img.naturalHeight;
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
}

/* ============================================================
   文字引擎
   ============================================================ */
function drawText(ls, ctx, env) {
  const p = ls.p;
  const size = p.fontSize || 96;
  const weight = p.fontWeight || 700;
  const ls_ = p.letterSpacing || 0;
  const align = p.align || 'center';
  const fill = p.fill || '#ffffff';
  const shadow = p.shadow || 0;
  const T = env.time;

  ctx.font = fontStr(size, weight);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  let units = ls.text && ls.text.length ? ls.text : [String(p.text ?? '')];
  const lay = layout(ctx, units, size, weight, ls_, align);
  const startX = align === 'center' ? -lay.total / 2 : align === 'right' ? -lay.total : 0;
  const baseY = 0;

  const stagger = ls.fx.stagger;
  const pop = ls.fx.charPop;
  const wipe = ls.fx.wipe;
  const sweep = ls.fx.sweep;
  const tw = ls.fx.typewriter;
  const karaoke = ls.fx.karaoke;

  // 打字机：只画已"打出"的字符
  let limit = units.length;
  if (tw) limit = clamp(tw.count, 0, units.length);

  // 遮罩擦除：算出一个"擦除边缘"的 x 坐标
  let wipeEdge = null;
  if (wipe) {
    const prog = ease('inOutQuad', clamp01((T - wipe.start) / wipe.dur));
    const x0 = startX, x1 = startX + lay.total;
    wipeEdge = wipe.dir === 'right' ? lerpf(x1, x0, prog) : lerpf(x0, x1, prog);
  }

  // karaoke：说到第几个词
  let hiIdx = -1;
  if (karaoke) {
    hiIdx = Math.floor(Math.max(0, T - karaoke.start) * 5.2);
  }

  for (let i = 0; i < limit; i++) {
    const u = units[i];
    const x = startX + lay.xs[i];
    const w = lay.widths[i];

    let oy = 0, sc = 1, a = 1, col = fill;

    if (pop) {
      const s = pop.start + i * pop.gap;
      const prog = clamp01((T - s) / pop.dur);
      if (prog <= 0) { a = 0; }
      else {
        a = clamp01(prog * 2.4);
        const ez = pop.ease === 'elasticOut' ? 'outElastic' : pop.ease === 'bounceOut' ? 'outBounce' : pop.ease === 'backOut' ? 'outBack' : 'outCubic';
        sc = lerpf(0.55, 1, ease(ez, prog));
        oy = (1 - ease('outCubic', prog)) * size * 0.3;
      }
    } else if (stagger) {
      const s = stagger.start + i * stagger.gap;
      const prog = clamp01((T - s) / 0.4);
      if (prog <= 0) a = 0;
      else {
        a = clamp01(prog * 1.8);
        oy = (1 - ease('outCubic', prog)) * size * 0.2;
      }
    }

    if (sweep) {
      const prog = ease('inOutCubic', clamp01((T - sweep.start) / sweep.dur));
      const local = clamp01(prog * units.length - i);
      a = Math.min(a, local);
      oy = -Math.sin(prog * Math.PI * 2) * sweep.amp * (1 - prog);
    }

    if (karaoke && hiIdx >= 0 && i <= hiIdx) col = karaoke.color;

    if (a <= 0.001) continue;

    // 擦除裁剪
    if (wipeEdge != null) {
      const cx = x + w / 2;
      if (wipe.dir === 'right') { if (cx > wipeEdge) continue; }
      else { if (cx < wipeEdge) continue; }
    }

    ctx.save();
    if (shadow > 0) {
      ctx.shadowColor = 'rgba(0,0,0,.55)';
      ctx.shadowBlur = shadow;
      ctx.shadowOffsetY = shadow * 0.25;
    }
    if (sc !== 1) {
      const cxm = x + w / 2, cym = baseY;
      ctx.translate(cxm, cym);
      ctx.scale(sc, sc);
      ctx.translate(-cxm, -cym);
    }
    // 继承图层 alpha（drawLayer 已设 globalAlpha，这里按单位再乘）
    const baseA = ctx.globalAlpha;
    ctx.globalAlpha = baseA * a;
    ctx.fillStyle = col;

    // 避头尾：禁则标点微调基线（中文排版细节）
    if (NO_START.includes(u) && i > 0) ctx.translate(0, -size * 0.02);

    ctx.fillText(u, x, baseY + oy);
    ctx.restore();
  }
}

function lerpf(a, b, t) { return a + (b - a) * t; }

/* ============================================================
   数据驱动绘制：柱状图 / 折线 / 重复器 / 频谱 / 粒子
   ============================================================ */
function drawData(ls, ctx, env) {
  const d = ls.data;
  if (!d) return;
  const base = d.base || ls.p;
  const bx = base.x || 0, by = base.y || 0;
  const t = env.time;

  ctx.save();
  ctx.translate(bx, by);

  switch (d.kind) {
    /* 数据柱状图（growBar） */
    case 'bars': {
      const W = base.w || 900, H = base.h || 360;
      if (d.audioBars) { drawSpectrumBars(ctx, d, W, H); break; }
      const bars = d.bars || [];
      if (!bars.length) break;
      const n = bars.length;
      const gap = Math.min(14, W / n * 0.24);
      const bw = (W - gap * (n - 1)) / n;
      ctx.strokeStyle = 'rgba(255,255,255,.22)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-W / 2, H / 2 + 10); ctx.lineTo(W / 2, H / 2 + 10); ctx.stroke();

      for (let i = 0; i < n; i++) {
        const bar = bars[i];
        const x = -W / 2 + i * (bw + gap);
        const h = bar.v * H * bar.p;
        if (h <= 0.5) continue;
        const grd = ctx.createLinearGradient(0, H / 2, 0, H / 2 - h);
        grd.addColorStop(0, mixHex(bar.color || '#38c98b', '#000000', 0.25));
        grd.addColorStop(1, bar.color || '#38c98b');
        ctx.fillStyle = grd;
        roundRect(ctx, x, H / 2 - h, bw, h, Math.min(6, bw / 3));
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.82)';
        ctx.font = fontStr(Math.max(14, H / 14), 700);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(Math.round(bar.v * 100) + '', x + bw / 2, H / 2 - h - 10);
      }
      break;
    }
    case 'line': {
      const pts = d.points || [];
      if (pts.length < 2) break;
      const W = base.w || 900, H = base.h || 400;
      const n = pts.length;
      const max = Math.max(...pts, 1);
      const min = Math.min(...pts, 0);
      const span = (max - min) || 1;
      const p = ease('inOutCubic', clamp01((t - d.start) / d.dur));
      const shown = Math.max(2, Math.min(n, Math.ceil(n * p)));
      const px = (i) => -W / 2 + (i / (n - 1)) * W;
      const py = (v) => H / 2 - ((v - min) / span) * H;

      ctx.strokeStyle = 'rgba(255,255,255,.1)';
      ctx.lineWidth = 1;
      for (let g = 0; g <= 4; g++) {
        const yy = H / 2 - (g / 4) * H;
        ctx.beginPath(); ctx.moveTo(-W / 2, yy); ctx.lineTo(W / 2, yy); ctx.stroke();
      }
      ctx.strokeStyle = d.color || '#ffb020';
      ctx.lineWidth = Math.max(3, H / 90);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px(0), py(pts[0]));
      for (let i = 1; i < shown; i++) ctx.lineTo(px(i), py(pts[i]));
      ctx.stroke();
      if (shown > 1 && shown <= n) {
        const i = shown - 1;
        const cx = px(i), cy = py(pts[i]);
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(cx, cy, Math.max(5, H / 40), 0, Math.PI * 2); ctx.fill();
        const ring = (t * 1.6) % 1;
        ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - ring)})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, Math.max(5, H / 40) * (1 + ring * 3), 0, Math.PI * 2); ctx.stroke();
      }
      break;
    }
    case 'repeater': {
      const items = d.items || [];
      const bw = base.w || 60, bh = base.h || 160;
      for (const it of items) {
        const p = ease('outBack', clamp01((t - it.delay) / 0.5));
        if (p <= 0) continue;
        const h = it.h + p * (bh - it.h);
        ctx.save();
        ctx.translate(it.x, 0);
        ctx.scale(1, Math.max(0.001, p));
        ctx.fillStyle = mixHex(base.fill || '#4a8cff', '#ffffff', (it.i % 5) / 8);
        roundRect(ctx, -bw / 2, -h / 2, bw, h, Math.min(10, bw / 4));
        ctx.fill();
        ctx.restore();
      }
      break;
    }
    case 'ring': {
      const spec = d.spectrum || [];
      if (!spec.length) break;
      const R = d.radius;
      const n = spec.length;
      const barLen = Math.max(8, (Math.PI * 2 * R) / n * 0.62);
      const lw = Math.max(4, barLen * 0.5);
      ctx.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
        const len = spec[i] * R * 0.55 + lw;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        ctx.strokeStyle = mixHex(d.color || '#38c98b', '#ffffff', spec[i] * 0.6);
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(ca * R, sa * R);
        ctx.lineTo(ca * (R + len), sa * (R + len));
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,255,255,.12)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case 'particles': {
      const ps = d.ps || [];
      const life = d.dur || 3;
      for (const pt of ps) {
        const age = t - pt.delay;
        if (age < 0 || age > pt.life * life) continue;
        const k = age / (pt.life * life);
        const x = pt.x + pt.vx * age;
        const y = pt.y + pt.vy * age + 120 * age * age;
        ctx.globalAlpha = (1 - k) * 0.9;
        ctx.fillStyle = mixHex(d.color || '#4a8cff', '#ffffff', k * 0.5);
        ctx.beginPath(); ctx.arc(x, y, pt.r * (1 - k * 0.5), 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
  }
  ctx.restore();
}

/* 音频波形柱：频谱从低频（左）到高频（右） */
function drawSpectrumBars(ctx, d, W, H) {
  const spec = d.spectrum || [];
  const n = spec.length;
  if (!n) return;
  const gap = Math.min(10, W / n * 0.28);
  const bw = (W - gap * (n - 1)) / n;
  const gain = d.gain || 1;
  for (let i = 0; i < n; i++) {
    const x = -W / 2 + i * (bw + gap);
    const h = clamp01(spec[i] * gain) * H;
    if (h <= 0.5) continue;
    const grd = ctx.createLinearGradient(0, H / 2, 0, H / 2 - h);
    grd.addColorStop(0, mixHex(d.color || '#7c5cff', '#000000', 0.3));
    grd.addColorStop(1, mixHex(d.color || '#7c5cff', '#ffffff', 0.35));
    ctx.fillStyle = grd;
    roundRect(ctx, x, H / 2 - h, bw, h, Math.min(6, bw / 2));
    ctx.fill();
  }
}

/* 环境时间由 env.time 传入，无需模块级时间状态 */
