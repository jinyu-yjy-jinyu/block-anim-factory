/* ============================================================
   marketplace.js · 模板与社区（V4）
   ------------------------------------------------------------
   规划 I：
     · 官方模板库（口播字幕、数据榜单、知识科普、片头片尾、产品演示）
     · 一键 Remix：改参数即出片
     · 模板发布与分成、版本管理
     · 素材库：免版权字体、图标、音效、背景
   规划 V4：第三方作者能发布付费模板并产生交易

   设计要点：
     · 模板 = IR 快照 + 参数规格 + 元数据 + 版本历史
     · 发布/下架/评分/下载走一个本地 registry，可换成本地/远端后端
     · 分成记账只做「应结」明细，不碰真实资金
     · 版本是**不可变快照**，Remix 时锁定到具体版本 → 别人的模板不会被我改坏
   ============================================================ */

import { clone, uid, validate } from './ir.js';
import { ParamSet, ParamSpec, applyParams } from './batch.js';
import { expandCustomBlocks, CustomBlockLibrary } from './customblocks.js';

/* ============================================================
   模板
   ============================================================ */
export const TEMPLATE_CATEGORIES = [
  { key: 'official', label: '官方' },
  { key: 'speech', label: '口播字幕' },
  { key: 'data', label: '数据榜单' },
  { key: 'knowledge', label: '知识科普' },
  { key: 'intro', label: '片头片尾' },
  { key: 'product', label: '产品演示' },
  { key: 'other', label: '其它' },
];

export class Template {
  constructor(opts = {}) {
    this.id = opts.id || uid('TPL');
    this.name = opts.name || '未命名模板';
    this.version = opts.version || '1.0.0';
    this.category = opts.category || 'other';
    this.tags = opts.tags || [];
    this.author = opts.author || '匿名';
    this.description = opts.description || '';
    this.cover = opts.cover || '';            // dataURL 或占位标识
    this.previewTimes = opts.previewTimes || [0.5, 2, 4];  // 封面取哪几帧

    // 内容
    this.ir = opts.ir || null;
    this.params = opts.params || null;        // ParamSet JSON
    this.customBlocks = opts.customBlocks || [];

    // 商业
    this.price = opts.price || 0;            // 分（0 = 免费）
    this.revenueShare = opts.revenueShare == null ? 0.7 : opts.revenueShare;

    // 统计
    this.stats = Object.assign({ downloads: 0, likes: 0, ratingSum: 0, ratingCount: 0, sales: 0, revenue: 0 }, opts.stats || {});

    this.createdAt = opts.createdAt || new Date().toISOString();
    this.updatedAt = opts.updatedAt || this.createdAt;
    this.status = opts.status || 'published'; // draft | published | unlisted | removed
  }

  get isFree() { return !this.price || this.price <= 0; }
  get avgRating() {
    return this.stats.ratingCount ? this.stats.ratingSum / this.stats.ratingCount : 0;
  }

  /** 校验能否发布 */
  validate() {
    const issues = [];
    if (!this.name.trim()) issues.push({ level: 'error', msg: '模板必须有名字' });
    if (!this.version.trim() || !/^\d+\.\d+\.\d+$/.test(this.version)) {
      issues.push({ level: 'error', msg: `版本号格式应为 x.y.z（当前「${this.version}」）` });
    }
    if (!this.ir || !this.ir.layers || !this.ir.layers.length) {
      issues.push({ level: 'error', msg: '模板缺少工程内容' });
    } else {
      const irIssues = validate(this.ir);
      for (const i of (irIssues.errors || [])) issues.push({ level: 'error', msg: `工程错误：${i.msg || i}` });
    }
    if (this.price < 0) issues.push({ level: 'error', msg: '价格不能为负' });
    if (this.revenueShare < 0 || this.revenueShare > 1) {
      issues.push({ level: 'error', msg: '分成比例应在 0~1 之间' });
    }
    if (this.price > 0 && this.author === '匿名') {
      issues.push({ level: 'warn', msg: '付费模板需要设置作者名' });
    }
    // 参数规格必须与实际暴露的一致
    if (this.params && this.params.params) {
      const ps = ParamSet.fromJSON(this.params);
      for (const p of ps.params) {
        if (p.type === 'color' && !/^#[0-9a-fA-F]{6}$/.test(String(p.value))) {
          issues.push({ level: 'error', msg: `参数「${p.label}」的颜色值格式不对` });
        }
      }
      for (const i of ps.validate()) issues.push({ level: 'warn', msg: `参数「${i.key}」${i.msg}` });
    }
    return issues;
  }

  /** 装入一份**可编辑副本**（Remix） */
  instantiate(overrides = {}) {
    const ir = clone(this.ir);
    const ps = this.params ? ParamSet.fromJSON(this.params) : new ParamSet();
    // 1) 参数覆盖图层属性
    const values = Object.assign(ps.values(), overrides);
    let out = applyParams(ir, values);
    // 2) 覆盖项直接落到属性（不要求它被声明为参数）
    for (const [k, v] of Object.entries(overrides)) {
      if (v && typeof v === 'object' && v.layerId) {
        const l = out.layers.find(x => x.id === v.layerId);
        if (l) l.props[v.key] = v.value;
      }
    }
    if (this.customBlocks && this.customBlocks.length) {
      out.customLibrary = new CustomBlockLibrary({
        blocks: this.customBlocks.map(b => {
          const { CustomBlock } = { CustomBlock: null };
          void CustomBlock;
          return b;
        }),
      });
    }
    out.templateInfo = {
      id: this.id, name: this.name, version: this.version,
      author: this.author, category: this.category, tags: this.tags.slice(),
    };
    return out;
  }

  toJSON() {
    return {
      id: this.id, name: this.name, version: this.version, category: this.category,
      tags: this.tags, author: this.author, description: this.description,
      cover: this.cover, previewTimes: this.previewTimes,
      ir: this.ir, params: this.params,
      customBlocks: this.customBlocks,
      price: this.price, revenueShare: this.revenueShare,
      stats: this.stats, createdAt: this.createdAt, updatedAt: this.updatedAt,
      status: this.status,
    };
  }

  static fromJSON(j) { return new Template(j); }
}

/* ============================================================
   版本历史（不可变快照）
   ============================================================ */
export class TemplateVersion {
  constructor(opts = {}) {
    this.id = opts.id || uid('V');
    this.version = opts.version;
    this.ir = opts.ir;              // 完整快照
    this.params = opts.params;
    this.changelog = opts.changelog || '';
    this.author = opts.author || '';
    this.createdAt = opts.createdAt || new Date().toISOString();
  }
  static fromJSON(j) { return new TemplateVersion(j); }
  toJSON() { return Object.assign({}, this); }
}

/* ============================================================
   素材库（免版权）
   ============================================================ */
export const ASSET_KINDS = ['font', 'sfx', 'icon', 'background', 'music'];

export class AssetLib {
  constructor() {
    // 所有种子素材统一标 CC0（免版权），用户新增的默认也按 CC0
    this.assets = {};
    for (const [kind, list] of Object.entries(SEED_ASSETS)) {
      this.assets[kind] = list.map(a => Object.assign({ license: 'CC0' }, a));
    }
  }
  all(kind) {
    if (!kind) return Object.entries(this.assets).flatMap(([k, list]) => list.map(a => Object.assign({ kind: k }, a)));
    return (this.assets[kind] || []).map(a => Object.assign({ kind }, a));
  }
  get(kind, key) {
    return (this.assets[kind] || []).find(a => a.key === key) || null;
  }
  add(kind, asset) {
    if (!this.assets[kind]) this.assets[kind] = [];
    const a = Object.assign({ key: uid('A'), license: 'CC0' }, asset);
    this.assets[kind].push(a);
    return a;
  }
  search(q, kind) {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return this.all(kind);
    return this.all(kind).filter(a =>
      (a.name || '').toLowerCase().includes(needle)
      || (a.key || '').toLowerCase().includes(needle)
      || (a.tags || []).some(t => String(t).toLowerCase().includes(needle)));
  }
}

/* 免版权素材种子（全部 CC0；真实文件由使用方自行接入，这里给的是可用的参数） */
const SEED_ASSETS = {
  font: [
    { key: 'sys-sans', name: '系统无衬线', desc: '苹方 / 微软雅黑 / Noto，零加载', stack: '"PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif', tags: ['中文', '通用'] },
    { key: 'sys-serif', name: '系统衬线', desc: '宋体系，适合正式文案', stack: '"Songti SC","SimSun","Noto Serif SC",serif', tags: ['中文', '正式'] },
    { key: 'mono-num', name: '等宽数字', desc: '数字滚动时宽度不跳', stack: 'ui-monospace,"SF Mono",Menlo,Consolas,monospace', tags: ['数字', '表格'] },
  ],
  sfx: [
    { key: 'pop', name: '轻弹出', desc: '短促上扬，适合文字入场', synth: { type: 'pop', dur: 0.12 }, tags: ['UI', '入场'] },
    { key: 'whoosh', name: '呼啸', desc: '快速掠过，适合转场', synth: { type: 'noise-sweep', dur: 0.35 }, tags: ['转场'] },
    { key: 'click', name: '点击', desc: '干净短点击', synth: { type: 'click', dur: 0.05 }, tags: ['UI'] },
    { key: 'ding', name: '叮', desc: '铃铛音色，提示用', synth: { type: 'sine', freq: 880, dur: 0.4 }, tags: ['提示'] },
    { key: 'bass-drop', name: '低频下坠', desc: '强调落点', synth: { type: 'sine', freq: 120, dur: 0.5, slide: 40 }, tags: ['强调'] },
  ],
  icon: [
    { key: 'star', name: '星形', desc: '五角星路径', path: 'M12,2 L15,9 L22,9.5 L16.5,14 L18.5,21 L12,17 L5.5,21 L7.5,14 L2,9.5 L9,9 Z', tags: ['基础'] },
    { key: 'arrow', name: '箭头', desc: '向右箭头', path: 'M4,12 L18,12 M12,6 L18,12 L12,18', tags: ['指示'] },
    { key: 'check', name: '对勾', desc: '完成标记', path: 'M4,12 L9,17 L20,6', tags: ['状态'] },
    { key: 'bolt', name: '闪电', desc: '速度感', path: 'M13,2 L4,14 L11,14 L10,22 L20,10 L13,10 Z', tags: ['强调'] },
  ],
  background: [
    { key: 'grid', name: '网格', desc: '工程感网格底', draw: { type: 'grid', size: 64, color: 'rgba(255,255,255,.05)' }, tags: ['科技'] },
    { key: 'dots', name: '点阵', desc: '稀疏点阵', draw: { type: 'dots', size: 40, color: 'rgba(255,255,255,.08)' }, tags: ['简洁'] },
    { key: 'gradient-brand', name: '品牌渐变', desc: '深蓝到紫', draw: { type: 'gradient', from: '#111a3a', to: '#3a1f6b', angle: 135 }, tags: ['渐变'] },
    { key: 'gradient-warm', name: '暖色渐变', desc: '橙红，适合口播', draw: { type: 'gradient', from: '#2b1216', to: '#6b2f1f', angle: 135 }, tags: ['口播'] },
  ],
  music: [
    { key: 'lofi', name: 'Lo-Fi 循环', desc: '程序化生成的慵懒节拍（离线可用）', synth: { bpm: 82, bars: 8, mood: 'lofi' }, tags: ['背景音乐', '离线'] },
    { key: 'upbeat', name: '轻快循环', desc: '明快电子', synth: { bpm: 120, bars: 8, mood: 'upbeat' }, tags: ['背景音乐', '离线'] },
    { key: 'tension', name: '紧张循环', desc: '悬疑推进', synth: { bpm: 96, bars: 8, mood: 'tension' }, tags: ['背景音乐', '离线'] },
  ],
};

/* ============================================================
   市场（注册表）
   ============================================================ */
export class Marketplace {
  constructor(opts = {}) {
    this.templates = new Map();          // id → Template（当前版本）
    this.versions = new Map();           // templateId → TemplateVersion[]
    this.purchases = new Map();          // userId → Set<templateId>
    this.revenue = [];                   // 分成流水
    this.currentUser = opts.currentUser || 'me';
  }

  /* ---------- 发布 ---------- */
  publish(ir, meta = {}) {
    const tpl = new Template(Object.assign({}, meta, { ir }));
    const issues = tpl.validate().filter(i => i.level === 'error');
    if (issues.length) throw new Error(issues.map(i => i.msg).join('；'));
    // 已有同名 → 视为发新版本
    const prev = [...this.templates.values()].find(t => t.name === tpl.name && t.author === tpl.author);
    if (prev) return this.publishVersion(prev.id, tpl.ir, { version: meta.version, changelog: meta.changelog, params: tpl.params });
    this.templates.set(tpl.id, tpl);
    this.versions.set(tpl.id, [new TemplateVersion({
      version: tpl.version, ir: tpl.ir, params: tpl.params, changelog: '首次发布', author: tpl.author,
    })]);
    return tpl;
  }

  publishVersion(templateId, ir, opts = {}) {
    const tpl = this.templates.get(templateId);
    if (!tpl) throw new Error('模板不存在：' + templateId);
    const history = this.versions.get(templateId) || [];
    if (history.some(v => v.version === opts.version)) {
      throw new Error(`版本 ${opts.version} 已存在`);
    }
    const v = new TemplateVersion({
      version: opts.version, ir, params: opts.params || tpl.params,
      changelog: opts.changelog || '', author: opts.author || tpl.author,
    });
    history.push(v);
    this.versions.set(templateId, history);
    // 指针移到新版本
    tpl.version = v.version;
    tpl.ir = clone(ir);
    tpl.params = v.params;
    tpl.updatedAt = v.createdAt;
    // 付费模板改内容要重新上架审核（这里简化为标记）
    if (!tpl.isFree) tpl.status = 'published';
    return v;
  }

  unlist(templateId) {
    const t = this.templates.get(templateId);
    if (!t) return false;
    t.status = 'unlisted';
    return true;
  }

  remove(templateId) {
    const t = this.templates.get(templateId);
    if (!t) return false;
    // 只有无付费记录才能物理删除
    if (t.stats.sales > 0) { t.status = 'removed'; return true; }
    this.templates.delete(templateId);
    this.versions.delete(templateId);
    return true;
  }

  /* ---------- 查询 ---------- */
  get(id) { return this.templates.get(id) || null; }

  list(opts = {}) {
    let list = [...this.templates.values()];
    if (opts.category && opts.category !== 'all') list = list.filter(t => t.category === opts.category);
    if (opts.q) {
      const q = String(opts.q).toLowerCase();
      list = list.filter(t =>
        t.name.toLowerCase().includes(q)
        || (t.description || '').toLowerCase().includes(q)
        || (t.author || '').toLowerCase().includes(q)
        || t.tags.some(x => String(x).toLowerCase().includes(q)));
    }
    if (opts.tag) list = list.filter(t => t.tags.includes(opts.tag));
    if (opts.freeOnly) list = list.filter(t => t.isFree);
    if (opts.paidOnly) list = list.filter(t => !t.isFree);
    if (opts.mine) list = list.filter(t => t.author === this.currentUser);
    // 下架/删除的只在「包含不可见」或「看自己的」时出现
    if (!opts.mine && !opts.includeHidden) list = list.filter(t => t.status === 'published');
    const sort = opts.sort || 'updated';
    list.sort((a, b) => {
      if (sort === 'downloads') return b.stats.downloads - a.stats.downloads;
      if (sort === 'likes') return b.stats.likes - a.stats.likes;
      if (sort === 'rating') return b.avgRating - a.avgRating;
      if (sort === 'price') return a.price - b.price;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
    return list;
  }

  versionsOf(templateId) {
    return (this.versions.get(templateId) || []).slice().sort(
      (a, b) => compareVersion(b.version, a.version));
  }

  getVersion(templateId, version) {
    return (this.versions.get(templateId) || []).find(v => v.version === version) || null;
  }

  /* ---------- 交易 ---------- */
  /** 已购 / 作者本人 / 免费 → 可以用；付费未购 → 不行 */
  canUse(templateId) {
    const t = this.templates.get(templateId);
    if (!t) return { ok: false, reason: '模板不存在' };
    if (t.author === this.currentUser) return { ok: true, reason: 'own' };
    if (t.isFree) return { ok: true, reason: 'free' };
    if (this.purchases.get(this.currentUser)?.has(templateId)) return { ok: true, reason: 'purchased' };
    return { ok: false, reason: 'paid', price: t.price };
  }

  purchase(templateId) {
    const t = this.templates.get(templateId);
    if (!t) throw new Error('模板不存在');
    if (t.isFree) return { free: true };
    if (t.author === this.currentUser) throw new Error('不能购买自己发布的模板');
    if (this.purchases.get(this.currentUser)?.has(templateId)) return { alreadyOwned: true };
    if (!this.purchases.has(this.currentUser)) this.purchases.set(this.currentUser, new Set());
    this.purchases.get(this.currentUser).add(templateId);
    t.stats.sales++;
    // 分成记账
    const share = Math.round(t.price * t.revenueShare);
    this.revenue.push({
      id: uid('RV'), templateId, templateName: t.name,
      buyer: this.currentUser, author: t.author,
      gross: t.price, share, platform: t.price - share,
      at: new Date().toISOString(),
    });
    return { free: false, share };
  }

  /** 作者收益明细 */
  earnings(author) {
    const rows = this.revenue.filter(r => r.author === author);
    const total = rows.reduce((a, r) => a + r.share, 0);
    return { rows, total, sales: rows.length, currency: 'CNY' };
  }

  owned() {
    const set = this.purchases.get(this.currentUser) || new Set();
    return [...set].map(id => this.templates.get(id)).filter(Boolean);
  }

  /* ---------- 互动 ---------- */
  like(templateId) {
    const t = this.templates.get(templateId);
    if (!t) return 0;
    t.stats.likes++;
    return t.stats.likes;
  }
  rate(templateId, score) {
    const t = this.templates.get(templateId);
    if (!t) return 0;
    const s = Math.max(1, Math.min(5, Math.round(score)));
    t.stats.ratingSum += s;
    t.stats.ratingCount++;
    return t.avgRating;
  }
  download(templateId) {
    const t = this.templates.get(templateId);
    if (!t) return 0;
    t.stats.downloads++;
    return t.stats.downloads;
  }

  /* ---------- 导入导出 ---------- */
  exportTemplate(t) {
    return JSON.stringify({
      format: 'block-anim-template/1',
      template: t.toJSON(),
      versions: (this.versions.get(t.id) || []).map(v => v.toJSON()),
    }, null, 2);
  }

  importTemplate(text) {
    let j;
    try { j = JSON.parse(text); } catch (e) { throw new Error('不是合法的 JSON'); }
    if (j.format !== 'block-anim-template/1') throw new Error('不支持的模板包格式：' + j.format);
    const t = Template.fromJSON(j.template);
    const issues = t.validate().filter(i => i.level === 'error');
    if (issues.length) throw new Error('模板包校验失败：' + issues.map(i => i.msg).join('；'));
    this.templates.set(t.id, t);
    this.versions.set(t.id, (j.versions || []).map(TemplateVersion.fromJSON));
    if (!this.versions.get(t.id).length) {
      this.versions.set(t.id, [new TemplateVersion({ version: t.version, ir: t.ir, params: t.params, author: t.author })]);
    }
    return t;
  }

  /** 把已装载的官方模板灌进市场 */
  seedFrom(entries) {
    for (const e of entries) {
      try { this.publish(e.ir, e.meta); } catch { /* 跳过损坏项 */ }
    }
    return this.templates.size;
  }
}

export function compareVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/* ============================================================
   音效合成（免版权素材真的能用起来）
   ------------------------------------------------------------
   素材库里给的是**参数**，这里把它合成为可播放的 PCM。
   好处：零版权、完全离线、体积极小。
   ============================================================ */
export function synthSfx(spec, sampleRate = 48000) {
  const dur = (spec && spec.dur) || 0.2;
  const n = Math.max(1, Math.round(sampleRate * dur));
  const out = new Float32Array(n);
  const type = (spec && spec.type) || 'pop';

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const p = i / n;
    let v = 0;
    switch (type) {
      case 'pop':
        v = Math.sin(2 * Math.PI * (320 + 900 * p) * t) * Math.exp(-p * 9);
        break;
      case 'click':
        v = (Math.random() * 2 - 1) * Math.exp(-p * 40) * 0.7;
        break;
      case 'ding':
        v = (Math.sin(2 * Math.PI * (spec.freq || 880) * t)
          + 0.4 * Math.sin(2 * Math.PI * (spec.freq || 880) * 2.01 * t)) * Math.exp(-p * 4) * 0.5;
        break;
      case 'sine': {
        const f = (spec.freq || 440) + (spec.slide || 0) * p;
        v = Math.sin(2 * Math.PI * f * t) * Math.exp(-p * 3) * 0.6;
        break;
      }
      case 'noise-sweep': {
        // 白噪 + 带通包络，做出「掠过去」的感觉
        const env = Math.sin(Math.PI * p) ** 1.5;
        v = (Math.random() * 2 - 1) * env * 0.35;
        break;
      }
      default:
        v = Math.sin(2 * Math.PI * 440 * t) * 0.4;
    }
    out[i] = v;
  }

  // 首尾淡入淡出，避免爆音
  const fade = Math.min(Math.round(sampleRate * 0.003), Math.floor(n / 4));
  for (let i = 0; i < fade; i++) {
    out[i] *= i / fade;
    out[n - 1 - i] *= i / fade;
  }
  return out;
}

/** 把素材库的 background 描述画到画布上（供模板/场景使用） */
export function drawBackground(ctx, spec, w, h) {
  if (!spec) return false;
  const d = spec.draw || {};
  ctx.save();
  if (d.type === 'grid' || d.type === 'dots') {
    const size = d.size || 48;
    ctx.strokeStyle = d.color || 'rgba(255,255,255,.06)';
    ctx.fillStyle = d.color || 'rgba(255,255,255,.08)';
    if (d.type === 'grid') {
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= w; x += size) { ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, h); }
      for (let y = 0; y <= h; y += size) { ctx.moveTo(0, y + .5); ctx.lineTo(w, y + .5); }
      ctx.stroke();
    } else {
      for (let x = size / 2; x < w; x += size) {
        for (let y = size / 2; y < h; y += size) {
          ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  } else if (d.type === 'gradient') {
    const a = ((d.angle || 0) * Math.PI) / 180;
    const cx = w / 2, cy = h / 2;
    const len = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
    const g = ctx.createLinearGradient(cx - Math.cos(a) * len / 2, cy - Math.sin(a) * len / 2,
      cx + Math.cos(a) * len / 2, cy + Math.sin(a) * len / 2);
    g.addColorStop(0, d.from || '#111');
    g.addColorStop(1, d.to || '#333');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.restore();
    return false;
  }
  ctx.restore();
  return true;
}

export { expandCustomBlocks };