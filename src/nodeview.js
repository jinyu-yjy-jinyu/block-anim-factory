/* ============================================================
   nodeview.js · 节点图渲染（P1-A）
   ------------------------------------------------------------
   只负责把 NodeGraph 画成 DOM + SVG 连线，不含任何业务逻辑。
   业务（转换、布局）在 nodegraph.js。
   ============================================================ */

import { NODE_KINDS } from './nodegraph.js';

const NS = 'http://www.w3.org/2000/svg';

export function renderNodeGraph(container, svg, graph, opts = {}) {
  const state = opts.state || {};
  // 节点画在 #nodeLayer 里，#nodeCanvas 只负责滚动与定位
  const layer = (container.querySelector('#nodeLayer') || container);
  layer.querySelectorAll('.nnode,.nframe').forEach(n => n.remove());
  svg.innerHTML = '';

  if (!graph || !graph.nodes.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px;padding:20px;text-align:center;line-height:1.7';
    empty.textContent = opts.emptyText || '当前图层没有积木\n切到「积木」页搭几块，再点「从积木」';
    empty.style.whiteSpace = 'pre-line';
    layer.appendChild(empty);
    return;
  }

  // ---- frame（分组框）----
  for (const g of graph.nodes) {
    if (g.kind !== 'group') continue;
    const el = document.createElement('div');
    el.className = 'nframe';
    el.style.left = g.x + 'px';
    el.style.top = g.y + 'px';
    el.style.width = (g.w || 180) + 'px';
    el.style.height = (g.h || 100) + 'px';
    const label = document.createElement('div');
    label.className = 'nframe-label';
    label.textContent = g.title || '分组';
    el.appendChild(label);
    layer.appendChild(el);
  }

  // ---- 节点 ----
  for (const n of graph.nodes) {
    if (n.kind === 'group') continue;
    const el = document.createElement('div');
    const kind = NODE_KINDS[n.kind] || NODE_KINDS.exec;
    el.className = 'nnode nnode-' + n.kind + (state.selected === n.id ? ' selected' : '');
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    el.dataset.nodeId = n.id;

    const head = document.createElement('div');
    head.className = 'nnode-head';
    head.textContent = n.title || n.op;
    el.appendChild(head);

    const body = document.createElement('div');
    body.className = 'nnode-body';
    for (const p of n.inputs || []) {
      const row = document.createElement('div');
      row.className = 'nport';
      const dot = document.createElement('span');
      dot.className = 'dot';
      row.appendChild(dot);
      const lb = document.createElement('span');
      lb.textContent = p.label || '';
      row.appendChild(lb);
      if (p.value != null && p.value.k === 'lit') {
        const v = document.createElement('span');
        v.className = 'val';
        v.textContent = formatVal(p.value);
        row.appendChild(v);
      }
      body.appendChild(row);
    }
    el.appendChild(body);
    layer.appendChild(el);
  }

  // ---- 连线 ----
  const pos = new Map(graph.nodes.map(n => [n.id, n]));
  for (const e of graph.edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;

    const isFlow = e.kind === 'flow';
    let d;
    if (isFlow) {
      // 执行流：从右边缘绕到左边缘（走右侧通道）
      const x0 = a.x + nodeWidth(a), y0 = a.y + 26;
      const x1 = b.x, y1 = b.y + 26;
      const mx = Math.max(x0 + 40, (x0 + x1) / 2);
      d = `M ${x0} ${y0} C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1}`;
    } else {
      // 数据流：端口到端口
      const x0 = a.x + nodeWidth(a), y0 = a.y + 46;
      const x1 = b.x, y1 = b.y + 26;
      const mx = (x0 + x1) / 2;
      d = `M ${x0} ${y0} C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1}`;
    }

    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', isFlow ? '#c2377b' : '#2b62b8');
    path.setAttribute('stroke-width', isFlow ? '2.2' : '1.6');
    if (!isFlow) path.setAttribute('stroke-dasharray', '4 3');
    svg.appendChild(path);

    // 箭头
    const arrow = document.createElementNS(NS, 'polygon');
    const ah = 6;
    arrow.setAttribute('points', `${b.x},${b.y + 26} ${b.x - ah},${b.y + 26 - ah * 0.7} ${b.x - ah},${b.y + 26 + ah * 0.7}`);
    arrow.setAttribute('fill', isFlow ? '#c2377b' : '#2b62b8');
    svg.appendChild(arrow);
  }
}

function nodeWidth(n) {
  // 粗略估算：标题宽度或输入槽数量
  const inputs = (n.inputs || []).length;
  return Math.max(132, Math.min(230, (n.title || '').length * 13 + 32, 132 + inputs * 8));
}

function formatVal(v) {
  if (!v) return '';
  if (v.k === 'blk') return '◆积木';
  if (v.t === 'num') return String(v.v);
  if (v.t === 'time') return v.v + 's';
  if (v.t === 'bool') return v.v ? '真' : '假';
  if (v.t === 'col') return String(v.v || '');
  return String(v.v == null ? '' : v.v).slice(0, 10);
}

/** 画布尺寸（给 SVG 一个足够大的 viewBox） */
export function graphExtent(graph) {
  let w = 400, h = 300;
  for (const n of graph.nodes) {
    w = Math.max(w, n.x + nodeWidth(n) + 40);
    h = Math.max(h, n.y + (n.h || 90) + 40);
  }
  return { w, h };
}