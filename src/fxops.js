/* ============================================================
   fxops.js · 旧效果积木的 enter / sample 拆分
   ------------------------------------------------------------
   enter：线程走到积木时解析目标与参数，登记一条描述符。
   sample：渲染前按当前时间计算画面，公式与原 evaluator 逐行一致。
   这样 wait 之前只登记、之后按时间采样，旧模板的绝对 start
   仍然优先，顺序链也真正生效。
   ============================================================ */

import {
  num, ease, clamp01, mixHex, buildUnits, parseData,
} from './evaluator.js';

const LAYER_SLOT_OPS = new Set(['repeater', 'particles']);

export function resolveObject(rt, sel, fallback) {
  if (sel === undefined || sel === null || sel === '' || sel === '@current') return fallback;
  return rt.findObject(String(sel)) || fallback;
}

export function hasLayerSlot(rt, sel) {
  if (sel === undefined || sel === null || sel === '') return false;
  const s = String(sel);
  if (s === '@current') return true;
  return !!rt.findObject(s);
}

/* 原 evaluator 的 ensureUnits —— 保留其既有行为，避免改变旧模板画面 */
function ensureUnits(obj, want) {
  const unit = want || obj.splitUnit || 'whole';
  if (!obj.text || obj.text.length <= 1) {
    if (unit === 'whole' && want && want !== 'whole') {
      obj.splitUnit = want;
      obj.text = buildUnits(String(obj.p.text ?? ''), want);
      return;
    }
  }
  if (!obj.text) obj.text = buildUnits(String(obj.p.text ?? ''), obj.splitUnit || 'whole');
}

function push(obj, d) { obj.fxDefs.push(d); }

/* ============================================================
   enter：当前线程时刻 now 下登记效果
   ============================================================ */
export function enterFx(rt, execObj, b, S, E, now) {
  const op = b.op;
  const at = (v, fb = 0) => Math.max(now, num(v, fb));
  switch (op) {
    case 'showText': {
      const target = resolveObject(rt, E(0), execObj);
      const raw = S(1);
      const content = raw === undefined ? null : String(E(1) ?? '');
      push(target, { op, text: content, onlyIfEmpty: true });
      return true;
    }
    case 'setText': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, { op, text: String(E(1) ?? '') });
      return true;
    }
    case 'splitBy': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, { op, unit: String(E(1) ?? 'whole') });
      return true;
    }

    /* ---------- 文字动效 ---------- */
    case 'stagger': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, { op, gap: Math.max(0, num(E(1), 0.05)), start: at(E(2)) });
      return true;
    }
    case 'typewriter': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, { op, cps: Math.max(0.5, num(E(1), 12)), start: at(E(2)) });
      return true;
    }
    case 'charPopIn': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, {
        op, start: at(E(1)), gap: Math.max(0, num(E(2), 0.05)),
        ease: String(E(3) ?? 'backOut'), dur: 0.45,
      });
      return true;
    }
    case 'maskWipe': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, {
        op, dur: Math.max(0.01, num(E(1), 0.8)),
        start: at(E(2)), dir: String(E(3) ?? 'left'),
      });
      return true;
    }
    case 'pathSweep': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, {
        op, dur: Math.max(0.01, num(E(1), 1.2)),
        start: at(E(2)), amp: Math.max(0, num(E(3), 60)),
      });
      return true;
    }
    case 'numberRoll': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, {
        op, target: num(E(1), 100), dur: Math.max(0.01, num(E(2), 1.5)),
        start: at(E(3)), dec: Math.max(0, Math.round(num(E(4), 0))),
      });
      return true;
    }
    case 'highlightWord': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, { op, words: String(E(1) ?? ''), start: at(E(2)), color: String(E(3) ?? '#ffd166') });
      return true;
    }

    /* ---------- 入场 / 退场 ---------- */
    case 'fadeIn': case 'fadeOut': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, {
        op, dir: op === 'fadeIn' ? 1 : -1,
        dur: Math.max(0.01, num(E(1), 0.5)), start: at(E(2)),
      });
      return true;
    }
    case 'moveIn': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, {
        op, dir: String(E(1) ?? 'left'), dist: num(E(2), 120),
        dur: Math.max(0.01, num(E(3), 0.6)), start: at(E(4)),
        ease: String(E(5) ?? 'outCubic'),
      });
      return true;
    }
    case 'scaleIn': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, {
        op, from: num(E(1), 0), to: num(E(2), 1),
        dur: Math.max(0.01, num(E(3), 0.6)), start: at(E(4)),
        ease: String(E(5) ?? 'backOut'),
      });
      return true;
    }

    /* ---------- 形状 ---------- */
    case 'setFill': {
      const target = resolveObject(rt, E(0), execObj);
      const color = String(E(1) ?? '#ffffff');
      push(target, {
        op, color, dur: Math.max(0, num(E(2), 0)), start: at(E(3)),
      });
      return true;
    }
    case 'drawShape': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, {
        op, fill: String(E(1) ?? '#4a8cff'),
        w: Math.max(0, num(E(2), target.p.w ?? 400)),
        h: Math.max(0, num(E(3), target.p.h ?? 120)),
        radius: Math.max(0, num(E(4), target.p.radius ?? 0)),
      });
      return true;
    }

    /* ---------- 数据驱动图形 ---------- */
    case 'growBar': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, {
        op, data: String(E(1) ?? ''), per: Math.max(0.02, num(E(2), 0.5)),
        gap: Math.max(0, num(E(3), 0.12)), start: at(E(4)),
        color: String(E(5) ?? '#38c98b'),
      });
      return true;
    }
    case 'drawLine': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, {
        op, data: String(E(1) ?? ''), dur: Math.max(0.01, num(E(2), 1.5)),
        start: at(E(3)), color: String(E(4) ?? '#ffb020'),
      });
      return true;
    }
    case 'repeater': {
      const raw0 = S(0);
      const withLayer = hasLayerSlot(rt, raw0 === undefined ? undefined : E(0));
      const base = withLayer ? 1 : 0;
      const target = withLayer ? resolveObject(rt, E(0), execObj) : execObj;
      push(target, {
        op, base: target.base,
        n: Math.max(1, Math.min(120, Math.round(num(E(base), 8)))),
        spacing: num(E(base + 1), 90),
        gap: Math.max(0, num(E(base + 2), 0.06)),
        start: at(E(base + 3)),
        h0: Math.max(0, num(E(base + 4), 20)),
      });
      return true;
    }
    case 'audioBars': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, {
        op, n: Math.max(4, Math.min(160, Math.round(num(E(1), 48)))),
        start: at(E(2)), color: String(E(3) ?? '#7c5cff'),
        gain: Math.max(0.1, num(E(4), 1)), base: target.base, startTime: now,
      });
      return true;
    }
    case 'ringSpectrum': {
      const target = resolveObject(rt, E(0), execObj);
      push(target, {
        op, n: Math.max(8, Math.min(200, Math.round(num(E(1), 64)))),
        start: at(E(2)), color: String(E(3) ?? '#38c98b'),
        radius: Math.max(20, num(E(4), 300)), base: target.base, startTime: now,
      });
      return true;
    }
    case 'particles': {
      const raw0 = S(0);
      const withLayer = hasLayerSlot(rt, raw0 === undefined ? undefined : E(0));
      const base = withLayer ? 1 : 0;
      const target = withLayer ? resolveObject(rt, E(0), execObj) : execObj;
      // 旧工程只有前 5 个槽，新增的 5 个必须按「缺槽 = 默认值」处理：
      // evalExpr(undefined) 返回 0，直接拿它会以为用户把寿命/大小调成了 0。
      const orDefault = (i, dflt) => (S(i) === undefined ? dflt : num(E(i), dflt));
      const lifeScale = Math.max(0.05, orDefault(base + 5, 1));
      const spread = Math.max(0, Math.min(360, orDefault(base + 6, 360)));
      const gravity = orDefault(base + 7, 240);
      const drag = Math.max(0, orDefault(base + 8, 0));
      const sizeScale = Math.max(0.01, orDefault(base + 9, 1));
      // 默认参数保持旧公式；只有显式改动后才走固定步长模拟
      const advanced = Math.abs(lifeScale - 1) > 1e-6 || Math.abs(spread - 360) > 1e-6
        || Math.abs(gravity - 240) > 1e-6 || drag > 1e-6 || Math.abs(sizeScale - 1) > 1e-6;
      push(target, {
        op, base: target.base,
        n: Math.max(4, Math.min(400, Math.round(num(E(base), 90)))),
        start: at(E(base + 1)),
        dur: Math.max(0.1, num(E(base + 2), 3)),
        color: String(E(base + 3) ?? '#4a8cff'),
        speed: num(E(base + 4), 180),
        lifeScale, spread, gravity, drag, sizeScale, advanced,
        fps: rt.fps,
      });
      return true;
    }
    default:
      return false;
  }
}

/* ============================================================
   sample：按当前时间把描述符应用到输出图层
   ============================================================ */
export function sampleFx(rt, d, out, t) {
  switch (d.op) {
    case 'showText': {
      if (d.text !== null && d.text !== '') out.p.text = d.text;
      out.visible = true;
      if (out.text === null || out.text === undefined) out.text = buildUnits(String(out.p.text ?? ''), out.splitUnit);
      return;
    }
    case 'setText': {
      out.p.text = d.text;
      out.text = buildUnits(String(out.p.text ?? ''), out.splitUnit);
      return;
    }
    case 'splitBy': {
      out.splitUnit = d.unit;
      out.text = buildUnits(String(out.p.text ?? ''), d.unit);
      return;
    }
    case 'stagger': {
      out.visible = true;
      ensureUnits(out, 'char');
      out.fx.stagger = { gap: d.gap, start: d.start };
      return;
    }
    case 'typewriter': {
      out.visible = true;
      ensureUnits(out, 'char');
      const count = Math.floor(Math.max(0, t - d.start) * d.cps);
      out.fx.typewriter = { cps: d.cps, start: d.start, count };
      return;
    }
    case 'charPopIn': {
      out.visible = true;
      ensureUnits(out, 'char');
      out.fx.charPop = { start: d.start, gap: d.gap, ease: d.ease, dur: d.dur };
      return;
    }
    case 'maskWipe': {
      out.visible = true;
      ensureUnits(out, 'char');
      out.fx.wipe = { dur: d.dur, start: d.start, dir: d.dir };
      return;
    }
    case 'pathSweep': {
      out.visible = true;
      ensureUnits(out, 'char');
      out.fx.sweep = { dur: d.dur, start: d.start, amp: d.amp };
      return;
    }
    case 'numberRoll': {
      out.visible = true;
      const p = ease('outCubic', clamp01((t - d.start) / d.dur));
      out.p.text = (d.target * p).toFixed(d.dec);
      out.text = buildUnits(out.p.text, 'whole');
      return;
    }
    case 'highlightWord': {
      out.visible = true;
      if (d.words) {
        out.p.text = d.words;
        out.splitUnit = 'word';
        out.text = buildUnits(d.words, 'word');
      }
      out.fx.karaoke = { start: d.start, color: d.color };
      return;
    }
    case 'fadeIn': case 'fadeOut': {
      const p = clamp01((t - d.start) / d.dur);
      const k = ease('inOutQuad', p);
      out.p.opacity = (d.dir === 1 ? k : 1 - k) * (out.base.opacity ?? 1);
      out.visible = true;
      out.fx.fade = { start: d.start, dur: d.dur, dir: d.dir };
      return;
    }
    case 'moveIn': {
      const p = ease(d.ease, clamp01((t - d.start) / d.dur));
      const dx = d.dir === 'left' ? -d.dist : d.dir === 'right' ? d.dist : 0;
      const dy = d.dir === 'up' ? -d.dist : d.dir === 'down' ? d.dist : 0;
      out.p.x = (out.base.x ?? 0) + dx * (1 - p);
      out.p.y = (out.base.y ?? 0) + dy * (1 - p);
      out.p.opacity = (out.base.opacity ?? 1) * clamp01(p * 1.6);
      out.visible = true;
      out.fx.move = { start: d.start, dur: d.dur, dir: d.dir, dist: d.dist };
      return;
    }
    case 'scaleIn': {
      out.fx.scale = d.from + (d.to - d.from) * ease(d.ease, clamp01((t - d.start) / d.dur));
      out.visible = true;
      return;
    }
    case 'setFill': {
      if (d.dur <= 0) {
        out.p.fill = d.color;
        out.p.color = d.color;
        return;
      }
      const p = clamp01((t - d.start) / d.dur);
      out.p.fill = mixHex(String(out.base.fill || out.base.color || '#4a8cff'), d.color, ease('inOutQuad', p));
      return;
    }
    case 'drawShape': {
      out.p.fill = d.fill;
      out.p.color = d.fill;
      out.p.w = d.w;
      out.p.h = d.h;
      out.p.radius = d.radius;
      out.visible = true;
      return;
    }
    case 'growBar': {
      const data = parseData(d.data);
      if (!data.length) return;
      const max = Math.max(...data.map(v => Math.abs(v)), 1);
      const bars = data.map((v, i) => {
        const s = d.start + i * d.gap;
        return { v: v / max, p: ease('outCubic', clamp01((t - s) / d.per)), delay: s, color: d.color };
      });
      out.visible = true;
      out.data = { kind: 'bars', bars, base: out.base };
      return;
    }
    case 'drawLine': {
      const points = parseData(d.data);
      if (!points.length) return;
      out.visible = true;
      out.data = { kind: 'line', points, dur: d.dur, start: d.start, color: d.color, base: out.base };
      return;
    }
    case 'repeater': {
      const items = [];
      for (let i = 0; i < d.n; i++) {
        items.push({ i, delay: d.start + i * d.gap, x: i * d.spacing, h: d.h0 });
      }
      out.visible = true;
      out.data = { kind: 'repeater', items, base: out.base };
      return;
    }
    case 'audioBars': {
      const spectrum = rt.audio ? rt.audio.spectrum(t, d.n) : new Array(d.n).fill(0);
      out.visible = true;
      out.data = {
        kind: 'bars', audioBars: true, spectrum, color: d.color,
        gain: d.gain, base: out.base, start: d.start,
      };
      return;
    }
    case 'ringSpectrum': {
      const spectrum = rt.audio ? rt.audio.spectrum(t, d.n) : new Array(d.n).fill(0);
      out.visible = true;
      out.data = {
        kind: 'ring', spectrum, color: d.color, radius: d.radius,
        base: out.base, start: d.start,
      };
      return;
    }
    case 'particles': {
      if (d.advanced) {
        if (!d.sim) d.sim = simulateParticles(d);
        out.visible = true;
        out.data = {
          kind: 'particles', ps: d.sim.ps, trailFps: d.fps, dur: d.dur,
          color: d.color, start: d.start, base: out.base,
        };
        return;
      }
      const ps = [];
      for (let i = 0; i < d.n; i++) {
        const ang = hash2(i, 1.7) * Math.PI * 2;
        const sp = (0.4 + hash2(i, 4.3) * 0.6) * d.speed;
        const life = 0.6 + hash2(i, 8.8) * 0.8;
        ps.push({
          x: 0, y: 0,
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
          life, delay: d.start + hash2(i, 2.2) * 0.4,
          r: 3 + hash2(i, 5.5) * 7, seed: i,
        });
      }
      out.visible = true;
      out.data = { kind: 'particles', ps, dur: d.dur, color: d.color, start: d.start, base: out.base };
      return;
    }
    default:
      return;
  }
}

/* 固定步长粒子模拟：结果只取决于参数与 fps，seek 重放完全一致。 */
function simulateParticles(d) {
  const fps = Math.max(1, d.fps || 24);
  const dt = 1 / fps;
  const ps = [];
  let maxLife = 0;
  for (let i = 0; i < d.n; i++) {
    const u = hash2(i, 1.7);
    const ang = d.spread >= 360
      ? u * Math.PI * 2
      : -Math.PI / 2 + (u - 0.5) * (d.spread * Math.PI / 180);
    const sp = (0.4 + hash2(i, 4.3) * 0.6) * d.speed;
    const lifeNorm = 0.6 + hash2(i, 8.8) * 0.8;
    const life = lifeNorm * d.dur * d.lifeScale;
    maxLife = Math.max(maxLife, life);
    ps.push({
      life: lifeNorm * d.lifeScale,
      delay: d.start + hash2(i, 2.2) * 0.4,
      r: (3 + hash2(i, 5.5) * 7) * d.sizeScale,
      seed: i,
      xs: null, ys: null,
    });
  }
  const steps = Math.max(2, Math.ceil(maxLife * fps) + 2);
  const damp = Math.exp(-d.drag * dt);
  for (let i = 0; i < ps.length; i++) {
    const pt = ps[i];
    const u = hash2(i, 1.7);
    const ang = d.spread >= 360
      ? u * Math.PI * 2
      : -Math.PI / 2 + (u - 0.5) * (d.spread * Math.PI / 180);
    const sp = (0.4 + hash2(i, 4.3) * 0.6) * d.speed;
    let x = 0, y = 0, vx = Math.cos(ang) * sp, vy = Math.sin(ang) * sp;
    const xs = new Float32Array(steps);
    const ys = new Float32Array(steps);
    for (let step = 0; step < steps; step++) {
      xs[step] = x;
      ys[step] = y;
      x += vx * dt;
      y += vy * dt + 0.5 * d.gravity * dt * dt;
      vx *= damp;
      vy = (vy + d.gravity * dt) * damp;
    }
    pt.xs = xs;
    pt.ys = ys;
  }
  return { ps, fps };
}

/* 与 evaluator 的确定性伪随机保持一致 */
function hash2(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

export function applyFxDefs(rt, defs, out, t) {
  for (const d of defs) sampleFx(rt, d, out, t);
}

export { LAYER_SLOT_OPS };
