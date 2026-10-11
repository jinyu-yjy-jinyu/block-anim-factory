/* ============================================================
   blockview.js · 积木渲染器 + 拖拽 + 参数编辑
   ------------------------------------------------------------
   与 renderer.js 的关系：这里画的是「逻辑」，那里画的是「画面」。
   两者读同一份 IR（ir.js），符合规划里「积木与节点共用一份中间表示」。
   ============================================================ */

import { defOf, EASINGS, UNIT_LABELS, DIR_LABELS, LEAF_SLOTS } from './blocks.js';
import { NUM, STR, BOOL, COL, TIME, SEL, defaultForType, uid, toText } from './ir.js';

/* 会话态（由 main.js 注入回调） */
export const S = {
  ir: null,
  selected: null,          // 选中积木 id
  layerId: null,           // 当前图层 id
  onSelect: () => {},
  onChange: () => {},       // 结构变更（需进撤销栈）
  onTick: () => {},         // 参数微调（不进撤销栈）
  getMarkers: () => [],
  findLayer: () => null,
  openExpr: () => {},
};

let ROOT = null;

export function initBlockView(root) {
  ROOT = root;
  root.addEventListener('mousedown', onRootMouseDown);
  root.addEventListener('dragstart', (e) => e.preventDefault());
  root.addEventListener('click', onRootClick);
  root.addEventListener('dblclick', onRootDblClick);
}

/* ============================================================
   渲染
   ============================================================ */
export function renderBlocks() {
  if (!ROOT || !S.ir) return;
  const scrollTop = ROOT.scrollTop;
  ROOT.innerHTML = '';
  const stack = document.createElement('div');
  stack.className = 'stack';
  const layer = S.ir.layers.find(l => l.id === S.layerId);
  if (!layer) {
    stack.appendChild(el('div', 'hint', '请先在左侧选择一个图层'));
    ROOT.appendChild(stack);
    return;
  }
  stack.appendChild(layerHeader(layer));
  const list = document.createElement('div');
  list.className = 'stack';
  list.dataset.list = 'root';
  list.dataset.layer = layer.id;
  for (const b of layer.blocks) list.appendChild(blockEl(b, 'root', layer));
  list.appendChild(dropzone('root', layer));
  stack.appendChild(list);
  ROOT.appendChild(stack);
  ROOT.scrollTop = scrollTop;
}

function layerHeader(layer) {
  const d = document.createElement('div');
  // 注意：不要用 .block 类，否则会被当成可选中的积木
  d.className = 'block-head';
  d.style.setProperty('--bc', layer.type === 'text' ? '#0f8a72' : '#8a5a00');
  const h = el('div', 'bh');
  h.appendChild(el('span', 'dot'));
  h.appendChild(el('span', 'lbl', `图层逻辑 · ${layer.name}`));
  const more = el('button', 'more', '⋯');
  more.dataset.act = 'layerMenu';
  more.dataset.layer = layer.id;
  h.appendChild(more);
  d.appendChild(h);
  return d;
}

/* ---------- 单块 ---------- */
export function blockEl(b, listKey, layer, depth = 0) {
  const def = defOf(b.op);
  const node = document.createElement('div');
  node.className = 'block';
  if (def) node.style.setProperty('--bc', def.color);
  else node.style.setProperty('--bc', '#6b7280');
  node.dataset.id = b.id;
  node.dataset.op = b.op;
  node.dataset.list = listKey;
  node.dataset.depth = String(depth);
  if (S.selected === b.id) node.classList.add('selected');

  const h = el('div', 'bh');
  h.appendChild(el('span', 'dot'));
  h.appendChild(el('span', 'lbl', def ? def.label : `未知(${b.op})`));
  if (def && !def.isLeaf) h.appendChild(el('span', 'badge', 'C'));
  if (def && def.isLeaf) h.appendChild(el('span', 'badge', 'N'));
  const more = el('button', 'more', '⋯');
  more.dataset.act = 'blockMenu';
  more.dataset.id = b.id;
  h.appendChild(more);
  node.appendChild(h);

  if (b.k === 'N') {
    node.classList.add('leaf');
    const row = el('div', 'bslot');
    row.appendChild(leafArgs(b, def));
    node.appendChild(row);
  } else if (b.slots) {
    const slotWrap = el('div', 'bslot');
    b.slots.forEach((s, i) => {
      if (Array.isArray(s.value)) {
        const row = el('div', 'row');
        if (s.label) row.appendChild(el('span', 'k', s.label));
        const sub = document.createElement('div');
        sub.className = 'stack nested';
        sub.dataset.list = `${b.id}:${i}`;
        sub.dataset.layer = layer ? layer.id : '';
        sub.dataset.owner = b.id;
        for (const cb of s.value) sub.appendChild(blockEl(cb, `${b.id}:${i}`, layer, depth + 1));
        sub.appendChild(dropzone(`${b.id}:${i}`, layer, b));
        row.appendChild(sub);
        slotWrap.appendChild(row);
      } else {
        const row = el('div', 'row');
        if (s.label) row.appendChild(el('span', 'k', s.label));
        // path = 槽位序号（owner 本身已由 data-owner 定位）
        row.appendChild(pinEl(s, b, String(i)));
        slotWrap.appendChild(row);
      }
    });
    node.appendChild(slotWrap);
  }
  return node;
}

function leafArgs(b, def) {
  const wrap = el('div', 'row');
  const specs = leafSpec(b.op);
  const vals = [b.a, b.b, b.c, b.p, b.p2];
  if (!specs.length) {
    wrap.appendChild(el('span', 'k', '()'));
    return wrap;
  }
  specs.forEach((sd, i) => {
    const key = ['a', 'b', 'c', 'p', 'p2'][i];
    const fake = { id: b.id, op: b.op };
    const s = {
      type: sd[0], label: sd[1], menu: sd[3] || null, placeholder: sd[4] || '',
      value: vals[i] !== undefined && vals[i] !== null ? vals[i] : defaultForType(sd[0]),
    };
    wrap.appendChild(pinEl(s, b, `${key}`, false));
  });
  return wrap;
}

/* 叶子块参数规格（来自 blocks.js LEAF_SLOTS） */
function leafSpec(op) { return LEAF_SLOTS[op] || []; }

/* ---------- 参数槽 ---------- */
function pinEl(slot, owner, path, isSlot = true) {
  const v = slot.value;
  const holder = document.createElement('span');

  // 表达式积木 → 紫色小图
  if (v && typeof v === 'object' && v.k === 'blk') {
    const d = defOf(v.op);
    const chip = el('span', 'exprmini', exprText(v, d));
    chip.dataset.expr = owner.id;
    chip.dataset.path = path;
    chip.title = '点击编辑表达式';
    holder.appendChild(chip);
    return holder;
  }
  if (v && typeof v === 'object' && v.k === 'audio') {
    const chip = el('span', 'exprmini', `♪${audioLabel(v.metric)}`);
    chip.dataset.expr = owner.id;
    chip.dataset.path = path;
    holder.appendChild(chip);
    return holder;
  }

  let input;
  if (slot.menu) {
    input = document.createElement('select');
    input.className = 'pin sel';
    for (const opt of menuOptions(slot)) {
      const o = document.createElement('option');
      o.value = opt[0];
      o.textContent = opt[1];
      if (String(v && v.v) === String(opt[0])) o.selected = true;
      input.appendChild(o);
    }
  } else if (slot.type === 'bool') {
    input = document.createElement('select');
    input.className = 'pin sel bool';
    for (const [val, txt] of [[true, '是'], [false, '否']]) {
      const o = document.createElement('option');
      o.value = val ? '1' : '0';
      o.textContent = txt;
      if (!!(v && v.v) === val) o.selected = true;
      input.appendChild(o);
    }
  } else if (slot.type === 'col') {
    input = document.createElement('input');
    input.type = 'color';
    input.className = 'pin col';
    input.value = hex2css(v && v.v);
  } else {
    input = document.createElement('input');
    input.type = slot.type === 'num' || slot.type === 'time' ? 'number' : 'text';
    input.className = 'pin ' + (slot.type === 'str' ? 'txt' : 'num');
    input.step = slot.type === 'time' ? '0.01' : 'any';
    input.value = v && v.v !== undefined && v.v !== null ? v.v : '';
    if (slot.placeholder) input.placeholder = slot.placeholder;
  }
  input.dataset.owner = owner.id;
  input.dataset.path = path;
  input.dataset.slot = '1';
  holder.appendChild(input);
  return holder;
}

function menuOptions(slot) {
  const m = slot.menu;
  if (m === 'markers') {
    const ms = S.getMarkers() || [];
    return [['', '（无标记）'], ...ms.map(x => [x.label, `${x.label} @${x.time.toFixed(2)}s`])];
  }
  if (m === 'layersText') return S.ir.layers.filter(l => l.type === 'text').map(l => [l.name, l.name]);
  if (m === 'layersShape') return S.ir.layers.filter(l => l.type !== 'text').map(l => [l.name, l.name]);
  if (m === 'targets') {
    const opts = [['', '（当前图层）']];
    for (const l of S.ir.layers) opts.push([l.name, l.name]);
    return opts;
  }
  if (m === 'easings') return EASINGS.map(([k, t]) => [k, t]);
  if (Array.isArray(m)) {
    if (m.length && typeof m[0] === 'string' && (UNIT_LABELS[m[0]] || DIR_LABELS[m[0]] || EASINGS.find(e => e[0] === m[0]))) {
      return m.map(x => [x, UNIT_LABELS[x] || DIR_LABELS[x] || (EASINGS.find(e => e[0] === x) || [, x])[1]]);
    }
    return m.map(x => [x, x]);
  }
  return [['', '（无）']];
}

function audioLabel(m) {
  return { amp: '振幅', bass: '低频', mid: '中频', treble: '高频', beat: '节拍', bpm: 'BPM' }[m] || m;
}

function exprText(e, d) {
  if (!d) return e.op;
  const fmt = (x) => {
    if (x == null) return '';
    if (typeof x === 'object' && x.k === 'lit') return String(x.v);
    if (typeof x === 'object' && x.k === 'blk') return exprText(x, defOf(x.op));
    if (typeof x === 'object' && x.k === 'var') return x.name;
    return String(x);
  };
  if (e.op === 'mixCol') return `混色(${fmt(e.a)},${fmt(e.b)},${fmt(e.c)})`;
  if (e.op === 'hsl') return `HSL(${fmt(e.a)},${fmt(e.b)},${fmt(e.c)})`;
  if (e.op === 'tween') return `${fmt(e.a)}→${fmt(e.b)}`;
  if (e.op === 'amp' || e.op === 'bass' || e.op === 'mid' || e.op === 'treble' || e.op === 'beat') return `♪${audioLabel(e.op)}`;
  if (e.op === 'lerp') return `${fmt(e.a)}↔${fmt(e.b)}`;
  if (e.op === 'randRange') return `随机(${fmt(e.a)}~${fmt(e.b)})`;
  return `${d.label}(${fmt(e.a)}${e.b !== undefined && e.b !== null ? `,${fmt(e.b)}` : ''})`;
}

function hex2css(h) {
  const s = String(h || '#ffffff');
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : '#ffffff';
}

/* ---------- 插入占位 ---------- */
function dropzone(listKey, layer, owner) {
  const dz = el('div', 'dropzone');
  dz.dataset.drop = listKey;
  if (owner) dz.dataset.owner = owner.id;
  if (layer) dz.dataset.layer = layer.id;
  return dz;
}

/* ============================================================
   交互：点击 / 双击 / 参数输入
   ============================================================ */
function onRootClick(e) {
  const t = e.target;
  const more = t.closest('[data-act="blockMenu"]');
  if (more) { e.stopPropagation(); S.onBlockMenu && S.onBlockMenu(more.dataset.id, more); return; }
  const lm = t.closest('[data-act="layerMenu"]');
  if (lm) { e.stopPropagation(); S.onLayerMenu && S.onLayerMenu(lm.dataset.layer); return; }

  const pin = t.closest('.pin');
  if (pin) {
    e.stopPropagation();
    S.selected = pin.dataset.owner;
    markSelected();
    S.onSelect && S.onSelect(pin.dataset.owner);
    return;
  }
  const mini = t.closest('.exprmini');
  if (mini) {
    e.stopPropagation();
    S.selected = mini.dataset.expr;
    markSelected();
    S.onSelect && S.onSelect(mini.dataset.expr);
    S.openExpr(mini.dataset.expr, mini.dataset.path);
    return;
  }
  const blk = t.closest('.block');
  if (blk) {
    S.selected = blk.dataset.id;
    markSelected();
    S.onSelect && S.onSelect(blk.dataset.id);
  } else {
    S.selected = null;
    markSelected();
    S.onSelect && S.onSelect(null);
  }
}

function markSelected() {
  for (const n of ROOT.querySelectorAll('.block.selected')) n.classList.remove('selected');
  if (S.selected) {
    const n = ROOT.querySelector(`.block[data-id="${cssEsc(S.selected)}"]`);
    if (n) n.classList.add('selected');
  }
}

function onRootDblClick(e) {
  const mini = e.target.closest('.exprmini');
  if (mini) { S.openExpr(mini.dataset.expr, mini.dataset.path); return; }
  const pin = e.target.closest('.pin');
  if (pin) { S.openExpr(pin.dataset.owner, pin.dataset.path); }
}

/* 参数输入：change 进撤销栈，input 只刷新画面。
   注意：change 后不重建整棵积木树，避免输入框失焦。 */
export function bindPinEditing(root) {
  root.addEventListener('change', (e) => {
    const pin = e.target.closest('.pin');
    if (!pin) return;
    const v = readPin(pin);
    S.onChange(() => {
      applyToOwner(S.ir, pin.dataset.owner, pin.dataset.path, v);
    });
    S.onTick && S.onTick();
  });
  root.addEventListener('input', (e) => {
    const pin = e.target.closest('.pin');
    if (!pin || pin.tagName === 'SELECT') return;
    applyToOwner(S.ir, pin.dataset.owner, pin.dataset.path, readPin(pin));
    S.onTick && S.onTick();
  });
}

function readPin(pin) {
  const cls = pin.className || '';
  if (cls.includes('bool')) return BOOL(pin.value === '1');
  if (cls.includes('col')) return COL(pin.value);
  if (cls.includes('sel')) return SEL(pin.value);
  if (pin.type === 'number') return NUM(parseFloat(pin.value) || 0);
  return STR(pin.value);
}

/* 按 path 写回。path 为纯槽位序号（语句块）或参数键名（表达式块）。 */
export function applyToOwner(ir, ownerId, path, value) {
  const owner = findBlockDeep(ir, ownerId);
  if (!owner) return;
  if (owner.k === 'N') {
    owner[path] = value;
    return;
  }
  const idx = parseInt(path, 10);
  const slot = owner.slots && owner.slots[idx];
  if (slot) slot.value = value;
}

export function findBlockDeep(ir, id) {
  let found = null;
  const scan = (list) => {
    for (const b of list || []) {
      if (b.id === id) { found = b; return; }
      if (b.slots) for (const s of b.slots) if (Array.isArray(s.value)) scan(s.value);
      if (found) return;
    }
  };
  for (const l of ir.layers) scan(l.blocks);
  return found;
}

export function findBlockParent(ir, id) {
  let res = null;
  const scan = (list, owner, key) => {
    for (let i = 0; i < (list || []).length; i++) {
      const b = list[i];
      if (b.id === id) { res = { list, index: i, owner, key }; return; }
      if (b.slots) {
        for (let s = 0; s < b.slots.length; s++) {
          if (Array.isArray(b.slots[s].value)) { scan(b.slots[s].value, b, `${key}|${s}`); if (res) return; }
        }
      }
    }
  };
  for (const l of ir.layers) { scan(l.blocks, null, 'root'); if (res) break; }
  return res;
}

/* ============================================================
   拖拽：从积木库拖入 / 块间重排 / 嵌套
   ============================================================ */
function onRootMouseDown(e) {
  const head = e.target.closest('.bh');
  if (!head) return;
  const node = head.closest('.block');
  if (!node || node.querySelector('.bh') !== head) return;
  if (e.target.closest('.more')) return;
  if (e.button !== 0) return;
  e.preventDefault();
  startDrag({ kind: 'move', id: node.dataset.id }, e);
}

export function startDragFromPalette(op, e) {
  startDrag({ kind: 'new', op }, e);
}

function startDrag(payload, ev) {
  const ghost = document.createElement('div');
  ghost.className = 'block dragging';
  const def = payload.kind === 'new' ? defOf(payload.op) : null;
  ghost.style.setProperty('--bc', def ? def.color : '#4a8cff');
  const g = el('div', 'bh');
  g.appendChild(el('span', 'dot'));
  g.appendChild(el('span', 'lbl', def ? def.label : (findBlockLabel(payload.id) || '积木')));
  ghost.appendChild(g);
  ghost.style.cssText += ';position:fixed;left:0;top:0;pointer-events:none;z-index:999;opacity:.85';
  document.body.appendChild(ghost);

  const sx = ev.clientX, sy = ev.clientY;
  let moved = false;

  const onMove = (e) => {
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    ghost.style.transform = `translate(${dx}px,${dy}px) rotate(1.5deg)`;
    highlightDrop(e);
  };
  const onUp = (e) => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    ghost.remove();
    clearHighlights();
    if (!moved) {
      const id = payload.kind === 'move' ? payload.id : null;
      S.selected = id;
      markSelected();
      if (S.onSelect) S.onSelect(id);
      return;
    }
    const dz = pickDrop(e);
    if (dz) applyDrop(payload, dz, e.clientY);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function findBlockLabel(id) {
  const b = findBlockDeep(S.ir, id);
  const d = b ? defOf(b.op) : null;
  return d ? d.label : '积木';
}

function highlightDrop(e) {
  clearHighlights();
  const dz = pickDrop(e);
  if (dz) dz.classList.add('over');
}
function clearHighlights() {
  for (const n of document.querySelectorAll('.dropzone.over')) n.classList.remove('over');
}

function pickDrop(e) {
  const els = document.elementsFromPoint(e.clientX, e.clientY);
  for (const n of els) {
    if (n.classList && n.classList.contains('dropzone')) return n;
    const z = n.querySelector && n.querySelector(':scope > .dropzone');
    if (z) return z;
  }
  // 兜底：找最近的垂直 dropzone
  const all = [...document.querySelectorAll('.dropzone')];
  if (!all.length) return null;
  return all.find(z => {
    const r = z.getBoundingClientRect();
    return e.clientY >= r.top - 8 && e.clientY <= r.bottom + 8;
  }) || null;
}

function applyDrop(payload, dz, dropY) {
  const listKey = dz.dataset.drop;
  S.onChange(() => {
    let moving;
    if (payload.kind === 'move') {
      const par = findBlockParent(S.ir, payload.id);
      if (!par) return;
      moving = par.list[par.index];
      // 禁止把积木拖进自己的子树（会造成不可达代码）
      const sub = collectIds(moving);
      if (listIsInside(moving, listKey)) return;
      if (containsId(listKey, sub)) return;
      par.list.splice(par.index, 1);
    } else {
      moving = createBlock(payload.op);
    }
    const list = resolveList(listKey);
    if (!list) return;
    let idx = list.length;
    for (let i = 0; i < list.length; i++) {
      const r = list[i].getBoundingClientRect();
      if (dropY < r.top + r.height / 2) { idx = i; break; }
    }
    list.splice(idx, 0, moving);
    renderBlocks();
    S.onTick && S.onTick();
  }, { rebuild: true });
}

/* 收集子树所有 id（含自身） */
function collectIds(b) {
  const out = new Set([b.id]);
  if (b.slots) for (const s of b.slots) if (Array.isArray(s.value)) for (const cb of s.value) collectInto(cb, out);
  return out;
}
function collectInto(b, out) {
  out.add(b.id);
  if (b.slots) for (const s of b.slots) if (Array.isArray(s.value)) for (const cb of s.value) collectInto(cb, out);
}
function containsId(listKey, set) {
  if (listKey === 'root') return false;
  const ownerId = listKey.split(':')[0];
  return set.has(ownerId);
}
/* 目标列表是否位于 moving 自身内部 */
function listIsInside(moving, listKey) {
  if (listKey === 'root') return false;
  const ownerId = listKey.split(':')[0];
  return collectIds(moving).has(ownerId);
}

export function resolveList(listKey) {
  if (listKey === 'root') {
    const l = S.ir.layers.find(x => x.id === S.layerId);
    return l ? l.blocks : null;
  }
  const [bid, si] = listKey.split(':');
  const owner = findBlockDeep(S.ir, bid);
  if (!owner || !owner.slots) return null;
  const slot = owner.slots[parseInt(si, 10)];
  if (!slot) return null;
  if (!Array.isArray(slot.value)) slot.value = [];
  return slot.value;
}

/* ---------- 从 op 创建块 ---------- */
export function createBlock(op) {
  const def = defOf(op);
  if (!def) return { id: uid('B'), k: 'C', op, slots: [] };
  if (def.isLeaf) {
    const slots = leafSpec(op);
    const b = { id: uid('B'), k: 'N', op };
    const keys = ['a', 'b', 'c', 'p', 'p2'];
    slots.forEach((sd, i) => { b[keys[i]] = defaultForType(sd[0]); });
    return b;
  }
  const b = { id: uid('B'), k: 'C', op, slots: [] };
  for (const sd of (def.slots || [])) {
    const isSub = sd.default !== undefined && Array.isArray(sd.default);
    b.slots.push({
      type: sd.type, label: sd.label, placeholder: sd.placeholder, menu: sd.menu || null,
      value: isSub ? [] : defaultForType(sd.type),
    });
  }
  return b;
}

/* ---------- 文本序列化（复用 ir.js 的唯一实现） ---------- */
export function dumpText(ir) { return toText(ir); }

/* ---------- 工具 ---------- */
export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }
