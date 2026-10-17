/* ============================================================
   ir.js · 统一中间表示（Animation IR / 动画 AST）
   ------------------------------------------------------------
   积木视图（Block）与将来的节点视图（Node）都是这份 IR 的投影。
   本文件只定义「数据」，不含任何求值/渲染逻辑。

   IR 结构:
   {
     version: "1.0",
     project: { name, width, height, fps, duration, background },
     markers: [ {id, time, label, color} ],
     layers:  [ {id, name, type, visible, locked, props:{...}, blocks:[Stmt] } ],
     variables: [ {id, name, type, value} ]
   }

   Stmt  = C 语句积木（带 bslot 的语句）
         | N 表达式积木（叶子）
   bslot = { type, value, ... }
   Expr  = 字面量 {k:'lit', t:'num'|'str'|'bool'|'col'|'time'|'sel', v}
         | 变量 {k:'var', name}
         | 表达式积木 {k:'blk', op, a?, b?, c?, p?{...}}
         | 音频探针 {k:'audio', metric, offset}
   ============================================================ */

export const IR_VERSION = '1.0';

/* ---------- 项目默认值 ---------- */
export function defaultProject(name = '未命名工程') {
  return {
    version: IR_VERSION,
    project: {
      name,
      width: 1920,
      height: 1080,
      fps: 24,
      duration: 6,
      background: '#0d1017',
      loudnessTarget: -14,      // LUFS 平台响度预设
    },
    markers: [],
    variables: [],
    layers: [
      newLayer('背景', 'rect', { x: 960, y: 540, w: 1920, h: 1080, fill: '#121722', stroke: '', strokeWidth: 0, radius: 0, opacity: 1, rotation: 0 }),
      newLayer('标题文字', 'text', { x: 960, y: 460, text: '积木动画工厂', fontSize: 120, fontWeight: 800, fill: '#ffffff', align: 'center', letterSpacing: 0, lineHeight: 1.25, opacity: 1, rotation: 0, shadow: 0 }),
      newLayer('装饰方块', 'rect', { x: 960, y: 700, w: 420, h: 12, fill: '#4a8cff', stroke: '', strokeWidth: 0, radius: 6, opacity: 1, rotation: 0 }),
    ],
  };
}

let _seq = 0;
export function uid(prefix = 'i') {
  _seq += 1;
  return `${prefix}${Date.now().toString(36).slice(-4)}${_seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/* ---------- 图层 ---------- */
export const LAYER_TYPES = {
  text:  { label: '文字',   icon: 'T' },
  rect:  { label: '矩形',   icon: '▭' },
  circle:{ label: '圆形',   icon: '●' },
  image: { label: '图片',   icon: '▤' },
};

export function newLayer(name, type = 'rect', props = {}) {
  return {
    id: uid('L'),
    name,
    type,
    visible: true,
    locked: false,
    props: Object.assign({
      x: 960, y: 540, opacity: 1, rotation: 0,
    }, type === 'text' ? {
      text: '文字', fontSize: 96, fontWeight: 700, fill: '#ffffff',
      align: 'left', letterSpacing: 0, lineHeight: 1.25, shadow: 0,
    } : type === 'image' ? {
      src: '', w: 400, h: 400, radius: 0,
    } : {
      w: 300, h: 300, radius: 0, fill: '#4a8cff', stroke: '', strokeWidth: 0,
    }, props),
    blocks: [],
  };
}

export function findLayer(ir, id) {
  return ir.layers.find(l => l.id === id) || null;
}

/* ---------- 表达式构造 ---------- */
export const lit = (t, v) => ({ k: 'lit', t, v });
export const varRef = (name) => ({ k: 'var', name });
export const blk = (op, args = {}, p = null) => ({ k: 'blk', op, ...args, p: p || undefined });
export const audioRef = (metric = 'amp', offset = 0) => ({ k: 'audio', metric, offset });

export const NUM = (v) => lit('num', v);
export const STR = (v) => lit('str', v);
export const BOOL = (v) => lit('bool', v);
export const COL = (v) => lit('col', v);
export const TIME = (v) => lit('time', v);
export const SEL = (v) => lit('sel', v);

/* ---------- 深拷贝 / 迁移 ---------- */
export function clone(x) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(x); } catch { /* 含 DOM 时回退 */ }
  }
  return JSON.parse(JSON.stringify(x));
}

/* ---------- 校验 ---------- */
export function validate(ir) {
  const errs = [];
  if (!ir || typeof ir !== 'object') return ['工程对象为空'];
  if (!ir.project) errs.push('缺少 project 字段');
  if (!Array.isArray(ir.layers)) errs.push('缺少 layers 数组');
  if (errs.length) return errs;
  if (!(ir.project.fps > 0)) errs.push('fps 必须为正数');
  if (!(ir.project.duration > 0)) errs.push('duration 必须为正数');
  if (ir.markers.length !== (ir.markers || []).length) errs.push('markers 必须是数组');
  for (const m of ir.markers || []) {
    if (!(m.time >= 0)) errs.push(`标记点「${m.label}」时间非法`);
  }
  return errs;
}

/* ============================================================
   积木文本格式（.txt）—— 便于手写、diff、版本管理
   ------------------------------------------------------------
   语法：
     # 工程: 名称                        ← 注释
     MARK 0.200 开场                      ← 锚点
     VAR name <json>                     ← 变量
     LAYER 标题文字 [text] (隐藏)         ← 图层（缩进 0）
       PROP text = "你好"                 ← 图层静态属性
       @ splitBy "标题文字" schar         ← 积木（缩进即嵌套层级）

     @ atMarker s开场                    ← C 形块
       > 0                               ← 进入第 0 个「子块槽」
         @ fadeIn "" ~0.5 ~0
       > 1                               ← 第 1 个子块槽
         @ ...

   值编码：
     #数值   ~时间   c#颜色   !布尔   s选项   "字符串"（可转义）
   复合值：
     $op(a,b,c)      表达式积木，如 $mul($add(#1,#2),#3)
     $name           变量引用
     ♪metric(offset) 音频变量，如 ♪amp(#0)
   注：`> n` 的 n 只数「子块槽」，不含参数槽，因此从 0 顺序数。
   ============================================================ */

/* ---------- 值编码 ---------- */
function escapeStr(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
function unescapeStr(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      i++;
      out += s[i] === 'n' ? '\n' : s[i];
    } else out += s[i];
  }
  return out;
}

function fmtValue(v) {
  if (v === undefined || v === null) return '""';
  if (typeof v === 'number') return '#' + v;
  if (typeof v === 'boolean') return '!' + (v ? '1' : '0');
  if (typeof v === 'string') return '"' + escapeStr(v) + '"';
  if (typeof v === 'object') {
    if (v.k === 'lit') {
      switch (v.t) {
        case 'num': return '#' + (Number(v.v) || 0);
        case 'time': return '~' + (Number(v.v) || 0);
        case 'col': return 'c' + v.v;
        case 'bool': return '!' + (v.v ? '1' : '0');
        case 'sel': return 's' + (v.v == null ? '' : v.v);
        case 'str': default: return '"' + escapeStr(v.v == null ? '' : v.v) + '"';
      }
    }
    if (v.k === 'blk') return fmtExpr(v);
    if (v.k === 'audio') return `♪${v.metric}(${fmtValue(v.offset || NUM(0))})`;
    if (v.k === 'var') return `$${v.name}`;
  }
  return '"' + escapeStr(String(v)) + '"';
}

/** VAR 行的值解码 —— 与 fmtValue 互逆。
 *  旧实现 toText 写 `JSON.stringify(值)`，fromText 却一律包成字符串字面量
 *  （`STR(原文)`），于是每存读一轮就多套一层转义：42 → "42" → "\"42\"" → …
 *  用户的工程文件会被逐轮写坏（实测第 2 轮 ≠ 第 4 轮）。
 *  改用与槽位值同一套编码（#数值 ~时间 c#颜色 !布尔 s选项 "字符串" $表达式），
 *  存读才是严格互逆的。旧文件里的 JSON / 裸值形态在这里兼容读一次。 */
function parseVarValue(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return STR('');
  if (s[0] === '{' || s[0] === '[') {
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object' && j.k) return j;
      return STR(s);
    } catch { /* 不是 JSON，按普通值继续解析 */ }
  }
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return NUM(parseFloat(s));
  if (s === 'true') return BOOL(true);
  if (s === 'false') return BOOL(false);
  return parsePin(s);
}

function fmtExpr(e) {
  if (!e) return '#0';
  if (e.k === 'lit') return fmtValue(e);
  if (e.k === 'audio') return `♪${e.metric}(${fmtValue(e.offset || NUM(0))})`;
  if (e.k === 'var') return `$${e.name}`;
  if (e.k !== 'blk') return '#0';
  const parts = ['a', 'b', 'c', 'p', 'p2']
    .filter(k => e[k] !== undefined && e[k] !== null)
    .map(k => fmtValue(e[k]));
  return `$${e.op}(${parts.join(',')})`;
}

/* ---------- 值解析 ---------- */
export function parsePin(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s === '·') return NUM(0);
  const c = s[0];
  if (c === '#') return NUM(parseFloat(s.slice(1)) || 0);
  if (c === '~') return TIME(parseFloat(s.slice(1)) || 0);
  if (c === '!' ) return BOOL(s.slice(1) === '1');
  if (c === 's' && (s.length === 1 || !/^s[\d.]/.test(s))) return SEL(s.length === 1 ? '' : s.slice(1));
  if (c === 'c' && /^#[0-9a-fA-F]{3,8}$/.test(s.slice(1))) return COL(s.slice(1));
  if (c === '"') return STR(unescapeStr(s.slice(1, -1)));
  if (c === '$') return parseExpr(s);
  if (c === '♪') {
    const m = s.match(/^♪(\w+)\((.*)\)$/);
    if (m) return { k: 'audio', metric: m[1], offset: m[2] ? parsePin(m[2]) : NUM(0) };
    const m2 = s.match(/^♪(\w+)$/);
    if (m2) return { k: 'audio', metric: m2[1], offset: NUM(0) };
    return { k: 'audio', metric: 'amp', offset: NUM(0) };
  }
  return STR(unescapeStr(s));
}

/* 解析 $op(a,b,c) —— 递归；无括号时视为变量引用 */
export function parseExpr(s) {
  const str = String(s);
  const m = str.match(/^\$([A-Za-z_]\w*)\(([\s\S]*)\)$/);
  if (!m) {
    const mv = str.match(/^\$([A-Za-z_]\w*)$/);
    if (mv) return { k: 'var', name: mv[1] };
    return NUM(parseFloat(str.replace(/[^0-9.\-]/g, '')) || 0);
  }
  const op = m[1];
  const args = splitArgs(m[2]);
  const e = { k: 'blk', op };
  const keys = ['a', 'b', 'c', 'p', 'p2'];
  args.forEach((raw, i) => {
    if (i < keys.length && raw !== '') e[keys[i]] = parsePin(raw);
  });
  return e;
}

function splitArgs(s) {
  const out = [];
  let cur = '', depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\') { cur += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; cur += ch; continue; }
    if (!inStr) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

/* ---------- 序列化 ---------- */
export function toText(ir) {
  const L = [];
  L.push(`# 工程: ${ir.project.name}`);
  L.push(`# 画布 ${ir.project.width}x${ir.project.height} @ ${ir.project.fps}fps, 时长 ${ir.project.duration}s`);
  L.push('# 值编码: #数值 ~时间 c#颜色 !布尔 s选项 "字符串"');
  L.push('# 积木行以 @ 开头，`> n` 表示进入 C 形块的第 n 个子块槽');
  for (const m of ir.markers) L.push(`MARK ${m.time.toFixed(3)} ${m.label}`);
  // 变量的值按「与槽位值同一套编码」写（见 parseVarValue 的说明）。
  // 原实现写 JSON.stringify，与读取侧不对称，每存读一轮多套一层转义。
  for (const v of ir.variables || []) L.push(`VAR ${v.name} ${fmtValue(v.value)}`);
  for (const layer of ir.layers) {
    L.push('');
    L.push(`LAYER ${escapeStr(layer.name)} [${layer.type}]${layer.visible ? '' : ' (隐藏)'}`);
    for (const k of Object.keys(layer.props)) {
      const v = layer.props[k];
      if (typeof v === 'string') L.push(`  PROP ${k} = ${JSON.stringify(v)}`);
      else L.push(`  PROP ${k} = ${v}`);
    }
    emitBlocks(L, layer.blocks, 1);
  }
  return L.join('\n');
}

function emitBlocks(L, blocks, depth) {
  const pad = '  '.repeat(depth);
  for (const b of blocks || []) {
    if (b.k === 'N') {
      L.push(`${pad}@ ${b.op} ${fmtValue(b.a)} ${b.b != null ? fmtValue(b.b) : ''} ${b.c != null ? fmtValue(b.c) : ''} ${b.p != null ? fmtValue(b.p) : ''}`.replace(/\s+$/, ''));
      continue;
    }
    const pins = (b.slots || []).filter(s => !Array.isArray(s.value)).map(s => fmtValue(s.value));
    L.push(`${pad}@ ${b.op}${pins.length ? ' ' + pins.join(' ') : ''}`);
    if (!b.slots) continue;
    // `> n` 的 n 只数「子块槽」（不含参数槽），所以手写时从 0 开始顺序数
    let subIdx = 0;
    for (const s of b.slots) {
      if (!Array.isArray(s.value)) continue;
      L.push(`${pad}  > ${subIdx}`);
      emitBlocks(L, s.value, depth + 2);
      subIdx++;
    }
  }
}

/* ---------- 反序列化 ---------- */
export function fromText(text, blockDefs) {
  // 从「空骨架」开始，而不是 defaultProject()——否则会和解析出的图层叠加
  const ir = {
    version: IR_VERSION,
    project: {
      name: '导入的工程',
      width: 1920, height: 1080, fps: 24, duration: 6,
      background: '#0d1017', loudnessTarget: -14,
    },
    markers: [],
    variables: [],
    layers: [],
  };
  const lines = String(text).split(/\r?\n/);
  const notes = [];
  let stack = [];
  let curLayer = null;
  const meta = _opMetaCache;

  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;

    /* 注释行：解析项目头（工程名 / 画布 / fps / 时长） */
    if (raw.startsWith('# 工程:')) { ir.project.name = raw.slice(5).trim() || ir.project.name; continue; }
    if (raw.startsWith('#')) {
      const m = raw.match(/画布\s*(\d+)x(\d+)\s*@\s*(\d+)fps.*时长\s*([\d.]+)s/);
      if (m) {
        ir.project.width = +m[1]; ir.project.height = +m[2];
        ir.project.fps = +m[3]; ir.project.duration = +m[4];
      }
      continue;
    }

    const indent = (line.match(/^[ \t]*/) || [''])[0];
    const depth = Math.floor(indent.replace(/\t/g, '  ').length / 2);
    const s = raw;

    if (s.startsWith('MARK ')) {
      const m = s.slice(5).trim().match(/^([\d.]+)\s*(.*)$/);
      if (m) ir.markers.push({ id: uid('M'), time: parseFloat(m[1]) || 0, label: m[2] || '标记', color: '#ffb020' });
      continue;
    }
    if (s.startsWith('VAR ')) {
      const m = s.slice(4).trim().match(/^(\S+)\s*(.*)$/);
      // 值保留类型（原实现一律 STR(...)，数字/布尔/颜色全变成字符串）。
      // 类型字段跟着值的 t 走，`type:'any'` 不再是无信息量占位。
      if (m) {
        const value = parseVarValue(m[2]);
        ir.variables.push({ id: uid('V'), name: m[1], type: value && value.t ? value.t : 'any', value });
      }
      continue;
    }
    if (s.startsWith('LAYER ')) {
      const body = s.slice(6);
      const m = body.match(/^(.*?)\s*\[(\w+)\](\s*\(隐藏\))?\s*$/);
      if (!m) { notes.push('LAYER 行无法解析：' + s); continue; }
      const name = unescapeStr(m[1]).trim();
      const type = m[2];
      curLayer = newLayer(name, type === 'text' || type === 'image' || type === 'circle' ? type : 'rect');
      curLayer.visible = !m[3];
      ir.layers.push(curLayer);
      stack = [{ depth: 1, list: curLayer.blocks, owner: null }];
      continue;
    }
    if (s.startsWith('PROP ')) {
      if (!curLayer) continue;
      const m = s.slice(5).trim().match(/^(\S+)\s*=\s*([\s\S]*)$/);
      if (m) {
        const pv = m[2].trim();
        try {
          curLayer.props[m[1]] = /^["\d.\-]|^(true|false|null)$/.test(pv) ? JSON.parse(pv) : pv;
        } catch { curLayer.props[m[1]] = pv; }
      }
      continue;
    }
    if (s.startsWith('>')) {
      if (!stack.length) continue;
      const f = stack[stack.length - 1];
      if (!f.owner || !f.owner.slots) continue;
      const idx = parseInt(s.slice(1).trim(), 10);
      if (!(idx >= 0)) continue;
      // `> n` 的 n 只数「子块槽」（不含参数槽）
      const subSlots = f.owner.slots.filter(x => Array.isArray(x.value));
      const slot = subSlots[idx];
      if (!slot) { notes.push(`子块槽越界：${s}`); continue; }
      if (!Array.isArray(slot.value)) slot.value = [];
      // 该帧就是「正在填的子块槽」，切换它的目标列表
      f.list = slot.value;
      continue;
    }
    if (!s.startsWith('@ ')) continue;
    if (!curLayer) { notes.push('积木出现在 LAYER 之前，已跳过：' + s); continue; }

    const body = s.slice(2);
    const sp = body.indexOf(' ');
    const op = sp < 0 ? body : body.slice(0, sp);
    const rest = sp < 0 ? '' : body.slice(sp + 1);
    const md = meta.get(op);
    if (!md) { notes.push(`未知积木：${op}`); continue; }

    // 弹出所有「比当前缩进更深」的栈帧，回到正确的父列表
    while (stack.length > 1 && stack[stack.length - 1].depth > depth) stack.pop();
    const frame = stack[stack.length - 1];
    if (!frame) continue;

    const node = makeFromOp(md, op, tokenizePins(rest));
    frame.list.push(node);

    // 若该块有子块槽，为它压入一个新栈帧（默认指向第 0 个子块槽）
    if (node.slots) {
      const subSlots = node.slots.filter(x => Array.isArray(x.value));
      if (subSlots.length) {
        stack.push({ depth: depth + 1, list: subSlots[0].value, owner: node, subSlots });
      }
    }
  }

  // 没有任何 LAYER 时给一个占位图层，保证 IR 始终可用
  if (!ir.layers.length) {
    notes.push('文本中没有 LAYER，已补一个空图层');
    const l = newLayer('图层1', 'rect');
    ir.layers.push(l);
  }
  return { ir, notes };
}

function makeFromOp(md, op, tokens) {
  if (md.isLeaf) {
    const b = { id: uid('B'), k: 'N', op };
    ['a', 'b', 'c', 'p', 'p2'].forEach((k, i) => {
      if (tokens[i] !== undefined) b[k] = tokens[i];
    });
    return b;
  }
  const slots = [];
  let pi = 0;
  for (const sd of (md.slots || [])) {
    if (sd.isSub) slots.push({ type: 'blocks', label: sd.label, menu: sd.menu || null, value: [] });
    else slots.push({ type: sd.type, label: sd.label, placeholder: sd.placeholder, menu: sd.menu || null, value: tokens[pi] !== undefined ? tokens[pi] : defaultForType(sd.type) });
    if (!sd.isSub) pi++;
  }
  return { id: uid('B'), k: 'C', op, slots };
}

/* 把一行参数切成若干个 token。
   规则：空白分隔；但 "$op(...)" / "♪amp(off)" 这类复合值整体作为一个 token，
   引号内的空格不算分隔符。 */
export function tokenizePins(rest) {
  const s = String(rest || '').trim();
  if (!s) return [];
  const out = [];
  let i = 0;
  while (i < s.length && out.length < 8) {
    while (i < s.length && s[i] === ' ') i++;
    if (i >= s.length) break;
    const start = i;
    let depth = 0;
    let inStr = false;
    let esc = false;
    while (i < s.length) {
      const ch = s[i];
      if (esc) { esc = false; i++; continue; }
      if (ch === '\\') { esc = true; i++; continue; }
      if (ch === '"') { inStr = !inStr; i++; continue; }
      if (!inStr) {
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { depth = Math.max(0, depth - 1); i++; continue; }
        if (depth === 0 && ch === ' ') break;
      }
      i++;
    }
    out.push(parsePin(s.slice(start, i)));
  }
  return out;
}

export function defaultForType(t) {
  switch (t) {
    case 'num': return NUM(0);
    case 'time': return TIME(0);
    case 'bool': return BOOL(false);
    case 'col': return COL('#ffffff');
    case 'sel': return SEL('');
    case 'str': return STR('');
    default: return STR('');
  }
}

/* 供 fromText 查 op 元数据（由 blocks.js 的 metaFor + main.js 填充） */
export const _opMetaCache = new Map();
export function registerOpMeta(defs) {
  for (const d of defs) _opMetaCache.set(d.op, d);
}

export function emptyProject() { return defaultProject(); }
