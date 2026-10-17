/* ============================================================
   collab.js · 协作与版本管理（V4）
   ------------------------------------------------------------
   规划 V4：「协作与版本管理」

   没有服务端，所以这一层做的是**协作的基础设施**而不是多人同步：
     · 版本：每次改动一个可回溯的快照，带说明与差异摘要
     · 分支：从任意版本派生，互不干扰（做 A/B 方案对比）
     · 合并：三方合并（base / ours / theirs），冲突逐块列出
     · 标签：给重要版本起名字（v1.0、大促版…）
     · 导出补丁：可读文本，能贴给同事或存进 issue

   之所以先做这一层：真正的多人实时同步（CRDT/OT）是另一回事，
   但「分支 + 三方合并」已经能覆盖 90% 的创作协作场景
   （比如「你出文案分支，我出动画分支，最后合并」）。
   ============================================================ */

import { clone, uid, toText, fromText, defaultProject } from './ir.js';
import { BLOCK_DEFS, metaFor } from './blocks.js';
import { registerOpMeta } from './ir.js';

// fromText 需要积木元数据才能把 @ op 还原成槽位
const OP_META = BLOCK_DEFS.map(d => metaFor(d.op)).filter(Boolean);

/* ============================================================
   版本
   ============================================================ */
export class Revision {
  constructor(opts = {}) {
    this.id = opts.id || uid('R');
    this.parent = opts.parent || null;
    this.branch = opts.branch || 'main';
    this.message = opts.message || '';
    this.author = opts.author || '匿名';
    this.createdAt = opts.createdAt || new Date().toISOString();
    this.ir = opts.ir || null;              // 完整快照（简单可靠）
    this.tags = opts.tags || [];
    this.tagNotes = opts.tagNotes || {};
    this.stats = opts.stats || diffStats(opts.ir, opts.parentIr);
  }

  get shortHash() { return this.id.slice(-7); }

  toJSON() {
    return {
      id: this.id, parent: this.parent, branch: this.branch,
      message: this.message, author: this.author, createdAt: this.createdAt,
      tags: this.tags, tagNotes: this.tagNotes, stats: this.stats,
      // 存成缩进式文本而不是 JSON —— 体积小、diff 友好、跨版本更稳
      text: toText(this.ir),
    };
  }

  static fromJSON(j) {
    let ir = j.ir || null;
    if (!ir && j.text) {
      try {
        const r = fromText(j.text, OP_META);
        // fromText 返回 { ir, notes }
        ir = (r && r.ir) || r || null;
      } catch { ir = null; }
    }
    const r = new Revision(Object.assign({}, j, { ir }));
    r.tags = j.tags || [];
    r.tagNotes = j.tagNotes || {};
    return r;
  }
}

/* ============================================================
   版本库
   ============================================================ */
export class Repo {
  constructor(opts = {}) {
    this.revisions = opts.revisions || [];
    this.branches = opts.branches || { main: null };  // name → head revision id
    this.currentBranch = opts.currentBranch || 'main';
    this.current = opts.current || null;
    this.mergeBases = new Map();               // `${a}...${b}` → 共同祖先 id
  }

  /** 首次提交 */
  init(ir, opts = {}) {
    const r = new Revision({ ir: clone(ir), message: opts.message || '初始版本', author: opts.author });
    this.revisions.push(r);
    this.branches[this.currentBranch] = r.id;
    this.current = r;
    return r;
  }

  /** 提交一次改动 */
  commit(ir, message, opts = {}) {
    const branch = opts.branch || this.currentBranch;
    const head = this.head(branch);
    if (!head) return this.init(ir, { message, author: opts.author });
    const r = new Revision({
      ir: clone(ir), parent: head, branch,
      message: message || '未命名改动',
      author: opts.author || '匿名',
    });
    this.revisions.push(r);
    this.branches[branch] = r.id;
    if (branch === this.currentBranch) this.current = r;
    return r;
  }

  head(branch) { return this.branches[branch] || null; }

  get(id) { return this.revisions.find(r => r.id === id) || null; }

  /** 某个分支上的历史（从新到旧） */
  log(branch) {
    const b = branch || this.currentBranch;
    const out = [];
    let id = this.head(b);
    const seen = new Set();
    while (id && !seen.has(id)) {
      seen.add(id);
      const r = this.get(id);
      if (!r) break;
      out.push(r);
      id = r.parent;
    }
    return out;
  }

  /** 分支名列表 */
  listBranches() { return Object.keys(this.branches); }

  /* ---------- 分支 ---------- */
  branch_(name, fromBranch) {
    if (this.branches[name]) throw new Error(`分支 ${name} 已存在`);
    const base = this.head(fromBranch || this.currentBranch);
    if (!base) throw new Error('还没有任何提交');
    this.branches[name] = base;
    return name;
  }

  checkout(name) {
    if (!this.branches[name]) throw new Error(`分支 ${name} 不存在`);
    this.currentBranch = name;
    const h = this.get(this.branches[name]);
    if (h) this.current = h;
    return h;
  }

  deleteBranch(name) {
    if (name === 'main') throw new Error('不能删主干');
    if (!this.branches[name]) return false;
    delete this.branches[name];
    return true;
  }

  /* ---------- 标签 ---------- */
  tag(name, revisionId, note) {
    const r = this.get(revisionId || (this.current && this.current.id));
    if (!r) throw new Error('找不到目标版本');
    if (r.tags.includes(name)) return r;
    r.tags.push(name);
    r.tagNotes = r.tagNotes || {};
    r.tagNotes[name] = note || '';
    return r;
  }

  removeTag(name) {
    for (const r of this.revisions) {
      const i = r.tags.indexOf(name);
      if (i >= 0) {
        r.tags.splice(i, 1);
        if (r.tagNotes) delete r.tagNotes[name];
        return true;
      }
    }
    return false;
  }

  byTag(name) { return this.revisions.find(r => r.tags.includes(name)) || null; }

  /* ---------- 回滚 ---------- */
  /**
   * 回滚 = 以目标版本为内容，往当前分支追加一个新提交。
   * 不改历史（不可变），这样版本链始终可信。
   */
  revert(revisionId, message) {
    const target = this.get(revisionId);
    if (!target) throw new Error('找不到要回滚的版本');
    return this.commit(target.ir, message || `回滚到 ${target.shortHash}：${target.message}`, { author: target.author });
  }

  /* ---------- 共同祖先 ---------- */
  base(aId, bId) {
    const key = `${aId}...${bId}`;
    if (this.mergeBases.has(key)) return this.get(this.mergeBases.get(key));
    const ancestors = (id) => {
      const set = new Set();
      let cur = this.get(id);
      while (cur) { set.add(cur.id); cur = this.get(cur.parent); }
      return set;
    };
    const A = ancestors(aId), B = ancestors(bId);
    // 从 ours 一路往上走，第一个也在 B 里的就是最近共同祖先
    let cur = this.get(aId);
    while (cur && !B.has(cur.id)) cur = this.get(cur.parent);
    if (cur) this.mergeBases.set(key, cur.id);
    return cur || null;
  }

  /* ---------- 合并 ---------- */
  /**
   * 三方合并。
   * 逐图层、逐图层内的顶层积木做对比：
   *   两边都没改 → 取 ours
   *   只有一边改 → 取改的那边
   *   两边改成一样 → 都行
   *   两边改得不同 → **冲突**，以 ours 为准并记录
   * 冲突绝不静默丢弃。
   */
  merge(branchName, opts = {}) {
    const theirsId = this.branches[branchName];
    if (!theirsId) throw new Error(`分支 ${branchName} 不存在`);
    const oursId = this.branches[this.currentBranch];
    const baseRev = this.base(oursId, theirsId);
    const ours = this.get(oursId);
    const theirs = this.get(theirsId);
    if (!ours || !theirs) throw new Error('版本链异常');

    const base = baseRev ? baseRev.ir : defaultProject('base');
    const merged = clone(ours.ir);
    const conflicts = [];
    const taken = [];

    const baseLayers = new Map((base.layers || []).map(l => [l.id, l]));
    const oursLayers = new Map((ours.ir.layers || []).map(l => [l.id, l]));
    const theirsLayers = new Map((theirs.ir.layers || []).map(l => [l.id, l]));

    // theirs 里的新图层
    for (const [id, l] of theirsLayers) {
      if (oursLayers.has(id)) continue;
      if (!baseLayers.has(id)) {
        merged.layers.push(clone(l));          // 两边各自新增且 id 不撞 → 直接进
        taken.push({ kind: 'layerAdded', layerId: id, name: l.name });
      } else {
        // base 里有、ours 里没有 → 是我方删掉的这个图层
        // （theirs 也删了的话它根本不在 theirsLayers 里，进不到这里）
        const bl = baseLayers.get(id);
        if (sameLayer(bl, l)) {
          taken.push({ kind: 'layerDeleted', layerId: id, name: l.name });   // 对方没动过 → 尊重我方的删除
        } else {
          // 对方改过它。原实现这一支什么都不做，而 merged 是 ours 的副本（已无此图层），
          // 对方的改动就被静默丢了。这里与「对方删我改」对称化，交给用户决定。
          conflicts.push({
            kind: 'deleteVsEdit', layerId: id, name: l.name,
            msg: `「${l.name}」在本地被删除，但对方分支改过（对方的改动会随删除一起丢掉）`,
          });
        }
      }
    }

    for (const [id, ol] of oursLayers) {
      const tl = theirsLayers.get(id);
      const bl = baseLayers.get(id);

      if (!tl) {
        // theirs 删了：ours 没改就跟着删，改了就当冲突
        if (!bl || sameLayer(bl, ol)) {
          merged.layers = merged.layers.filter(x => x.id !== id);
          taken.push({ kind: 'layerDeleted', layerId: id, name: ol.name });
        } else {
          conflicts.push({ kind: 'deleteVsEdit', layerId: id, name: ol.name, msg: `「${ol.name}」在对方分支被删除，但你在本地改过` });
        }
        continue;
      }

      const res = mergeLayer(bl, ol, tl);
      if (res.conflicts.length) conflicts.push(...res.conflicts.map(c => Object.assign({ layerId: id, name: ol.name }, c)));
      taken.push(...res.taken.map(c => Object.assign({ layerId: id, name: ol.name }, c)));

      // 把合并结果写回去
      const target = merged.layers.find(x => x.id === id);
      if (target) {
        target.blocks = res.blocks;
        target.props = res.props;
        target.visible = res.visible;
        // 图层自身的字段（name / locked / type …）也要参与合并。
        // 原实现只写回 blocks/props/visible，改名或改锁定会被静默丢掉。
        const lf = mergeScalars(bl, ol, tl, {
          label: `图层「${ol.name}」`, kind: 'layerFieldConflict',
          skip: ['id', 'blocks', 'props'],
        }, conflicts);
        for (const k of Object.keys(lf)) if (k !== 'id') target[k] = lf[k];
      }
    }

    // 标记点 / 变量：原实现从头到尾没有比较过它们，对方的改动静默消失
    const mk = mergeIdList(base.markers, ours.ir.markers, theirs.ir.markers, {
      unit: '标记点', kind: 'marker', nameOf: (m) => m && m.label,
    });
    merged.markers = mk.value;
    conflicts.push(...mk.conflicts);
    taken.push(...mk.taken);

    const vr = mergeIdList(base.variables, ours.ir.variables, theirs.ir.variables, {
      unit: '变量', kind: 'var', nameOf: (v) => v && v.name,
    });
    merged.variables = vr.value;
    conflicts.push(...vr.conflicts);
    taken.push(...vr.taken);

    // 项目级属性
    const projRes = mergeProject(base.project, ours.ir.project, theirs.ir.project);
    merged.project = projRes.value;
    conflicts.push(...projRes.conflicts);
    taken.push(...projRes.taken);

    // 顶层兜底：上面显式处理过的 key 之外，遍历两侧并集，不同即冲突。
    // 这样将来 IR 新增顶层字段时不会再静默丢改动。
    const HANDLED = ['layers', 'markers', 'variables', 'project'];
    const topRes = mergeScalars(
      pick(base, HANDLED), pick(ours.ir, HANDLED), pick(theirs.ir, HANDLED),
      { label: '工程', kind: 'topLevelConflict' }, conflicts);
    // version 之类的元数据：只有一边改就采用，不必惊动用户
    for (const k of Object.keys(topRes)) {
      merged[k] = topRes[k];
    }

    if (conflicts.length && !opts.force) {
      return { ok: false, conflicts, taken, merged: null };
    }

    const rev = this.commit(merged, opts.message || `合并分支 ${branchName} 到 ${this.currentBranch}`, {
      author: opts.author,
    });
    return { ok: true, conflicts, taken, revision: rev, merged };
  }

  /** 对比两个版本，产出人类可读的摘要 */
  diff(aId, bId) {
    const A = this.get(aId), B = this.get(bId);
    if (!A || !B) throw new Error('版本不存在');
    return diffIR(A.ir, B.ir, A, B);
  }

  /** 生成可读的补丁文本（能贴进 issue / PR） */
  patch(aId, bId) {
    const d = this.diff(aId, bId);
    const lines = [];
    lines.push(`# ${aId.slice(-7)} → ${bId.slice(-7)}`);
    lines.push('');
    lines.push(`- 新增图层：${d.added.map(l => l.name).join('、') || '无'}`);
    lines.push(`- 删除图层：${d.removed.map(l => l.name).join('、') || '无'}`);
    lines.push(`- 修改图层：${d.changed.map(l => l.name).join('、') || '无'}`);
    if (d.project.length) {
      lines.push('');
      lines.push('## 项目设置变更');
      for (const p of d.project) lines.push(`- ${p.key}: ${p.from} → ${p.to}`);
    }
    if (d.blockChanges.length) {
      lines.push('');
      lines.push('## 积木变更');
      for (const b of d.blockChanges) lines.push(`- [${b.layer}] ${b.msg}`);
    }
    return lines.join('\n');
  }

  /* ---------- 导入导出 ---------- */
  toJSON() {
    return {
      format: 'block-anim-repo/1',
      revisions: this.revisions.map(r => r.toJSON()),
      branches: this.branches,
      currentBranch: this.currentBranch,
    };
  }

  static fromJSON(j) {
    if (j.format !== 'block-anim-repo/1') throw new Error('不支持的版本库格式');
    const repo = new Repo();
    repo.revisions = j.revisions.map(Revision.fromJSON);
    repo.branches = j.branches || { main: null };
    repo.currentBranch = j.currentBranch || 'main';
    const h = repo.get(repo.branches[repo.currentBranch]);
    repo.current = h || null;
    return repo;
  }
}

/* ============================================================
   差异计算
   ============================================================ */

/** 顶层积木的可读签名（用来判断「改了什么」） */
function blockSig(b) {
  if (!b) return '';
  const slotStr = (b.slots || []).map(s => {
    const v = s.value;
    if (Array.isArray(v)) return `[${v.length}块]`;
    if (v && typeof v === 'object' && v.k === 'lit') return `${v.t}:${JSON.stringify(v.v)}`;
    if (v && typeof v === 'object' && v.k === 'blk') return `expr:${v.op}`;
    return String(v);
  }).join('|');
  return `${b.op}(${slotStr})`;
}

function layerBlockSigs(layer) {
  return (layer.blocks || []).map(blockSig);
}

/** 顶层积木序列的三方合并 */
function mergeLayer(base, ours, theirs) {
  const conflicts = [];
  const taken = [];
  if (!base) {
    // 基线里没有这个图层：两边都是新增。层内不做细粒度合并，取 ours。
    if (!sameLayerSig(ours, theirs)) {
      conflicts.push({ kind: 'bothAddedLayer', msg: `图层「${ours.name}」两边都新增且内容不同` });
    } else {
      taken.push({ kind: 'layerAdded', msg: '两边新增了同样的图层' });
    }
    return { blocks: clone(ours.blocks || []), props: clone(ours.props || {}), visible: ours.visible, conflicts, taken };
  }

  // 属性
  const props = mergeObject(base.props || {}, ours.props || {}, theirs.props || {}, '图层「' + ours.name + '」的属性', conflicts);

  // 积木：按 op 序列做最小化合并
  const B = layerBlockSigs(base);
  const O = layerBlockSigs(ours);
  const T = layerBlockSigs(theirs);
  const blocks = clone(ours.blocks || []);

  if (B.join('\0') === O.join('\0')) {
    // ours 没改 → 整体取 theirs
    taken.push({ kind: 'blocksTheirs', msg: `「${ours.name}」的积木在对方分支被修改，已采用对方版本` });
    return { blocks: clone(theirs.blocks || []), props, visible: theirs.visible, conflicts, taken };
  }
  if (B.join('\0') === T.join('\0')) {
    // theirs 没改 → 保留 ours
    taken.push({ kind: 'blocksKept', msg: `「${ours.name}」的积木只有你改过，已保留你的版本` });
    return { blocks, props, visible: ours.visible, conflicts, taken };
  }
  if (O.join('\0') === T.join('\0')) {
    taken.push({ kind: 'blocksSame', msg: `「${ours.name}」两边改成了同样内容` });
    return { blocks, props, visible: ours.visible, conflicts, taken };
  }

  // 两边都改了且不同 → 逐块尽力合并：找两边新增的块
  const merged = tryMergeBlocks(B, O, T, base, ours, theirs, conflicts, ours.name);
  return { blocks: merged, props, visible: ours.visible, conflicts, taken };
}

function tryMergeBlocks(B, O, T, base, ours, theirs, conflicts, layerName) {
  // 以 ours 为基，把 theirs 独有且 ours 没有的块追加到末尾
  const out = clone(ours.blocks || []);
  const oursSet = new Set(O);
  const addedByThem = [];
  T.forEach((sig, i) => {
    if (oursSet.has(sig)) return;
    // theirs 新增的：base 里没有才算是「新增」
    const baseHas = B.includes(sig);
    if (!baseHas) addedByThem.push(i);
  });

  if (addedByThem.length) {
    // 只追加确定新增的（末尾连续的一段），中间的差异算冲突
    const tail = contiguousTail(addedByThem, T.length);
    if (tail.length) {
      for (const i of tail) out.push(clone(theirs.blocks[i]));
      conflicts.push({
        kind: 'blocksBothEdited',
        msg: `图层「${layerName}」两边都改了积木：已自动保留你的全部块，并追加对方新增的 ${tail.length} 个；请人工核对`,
        autoMerged: tail.length,
      });
    }
  }

  // 把 ours 相对 base 的修改数也算一下，判断到底有多乱
  const ourChanged = countChanged(B, O);
  const theirChanged = countChanged(B, T);
  if (ourChanged > 0 && theirChanged > 0 && !addedByThem.length) {
    conflicts.push({
      kind: 'blocksConflict',
      msg: `图层「${layerName}」两边都改了积木且无法自动合并（你改了 ${ourChanged} 处，对方改了 ${theirChanged} 处），已保留你的版本`,
      ourChanged, theirChanged,
    });
  }
  void base;
  return out;
}

function contiguousTail(sorted, len) {
  if (!sorted.length) return [];
  const tail = [sorted[sorted.length - 1]];
  for (let i = sorted.length - 2; i >= 0; i--) {
    if (sorted[i] === tail[0] - 1) tail.unshift(sorted[i]);
    else break;
  }
  return tail;
}

function countChanged(a, b) {
  let n = 0;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) if (a[i] !== b[i]) n++;
  return n;
}

/**
 * 三方合并一个普通对象（逐 key）。
 * opts.kind     冲突种类，默认 propConflict（图层属性沿用）
 * opts.keyLabel 生成 key 的可读名，默认「<label>的「<key>」」
 * opts.fmt      值格式化，默认 JSON.stringify
 */
function mergeObject(base, ours, theirs, label, conflicts, opts = {}) {
  const out = Object.assign({}, ours);
  const kind = opts.kind || 'propConflict';
  const keyLabel = opts.keyLabel || ((k) => `${label}的「${k}」`);
  const fmt = opts.fmt || ((v) => JSON.stringify(v));
  for (const k of Object.keys(theirs)) {
    const bv = base[k], ov = ours[k], tv = theirs[k];
    if (JSON.stringify(ov) === JSON.stringify(tv)) continue;       // 改成了同一个值
    if (JSON.stringify(bv) === JSON.stringify(ov)) { out[k] = tv; continue; }  // 只有对方改
    if (JSON.stringify(bv) === JSON.stringify(tv)) continue;                     // 只有我改
    conflicts.push({ kind, msg: `${keyLabel(k)}两边改成了不同的值：你是 ${fmt(ov)}，对方是 ${fmt(tv)}` });
  }
  return out;
}

/** 把值压短，用于冲突提示（大对象整个塞进提示里没法看） */
function brief(v) {
  const s = JSON.stringify(v);
  if (s === undefined) return '未设置';
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

function hasOwn(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

/** 取出一组 key（不含 skip 里的），用于「显式处理过的字段」之外的兜底比对 */
function pick(o, skip) {
  const out = {};
  for (const k of Object.keys(o || {})) if (skip.indexOf(k) < 0) out[k] = o[k];
  return out;
}

/**
 * 单值三方取舍（含「这个字段在不在」也算改动的一部分）。
 *   两边一样            → 通过
 *   只有对方改          → 采用对方
 *   只有我改            → 保留我的
 *   两边改得不同        → 记一条冲突，保留我的
 */
function pickThree(bh, bv, oh, ov, th, tv, label, kind, fmt, conflicts) {
  const eq = (pa, va, pb, vb) => pa === pb && JSON.stringify(va) === JSON.stringify(vb);
  if (eq(th, tv, oh, ov)) return { has: oh, val: ov };      // 改成了同一个值
  if (eq(bh, bv, oh, ov)) return { has: th, val: tv };      // 只有对方改
  if (eq(bh, bv, th, tv)) return { has: oh, val: ov };      // 只有我改
  conflicts.push({ kind, msg: `${label}两边改成了不同的值：你是 ${fmt(ov)}，对方是 ${fmt(tv)}` });
  return { has: oh, val: ov };
}

/**
 * 三方合并一组标量字段（遍历两侧 key 的并集，字段增删也算改动）。
 * 用于图层自身的字段（name / visible / locked / type …）与顶层兜底字段。
 */
function mergeScalars(base, ours, theirs, cfg, conflicts) {
  const label = cfg.label, kind = cfg.kind, fmt = cfg.fmt || brief, skip = cfg.skip || [];
  const out = clone(ours || {});
  const keys = new Set([...Object.keys(ours || {}), ...Object.keys(theirs || {})]);
  for (const k of keys) {
    if (skip.indexOf(k) >= 0) continue;
    const res = pickThree(
      hasOwn(base, k), (base || {})[k],
      hasOwn(ours, k), (ours || {})[k],
      hasOwn(theirs, k), (theirs || {})[k],
      `${label}的「${k}」`, kind, fmt, conflicts);
    if (res.has) out[k] = res.val; else delete out[k];
  }
  return out;
}

/**
 * 按 id 做三方合并（标记点 / 变量共用）。
 *
 * 为什么需要它：merge() 原先只比对 layers 与 project，markers / variables
 * 从头到尾没有被比较过一次 —— 它们在 merged = clone(ours.ir) 里原样保留，
 * 于是「对方改了标记点 / 变量」的结果是 ok=true、无冲突、对方的改动静默消失。
 *
 * 规则与 layers 完全一致：
 *   只有一边改 → 自动采用改的那边（不打扰用户）
 *   两边改成一样 → 通过
 *   两边改得不同 → 冲突（merge 默认遇冲突不提交，交给用户决定）
 *   一边删一边改 → deleteVsEdit 冲突（两侧对称，任何一侧都不静默丢改动）
 */
function mergeIdList(baseArr, oursArr, theirsArr, cfg) {
  const unit = cfg.unit, kind = cfg.kind, nameOf = cfg.nameOf, fmt = cfg.fmt || brief;
  const conflicts = [], taken = [];
  const byId = (arr) => new Map((arr || []).filter(x => x && x.id != null).map(x => [x.id, x]));
  const B = byId(baseArr), O = byId(oursArr), T = byId(theirsArr);

  // 输出顺序：先按 ours、再补 theirs 新增的，最后是只在 base 里出现过的
  const order = [];
  for (const arr of [oursArr, theirsArr]) {
    for (const x of arr || []) if (x && x.id != null && order.indexOf(x.id) < 0) order.push(x.id);
  }
  for (const id of B.keys()) if (order.indexOf(id) < 0) order.push(id);

  const out = [];
  for (const id of order) {
    const b = B.get(id), o = O.get(id), t = T.get(id);
    const nm = (nameOf && nameOf(o || t || b)) || id;
    const L = `${unit}「${nm}」`;
    const push = (c) => conflicts.push(Object.assign({ id, name: nm }, c));

    // 基线里没有 → 两边各自新增
    if (!b) {
      if (o && t) {
        if (JSON.stringify(o) === JSON.stringify(t)) {
          taken.push({ kind: `${kind}Same`, id, name: nm, msg: `${L}两边新增了相同内容` });
        } else {
          push({ kind: `${kind}BothAdded`, msg: `${L}两边都新增了同一个${unit}但内容不同：你是 ${fmt(o)}，对方是 ${fmt(t)}` });
        }
        out.push(clone(o));
      } else if (t) {
        out.push(clone(t));
        taken.push({ kind: `${kind}Added`, id, name: nm, msg: `采用了对方新增的${L}` });
      } else if (o) {
        out.push(clone(o));
      }
      continue;
    }

    // 对方删了
    if (!t) {
      if (!o) continue;                                   // 两边都删，什么都不做
      if (JSON.stringify(b) === JSON.stringify(o)) {
        taken.push({ kind: `${kind}Deleted`, id, name: nm, msg: `${L}被对方删除，你未改动，已一并删除` });
      } else {
        push({ kind: 'deleteVsEdit', msg: `${L}在对方分支被删除，但你在本地改过` });
        out.push(clone(o));
      }
      continue;
    }

    // 我删了、对方还在
    if (!o) {
      if (JSON.stringify(b) === JSON.stringify(t)) {
        taken.push({ kind: `${kind}Deleted`, id, name: nm, msg: `${L}被你在本地删除，对方未改动，已删除` });
      } else {
        // 原实现这一支什么都不做 → 对方的改动静默消失；与上面「对方删我改」对称化
        push({ kind: 'deleteVsEdit', msg: `${L}在本地被删除，但对方分支改过（对方的改动会随删除一起丢掉）` });
      }
      continue;
    }

    // 三方都在，且两边都改了 → 逐字段定位到底哪一项冲突
    if (JSON.stringify(o) === JSON.stringify(t)) { out.push(clone(o)); continue; }
    if (JSON.stringify(b) === JSON.stringify(o)) {
      out.push(clone(t));
      taken.push({ kind: `${kind}Theirs`, id, name: nm, msg: `${L}只有对方改过，已采用对方版本` });
      continue;
    }
    if (JSON.stringify(b) === JSON.stringify(t)) { out.push(clone(o)); continue; }
    const fc = [];
    const merged = mergeScalars(b, o, t, { label: L, kind: `${kind}Conflict`, fmt, skip: ['id'] }, fc);
    for (const c of fc) push(c);
    out.push(merged);
  }

  return { value: out, conflicts, taken };
}

function mergeProject(base, ours, theirs) {
  const conflicts = [];
  const taken = [];
  const value = mergeObject(base || {}, ours || {}, theirs || {}, '项目设置', conflicts);
  return { value, conflicts, taken };
}

function sameLayerSig(a, b) {
  return JSON.stringify(layerBlockSigs(a)) === JSON.stringify(layerBlockSigs(b))
    && JSON.stringify(a.props || {}) === JSON.stringify(b.props || {});
}
function sameLayer(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/** 整体差异摘要 */
export function diffIR(a, b, revA, revB) {
  const aLayers = new Map((a.layers || []).map(l => [l.id, l]));
  const bLayers = new Map((b.layers || []).map(l => [l.id, l]));
  const added = [], removed = [], changed = [], blockChanges = [];

  for (const [id, l] of bLayers) {
    if (!aLayers.has(id)) { added.push(l); continue; }
    const A = aLayers.get(id);
    const msg = [];
    if (JSON.stringify(A.props || {}) !== JSON.stringify(l.props || {})) {
      const keys = new Set([...Object.keys(A.props || {}), ...Object.keys(l.props || {})]);
      const pks = [...keys].filter(k => JSON.stringify((A.props || {})[k]) !== JSON.stringify((l.props || {})[k]));
      msg.push(`属性 ${pks.slice(0, 5).join('、')}${pks.length > 5 ? ' 等' : ''} 变了`);
    }
    const sa = layerBlockSigs(A), sb = layerBlockSigs(l);
    if (sa.join(' ') !== sb.join(' ')) {
      const add = sb.length - sa.length;
      msg.push(add > 0 ? `积木 +${add} 个` : add < 0 ? `积木 ${add} 个` : '积木被修改');
      const n = Math.min(sa.length, sb.length);
      for (let i = 0; i < n; i++) {
        if (sa[i] !== sb[i]) blockChanges.push({ layer: l.name, msg: `第 ${i + 1} 块：${shortOp(sa[i])} → ${shortOp(sb[i])}` });
      }
      for (let i = n; i < sb.length; i++) blockChanges.push({ layer: l.name, msg: `新增：${shortOp(sb[i])}` });
      for (let i = n; i < sa.length; i++) blockChanges.push({ layer: l.name, msg: `删除：${shortOp(sa[i])}` });
    }
    if (A.visible !== l.visible) msg.push(l.visible ? '图层被显示' : '图层被隐藏');
    if (msg.length) changed.push({ id, name: l.name, msg });
  }
  for (const [id, l] of aLayers) {
    if (!bLayers.has(id)) removed.push(l);
  }

  const project = [];
  const keys = new Set([...Object.keys(a.project || {}), ...Object.keys(b.project || {})]);
  for (const k of keys) {
    if (JSON.stringify((a.project || {})[k]) !== JSON.stringify((b.project || {})[k])) {
      project.push({ key: k, from: (a.project || {})[k], to: (b.project || {})[k] });
    }
  }

  void revA; void revB;
  return { added, removed, changed, blockChanges, project };
}

function shortOp(sig) {
  const m = String(sig).match(/^(\w+)/);
  return m ? m[1] : sig;
}

/** 提交时的统计（新增/修改了多少） */
export function diffStats(ir, parentIr) {
  if (!parentIr) {
    return { layers: (ir.layers || []).length, blocks: countBlocks(ir), added: (ir.layers || []).length, removed: 0 };
  }
  const d = diffIR(parentIr, ir);
  return {
    layers: (ir.layers || []).length,
    blocks: countBlocks(ir),
    added: d.added.length,
    removed: d.removed.length,
    changed: d.changed.length,
  };
}

function countBlocks(ir) {
  let n = 0;
  for (const l of ir.layers || []) {
    const walk = (list) => {
      for (const b of list || []) {
        n++;
        if (b.slots) for (const s of b.slots) if (Array.isArray(s.value)) walk(s.value);
      }
    };
    walk(l.blocks);
  }
  return n;
}