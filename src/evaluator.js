/* ============================================================
   evaluator.js · 求值器 + 程序化时间轴执行引擎
   ------------------------------------------------------------
   核心思想：每一帧从「绝对时间 t」出发，重新走一遍积木树。
   遇到 wait / 循环等顺序结构时维护一个「时间游标」，
   因此画面状态是时间的纯函数 —— 天然可跳转、可倒放、可单步调试。

   音频不是外部文件：AudioSource 是一段**程序化合成**的音频，
   与画布共用同一个时钟，所以 amp/bass/beat 等变量在预览与导出
   （逐帧离线求值）时结果完全一致。
   ============================================================ */

import { defOf } from './blocks.js';
import { expandCustomBlocks } from './customblocks.js';

/* ---------------- 缓动 ---------------- */
export function ease(name, x) {
  const t = clamp01(x);
  switch (name) {
    case 'linear': return t;
    case 'inQuad': return t * t;
    case 'outQuad': return t * (2 - t);
    case 'inOutQuad': return t < .5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case 'inCubic': return t * t * t;
    case 'outCubic': return 1 - Math.pow(1 - t, 3);
    case 'inOutCubic': return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case 'outExpo': return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
    case 'outBack': {
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
    case 'backOut': return ease('outBack', t);
    case 'outElastic': {
      if (t === 0 || t === 1) return t;
      const c4 = (2 * Math.PI) / 3;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    }
    case 'elasticOut': return ease('outElastic', t);
    case 'outBounce': {
      const n1 = 7.5625, d1 = 2.75;
      let x = t;
      if (x < 1 / d1) return n1 * x * x;
      if (x < 2 / d1) { x -= 1.5 / d1; return n1 * x * x + .75; }
      if (x < 2.5 / d1) { x -= 2.25 / d1; return n1 * x * x + .9375; }
      x -= 2.625 / d1;
      return n1 * x * x + .984375;
    }
    case 'bounceOut': return ease('outBounce', t);
    default: return t;
  }
}

export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const clamp01 = (v) => clamp(v, 0, 1);
const lerpN = (a, b, t) => a + (b - a) * t;

/* 确定性伪随机（同一 seed 永远同值 → 可逐帧复现） */
export function hash01(n) {
  let x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  x -= Math.floor(x);
  return x;
}
export function hash2(x, y) {
  let n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}
/* 平滑一维噪声 */
export function noise1(seed, scale) {
  const x = seed * scale;
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerpN(hash2(i, seed), hash2(i + 1, seed), u);
}

/* ---------------- 颜色 ---------------- */
export function hex2rgb(h) {
  let s = String(h || '#000').replace('#', '').trim();
  if (s.length === 3) s = s.split('').map(c => c + c).join('');
  if (s.length !== 6 || /[^0-9a-fA-F]/.test(s)) return { r: 0, g: 0, b: 0 };
  const n = parseInt(s, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export function rgb2hex(r, g, b) {
  const f = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`;
}
export function mixHex(a, b, t) {
  const A = hex2rgb(a), B = hex2rgb(b), k = clamp01(t);
  return rgb2hex(lerpN(A.r, B.r, k), lerpN(A.g, B.g, k), lerpN(A.b, B.b, k));
}
export function hsl2hex(h, s, l) {
  h = ((h % 360) + 360) % 360; s = clamp01(s / 100); l = clamp01(l / 100);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return rgb2hex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/* ---------------- 程序化音频源 ----------------
   合成一段可重复的音频曲线；预览与导出用同一份数学定义，
   所以「声音驱动画面」在任何渲染路径下都逐帧一致。 */
export class AudioSource {
  constructor(opts = {}) {
    this.bpm = opts.bpm || 120;
    this.duration = opts.duration || 0;
    this.seed = opts.seed || 7;
    this.intensity = opts.intensity == null ? 1 : opts.intensity;
    this.beatEnv = opts.beatEnv || 'pulse';   // pulse | kick
  }
  setDuration(d) { this.duration = d; }

  /* 振幅包络：模拟口播的呼吸 + 鼓点 */
  amplitude(t) {
    if (t < 0) return 0;
    const spb = 60 / this.bpm;
    const beatPhase = (t / spb) % 1;
    const kick = this.beatEnv === 'kick'
      ? Math.pow(1 - beatPhase, 3.2)
      : Math.pow(1 - beatPhase, 1.6);
    // 呼吸感：低频噪声调制
    const breath = 0.55 + 0.45 * noise1(this.seed, 1.7);
    return clamp01((kick * 0.75 + breath * 0.45) * this.intensity);
  }
  bass(t) {
    const spb = 60 / this.bpm;
    return clamp01(Math.pow(1 - ((t / spb) % 1), 2.5) * this.intensity);
  }
  mid(t) { return clamp01(this.amplitude(t) * 0.7 + noise1(this.seed + 3, 5.1) * 0.3); }
  treble(t) { return clamp01(noise1(this.seed + 9, 11.3) * 0.6 + this.bass(t) * 0.25); }
  beatPulse(t) {
    const spb = 60 / this.bpm;
    const p = (t / spb) % 1;
    return Math.pow(1 - p, 8);
  }
  bpmValue() { return this.bpm; }

  /* 频段能量，供柱状/环形频谱用：把 [t-d, t] 的高频能量切成 n 段 */
  spectrum(t, bins = 48) {
    const out = new Array(bins).fill(0);
    const spb = 60 / this.bpm;
    for (let i = 0; i < bins; i++) {
      const f = i / bins;                        // 0(低) → 1(高)
      const seg = t - (1 - f) * 0.35;            // 高频延迟更短
      const env = f < 0.15 ? this.bass(seg) : f < 0.5 ? this.mid(seg) : this.treble(seg);
      const wob = 0.6 + 0.6 * noise1(i + this.seed, 4.4 + f * 6);
      out[i] = clamp01(env * wob);
    }
    return out;
  }
}

/* ---------------- 执行上下文 ---------------- */
/** 单帧总步数预算。
 *  loop 的次数上限是「每层各自 500」，嵌套起来是乘积：3 层 500 = 1.25 亿次
 *  语句执行（实测 27.6 秒卡死 UI），4 层直接算不完。所以除了每层的次数上限，
 *  还必须有一道「整帧总量」的闸门 —— 它是唯一能拦住嵌套乘积的东西。
 *  10 万步实测约 80ms，正常工程一帧只有几十到几百步，够用且能兜住爆炸。 */
export const DEFAULT_MAX_STEPS = 100000;

/** 变量键归一：`ctx.vars` 里一律用带 $ 的键（$time / $score），
 *  而 IR 里的变量名是裸名（`{k:'var',name:'score'}`、`VAR score …`）。
 *  两边都过这里归一，所以 $score 和 score 命中同一个值。 */
function normVarKey(k) {
  const s = String(k == null ? '' : k);
  return s.startsWith('$') ? s : '$' + s;
}

export class EvalContext {
  constructor(ir, time, audio, hooks = {}) {
    this.ir = ir;
    this.t = time;
    this.audio = audio;
    this.hooks = hooks;         // {onBlock, onVar, maxSteps}
    this.vars = new Map();
    // 工程声明的变量（IR: {id,name,type,value}）—— 原实现从不载入，
    // 于是 ctx.vars 里只有三个内置量，用户变量在表达式里永远取不到（恒为 0）。
    // 先载入变量、再注入内置量：$time/$frame/$progress 是引擎语义，同名变量不覆盖它们。
    for (const v of ir.variables || []) {
      if (!v || !v.name) continue;
      this.vars.set(normVarKey(v.name), v.value === undefined ? '' : v.value);
    }
    this.vars.set('$time', time);
    this.vars.set('$frame', Math.round(time * ir.project.fps));
    this.vars.set('$progress', ir.project.duration > 0 ? clamp01(time / ir.project.duration) : 0);
    this.steps = 0;
    this.stepBudget = Number.isFinite(hooks.maxSteps) && hooks.maxSteps > 0 ? hooks.maxSteps : DEFAULT_MAX_STEPS;
    this.budgetExceeded = false;   // 本帧是否因超出预算被截断
  }
  setVar(k, v) {
    const key = normVarKey(k);
    this.vars.set(key, v);
    this.hooks.onVar && this.hooks.onVar(key, v);
  }
  getVar(k) { return this.vars.get(normVarKey(k)); }
  /** 还有预算吗？没有就记下「被截断」并返回 false */
  hasBudget() {
    if (this.steps < this.stepBudget) return true;
    this.budgetExceeded = true;
    return false;
  }
}

/* ---------------- 表达式求值 ---------------- */
export function evalExpr(e, ctx) {
  if (e == null) return 0;
  if (typeof e === 'number' || typeof e === 'string' || typeof e === 'boolean') return e;
  if (Array.isArray(e)) return e;
  switch (e.k) {
    case 'lit': {
      // 容错：允许 lit 里再套一层 lit（例如 STR(SEL(x)) 被误写），
      // 避免出现 "[object Object]" 这种静默错误。
      if (e.v && typeof e.v === 'object' && e.v.k === 'lit') return evalExpr(e.v, ctx);
      switch (e.t) {
        case 'num': case 'time': return Number(e.v) || 0;
        case 'str': case 'sel': return String(e.v == null ? '' : e.v);
        case 'bool': return !!e.v;
        case 'col': return String(e.v || '#ffffff');
        default: return e.v;
      }
    }
    case 'var': {
      const v = ctx.getVar(e.name);
      if (v === undefined) return 0;
      // 只有真正的字面量节点才展开。原实现是 `'v' in v`，
      // 于是用户存进去的任何带 v 字段的对象（比如 {v: 42}）都被当成
      // 字面量再求值一次，取到的却是它自己的 v —— 用户拿到的不是他存的值。
      if (v && typeof v === 'object' && v.k === 'lit') return evalExpr(v, ctx);
      return v;
    }
    case 'audio': {
      const off = num(e.offset, 0);
      const tt = ctx.t + off;
      switch (e.metric) {
        case 'amp': return ctx.audio ? ctx.audio.amplitude(tt) : 0;
        case 'bass': return ctx.audio ? ctx.audio.bass(tt) : 0;
        case 'mid': return ctx.audio ? ctx.audio.mid(tt) : 0;
        case 'treble': return ctx.audio ? ctx.audio.treble(tt) : 0;
        case 'beat': return ctx.audio ? ctx.audio.beatPulse(tt) : 0;
        case 'bpm': return ctx.audio ? ctx.audio.bpmValue() : 120;
        default: return 0;
      }
    }
    case 'blk': {
      const A = () => evalExpr(e.a, ctx);
      const B = () => evalExpr(e.b, ctx);
      switch (e.op) {
        case 'add': return num(A()) + num(B());
        case 'sub': return num(A()) - num(B());
        case 'mul': return num(A()) * num(B());
        case 'div': { const d = num(B()); return d === 0 ? 0 : num(A()) / d; }
        case 'mod': { const d = num(B()); return d === 0 ? 0 : num(A()) % d; }
        case 'clamp': return clamp(num(A()), num(e.b), num(e.c));
        case 'lerp': return lerpN(num(A()), num(B()), num(e.c));
        case 'abs': return Math.abs(num(A()));
        case 'sin': return Math.sin(num(A())) * num(B());
        case 'cos': return Math.cos(num(A())) * num(B());
        case 'noise': return hash01(num(A()) * 12.9898 + num(B()) * 78.233);
        case 'noise1D': return noise1(num(A()), num(B()) || 1);
        case 'randRange': {
          const lo = num(A()), hi = num(B());
          return lo + Math.floor(hash01(ctx.t * 60 + lo * 7.3) * Math.max(1, hi - lo + 1));
        }
        case 'tween': {
          const from = num(A()), to = num(B());
          const dur = Math.max(0.0001, num(e.c));
          const start = num(e.p);
          const ez = e.p2 === undefined ? 'linear' : String(e.p2);
          const p = clamp01((ctx.t - start) / dur);
          return lerpN(from, to, ease(ez, p));
        }
        case 'frame': return ctx.vars.get('$frame');
        case 'time': return ctx.t;
        case 'progress': return ctx.vars.get('$progress');
        case 'gt': return num(A()) > num(B());
        case 'lt': return num(A()) < num(B());
        case 'eq': return num(A()) === num(B());
        case 'and': return !!A() && !!B();
        case 'or': return !!A() || !!B();
        case 'not': return !A();
        case 'mixCol': return mixHex(String(A()), String(B()), num(e.c));
        case 'hsl': return hsl2hex(num(A()), num(B()), num(e.c));
        case 'amp': return ctx.audio ? ctx.audio.amplitude(ctx.t) : 0;
        case 'bass': return ctx.audio ? ctx.audio.bass(ctx.t) : 0;
        case 'mid': return ctx.audio ? ctx.audio.mid(ctx.t) : 0;
        case 'treble': return ctx.audio ? ctx.audio.treble(ctx.t) : 0;
        case 'beat': return ctx.audio ? ctx.audio.beatPulse(ctx.t) : 0;
        case 'bpm': return ctx.audio ? ctx.audio.bpmValue() : 120;
        default: return 0;
      }
    }
    default: return 0;
  }
}

export function num(v, fb = 0) {
  if (typeof v === 'number') return isFinite(v) ? v : fb;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const f = parseFloat(v);
    return isFinite(f) ? f : fb;
  }
  if (v && typeof v === 'object') {
    if (v.k === 'lit') return v.t === 'num' || v.t === 'time' ? Number(v.v) || fb : fb;
  }
  return fb;
}

/* 文本里的 $变量 插值。
 * 语义：`$名字` 取当前帧 ctx 里的变量值（含 $time/$frame/$progress）。
 * 不动的两类，都是有意的：
 *   · 未声明的名字原样保留 —— 用户正文写 "$abc" 不该被静默吃掉；
 *   · `$data.键` 是数据面板的绑定语法，后面跟 `.` 就整段留给它。
 * 取值走 evalExpr({k:'var'})，和表达式里的变量引用同一条路径，
 * 保证「文本里显示的值」和「表达式里算出的值」永远一致。 */
const VAR_TOKEN = /\$([A-Za-z_]\w*)/g;
export function interpolateVars(str, ctx) {
  const s = String(str == null ? '' : str);
  if (s.indexOf('$') < 0) return s;
  return s.replace(VAR_TOKEN, (all, name, offset) => {
    if (s[offset + all.length] === '.') return all;   // $data.键 归数据面板
    // 注意不能直接用 evalExpr 判空：它对未定义变量返回 0，
    // 那样「没声明的 $abc」会被替换成 0 而不是原样保留。
    if (ctx.getVar(name) === undefined) return all;
    const v = evalExpr({ k: 'var', name }, ctx);
    if (v === undefined || v === null) return all;
    return String(v);
  });
}

/* ============================================================
   场景状态（每帧新建，纯数据）
   ============================================================ */
export function blankScene(ir) {
  const layers = {};
  for (const l of ir.layers) {
    layers[l.id] = {
      id: l.id,
      type: l.type,
      name: l.name,
      visible: false,          // 默认隐藏，只有积木让它出现
      base: Object.assign({}, l.props),
      p: Object.assign({}, l.props),   // 本帧求值后的属性
      fx: {},                  // 动效临时量
      text: null,              // 拆分后的单元
      splitUnit: 'whole',
      delay: 0,
      data: null,              // 数据驱动缓存
    };
  }
  return { layers, extras: {}, logs: [] };
}

/* 目标解析：允许 '' = 当前图层 */
function resolveTarget(ctx, sel, curLayerId) {
  if (!sel) return curLayerId;
  if (sel === '@current') return curLayerId;
  const byName = ctx.ir.layers.find(l => l.name === sel);
  if (byName) return byName.id;
  const byId = ctx.ir.layers.find(l => l.id === sel);
  if (byId) return byId.id;
  return curLayerId;
}

/**
 * 判断「第 0 个槽是不是图层选择槽」——决定按哪种参数布局读。
 *
 * 背景：`repeater` / `particles` 在 `blocks.js` 里**没有图层槽**
 * （repeater 是 份数/间距/错峰/起始/起始高度，particles 是 粒子数/起始/时长/颜色/速度），
 * 但 `templates.js` 里这两个积木是**带图层名**的写法：
 *   blk('repeater',  [L('重复条'), N(14), N(92), ...])
 *   blk('particles', [L('粒子'),  N(140), ...])
 * 于是存在两套语义。原先 evaluator 只认 6 参数写法，面板拖出来的 5 槽积木
 * 被整体错一位读（份数读成间距、间距读成错峰…），用户填的值全被吃错。
 *
 * 判别必须稳：只有当第 0 槽**确实指向一个存在的图层**（按名字或 id 命中）
 * 才认为它是图层槽。用户填的「8」不会撞上任何图层名，所以走 5 参数路径。
 */
function hasLayerSlot(sel, ctx) {
  if (sel === undefined || sel === null || sel === '') return false;
  const s = String(sel);
  if (s === '@current') return true;
  return ctx.ir.layers.some(l => l.name === s || l.id === s);
}

/* ============================================================
   语句执行
   返回 true 表示该语句「消费」了时间（后续语句的基准时间被推进）
   ============================================================ */
export function execBlocks(blocks, ctx, state, curLayerId, baseT) {
  let cursor = baseT;
  let lastEnd = baseT;

  for (let i = 0; i < (blocks || []).length; i++) {
    const b = blocks[i];
    if (!b) continue;
    const r = execBlock(b, ctx, state, curLayerId, cursor);
    if (typeof r === 'number' && isFinite(r)) {
      if (r > cursor) cursor = r;     // 该语句把时间游标推到了更后面
    } else if (r === 'end') {
      cursor = Math.max(cursor, ctx.t);
    }
    if (cursor > lastEnd) lastEnd = cursor;
  }
  return lastEnd;
}

export function execBlock(b, ctx, state, curLayerId, t) {
  const op = b.op;
  const def = defOf(op);
  ctx.steps++;
  // 预算用尽：不再执行任何语句。截断是「本帧到此为止」，不是报错 ——
  // 预览可以继续跑下一帧，比让界面卡死几十秒强。
  if (ctx.steps > ctx.stepBudget) {
    ctx.budgetExceeded = true;
    return t;
  }
  if (ctx.hooks.onBlock) ctx.hooks.onBlock(b, def, ctx.t, t);

  const S = (idx) => (b.slots && b.slots[idx] ? b.slots[idx].value : undefined);
  const E = (idx) => evalExpr(S(idx), ctx);

  switch (op) {
    /* ---------- 时间结构 ---------- */
    case 'wait': {
      const d = Math.max(0, num(evalExpr(S(0), ctx), 0));
      return t + d;                      // 推进游标
    }
    case 'setAt': {
      const at = num(E(0), 0);
      const dur = execBlocks(S(1), ctx, state, curLayerId, at);
      return Math.max(t, dur);
    }
    case 'atMarker': {
      const name = String(evalExpr(S(0), ctx) ?? '');
      const m = findMarker(ctx.ir, name);
      const at = m ? m.time : t;
      const dur = execBlocks(S(1), ctx, state, curLayerId, at);
      return Math.max(t, dur);
    }
    case 'waitUntilMarker': {
      const name = String(evalExpr(S(0), ctx) ?? '');
      const m = findMarker(ctx.ir, name);
      return m ? Math.max(t, m.time) : t;
    }
    case 'after': {
      const d = Math.max(0, num(E(0), 0));
      const dur = execBlocks(S(1), ctx, state, curLayerId, t + d);
      return Math.max(t, dur);
    }
    case 'loop': {
      const n = Math.max(0, Math.min(500, Math.round(num(E(0), 1))));
      let cur = t;
      for (let i = 0; i < n; i++) {
        // 每层 500 的上限挡不住嵌套（500ⁿ）。整个循环必须受同一帧预算约束，
        // 否则 3 层就是 1.25 亿次 → 界面卡死几十秒，用户以为程序崩了。
        if (!ctx.hasBudget()) break;
        const end = execBlocks(S(1), ctx, state, curLayerId, cur);
        cur = Math.max(cur, end);
      }
      return cur;
    }
    case 'parallel': {
      // 所有子块同一时刻开始，各自独立推进；总时长取最长
      let maxEnd = t;
      const n = (b.slots || []).length;
      for (let i = 0; i < n; i++) {
        const sub = S(i);
        if (!Array.isArray(sub) || !sub.length) continue;
        const e = execBlocks(sub, ctx, state, curLayerId, t);
        maxEnd = Math.max(maxEnd, e);
      }
      return maxEnd;
    }
    case 'if': {
      const cond = !!E(0);
      return execBlocks(cond ? S(1) : S(2), ctx, state, curLayerId, t);
    }

    /* ---------- 文字 ---------- */
    case 'showText': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      const content = S(1) === undefined ? null : interpolateVars(String(evalExpr(S(1), ctx) ?? ''), ctx);
      if (content !== null && content !== '') ls.p.text = content;
      ls.visible = true;
      if (ls.text === null || ls.text === undefined) ls.text = buildUnits(String(ls.p.text), ls.splitUnit);
      return t;
    }
    case 'setText': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      ls.p.text = interpolateVars(String(evalExpr(S(1), ctx) ?? ''), ctx);
      ls.text = buildUnits(ls.p.text, ls.splitUnit);
      return t;
    }
    /* ---------- 变量 ---------- */
    case 'setVar': {
      // 「写变量」：把值写进本帧上下文，供后续表达式与文本插值读取。
      // 变量名是裸名（IR 里 name 不带 $），setVar 内部归一到 $name。
      // 没写名字就什么都不做 —— 静默写一个空名变量会让调试面板出现诡异条目。
      const name = String(evalExpr(S(0), ctx) ?? '').trim();
      if (!name) return t;
      ctx.setVar(name, evalExpr(S(1), ctx));
      return t;
    }
    case 'splitBy': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      const unit = String(evalExpr(S(1), ctx) ?? 'whole');
      ls.splitUnit = unit;
      ls.text = buildUnits(String(ls.p.text ?? ''), unit);
      return t;
    }
    case 'stagger': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      ls.visible = true;
      ensureUnits(ls, 'char');
      ls.fx.stagger = { gap: Math.max(0, num(E(1), 0.05)), start: Math.max(0, num(E(2), 0)) };
      return t;
    }
    case 'typewriter': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      ls.visible = true;
      ensureUnits(ls, 'char');
      const cps = Math.max(0.5, num(E(1), 12));
      const start = num(E(2), 0);
      const shown = Math.floor(Math.max(0, ctx.t - start) * cps);
      ls.fx.typewriter = { cps, start, count: shown };
      return t;
    }
    case 'charPopIn': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      ls.visible = true;
      ensureUnits(ls, 'char');
      ls.fx.charPop = {
        start: Math.max(0, num(E(1), 0)),
        gap: Math.max(0, num(E(2), 0.05)),
        ease: String(evalExpr(S(3), ctx) ?? 'backOut'),
        dur: 0.45,
      };
      return t;
    }
    case 'maskWipe': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      ls.visible = true;
      ensureUnits(ls, 'char');
      ls.fx.wipe = {
        dur: Math.max(0.01, num(E(1), 0.8)),
        start: Math.max(0, num(E(2), 0)),
        dir: String(evalExpr(S(3), ctx) ?? 'left'),
      };
      return t;
    }
    case 'pathSweep': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      ls.visible = true;
      ensureUnits(ls, 'char');
      ls.fx.sweep = {
        dur: Math.max(0.01, num(E(1), 1.2)),
        start: Math.max(0, num(E(2), 0)),
        amp: Math.max(0, num(E(3), 60)),
      };
      return t;
    }
    case 'numberRoll': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      ls.visible = true;
      const target = num(E(1), 100);
      const dur = Math.max(0.01, num(E(2), 1.5));
      const start = Math.max(0, num(E(3), 0));
      const dec = Math.max(0, Math.round(num(E(4), 0)));
      const p = ease('outCubic', clamp01((ctx.t - start) / dur));
      ls.p.text = (target * p).toFixed(dec);
      ls.text = buildUnits(ls.p.text, 'whole');
      return t;
    }
    case 'highlightWord': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      ls.visible = true;
      const words = String(evalExpr(S(1), ctx) ?? '');
      const start = num(E(2), 0);
      const col = String(evalExpr(S(3), ctx) ?? '#ffd166');
      if (words) { ls.p.text = words; ls.splitUnit = 'word'; ls.text = buildUnits(words, 'word'); }
      ls.fx.karaoke = { start, color: col };
      return t;
    }

    /* ---------- 动效（作用到目标图层属性） ---------- */
    case 'fadeIn': case 'fadeOut': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      const dur = Math.max(0.01, num(E(1), 0.5));
      const start = Math.max(0, num(E(2), 0));
      const p = clamp01((ctx.t - start) / dur);
      const k = ease('inOutQuad', p);
      ls.p.opacity = (op === 'fadeIn' ? k : 1 - k) * (ls.base.opacity ?? 1);
      ls.visible = true;
      ls.fx.fade = { start, dur, dir: op === 'fadeIn' ? 1 : -1 };
      return t;
    }
    case 'moveIn': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      const dir = String(evalExpr(S(1), ctx) ?? 'left');
      const dist = num(E(2), 120);
      const dur = Math.max(0.01, num(E(3), 0.6));
      const start = Math.max(0, num(E(4), 0));
      const ez = String(evalExpr(S(5), ctx) ?? 'outCubic');
      const p = ease(ez, clamp01((ctx.t - start) / dur));
      const dx = dir === 'left' ? -dist : dir === 'right' ? dist : 0;
      const dy = dir === 'up' ? -dist : dir === 'down' ? dist : 0;
      ls.p.x = (ls.base.x ?? 0) + dx * (1 - p);
      ls.p.y = (ls.base.y ?? 0) + dy * (1 - p);
      ls.p.opacity = (ls.base.opacity ?? 1) * clamp01(p * 1.6);
      ls.visible = true;
      ls.fx.move = { start, dur, dir, dist };
      return t;
    }
    case 'scaleIn': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      const from = num(E(1), 0), to = num(E(2), 1);
      const dur = Math.max(0.01, num(E(3), 0.6));
      const start = Math.max(0, num(E(4), 0));
      const ez = String(evalExpr(S(5), ctx) ?? 'backOut');
      const p = lerpN(from, to, ease(ez, clamp01((ctx.t - start) / dur)));
      ls.fx.scale = p;
      ls.visible = true;
      return t;
    }
    case 'setFill': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      const col = String(evalExpr(S(1), ctx) ?? '#ffffff');
      const dur = Math.max(0, num(E(2), 0));
      const start = Math.max(0, num(E(3), 0));
      if (dur <= 0) { ls.p.fill = col; ls.p.color = col; return t; }
      const p = clamp01((ctx.t - start) / dur);
      ls.p.fill = mixHex(String(ls.base.fill || ls.base.color || '#4a8cff'), col, ease('inOutQuad', p));
      return t;
    }

    /* ---------- 数据驱动图形 ---------- */
    case 'growBar': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      const data = parseData(String(evalExpr(S(1), ctx) ?? ''));
      const per = Math.max(0.02, num(E(2), 0.5));
      const gap = Math.max(0, num(E(3), 0.12));
      const start = Math.max(0, num(E(4), 0));
      const col = String(evalExpr(S(5), ctx) ?? '#38c98b');
      if (!data.length) return t;
      const max = Math.max(...data.map(v => Math.abs(v)), 1);
      const bars = data.map((v, i) => {
        const s = start + i * gap;
        const p = ease('outCubic', clamp01((ctx.t - s) / per));
        return { v: v / max, p, delay: s, color: col };
      });
      ls.visible = true;
      ls.data = { kind: 'bars', bars, base: ls.base };
      ls.fx.growBar = { start };
      return t;
    }
    case 'drawLine': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      const data = parseData(String(evalExpr(S(1), ctx) ?? ''));
      const dur = Math.max(0.02, num(E(2), 1.5));
      const start = Math.max(0, num(E(3), 0));
      const col = String(evalExpr(S(4), ctx) ?? '#ffb020');
      if (!data.length) return t;
      ls.visible = true;
      ls.data = { kind: 'line', points: data, dur, start, color: col };
      return t;
    }
    case 'repeater': {
      // 两套语义：模板写法带图层槽（6 参数），面板写法不带（5 参数）。
      // 按第 0 槽是否指向真实图层来判别，见 hasLayerSlot 的说明。
      const raw0 = S(0);
      const withLayer = hasLayerSlot(raw0 === undefined ? undefined : evalExpr(raw0, ctx), ctx);
      const base = withLayer ? 1 : 0;
      const lid = withLayer ? resolveTarget(ctx, String(evalExpr(raw0, ctx) ?? ''), curLayerId) : curLayerId;
      const ls = state.layers[lid];
      if (!ls) return t;
      const n = Math.max(1, Math.min(120, Math.round(num(E(base), 8))));
      const spacing = num(E(base + 1), 90);
      const gap = Math.max(0, num(E(base + 2), 0.06));
      const start = Math.max(0, num(E(base + 3), 0));
      const h0 = Math.max(0, num(E(base + 4), 20));
      const items = [];
      for (let i = 0; i < n; i++) {
        const s = start + i * gap;
        items.push({ i, delay: s, x: i * spacing, h: h0 });
      }
      ls.visible = true;
      ls.data = { kind: 'repeater', items, base: ls.base };
      return t;
    }
    case 'audioBars': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      const n = Math.max(4, Math.min(160, Math.round(num(E(1), 48))));
      const start = Math.max(0, num(E(2), 0));
      const col = String(evalExpr(S(3), ctx) ?? '#7c5cff');
      const gain = Math.max(0.1, num(E(4), 1));
      const spectrum = ctx.audio ? ctx.audio.spectrum(ctx.t, n) : new Array(n).fill(0);
      ls.visible = true;
      ls.data = { kind: 'bars', audioBars: true, spectrum, color: col, gain, base: ls.base, start };
      return t;
    }
    case 'ringSpectrum': {
      const lid = resolveTarget(ctx, String(E(0) ?? ''), curLayerId);
      const ls = state.layers[lid];
      if (!ls) return t;
      const n = Math.max(8, Math.min(200, Math.round(num(E(1), 64))));
      const start = Math.max(0, num(E(2), 0));
      const col = String(evalExpr(S(3), ctx) ?? '#38c98b');
      const radius = Math.max(20, num(E(4), 300));
      const spectrum = ctx.audio ? ctx.audio.spectrum(ctx.t, n) : new Array(n).fill(0);
      ls.visible = true;
      ls.data = { kind: 'ring', spectrum, color: col, radius, base: ls.base, start };
      return t;
    }
    case 'particles': {
      // 同 repeater：模板带图层槽（6 参数），面板不带（5 参数）
      const raw0 = S(0);
      const withLayer = hasLayerSlot(raw0 === undefined ? undefined : evalExpr(raw0, ctx), ctx);
      const base = withLayer ? 1 : 0;
      const lid = withLayer ? resolveTarget(ctx, String(evalExpr(raw0, ctx) ?? ''), curLayerId) : curLayerId;
      const ls = state.layers[lid];
      if (!ls) return t;
      const n = Math.max(4, Math.min(400, Math.round(num(E(base), 90))));
      const start = Math.max(0, num(E(base + 1), 0));
      const dur = Math.max(0.1, num(E(base + 2), 3));
      const col = String(evalExpr(S(base + 3), ctx) ?? '#4a8cff');
      const speed = num(E(base + 4), 180);
      const ps = [];
      for (let i = 0; i < n; i++) {
        const ang = hash2(i, 1.7) * Math.PI * 2;
        const sp = (0.4 + hash2(i, 4.3) * 0.6) * speed;
        const life = 0.6 + hash2(i, 8.8) * 0.8;
        ps.push({
          x: 0, y: 0,
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
          life, delay: start + hash2(i, 2.2) * 0.4,
          r: 3 + hash2(i, 5.5) * 7, seed: i,
        });
      }
      ls.visible = true;
      ls.data = { kind: 'particles', ps, dur, color: col, start, base: ls.base };
      return t;
    }

    default: {
      // 未知 op：当作表达式处理，便于扩展而不破坏工程
      const v = evalExpr({ k: 'blk', op, a: S(0), b: S(1), c: S(2), p: S(3), p2: S(4) }, ctx);
      if (v !== 0) ls_setProp(state, curLayerId, 'opacity', num(v, 1));
      return t;
    }
  }
}

function ls_setProp(state, lid, key, val) {
  const ls = state.layers[lid];
  if (ls) ls.p[key] = val;
}

function findMarker(ir, name) {
  if (!ir.markers) return null;
  if (!name) return ir.markers[0] || null;
  return ir.markers.find(m => m.label === name || m.id === name) || null;
}

/* ---------- 文本单元拆分 ---------- */
export function buildUnits(text, unit) {
  const s = String(text ?? '');
  switch (unit) {
    case 'char': return Array.from(s);
    case 'word': return splitWords(s);
    case 'line': return s.split('\n');
    case 'whole':
    default: return [s];
  }
}

/* 逐词拆分：中文按字、英文/数字按连续词、标点独立成单元。
   空白不单独成单元（否则 karaoke 高亮会多出一个空格单元），
   而是并入它后面的那个词，以便渲染时保持正确的视觉间距。 */
function splitWords(s) {
  const raw = s.match(/[一-龥]|[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*|[^\s一-龥A-Za-z0-9]|\s+/g) || [];
  const out = [];
  let pending = '';
  for (const t of raw) {
    if (/^\s+$/.test(t)) { pending += t; continue; }
    out.push(pending + t);
    pending = '';
  }
  if (pending) {
    if (out.length) out[out.length - 1] += pending;
    else out.push(pending);
  }
  return out;
}

function ensureUnits(ls, want) {
  const unit = want || ls.splitUnit || 'whole';
  // 逐字/逐词类动效要求单元已拆分；若还是整块则自动按目标单位拆
  if (!ls.text || ls.text.length <= 1) {
    if (unit === 'whole' && want && want !== 'whole') {
      ls.splitUnit = want;
      ls.text = buildUnits(String(ls.p.text ?? ''), want);
      return;
    }
  }
  if (!ls.text) ls.text = buildUnits(String(ls.p.text ?? ''), ls.splitUnit || 'whole');
}

/* ---------- 数据解析 ---------- */
export function parseData(s) {
  return String(s || '')
    .split(/[,，\s]+/)
    .map(x => parseFloat(x))
    .filter(x => isFinite(x));
}

/* ============================================================
   对外主入口：evaluateFrame
   ------------------------------------------------------------
   时间是纯函数输入，因此：
   · 预览播放   → 连续调用
   · 单步调试   → t += 1/fps
   · 导出逐帧   → t = i/fps
   三条路径走的是同一份代码 → 预览与成片天然一致。
   ============================================================ */
export function evaluateFrame(ir, t, audio, hooks = {}) {
  const ctx = new EvalContext(ir, t, audio, hooks);
  const state = blankScene(ir);
  state.t = t;

  for (const layer of ir.layers) {
    const ls = state.layers[layer.id];
    ls.visible = !!layer.visible;
    ls.p = Object.assign({}, layer.props);
    ls.text = buildUnits(String(ls.p.text ?? ''), 'whole');
  }

  // 自定义积木（函数）在求值前做宏展开 —— 求值器不需要认识 custom.* 的 op
  const lib = ir.customLibrary || hooks.customLibrary || null;

  for (const layer of ir.layers) {
    if (!layer.blocks || !layer.blocks.length) continue;
    let blocks = layer.blocks;
    if (lib && lib.size) {
      try {
        blocks = expandCustomBlocks(layer.blocks, lib, { maxDepth: 16 }).blocks;
      } catch (e) {
        // 自定义积木出错（递归/嵌套过深）→ 该图层不动，并在调试面板提示
        if (hooks.onCustomBlockError) hooks.onCustomBlockError(layer, e);
        continue;
      }
    }
    execBlocks(blocks, ctx, state, layer.id, 0);
  }

  // 文字里的 $变量 在**全部积木执行完之后**统一插值一次。
  // 为什么不能放在上面初始化时：那样「先 setVar 再显示文字」的写法读到的还是初值
  // （积木还没跑）。也不能在 setText/showText 里就地插值 —— 它们只改写 p.text，
  // 而没被积木碰过的图层仍需插值，两条路各插一次会互相打架。
  // 只处理 text：其它属性位（fill/x…）保持字面量，避免把颜色串里的 $ 误当变量。
  for (const layer of ir.layers) {
    const ls = state.layers[layer.id];
    const before = String(ls.p.text ?? '');
    const after = interpolateVars(before, ctx);
    if (after !== before) {
      ls.p.text = after;
      // 只有原本就没被积木拆过单元时才重建 units；已拆过的保持原拆分方式，
      // 否则 typewriter/stagger 这类「逐字」动效会被整块覆盖成单元素。
      if (!ls.text || ls.text.length <= 1) ls.text = buildUnits(after, ls.splitUnit || 'whole');
      else if (ls.splitUnit === 'whole' || !ls.splitUnit) ls.text = buildUnits(after, 'whole');
    }
  }

  // 数据驱动块生成的额外图层（图元不在 IR 图层树里时也能画）
  state.extras = state.extras || {};
  return { state, ctx };
}
