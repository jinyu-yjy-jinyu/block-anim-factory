/* ============================================================
   nodegraph.js · 节点图（P1-A）
   ------------------------------------------------------------
   规划 2.2：积木与节点不是两套编辑器，而是同一份 IR 的两个投影。

   双向映射规则：
     · 积木 → 节点（保真）：
         语句块的子积木列表 ⇒ 一个 Group 节点（frame）
         参数槽 ⇒ 输入端口
         变量读写 ⇒ 隐式连线
     · 节点 → 积木（有损）：
         先拓扑排序，再按执行语义线性化；
         无法线性化的数据流（分支、循环回边）会退化为
         「顺序块 + 表达式」，并在转换报告里明示损失。

   节点图本身是纯数据：{nodes[], edges[]}，
   布局由 layout() 计算，渲染交给 nodeview。
   ============================================================ */

import { defOf, LEAF_SLOTS } from './blocks.js';
import { uid } from './ir.js';

/* ============================================================
   节点图数据结构
   ============================================================ */
export class NodeGraph {
  constructor(opts = {}) {
    this.id = opts.id || uid('G');
    this.nodes = opts.nodes || [];
    this.edges = opts.edges || [];
    this.groups = opts.groups || [];
    // 拓扑结果缓存。hasCycle() 原本每次都完整跑一遍 Kahn，
    // 而渲染/校验会连续问好几次「有环吗」—— 图不变就重复算。
    // 用 _rev 当失效标记：任何改动 nodes/edges 的操作都 ++。
    this._rev = 0;
    this._topoRev = -1;
    this._topoCache = null;
  }

  /** 图结构变了就调用，让拓扑缓存失效 */
  _touch() { this._rev++; }

  node(id) { return this.nodes.find(n => n.id === id); }
  edge(id) { return this.edges.find(e => e.id === id); }

  add(node) { this.nodes.push(node); this._touch(); return node; }
  remove(id) {
    this.nodes = this.nodes.filter(n => n.id !== id);
    this.edges = this.edges.filter(e => e.from !== id && e.to !== id);
    this._touch();
  }
  connect(from, to, opts = {}) {
    const e = {
      id: uid('E'), from, to,
      fromPort: opts.fromPort || 'out',
      toPort: opts.toPort || 'in',
      kind: opts.kind || 'data',      // data | flow
    };
    this.edges.push(e);
    this._touch();
    return e;
  }
  incoming(id, port) {
    return this.edges.filter(e => e.to === id && (!port || e.toPort === port));
  }
  outgoing(id, port) {
    return this.edges.filter(e => e.from === id && (!port || e.fromPort === port));
  }

  /** 拓扑排序（处理数据边；有环则返回 null） */
  topoOrder() {
    if (this._topoRev === this._rev) return this._topoCache ? this._topoCache.slice() : null;
    const result = this._topoOrderUncached();
    this._topoRev = this._rev;
    this._topoCache = result;
    // 返回副本：缓存里那份不能交给调用方去改，否则下一次「命中缓存」
    // 拿到的就是被改坏的顺序，错误会静默传染到所有后续调用。
    return result ? result.slice() : null;
  }

  _topoOrderUncached() {
    const indeg = new Map(this.nodes.map(n => [n.id, 0]));
    const adj = new Map(this.nodes.map(n => [n.id, []]));
    for (const e of this.edges) {
      if (!indeg.has(e.to) || !adj.has(e.from)) continue;
      adj.get(e.from).push(e.to);
      indeg.set(e.to, indeg.get(e.to) + 1);
    }
    // Kahn
    const q = this.nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
    const out = [];
    while (q.length) {
      const id = q.shift();
      out.push(id);
      for (const nx of adj.get(id) || []) {
        indeg.set(nx, indeg.get(nx) - 1);
        if (indeg.get(nx) === 0) q.push(nx);
      }
    }
    return out.length === this.nodes.length ? out : null;
  }

  /** 有环吗（走缓存；图没变时不再重跑拓扑排序） */
  hasCycle() { return this.topoOrder() === null; }

  toJSON() {
    return { id: this.id, nodes: this.nodes, edges: this.edges, groups: this.groups };
  }
  static fromJSON(j) { return new NodeGraph(j); }
}

/* 节点类型 */
export const NODE_KINDS = {
  exec:   { label: '执行', color: '#c2377b', shape: 'pill' },     // 流程连线
  value:  { label: '数值', color: '#2b62b8', shape: 'circle' },   // 数据端口
  inport:{ label: '输入', color: '#38c98b', shape: 'diamond' },
  group:  { label: '分组', color: '#5a5f6e', shape: 'frame' },
  comment:{ label: '注释', color: '#8a6d00', shape: 'note' },
};

/* ============================================================
   积木 → 节点（保真投影）
   ============================================================ */
export function blocksToGraph(blockList, opts = {}) {
  const g = new NodeGraph();
  const ctx = { block2node: new Map(), node2block: new Map(), warnings: [] };

  walkBlockList(blockList, g, ctx, null);

  // 同一列表内的兄弟块按顺序串成执行流（「积木顺序即时间顺序」）
  function walkBlockList(list, graph, c, groupNode) {
    let prev = groupNode ? groupNode.id : null;
    for (const b of list || []) {
      const node = blockToNode(b, graph, c);
      if (prev) graph.connect(prev, node.id, { kind: 'flow', fromPort: 'exec', toPort: 'exec' });
      prev = node.id;
    }
  }

  function blockToNode(b, graph, c) {
    const def = defOf(b.op);
    const isLeaf = b.k === 'N';
    const n = {
      id: uid('N'),
      kind: isLeaf ? 'value' : 'exec',
      op: b.op,
      blockId: b.id,
      title: def ? def.label : b.op,
      category: def ? def.cat : 'logic',
      x: 0, y: 0,
      inputs: [], outputs: [],
      props: {},
    };

    if (isLeaf) {
      // 表达式积木：参数作为输入端口，值作为端口上的常量
      const specs = LEAF_SLOTS[b.op] || [];
      n.inputs = specs.map((s, i) => ({
        id: ['a', 'b', 'c', 'p', 'p2'][i],
        label: s[1],
        type: s[0],
        menu: s[3] || null,
        value: b[['a', 'b', 'c', 'p', 'p2'][i]] ?? null,
      }));
      n.outputs = [{ id: 'out', label: '', type: inferType(b.op) }];
    } else {
      // 语句积木：参数槽为输入端口，子块槽展开成子节点
      const def2 = defOf(b.op);
      n.inputs = [];
      (def2.slots || []).forEach((s, i) => {
        if (Array.isArray(s.default)) return;      // 子块槽单独处理
        n.inputs.push({ id: 'in' + i, label: s.label, type: s.type, menu: s.menu || null, slotIndex: i, value: b.slots[i] && b.slots[i].value });
      });
      n.outputs = [{ id: 'out', label: '', type: 'exec' }];
      // 子块 → 子节点，每个子块槽一个 frame（parallel 有多个槽）
      const subSlots = (def2.slots || []).map((s, i) => ({ s, i })).filter(x => Array.isArray(x.s.default));
      n.frameIds = [];
      for (const { s, i } of subSlots) {
        const frame = {
          id: uid('G'), kind: 'group', op: b.op + ':frame',
          title: `${def2.label} · ${s.label || i}`,
          blockId: null,
          ownerBlockId: b.id,     // 宿主积木的 id
          ownerNodeId: n.id,      // 宿主节点的 id（还原时双向匹配）
          slotIndex: i,
          x: n.x, y: n.y,
          inputs: [], outputs: [],
          subSlots: [i],
        };
        graph.add(frame);
        n.frameIds.push(frame.id);
        if (!n.frameId) n.frameId = frame.id;
        c.node2block.set(frame.id, { type: 'frame', ownerId: b.id, slotIndex: i });
        const child = b.slots[i] && b.slots[i].value;
        walkBlockList(child, graph, c, frame);
      }
    }

    graph.add(n);
    c.block2node.set(b.id, n.id);
    c.node2block.set(n.id, b);
    // 槽位里若嵌了表达式积木，也展开成节点
    if (!isLeaf && b.slots) {
      for (let i = 0; i < b.slots.length; i++) {
        const s = b.slots[i];
        if (s && s.value && typeof s.value === 'object' && s.value.k === 'blk') {
          const child = exprToNode(s.value, graph, c);
          graph.connect(child.id, n.id, { fromPort: 'out', toPort: 'in' + i });
        }
      }
    }
    return n;
  }

  function exprToNode(e, graph, c) {
    const def = defOf(e.op);
    const n = {
      id: uid('N'), kind: 'value', op: e.op,
      title: def ? def.label : e.op,
      category: def ? def.cat : 'math',
      x: 0, y: 0,
      inputs: [], outputs: [{ id: 'out', label: '', type: inferType(e.op) }],
    };
    const specs = LEAF_SLOTS[e.op] || [];
    n.inputs = specs.map((s, i) => ({
      id: ['a', 'b', 'c', 'p', 'p2'][i],
      label: s[1], type: s[0], menu: s[3] || null,
      value: e[['a', 'b', 'c', 'p', 'p2'][i]] ?? null,
    }));
    graph.add(n);
    for (const s of n.inputs) {
      const v = s.value;
      if (v && typeof v === 'object' && v.k === 'blk') {
        const cn = exprToNode(v, graph, c);
        graph.connect(cn.id, n.id, { fromPort: 'out', toPort: s.id });
      }
    }
    return n;
  }

  layout(g);
  return { graph: g, block2node: ctx.block2node, node2block: ctx.node2block };
}

/* ============================================================
   节点 → 积木（有损线性化）
   返回 { blocks, losses } —— losses 明示降级点，产品上必须显示
   ============================================================ */
export function graphToBlocks(graph, opts = {}) {
  const losses = [];
  const execNodes = graph.nodes.filter(n => n.kind === 'exec');

  // 「被 frame 收纳」的节点不是根 —— 它们属于宿主块的作用域
  const frameChild = new Set();
  for (const g of graph.nodes) {
    if (g.kind !== 'group') continue;
    // 顺着 frame 的执行链把整串子节点都标上
    let cur = g;
    const guard = new Set();
    while (cur) {
      const e = graph.outgoing(cur.id, 'exec')[0];
      if (!e || guard.has(e.to)) break;
      guard.add(e.to);
      frameChild.add(e.to);
      cur = graph.node(e.to);
    }
  }

  const roots = execNodes.filter(n =>
    graph.incoming(n.id, 'exec').length === 0 && !frameChild.has(n.id));
  if (roots.length === 0 && execNodes.length) {
    roots.push(execNodes[0]);
    losses.push({ kind: 'noRoot', msg: '未找到执行入口，已按节点顺序展开' });
  }
  if (roots.length > 1) {
    losses.push({ kind: 'multiRoot', msg: `检测到 ${roots.length} 个执行入口，已按顺序串联（可能有并行语义丢失）` });
  }

  const visited = new Set();
  const blocks = [];
  const visit = (n, depth) => {
    if (!n || visited.has(n.id)) return;
    visited.add(n.id);
    const b = nodeToBlock(n, graph, losses, depth);
    if (b) blocks.push(b);
    // 顺着执行流一路走到底
    let cur = n;
    const guard = new Set([n.id]);
    while (cur) {
      const e = graph.outgoing(cur.id, 'exec')[0];
      if (!e || guard.has(e.to)) break;
      guard.add(e.to);
      const cn = graph.node(e.to);
      if (!cn) break;
      visit(cn, depth);
      cur = cn;
    }
  };
  roots.forEach(r => visit(graph.node(r.id), 0));

  // 未被流程边覆盖的节点也补进来，避免静默丢块（但跳过 frame 内的）
  for (const n of execNodes) {
    if (!visited.has(n.id) && !frameChild.has(n.id)) {
      const b = nodeToBlock(n, graph, losses, 0);
      if (b) {
        blocks.push(b);
        losses.push({ kind: 'orphan', msg: `节点「${n.title}」没有被执行流覆盖，已追加到末尾` });
      }
    }
  }

  return { blocks, losses };
}

function nodeToBlock(n, graph, losses, depth) {
  const def = defOf(n.op);
  if (!def) { losses.push({ kind: 'unknownOp', msg: `未知积木 ${n.op}，已跳过` }); return null; }

  if (n.kind === 'value') {
    const b = { id: uid('B'), k: 'N', op: n.op };
    ['a', 'b', 'c', 'p', 'p2'].forEach((k, i) => {
      const inp = n.inputs[i];
      if (!inp) return;
      // 有连线 → 用连线源的表达式；否则用端口上的常量
      const inc = graph.incoming(n.id, inp.id)[0];
      if (inc) {
        const src = graph.node(inc.from);
        const sb = nodeToBlock(src, graph, losses, depth + 1);
        if (sb && sb.k === 'N') b[k] = { k: 'blk', op: sb.op, a: sb.a, b: sb.b, c: sb.c, p: sb.p, p2: sb.p2 };
      } else if (inp.value != null) {
        b[k] = inp.value;
      }
    });
    return b;
  }

  // 语句块
  const slots = [];
  const defSlots = def.slots || [];
  defSlots.forEach((s, i) => {
    if (Array.isArray(s.default)) {
      // 子块槽：找它对应的 frame（frame 记录的是 owner 的 blockId）
      const ownerBlockId = n.blockId || n.id;
      const frame = graph.nodes.find(g =>
        g.kind === 'group'
        && (g.ownerBlockId === ownerBlockId || g.ownerNodeId === n.id)
        && g.slotIndex === i);
      const children = [];
      if (frame) {
        // frame 的执行流是一串链：frame → a → b → c …，需要顺着走完
        let cur = frame;
        const guard = new Set();
        while (cur) {
          const nextEdge = graph.outgoing(cur.id, 'exec')[0];
          if (!nextEdge || guard.has(nextEdge.to)) break;
          guard.add(nextEdge.to);
          const cn = graph.node(nextEdge.to);
          if (!cn) break;
          if (depth > 32) { losses.push({ kind: 'deepNest', msg: '嵌套过深，已截断' }); break; }
          const cb = nodeToBlock(cn, graph, losses, depth + 1);
          if (cb) children.push(cb);
          cur = cn;
        }
      } else {
        losses.push({ kind: 'noFrame', msg: `节点「${n.title}」的第 ${i} 个子块槽缺少分组，已留空` });
      }
      slots.push({ type: 'blocks', label: s.label, value: children });
    } else {
      const inp = n.inputs.find(x => x.slotIndex === i);
      let value = inp ? inp.value : undefined;
      // 如果有连线，把源节点表达式内联进来（保真）
      if (inp) {
        const inc = graph.incoming(n.id, inp.id)[0];
        if (inc) {
          const src = graph.node(inc.from);
          const sb = src && nodeToBlock(src, graph, losses, depth + 1);
          if (sb && sb.k === 'N') value = { k: 'blk', op: sb.op, a: sb.a, b: sb.b, c: sb.c, p: sb.p, p2: sb.p2 };
          else losses.push({ kind: 'flowToValue', msg: `端口「${inp.label}」的连线来源不是数值节点` });
        }
      }
      slots.push({ type: s.type, label: s.label, menu: s.menu || null, value: value != null ? value : defaultLit(s.type) });
    }
  });

  return { id: n.blockId || uid('B'), k: 'C', op: n.op, slots };
}

function defaultLit(t) {
  switch (t) {
    case 'num': return { k: 'lit', t: 'num', v: 0 };
    case 'time': return { k: 'lit', t: 'time', v: 0 };
    case 'bool': return { k: 'lit', t: 'bool', v: false };
    case 'col': return { k: 'lit', t: 'col', v: '#ffffff' };
    case 'sel': return { k: 'lit', t: 'sel', v: '' };
    default: return { k: 'lit', t: 'str', v: '' };
  }
}

function inferType(op) {
  if (['amp', 'bass', 'mid', 'treble', 'beat', 'bpm', 'frame', 'time', 'progress', 'noise', 'noise1D'].includes(op)) return 'num';
  if (['gt', 'lt', 'eq', 'and', 'or', 'not'].includes(op)) return 'bool';
  if (['mixCol', 'hsl'].includes(op)) return 'col';
  return 'num';
}

/* ============================================================
   自动布局
   ------------------------------------------------------------
   按执行层（拓扑深度）分列，数据边做纵向排布。
   没有依赖库，胜在可控且确定性。
   ============================================================ */
export function layout(g, opts = {}) {
  const COL_W = opts.colWidth || 230;
  const ROW_H = opts.rowHeight || 92;
  const PAD = opts.pad || 40;

  // 计算执行深度
  const depth = new Map();
  const execNodes = g.nodes.filter(n => n.kind !== 'group');
  const order = g.topoOrder();
  const seq = order || execNodes.map(n => n.id);
  for (const id of seq) {
    const n = g.node(id);
    if (!n) continue;
    const ins = g.incoming(id).filter(e => e.kind === 'flow' || true);
    let d = 0;
    for (const e of ins) {
      const pd = depth.get(e.from);
      if (pd != null) d = Math.max(d, pd + 1);
    }
    depth.set(id, d);
  }

  const byColumn = new Map();
  for (const n of g.nodes) {
    const d = n.kind === 'group' ? (depth.get(n.id) || 0) : (depth.get(n.id) || 0);
    if (!byColumn.has(d)) byColumn.set(d, []);
    byColumn.get(d).push(n);
  }

  const maxCol = Math.max(0, ...byColumn.keys());
  for (let c = 0; c <= maxCol; c++) {
    const list = byColumn.get(c) || [];
    list.forEach((n, i) => {
      n.x = PAD + c * COL_W;
      n.y = PAD + i * ROW_H;
    });
  }
  for (const gnode of g.nodes) {
    if (gnode.kind !== 'group') continue;
    // frame 圈住它所包的子节点
    const kids = g.outgoing(gnode.id, 'exec').map(e => g.node(e.to)).filter(Boolean);
    if (!kids.length) { gnode.x = gnode.x || 0; gnode.y = gnode.y || 0; continue; }
    const minX = Math.min(...kids.map(k => k.x)) - 24;
    const minY = Math.min(...kids.map(k => k.y)) - 28;
    const maxX = Math.max(...kids.map(k => k.x)) + 140;
    const maxY = Math.max(...kids.map(k => k.y)) + 60;
    gnode.x = minX; gnode.y = minY;
    gnode.w = maxX - minX;
    gnode.h = maxY - minY;
  }
  return g;
}

/* ============================================================
   差分报告：积木视图与节点视图是否保真
   ============================================================ */
export function roundTripReport(blocks) {
  const { graph, block2node } = blocksToGraph(blocks);
  const { blocks: back, losses } = graphToBlocks(graph);
  const before = countOps(blocks);
  const after = countOps(back);
  return {
    graph,
    before, after,
    losses,
    lossless: after === before && losses.length === 0,
    missing: before - after,
  };
}

function countOps(list) {
  let n = 0;
  for (const b of list || []) {
    n++;
    if (b.slots) for (const s of b.slots) if (Array.isArray(s.value)) n += countOps(s.value);
  }
  return n;
}

export { countOps as countBlockOps };