/* ============================================================
   customblocks.js · 自定义积木（函数）（P1-B）
   ------------------------------------------------------------
   规划 F：「自定义积木（函数）：把常用逻辑封装成一块，跨项目复用」

   设计要点：
     · 一个自定义积木 = 一段 IR 模板 + 一组形参 + 形参到实参的绑定
     · 调用点只保存实参，不复制函数体 —— 改一次函数体，所有调用点同步
     · 支持嵌套调用（函数 A 里调用函数 B），带深度保护
     · 支持跨项目复用（导出/导入 .cbjson）
   ============================================================ */

import { uid, clone, validate } from './ir.js';
import { defOf, LEAF_SLOTS } from './blocks.js';

/* ============================================================
   参数定义
   ============================================================ */
export const PARAM_TYPES = [
  ['num', '数值'], ['time', '时长'], ['text', '文本'], ['color', '颜色'],
  ['bool', '布尔'], ['sel', '选项'], ['blocks', '积木'],
];

export class ParamDef {
  constructor(opts = {}) {
    this.name = opts.name || 'p';
    this.label = opts.label || opts.name || '参数';
    this.type = opts.type || 'num';
    this.defaultValue = opts.defaultValue !== undefined ? opts.defaultValue : defaultFor(opts.type);
    this.menu = opts.menu || null;
    this.options = opts.options || null;
    this.desc = opts.desc || '';
  }
}
function defaultFor(t) {
  switch (t) {
    case 'num': return { k: 'lit', t: 'num', v: 0 };
    case 'time': return { k: 'lit', t: 'time', v: 0 };
    case 'bool': return { k: 'lit', t: 'bool', v: false };
    case 'color': return { k: 'lit', t: 'col', v: '#ffffff' };
    case 'sel': return { k: 'lit', t: 'sel', v: '' };
    default: return { k: 'lit', t: 'str', v: '' };
  }
}

/* ============================================================
   自定义积木定义
   ============================================================ */
export class CustomBlock {
  constructor(opts = {}) {
    this.id = opts.id || uid('CB');
    this.name = opts.name || '我的积木';
    this.op = opts.op || 'custom.' + (opts.name || 'x');
    this.category = opts.category || 'custom';
    this.color = opts.color || '#7c5cff';
    this.desc = opts.desc || '';
    this.params = (opts.params || []).map(p => p instanceof ParamDef ? p : new ParamDef(p));
    // 函数体：一组「语句块」模板，形参以 {参名} 占位
    this.body = opts.body || [];
    this.author = opts.author || '';
    this.version = opts.version || '1.0.0';
    this.createdAt = opts.createdAt || new Date().toISOString();
  }

  /**
   * 是语句型还是表达式型。
   * 判定顺序：
   *   1) 显式声明 isStatement
   *   2) 含「积木型」形参 ⇒ 语句型（要接子块）
   *   3) 函数体首块是 N ⇒ 表达式型
   *   4) 其余按语句型
   */
  get isStatement() {
    if (this._isStatement != null) return this._isStatement;
    if (this.params.some(p => p.type === 'blocks')) return true;
    const first = this.body.find(b => b && b.k !== 'placeholder');
    if (first && first.k === 'N') return false;
    return true;
  }

  set isStatement(v) { this._isStatement = !!v; }
  param(name) { return this.params.find(p => p.name === name); }

  /** 校验定义本身是否合法 */
  validate() {
    const issues = [];
    if (!this.name.trim()) issues.push({ level: 'error', msg: '积木必须有名字' });
    if (!this.op.startsWith('custom.')) issues.push({ level: 'error', msg: `op 必须以 custom. 开头（当前 ${this.op}）` });
    const names = new Set();
    for (const p of this.params) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.name)) issues.push({ level: 'error', msg: `参数名非法：${p.name}` });
      if (names.has(p.name)) issues.push({ level: 'error', msg: `参数重名：${p.name}` });
      names.add(p.name);
      if (p.type === 'sel' && (!p.menu || !p.menu.length)) issues.push({ level: 'warn', msg: `选项参数「${p.label}」没有候选项` });
    }
    if (!this.body.length) issues.push({ level: 'warn', msg: '函数体为空' });
    // 引用了未定义的形参
    for (const name of findPlaceholders(this.body)) {
      if (!this.param(name)) issues.push({ level: 'error', msg: `函数体引用了不存在的参数 ${name}` });
    }
    return issues;
  }

  /** 生成调用点需要的数据（用于插入到积木树里） */
  instantiate(args = {}) {
    if (!this.isStatement) {
      // 表达式型：返回表达式积木
      return {
        id: uid('B'), k: 'N', op: this.op,
        a: args[this.params[0] ? this.params[0].name : 'a'] || (this.params[0] ? this.params[0].defaultValue : null),
        b: args[this.params[1] ? this.params[1].name : 'b'] || (this.params[1] ? this.params[1].defaultValue : null),
        customRef: this.id,
      };
    }
    const slots = this.params.map(p => ({
      type: p.type === 'blocks' ? 'blocks' : p.type,
      label: p.label,
      menu: p.menu,
      placeholder: p.desc || undefined,
      value: p.type === 'blocks' ? [] : (args[p.name] !== undefined ? args[p.name] : clone(p.defaultValue)),
    }));
    return { id: uid('B'), k: 'C', op: this.op, slots, customRef: this.id };
  }

  toJSON() {
    return {
      id: this.id, name: this.name, op: this.op, category: this.category,
      color: this.color, desc: this.desc, version: this.version, author: this.author,
      params: this.params.map(p => Object.assign({}, p)),
      body: clone(this.body),
    };
  }
  static fromJSON(j) { return new CustomBlock(j); }
}

/* ============================================================
   自定义积木库（跨项目复用）
   ============================================================ */
export class CustomBlockLibrary {
  constructor(opts = {}) {
    this.blocks = opts.blocks || [];
    this.meta = opts.meta || { name: '我的积木库', version: '1.0.0' };
  }

  add(cb) {
    if (!(cb instanceof CustomBlock)) cb = new CustomBlock(cb);
    const issues = cb.validate().filter(i => i.level === 'error');
    if (issues.length) throw new Error(issues.map(i => i.msg).join('；'));
    // op 冲突检查
    if (this.blocks.some(b => b.op === cb.op)) {
      throw new Error(`积木 op 冲突：${cb.op}`);
    }
    // 内置积木名不能被占用
    if (defOf(cb.op)) throw new Error(`op 与内置积木冲突：${cb.op}`);
    this.blocks.push(cb);
    return cb;
  }

  remove(id) {
    const i = this.blocks.findIndex(b => b.id === id);
    if (i < 0) return false;
    this.blocks.splice(i, 1);
    return true;
  }

  get(id) { return this.blocks.find(b => b.id === id); }
  byOp(op) { return this.blocks.find(b => b.op === op); }
  list() { return this.blocks; }
  get size() { return this.blocks.length; }

  /** 转成 blocks.js 可消费的积木定义（供积木库面板使用） */
  toBlockDefs() {
    return this.blocks.map(b => ({
      op: b.op,
      cat: b.category,
      color: b.color,
      label: b.name,
      desc: b.desc || `自定义积木（${b.params.length} 个参数）`,
      isLeaf: !b.isStatement,
      slots: b.isStatement
        ? b.params.map(p => p.type === 'blocks'
          ? { type: 'blocks', label: p.label, default: [] }
          : { type: p.type, label: p.label, default: p.defaultValue ? p.defaultValue.v : 0, menu: p.menu })
        : undefined,
      customRef: b.id,
    }));
  }

  toJSON() { return { meta: this.meta, blocks: this.blocks.map(b => b.toJSON()) }; }
  static fromJSON(j) {
    return new CustomBlockLibrary({
      meta: j.meta,
      blocks: (j.blocks || []).map(CustomBlock.fromJSON),
    });
  }
}

/* ============================================================
   调用展开（把自定义积木替换成实际语句）
   ------------------------------------------------------------
   求值器不认识 custom.* 的 op，所以在求值前先做一次「宏展开」。
   ============================================================ */
export function expandCustomBlocks(blocks, library, ctx = {}) {
  const maxDepth = ctx.maxDepth || 16;
  let expanded = 0;
  const stack = [];          // 正在展开的自定义积木，用于检测递归

  const walk = (list, depth) => {
    if (depth > maxDepth) {
      throw new Error(`自定义积木嵌套超过 ${maxDepth} 层（可能存在递归调用）`);
    }
    const out = [];
    for (const b of list || []) {
      const def = library.byOp(b.op);
      if (!def) {
        // 非自定义积木：递归其子块与表达式参数
        if (b.slots) {
          for (const s of b.slots) {
            if (Array.isArray(s.value)) s.value = walk(s.value, depth);
            else s.value = walkExpr(s.value, depth);
          }
        }
        if (b.k === 'N') {
          for (const k of ['a', 'b', 'c', 'p', 'p2']) {
            if (b[k] && typeof b[k] === 'object' && b[k].k === 'blk') {
              const sub = walkExpr(b[k], depth);
              if (sub === null) continue;
              b[k] = sub;
            }
          }
        }
        out.push(b);
        continue;
      }

      // 自定义积木：绑定实参 → 复制函数体
      if (stack.includes(def.id)) {
        const names = [...stack, def.id].map(id => (library.get(id) || {}).name || id);
        throw new Error(`自定义积木「${def.name}」存在递归调用：${names.join(' → ')}`);
      }
      stack.push(def.id);
      const args = bindArgs(def, b);
      const body = clone(def.body);
      // substitute 可能把占位块摊平，返回新列表
      const filled = substitutePlaceholders(body, args);
      const inner = walk(filled, depth + 1);
      stack.pop();
      expanded += inner.length;
      out.push(...inner);
    }
    return out;
  };

  /**
   * 展开一个「表达式」位置。
   * 若它本身是自定义表达式积木，则用函数体替换（函数体只有一条 N 块）。
   * 返回 null 表示应当删除该位置。
   */
  const walkExpr = (e, depth) => {
    if (!e || typeof e !== 'object') return e;
    if (e.k !== 'blk') return e;

    const def = library.byOp(e.op);
    if (!def) {
      // 普通表达式：递归它的子表达式
      for (const k of ['a', 'b', 'c', 'p', 'p2']) {
        if (e[k] && typeof e[k] === 'object' && e[k].k === 'blk') e[k] = walkExpr(e[k], depth);
      }
      return e;
    }
    if (depth > maxDepth) throw new Error(`自定义积木嵌套超过 ${maxDepth} 层（可能存在递归调用）`);
    if (stack.includes(def.id)) {
      const names = [...stack, def.id].map(id => (library.get(id) || {}).name || id);
      throw new Error(`自定义积木「${def.name}」存在递归调用：${names.join(' → ')}`);
    }
    stack.push(def.id);
    const args = bindArgs(def, e);
    const body = clone(def.body);
    const filled = substitutePlaceholders(body, args);
    // 函数体必须正好是一条表达式
    const expr = filled.find(x => x && x.k === 'N');
    let result = null;
    if (expr) {
      const next = walkExpr(expr, depth + 1);
      if (next && next.k === 'blk') result = next;
    }
    stack.pop();
    return result;
  };

  return { blocks: walk(blocks, 0), expanded, depth: maxDepth };
}

function bindArgs(def, callBlock) {
  const args = {};
  if (callBlock.k === 'N') {
    const keys = ['a', 'b', 'c', 'p', 'p2'];
    def.params.forEach((p, i) => {
      const v = callBlock[keys[i]];
      args[p.name] = v === undefined || v === null ? clone(p.defaultValue) : v;
    });
  } else {
    (callBlock.slots || []).forEach((s, i) => {
      const p = def.params[i];
      if (!p) return;
      args[p.name] = Array.isArray(s.value) ? s.value : (s.value !== undefined ? s.value : clone(p.defaultValue));
    });
  }
  return args;
}

const PH_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/** 收集函数体里引用到的形参名 */
export function findPlaceholders(blocks) {
  const names = new Set();
  const scan = (v) => {
    if (typeof v === 'string') {
      let m;
      PH_RE.lastIndex = 0;
      while ((m = PH_RE.exec(v)) !== null) names.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === 'object') {
      if (typeof v.v === 'string') scan(v.v);
      for (const k of ['a', 'b', 'c', 'p', 'p2']) if (v[k]) scan(v[k]);
      if (v.slots) v.slots.forEach(s => { if (Array.isArray(s.value)) s.value.forEach(scan); else scan(s.value); });
    }
  };
  (blocks || []).forEach(scan);
  return [...names];
}

/**
 * 替换占位符。
 * · 标量占位（{name}）→ 直接换成实参，保留类型
 * · 积木型占位（op='placeholder'）→ 就地摊平实参子块到同一层
 */
function substitutePlaceholders(blocks, args) {
  /** 精确占位（整个值就是 `{x}`）：表达式位置应原样代入实参表达式。
   *  原先对非 lit 的实参一律走 STR(a)，而 STR 是 `String(v)` ——
   *  传进来一个表达式积木（{k:'blk'}）就被写成 "[object Object]" 字符串，
   *  参数在求值之前就已经被毁掉。对象一律 clone 代入（lit 与 blk 都对），
   *  只有原始值才转成字符串字面量。 */
  const injectArg = (a) => (a && typeof a === 'object' ? clone(a) : STR(a));
  /** 文本里的内嵌占位（整串不是单个 `{x}`，如 `时长={dur}s`）：按字符串规则替换。
   *  实参本身是对象（表达式/积木/子块列表）时无法写进一段文本，
   *  保留原占位符而不是写进 "[object Object]"。 */
  const inlineSub = (s) => s.replace(PH_RE, (mm, name) => {
    const a = args[name];
    if (a === undefined) return mm;
    if (a && typeof a === 'object' && a.k === 'lit') return String(a.v == null ? '' : a.v);
    if (a && typeof a === 'object') return mm;
    return String(a);
  });
  /** 把一个「值」里的 {name} 占位替换掉 */
  const subValue = (v) => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') {
      const m = v.match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
      if (m && args[m[1]] !== undefined) return injectArg(args[m[1]]);
      if (/\{[a-zA-Z_]/.test(v)) return { k: 'lit', t: 'str', v: inlineSub(v) };
      return v;
    }
    if (v && typeof v === 'object' && v.k === 'lit') {
      if (typeof v.v === 'string' && /\{[a-zA-Z_]/.test(v.v)) {
        const m2 = v.v.match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
        if (m2 && args[m2[1]] !== undefined) return injectArg(args[m2[1]]);
        // 内嵌占位（原实现只处理了整串就是单个 {x} 的情况）：
        // `{k:'lit',t:'time',v:'时长={dur}'}` 这类带前后缀的占位此前永远不生效 ——
        // 形参在面板上配了却没作用，且不报错。
        return { ...v, v: inlineSub(v.v) };
      }
      return v;
    }
    return v;
  };

  /** 处理一个列表：返回摊平后的新列表 */
  const process = (list) => {
    const out = [];
    for (const b of list || []) {
      // 占位块 → 摊平实参子块
      if (b && b.op === 'placeholder') {
        const key = b.slotRef || b.subSlot || '__self__';
        const arg = args[key];
        if (Array.isArray(arg)) out.push(...arg.map(x => clone(x)));
        continue;
      }
      if (b.k === 'N') {
        for (const k of ['a', 'b', 'c', 'p', 'p2']) {
          if (b[k] === undefined) continue;
          b[k] = subValue(b[k]);
        }
        out.push(b);
        continue;
      }
      if (b.slots) {
        for (const s of b.slots) {
          if (Array.isArray(s.value)) {
            // 子块槽里的占位块也摊平
            const before = s.value.length;
            s.value = process(s.value);
            if (s.value.length !== before) { /* 已摊平 */ }
          } else {
            s.value = subValue(s.value);
          }
        }
      }
      out.push(b);
    }
    return out;
  };

  return process(blocks);
}

function STR(v) { return { k: 'lit', t: 'str', v: v == null ? '' : String(v) }; }

function findPlaceholderIn(slot) {
  // 子块槽若整个就是一个占位块（op='placeholder'），返回它代表的形参名
  if (!slot.value || !slot.value.length) return null;
  if (slot.value.length === 1) {
    const b = slot.value[0];
    if (b && b.op === 'placeholder') {
      // 优先用 slotRef，其次从 subSlot 里读
      if (b.slotRef) return b.slotRef;
      if (b.subSlot) return b.subSlot;
      return '__self__';      // 占位块代表「这个槽本身」
    }
  }
  const names = findPlaceholders(slot.value);
  return names.length === 1 ? names[0] : null;
}

/* ============================================================
   「从现有积木封装为函数」
   ------------------------------------------------------------
   用户框选一段积木 → 自动推断参数 → 生成定义。
   ============================================================ */
export function extractFunction(blocks, opts = {}) {
  if (!blocks || !blocks.length) throw new Error('没有可封装的积木');
  const lib = new CustomBlockLibrary();
  const params = [];
  const body = clone(blocks);

  // 扫描可参数化的槽位：字面量数值/文本/颜色
  let idx = 0;
  const scan = (list) => {
    for (const b of list || []) {
      if (b.k === 'N') {
        for (const k of ['a', 'b', 'c', 'p', 'p2']) {
          const v = b[k];
          if (v && typeof v === 'object' && v.k === 'lit' && v.t !== 'bool') {
            const name = 'p' + (idx++);
            params.push(new ParamDef({ name, label: v.t === 'num' ? `数值${idx}` : (v.t === 'time' ? `时长${idx}` : v.t), type: v.t, defaultValue: clone(v) }));
            b[k] = { k: 'lit', t: 'str', v: `{${name}}` };
          }
        }
        continue;
      }
      if (!b.slots) continue;
      for (const s of b.slots) {
        if (Array.isArray(s.value)) { scan(s.value); continue; }
        const v = s.value;
        if (v && typeof v === 'object' && v.k === 'lit' && v.t !== 'bool') {
          const name = 'p' + (idx++);
          params.push(new ParamDef({ name, label: s.label || v.t, type: v.t, defaultValue: clone(v) }));
          s.value = { k: 'lit', t: 'str', v: `{${name}}` };
        }
      }
    }
  };
  scan(body);

  const cb = new CustomBlock({
    name: opts.name || '自定义积木',
    op: 'custom.' + (opts.key || slugify(opts.name || 'fn')),
    params,
    body,
    desc: opts.desc || `由 ${blocks.length} 个积木封装`,
    color: opts.color,
  });
  const issues = cb.validate().filter(i => i.level === 'error');
  if (issues.length) throw new Error(issues.map(i => i.msg).join('；'));
  lib.add(cb);
  return lib;
}

export function slugify(s) {
  // 保留字母数字下划线；纯中文时退回稳定哈希而不是空串
  const ascii = String(s).trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
  if (ascii) return ascii;
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 'fn_' + h.toString(36);
}

/* ============================================================
   从当前 IR 生成「工程内置自定义积木」
   ------------------------------------------------------------
   这就是「模板生态」的基础：作者把常用逻辑封成积木随工程发布。
   ============================================================ */
export function libraryFromIR(ir, opts = {}) {
  const lib = new CustomBlockLibrary();
  for (const spec of (ir.customBlocks || [])) {
    try {
      const cb = new CustomBlock(spec);
      cb.validate();
      lib.blocks.push(cb);       // 直接放行（工程内定义的允许历史遗留）
    } catch (e) { /* 跳过损坏的定义 */ }
  }
  void opts;
  return lib;
}

export { validate as validateIR };
export const _unused = { LEAF_SLOTS, clone };