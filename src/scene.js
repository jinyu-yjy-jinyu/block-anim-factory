/* ============================================================
   scene.js · 场景树（P0-G）
   ------------------------------------------------------------
   规划 A：场景 / 图层 / 组，支持嵌套与复用实例。
   元素类型：文字、基础图元、SVG、位图、视频占位、粒子、图表、Lottie 插槽。

   设计要点：
   · 节点是树（children），支持任意嵌套
   · 「实例」指向 masterId，渲染时展开 —— 改 master 所有实例同步更新
   · 属性与积木都在节点上；父组的变换与不透明度向下传递
   · 混合模式与遮罩是节点属性，由 renderer 直接消费
   ============================================================ */

import { uid, newLayer } from './ir.js';

export const ELEMENT_TYPES = {
  group:    { label: '组',      icon: '▣', canHaveChildren: true },
  text:     { label: '文字',    icon: 'T' },
  rect:     { label: '矩形',    icon: '▭' },
  ellipse:  { label: '椭圆',    icon: '●' },
  line:     { label: '线条',    icon: '╱' },
  path:     { label: '路径',    icon: '〜' },
  star:     { label: '星形',    icon: '★' },
  polygon:  { label: '多边形',  icon: '⬡' },
  svg:      { label: 'SVG',     icon: '◈' },
  image:    { label: '位图',    icon: '▤' },
  video:    { label: '视频占位', icon: '▶' },
  particle: { label: '粒子',    icon: '∴' },
  chart:    { label: '图表',    icon: '▥' },
  lottie:   { label: 'Lottie',  icon: '◇' },
  subtitle: { label: '字幕',    icon: '⌸' },
  audioBars:{ label: '波形柱',  icon: '▁▃▅' },
};

/* 混合模式（Canvas2D globalCompositeOperation） */
export const BLEND_MODES = [
  ['normal', '正常'], ['multiply', '正片叠底'], ['screen', '滤色'],
  ['overlay', '叠加'], ['darken', '变暗'], ['lighten', '变亮'],
  ['color-dodge', '颜色减淡'], ['color-burn', '颜色加深'],
  ['hard-light', '强光'], ['soft-light', '柔光'],
  ['difference', '差值'], ['exclusion', '排除'],
  ['hue', '色相'], ['saturation', '饱和度'], ['color', '颜色'], ['luminosity', '明度'],
];

/* 遮罩类型 */
export const MASK_TYPES = [
  ['none', '无'], ['alpha', 'Alpha'], ['rect', '矩形'], ['ellipse', '椭圆'],
  ['path', '路径'], ['text', '文字'], ['inverse', '反相'],
];

/* ============================================================
   场景节点
   ============================================================ */
export class SceneNode {
  constructor(opts = {}) {
    this.id = opts.id || uid('N');
    this.name = opts.name || '图层';
    this.type = opts.type || 'rect';
    this.visible = opts.visible !== false;
    this.locked = !!opts.locked;
    this.children = opts.children || [];
    this.masterId = opts.masterId || null;    // 实例指向的主节点
    this.props = Object.assign(defaultProps(this.type), opts.props || {});
    this.blend = opts.blend || 'normal';
    this.mask = opts.mask || null;            // {type, x,y,w,h,invert, feather}
    this.opacity = opts.opacity == null ? 1 : opts.opacity;
    this.blocks = opts.blocks || [];          // 程序化时间轴（与 V0 IR 一致）
    this.exposed = opts.exposed || [];        // 参数暴露（P2-A）
    this.overrides = opts.overrides || null; // 实例对 master 的显式覆盖键
  }

  get isGroup() { return this.type === 'group'; }
  get hasMaster() { return !!this.masterId; }
}

/* 各类型的默认属性 */
export function defaultProps(type) {
  const base = { x: 960, y: 540, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0 };
  switch (type) {
    case 'text':
      return Object.assign(base, {
        text: '文字', fontSize: 96, fontWeight: 700, fill: '#ffffff',
        align: 'left', letterSpacing: 0, lineHeight: 1.25, shadow: 0,
        fontStretch: 'normal', fontStyle: 'normal', vertical: false,
        pathText: null, ringText: null, stroke: '', strokeWidth: 0,
      });
    case 'rect':
      return Object.assign(base, { w: 300, h: 200, radius: 0, fill: '#4a8cff', stroke: '', strokeWidth: 0 });
    case 'ellipse':
      return Object.assign(base, { w: 200, h: 200, fill: '#7c5cff', stroke: '', strokeWidth: 0 });
    case 'line':
      return Object.assign(base, { x2: 1200, y2: 700, stroke: '#ffffff', strokeWidth: 6, cap: 'round' });
    case 'path':
      return Object.assign(base, { d: 'M0,0 L200,120 L80,260 Z', fill: 'none', stroke: '#38c98b', strokeWidth: 4, trim: 0 });
    case 'star':
      return Object.assign(base, { w: 240, h: 240, points: 5, innerRatio: 0.45, fill: '#ffd166', stroke: '', strokeWidth: 0 });
    case 'polygon':
      return Object.assign(base, { w: 200, h: 200, sides: 6, fill: '#38c98b', stroke: '', strokeWidth: 0 });
    case 'svg':
      return Object.assign(base, { w: 300, h: 300, src: '', fill: '#ffffff' });
    case 'image':
      return Object.assign(base, { w: 400, h: 400, src: '', radius: 0, fit: 'contain' });
    case 'video':
      return Object.assign(base, { w: 640, h: 360, src: '', poster: '', trimStart: 0, trimEnd: 0 });
    case 'particle':
      return Object.assign(base, { count: 90, speed: 180, life: 3, size: 8, fill: '#4a8cff' });
    case 'chart':
      return Object.assign(base, { w: 800, h: 400, kind: 'bar', data: '30,55,80,45', fill: '#38c98b' });
    case 'lottie':
      return Object.assign(base, { w: 300, h: 300, src: '', loop: true });
    case 'subtitle':
      return Object.assign(base, { trackId: null, styleId: 'default' });
    case 'audioBars':
      return Object.assign(base, { count: 48, w: 1000, h: 320, fill: '#7c5cff', gain: 1 });
    case 'group':
    default:
      return base;
  }
}

/* ============================================================
   场景树
   ============================================================ */
export class SceneTree {
  constructor(opts = {}) {
    this.root = opts.root || new SceneNode({ name: '场景 1', type: 'group' });
    this.masters = new Map();          // 复用的主节点（模板/组件）
  }

  /* ---------- 查询 ---------- */
  find(id, node = this.root) {
    if (node === null || node === undefined) return null;
    if (typeof id === 'object') return id;               // 直接传节点
    if (node.id === id) return node;
    for (const c of node.children) {
      const r = this.find(id, c);
      if (r) return r;
    }
    return null;
  }

  pathOf(id, node = this.root, trail = []) {
    if (node.id === id) return trail;
    for (let i = 0; i < node.children.length; i++) {
      const r = this.pathOf(id, node.children[i], trail.concat([{ node, index: i }]));
      if (r) return r;
    }
    return null;
  }

  parentOf(id, node = this.root) {
    if (node.children.some(c => c.id === id)) return node;
    for (const c of node.children) {
      const r = this.parentOf(id, c);
      if (r) return r;
    }
    return null;
  }

  all(node = this.root, out = []) {
    out.push(node);
    for (const c of node.children) this.all(c, out);
    return out;
  }

  get duration() {
    let m = 0;
    for (const n of this.all()) {
      if (n.visible === false) continue;
      if (n.type === 'subtitle') {
        // 字幕节点时长取决于字幕轨
        m = Math.max(m, n.duration || 0);
      }
    }
    return m;
  }

  /* ---------- 变更 ---------- */
  /** 加一个子节点；返回该节点的 id */
  add(node, parentId = null) {
    const parent = parentId ? this.find(parentId) : this.root;
    if (!parent) throw new Error('找不到父节点 ' + parentId);
    if (!parent.isGroup && node.type !== 'group') {
      // 非组节点不能有子节点 → 先把它包进一个新组，再挂进去
      return this.add(node, this.autoGroup(parent));
    }
    parent.children.push(node);
    return node.id;
  }

  /** 把某个节点包进一个新组；返回新组的 id
   （不原地升级 —— 那样会把原节点的类型与属性都毁掉） */
  autoGroup(node) {
    if (node.isGroup) return node.id;
    const p = this.parentOf(node.id);
    if (!p) throw new Error('节点不在树中');
    const idx = p.children.indexOf(node);

    const g = new SceneNode({
      name: node.name + ' 组',
      type: 'group',
      opacity: node.opacity,
      props: Object.assign({}, defaultProps('group'), { x: node.props.x, y: node.props.y }),
    });
    // 新组插到原位置，原节点挪进去
    p.children.splice(idx, 0, g);
    p.children.splice(p.children.indexOf(node), 1);
    g.children.push(node);
    return g.id;
  }

  /** 编组多个选中节点 */
  groupMany(ids, name = '组') {
    const list = (ids || []).map(i => this.find(i)).filter(Boolean);
    if (list.length < 1) return null;
    if (list.length === 1) return this.autoGroup(list[0]);
    // 只能在同一父级下编组
    const parent = this.parentOf(list[0].id);
    if (!parent || list.some(n => this.parentOf(n.id) !== parent)) return null;
    const g = new SceneNode({ name, type: 'group' });
    parent.children.unshift(g);
    for (const n of list) {
      parent.children.splice(parent.children.indexOf(n), 1);
      g.children.push(n);
    }
    return g.id;
  }

  remove(id) {
    const p = this.parentOf(id);
    if (!p) return false;
    const i = p.children.indexOf(this.find(id));
    if (i < 0) return false;
    p.children.splice(i, 1);
    return true;
  }

  move(id, newParentId, index = -1) {
    const node = this.find(id);
    if (!node) return false;
    // 不能移进自己的子树
    if (this.all(node).some(n => n.id === newParentId)) return false;
    const oldParent = this.parentOf(id);
    if (!oldParent) return false;
    const oi = oldParent.children.indexOf(node);
    oldParent.children.splice(oi, 1);
    const np = this.find(newParentId);
    if (!np) { oldParent.children.splice(oi, 0, node); return false; }
    if (!np.isGroup) { np.isGroup = true; }
    if (index < 0 || index > np.children.length) np.children.push(node);
    else np.children.splice(index, 0, node);
    return true;
  }

  reorder(id, delta) {
    const node = this.find(id);
    const p = this.parentOf(id);
    if (!node || !p) return false;
    const i = p.children.indexOf(node);
    const j = i + delta;
    if (j < 0 || j >= p.children.length) return false;
    p.children.splice(i, 1);
    p.children.splice(j, 0, node);
    return true;
  }

  duplicate(id) {
    const node = this.find(id);
    if (!node) return null;
    const copy = cloneNode(node, true);
    const p = this.parentOf(id);
    const i = p.children.indexOf(node);
    p.children.splice(i + 1, 0, copy);
    return copy;
  }

  /* ---------- 复用实例（P0-G 关键能力） ---------- */
  /** 登记为主组件；node 可以是节点对象或 id */
  registerMaster(node, name) {
    const n = typeof node === 'string' ? this.find(node) : node;
    if (!n) throw new Error('找不到要登记为组件的节点');
    const m = cloneNode(n, true);
    this.masters.set(m.id, m);
    if (name) m.name = name;
    return m;
  }

  /** 创建一个引用 master 的实例 */
  instantiate(masterId, overrides = {}) {
    const m = this.masters.get(masterId);
    if (!m) throw new Error('找不到 master ' + masterId);
    const inst = cloneNode(m, true);
    inst.masterId = masterId;
    inst.name = overrides.name || (m.name + ' 实例');
    // 只记录「显式覆盖」的键，resolve 时才知道该覆盖哪些
    inst.overrides = Object.assign({}, overrides.props || {});
    Object.assign(inst.props, inst.overrides);
    this.root.children.push(inst);
    return inst;
  }

  /** 展开所有实例（渲染前调用；master 改动自动反映到实例） */
  resolve(node = this.root, out = []) {
    if (node.masterId) {
      const m = this.masters.get(node.masterId);
      if (m) {
        const inst = cloneNode(m, true);
        inst.id = node.id;
        inst.masterId = node.masterId;
        inst.name = node.name;
        // 只有显式覆盖过的键才盖住 master 的值
        const ov = node.overrides || {};
        for (const k of Object.keys(ov)) inst.props[k] = ov[k];
        inst.opacity = node.opacity;
        inst.visible = node.visible;
        inst.blend = node.blend;
        inst.mask = node.mask;
        inst.children = node.children;
        out.push(inst);
        return out;
      }
    }
    out.push(node);
    for (const c of node.children) this.resolve(c, out);
    return out;
  }

  /**
   * 渲染顺序（自底向上；组按 children 顺序）
   *
   * 注意：这里**不过滤 visible / opacity**。
   * IR 里的 visible 只是「第 0 帧的初始状态」—— 很多图层是靠积木在
   * 动画里才出现的（模板里就是这样）。若在这里过滤会把它们整个丢掉，
   * 场景树就再也无法用于编辑了。可见性/透明度只在渲染时逐帧决定。
   */
  flatRenderList(opts = {}) {
    const respectVisibility = opts.respectVisibility === true;
    const list = [];
    const walk = (node, parentVisible, parentOpacity) => {
      const visible = respectVisibility ? node.visible : true;
      if (!visible) return;
      const op = respectVisibility
        ? parentOpacity * (node.opacity == null ? 1 : node.opacity)
        : parentOpacity;
      if (op <= 0.001) return;
      if (node.isGroup) {
        for (const c of node.children) walk(c, visible && node.visible, op);
      } else {
        list.push({ node, opacity: op, visible: node.visible, inherited: parentOpacity !== 1 });
      }
    };
    walk(this.root, true, 1);
    return list;
  }

  /**
 * 用 IR 的扁平图层重建树，但**保留已登记的 master**。
 * 用于「外部改了 App.ir.layers 之后」把场景树拉回同步。
 */
  syncFromLayers(layers) {
    const masters = this.masters;
    const rebuilt = SceneTree.fromLayers(layers);
    this.root = rebuilt.root;
    this.masters = masters;
    return this;
  }

  /** 序列化 */
  toJSON() {
    return {
      root: nodeToJSON(this.root),
      masters: [...this.masters.values()].map(nodeToJSON),
    };
  }

  static fromJSON(j) {
    const t = new SceneTree({ root: nodeFromJSON(j.root) });
    for (const m of (j.masters || [])) t.masters.set(m.id, nodeFromJSON(m));
    return t;
  }

  /** 从旧的扁平图层列表迁移（V0 IR → 场景树） */
  static fromLayers(layers) {
    const tree = new SceneTree();
    tree.root.children = layers.map(l => {
      const type = LAYER_TYPE_MAP[l.type] || 'rect';
      const n = new SceneNode({
        // **沿用原图层 id** —— 否则 IR 与场景树就对不上号了
        id: l.id,
        name: l.name, type,
        // IR 里没有 visible 字段 = 可见；只有显式 false 才隐藏
        visible: l.visible !== false,
        locked: !!l.locked,
        props: Object.assign({}, l.props),
        blocks: l.blocks || [],
      });
      return n;
    });
    return tree;
  }

  /**
   * 导出回扁平图层列表（保持与旧渲染管线兼容）
   * visible 保持节点自身的值（用户手动隐藏要保留），
   * 但**不叠加**组的隐藏 —— 那是渲染时逐帧的事。
   */
  toLayers() {
    return this.flatRenderList().map(({ node, opacity }) => ({
      id: node.id,
      name: node.name,
      type: LAYER_TYPE_INV[node.type] || 'rect',
      visible: node.visible,
      locked: node.locked,
      props: Object.assign({}, node.props),
      blocks: node.blocks,
    }));
  }
}

const LAYER_TYPE_MAP = { text: 'text', rect: 'rect', circle: 'ellipse', image: 'image' };
const LAYER_TYPE_INV = { text: 'text', rect: 'rect', ellipse: 'circle', image: 'image' };

/* ---------- 深拷贝
   freshIds=true 时所有节点都重新分配 id（复制/实例化用）；
   解析 JSON 时传 false 以保留原 id。 ---------- */
export function cloneNode(node, freshIds = true) {
  const c = new SceneNode({
    id: freshIds ? uid('N') : node.id,
    name: node.name, type: node.type,
    visible: node.visible, locked: node.locked,
    masterId: node.masterId,
    props: Object.assign({}, node.props),
    blend: node.blend,
    mask: node.mask ? Object.assign({}, node.mask) : null,
    opacity: node.opacity,
    blocks: JSON.parse(JSON.stringify(node.blocks || [])),
    exposed: (node.exposed || []).map(e => Object.assign({}, e)),
  });
  c.children = node.children.map(ch => cloneNode(ch, freshIds));
  return c;
}

function nodeToJSON(n) {
  return {
    id: n.id, name: n.name, type: n.type, visible: n.visible, locked: n.locked,
    masterId: n.masterId, props: n.props, blend: n.blend, mask: n.mask,
    opacity: n.opacity, blocks: n.blocks, exposed: n.exposed,
    children: n.children.map(nodeToJSON),
  };
}

function nodeFromJSON(j) {
  const n = new SceneNode({
    id: j.id, name: j.name, type: j.type, visible: j.visible, locked: j.locked,
    masterId: j.masterId, props: j.props, blend: j.blend, mask: j.mask,
    opacity: j.opacity, blocks: j.blocks || [], exposed: j.exposed || [],
  });
  n.children = (j.children || []).map(nodeFromJSON);
  return n;
}

export { newLayer };