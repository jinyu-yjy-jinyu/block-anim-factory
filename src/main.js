/* ============================================================
   main.js · 应用装配
   ============================================================ */

import {
  defaultProject, newLayer, uid, validate, toText, fromText,
  NUM, STR, COL, TIME, SEL, BOOL, defaultForType, clone, LAYER_TYPES, registerOpMeta,
} from './ir.js';
import { BLOCK_DEFS, defOf, categories, metaFor, EASINGS } from './blocks.js';
import { evaluateFrame, AudioSource, num, clamp } from './evaluator.js';
import { render } from './renderer.js';
import * as BV from './blockview.js';
import * as EX from './exporter.js';
import { TEMPLATES, loadTemplate, defaultAudio } from './templates.js';
import { TimelineDebugger } from './debugger.js';

/* ---------- P0/P1/P2 新增模块 ---------- */
import { AudioSource as UnifiedAudio } from './audiosource.js';
import { AudioTrack, encodeWav, mixTracks, mixDuration, normalizeLoudness, LOUDNESS_PRESETS } from './audio-core.js';
import { AUDIO_PRESETS } from './recorder.js';
import { AudioDesk } from './audiodesk.js';
import { SubtitlePanel } from './subpanel.js';
import { DataPanel } from './datapanel.js';
import { SceneTree } from './scene.js';
import { blocksToGraph, graphToBlocks, layout as layoutGraph, roundTripReport } from './nodegraph.js';
import { renderNodeGraph } from './nodeview.js';
import { exportVideo, detectCapabilities, FORMAT_PRESETS, exportWithAudio } from './video-export.js';
import { CustomBlockLibrary, CustomBlock, extractFunction, expandCustomBlocks } from './customblocks.js';
import * as SUB_EXPORTS from './subtitles.js';

/* ---------- V3/V4：模板市场 / 素材库 / AI 辅助 / 版本协作 ---------- */
import { Marketplace, AssetLib, synthSfx, ASSET_KINDS } from './marketplace.js';
import * as AI from './ai.js';
import { Repo } from './collab.js';
import * as IR_MOD from './ir.js';
// batch.js 只导入一次（原实现 import 了两次，产生 APP_INTERP / APP_BATCH
// 两个命名空间指向同一模块，谁在用哪个全靠运气）。
import * as APP_BATCH from './batch.js';

/* ---------- 注册 op 元数据（供积木文本解析用） ---------- */
registerOpMeta(BLOCK_DEFS.map(d => metaFor(d.op)).filter(Boolean));

/* ============================================================
   全局状态
   ============================================================ */
const App = {
  ir: null,
  audio: null,
  layerId: null,
  selectedBlock: null,
  probeLayer: null,        // 属性探针：被观察的图层 id
  time: 0,
  playing: false,
  loop: true,
  lastTs: 0,
  rafId: 0,
  zoom: 'fit',
  zoomNum: 1,
  showSafeArea: true,
  dirty: false,
  title: '',
  exportCancel: false,
  prefs: { fps: 24, width: 1920, height: 1080, duration: 6, bpm: 120, loudness: -14 },

  /* ---------- 新增子系统 ---------- */
  audioTracks: [],          // AudioTrack[]（真实音频）
  audioSource: null,        // UnifiedAudio：积木读到的统一音源
  customLibrary: null,      // CustomBlockLibrary
  sceneTree: null,          // SceneTree（场景树）
  nodeGraph: null,          // 当前图层的节点投影
  nodeReport: null,
  subPanel: null,
  audioDesk: null,
  dataPanel: null,
  caps: null,               // 导出能力探测结果

  /* ---------- V3/V4 ---------- */
  market: null,             // Marketplace
  assets: null,             // AssetLib（免版权素材）
  repo: null,               // Repo（版本与分支）
  selectedTemplateId: null,
  selectedRevisionId: null,
  gitMergeInfo: null,
};

const undoStack = [];
const redoStack = [];
const MAX_UNDO = 60;

const dbg = new TimelineDebugger();

/* ============================================================
   DOM 快捷引用
   ============================================================ */
const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const cctx = canvas.getContext('2d');

/* ============================================================
   启动
   ============================================================ */
function boot() {
  App.ir = loadTemplate('popTitle');
  App.ir.project.name = '我的第一个工程';
  App.audio = defaultAudio(App.ir);
  App.layerId = App.ir.layers[1] ? App.ir.layers[1].id : (App.ir.layers[0] && App.ir.layers[0].id);
  App.title = '我的第一个工程';

  BV.S.ir = App.ir;
  BV.S.layerId = App.layerId;
  BV.S.onChange = withUndo;
  BV.S.onTick = () => { markDirty(); drawFrame(); };
  BV.S.onSelect = (id) => {
    App.selectedBlock = id || null;
    renderInspector();
  };
  BV.S.getMarkers = () => App.ir.markers;
  BV.S.findLayer = () => App.ir.layers.find(l => l.id === App.layerId) || null;
  BV.S.openExpr = openExprEditor;
  BV.S.onBlockMenu = openBlockMenu;
  BV.S.onLayerMenu = openLayerMenu;

  BV.initBlockView($('blockCanvas'));
  BV.bindPinEditing($('blockCanvas'));

  initNewPanels();

  syncProjectToUI();
  buildPalette();
  renderLayerTree();
  BV.renderBlocks();
  renderInspector();
  renderProjectSettings();
  layoutStage();
  drawFrame();
  buildRuler();

  bindGlobal();
  detectCapabilities().then(c => { App.caps = c; renderExportFormats(); });
  toast('就绪 · 空格播放，拖动积木搭建动画逻辑', 'ok', 2600);
}

/* ============================================================
   新增子系统初始化
   ============================================================ */
function initNewPanels() {
  /* ---------- 音频：统一音源 ---------- */
  App.audioSource = UnifiedAudio.synth({
    bpm: App.ir.project.bpm || 120,
    duration: App.ir.project.duration,
  });

  /* ---------- 自定义积木库 ---------- */
  App.customLibrary = new CustomBlockLibrary({
    blocks: (App.ir.customBlocks || []).map(CustomBlock.fromJSON),
  });
  App.ir.customLibrary = App.customLibrary;

  /* ---------- 场景树（从扁平图层迁移，可无损回写） ---------- */
  App.sceneTree = SceneTree.fromLayers(App.ir.layers);

  /* ---------- 字幕面板 ---------- */
  App.subPanel = new SubtitlePanel({
    listEl: $('subList'),
    issuesEl: $('subIssues'),
    styleEl: $('subStyle'),
    onToast: toast,
    // 字幕面板改动要立刻回写 IR：否则 App.ir.subtitles 一直是打开工程时的旧快照，
    // 导出 JSON / 存版本 / 撤销都快照到旧数据（面板改了、存下来的还是改之前的）。
    onChange: () => { App.ir.subtitles = App.subPanel.toJSON(); markDirty(); },
    onSeek: (t) => { setTime(t); },
  });
  App.ir.subtitles = App.subPanel.toJSON();

  /* ---------- 音频台 ---------- */
  App.audioDesk = new AudioDesk({
    canvas: $('waveCanvas'),
    cursorEl: $('waveCursor'),
    levelEl: $('recLevel'),
    timeEl: $('recTime'),
    recBtn: $('recBtn'),
    onToast: toast,
    onSeek: (t) => setTime(t),
    onChange: () => { syncAudioSource(); markDirty(); },
  });
  App.audioDesk.setTracks(App.audioTracks);
  renderLoudnessPresets();
  renderAudioPresets();
  renderAudioStatus();

  /* ---------- 数据面板 ---------- */
  App.dataPanel = new DataPanel({
    previewEl: $('dataPreview'),
    countEl: $('dataCount'),
    bindEl: $('bindList'),
    progressEl: $('batchProgress'),
    nameEl: $('batchName'),
    onToast: toast,
    onBind: () => markDirty(),
    renderFn: async (ir) => renderBatchFrame(ir),
  });
  App.dataPanel.scanBindable(App.ir);

  /* ---------- 文件输入 ---------- */
  $('subFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) { await App.subPanel.importFile(f); App.ir.subtitles = App.subPanel.toJSON(); }
    e.target.value = '';
  });
  $('audioFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) {
      await App.audioDesk.importFile(f);
      App.audioTracks = App.audioDesk.tracks;
      syncAudioSource();
      renderAudioStatus();
    }
    e.target.value = '';
  });
  $('dataFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) await App.dataPanel.loadFile(f);
    e.target.value = '';
  });

  // 降噪 / 闪避开关
  const dn = $('recDenoise'), dk = $('recDuck');
  if (dn) dn.addEventListener('change', () => {
    if (App.audioDesk.recorder) App.audioDesk.recorder.setNoiseSuppression(dn.checked);
  });
  if (dk) dk.addEventListener('change', () => {
    if (App.audioDesk.recorder) App.audioDesk.recorder.duckOthers(dk.checked);
  });

  // 字幕样式下拉
  const ss = $('subStyle');
  if (ss) ss.addEventListener('change', () => App.subPanel.setStyleAll(ss.value));

  initMarket();
  initVersioning();

  refreshNodeGraph();
}

/* ============================================================
   V3/V4 · 模板市场
   ============================================================ */
function initMarket() {
  App.market = new Marketplace({ currentUser: '我' });
  App.assets = new AssetLib();

  // 把 6 套官方模板灌进市场，这样「一键 Remix」就有东西可 Remix
  App.market.seedFrom(TEMPLATES.map((t, i) => ({
    ir: t.make(),
    meta: {
      name: t.name, author: '官方', category: categoryForTemplate(t.key),
      description: t.desc, version: '1.0.0',
      tags: tagsForTemplate(t.key), price: 0,
      previewTimes: [0.3, 2, 4],
    },
    _i: i,
  })));

  // 市场搜索 / 排序
  const q = $('mktQuery');
  if (q) {
    let timer = 0;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(renderMarketList, 180);
    });
  }
  const sort = $('mktSort');
  if (sort) sort.addEventListener('change', renderMarketList);

  const file = $('mktFile');
  if (file) file.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const t = App.market.importTemplate(await f.text());
      renderMarketList();
      renderMarketDetail(t.id);
      toast(`已导入模板「${t.name}」v${t.version}`, 'ok');
    } catch (err) {
      toast('模板包导入失败：' + err.message, 'err', 4000);
    }
    e.target.value = '';
  });

  renderMarketCats();
  renderMarketList();
}

function categoryForTemplate(key) {
  return { karaoke: 'speech', barChart: 'data', popTitle: 'intro', ring: 'product', particles: 'product', audioBars: 'intro' }[key] || 'official';
}
function tagsForTemplate(key) {
  return { karaoke: ['字幕', '口播'], barChart: ['数据', '图表'], popTitle: ['标题', '片头'], ring: ['频谱', '音乐'], particles: ['粒子'], audioBars: ['音频', '音乐'] }[key] || [];
}

function renderMarketCats() {
  const box = $('mktCats');
  if (!box) return;
  box.innerHTML = '';
  const cats = [{ key: 'all', label: '全部' }].concat(MK_CATS);
  for (const c of cats) {
    const b = document.createElement('button');
    b.textContent = c.label;
    b.className = (App.marketCat === c.key || (!App.marketCat && c.key === 'all')) ? 'on' : '';
    b.addEventListener('click', () => {
      App.marketCat = c.key;
      renderMarketCats();
      renderMarketList();
    });
    box.appendChild(b);
  }
}

const MK_CATS = [
  { key: 'official', label: '官方' },
  { key: 'speech', label: '口播字幕' },
  { key: 'data', label: '数据榜单' },
  { key: 'intro', label: '片头片尾' },
  { key: 'product', label: '产品演示' },
  { key: 'other', label: '其它' },
];

function renderMarketList() {
  const box = $('mktList');
  if (!box || !App.market) return;
  const q = $('mktQuery') ? $('mktQuery').value.trim() : '';
  const sort = $('mktSort') ? $('mktSort').value : 'updated';
  const list = App.market.list({ q, sort, category: App.marketCat || 'all' });

  box.innerHTML = '';
  if (!list.length) {
    const d = document.createElement('div');
    d.style.cssText = 'padding:24px 16px;color:var(--muted);font-size:12px;text-align:center';
    d.textContent = q ? `没有匹配「${q}」的模板` : '这里还没有模板，点「发布」把当前工程发上去';
    box.appendChild(d);
    return;
  }

  for (const t of list) {
    const row = document.createElement('div');
    row.className = 'mkt-item' + (t.id === App.selectedTemplateId ? ' sel' : '');
    row.addEventListener('click', () => {
      App.selectedTemplateId = t.id;
      renderMarketList();
      renderMarketDetail(t.id);
    });

    const cover = document.createElement('div');
    cover.className = 'mkt-cover';
    cover.textContent = MK_ICON[t.category] || '◆';
    row.appendChild(cover);

    const meta = document.createElement('div');
    meta.className = 'mkt-meta';
    const can = App.market.canUse(t.id);
    const locked = !can.ok;
    meta.innerHTML =
      `<div class="mkt-name">${esc(t.name)}</div>` +
      `<div class="mkt-sub">${esc(t.author)} · v${t.version}${locked ? ' · 🔒' : ''}</div>` +
      `<div class="mkt-stats">` +
      `<span>⬇ ${t.stats.downloads}</span>` +
      `<span>♥ ${t.stats.likes}</span>` +
      `<span>★ ${t.avgRating ? t.avgRating.toFixed(1) : '—'}</span>` +
      (t.isFree ? '' : `<span>售 ${t.stats.sales}</span>`) +
      `</div>`;
    row.appendChild(meta);

    const price = document.createElement('div');
    price.className = 'mkt-price' + (t.isFree ? ' free' : '');
    price.textContent = t.isFree ? '免费' : `¥${(t.price / 100).toFixed(2)}`;
    row.appendChild(price);

    box.appendChild(row);
  }
}

const MK_ICON = { official: '★', speech: '💬', data: '📊', intro: '🎬', product: '📦', other: '◆' };
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderMarketDetail(id) {
  const box = $('mktDetail');
  if (!box || !App.market) return;
  box.innerHTML = '';
  const t = App.market.get(id);
  if (!t) return;

  const h = document.createElement('h5');
  h.textContent = `${t.name} v${t.version}`;
  box.appendChild(h);

  const desc = document.createElement('div');
  desc.className = 'lbl';
  desc.style.marginBottom = '5px';
  desc.textContent = t.description || '（没有写说明）';
  box.appendChild(desc);

  // 参数区：这就是「一键 Remix」的关键
  const ps = t.params ? APP_BATCH.ParamSet.fromJSON(t.params) : null;
  if (ps && ps.params.length) {
    const tt = document.createElement('div');
    tt.className = 'lbl';
    tt.textContent = '可调参数（改完点 Remix 直接出片）';
    box.appendChild(tt);
    for (const p of ps.exposed()) {
      const row = document.createElement('div');
      row.className = 'param';
      const lb = document.createElement('label');
      lb.textContent = p.label;
      row.appendChild(lb);
      let input;
      if (p.type === 'bool') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!p.value;
      } else if (p.type === 'select' && p.options) {
        input = document.createElement('select');
        for (const o of p.options) {
          const op = document.createElement('option');
          op.value = o[0] ?? o;
          op.textContent = o[1] ?? String(o);
          input.appendChild(op);
        }
        input.value = p.value;
      } else {
        input = document.createElement('input');
        input.type = p.type === 'color' ? 'color' : 'text';
        input.value = p.value == null ? '' : String(p.value);
      }
      input.dataset.pkey = p.key;
      row.appendChild(input);
      box.appendChild(row);
    }
  }

  // 版本历史
  const vs = App.market.versionsOf(t.id);
  if (vs.length) {
    const vd = document.createElement('div');
    vd.className = 'versions';
    vd.innerHTML = '版本：' + vs.map(v =>
      `<span class="ver-tag" data-ver="${esc(v.version)}">${esc(v.version)}</span>`).join('');
    box.appendChild(vd);
    vd.querySelectorAll('.ver-tag').forEach(el => {
      el.style.cursor = 'pointer';
      el.title = '点击切到这个版本';
      el.addEventListener('click', () => {
        App.market.get(t.id).version = el.dataset.ver;
        const v = App.market.getVersion(t.id, el.dataset.ver);
        if (v) { App.market.get(t.id).ir = v.ir; App.market.get(t.id).params = v.params; }
        renderMarketDetail(t.id);
        renderMarketList();
        toast(`已切到 v${el.dataset.ver}`);
      });
    });
  }

  // 操作
  const acts = document.createElement('div');
  acts.className = 'row';
  acts.style.marginTop = '7px';
  const can = App.market.canUse(t.id);

  const mkBtn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    acts.appendChild(b);
    return b;
  };

  mkBtn('♥ 喜欢', '', () => { App.market.like(t.id); renderMarketList(); });
  mkBtn('☆ 评分', '', () => {
    const s = prompt('打几分（1~5）？', '5');
    if (s) { App.market.rate(t.id, Number(s)); renderMarketList(); }
  });
  if (!t.isFree && can.reason === 'paid') {
    mkBtn(`购买 ¥${(t.price / 100).toFixed(2)}`, 'primary', () => {
      const r = App.market.purchase(t.id);
      toast(`已购买，作者分成 ¥${((r.share || 0) / 100).toFixed(2)}`, 'ok');
      renderMarketDetail(t.id);
      renderMarketList();
    });
  }
  mkBtn(can.ok ? 'Remix 载入' : '🔒 需购买', can.ok ? 'primary' : '', () => {
    if (!can.ok) { toast(can.reason === 'paid' ? '这是付费模板，请先购买' : '无法使用该模板', 'warn'); return; }
    remixTemplate(t);
  });
  box.appendChild(acts);
}

/** 一键 Remix：读参数 → 装入工程 */
function remixTemplate(t) {
  const overrides = {};
  const box = $('mktDetail');
  if (box) {
    box.querySelectorAll('[data-pkey]').forEach(inp => {
      const key = inp.dataset.pkey;
      overrides[key] = inp.type === 'checkbox' ? inp.checked
        : inp.type === 'number' ? Number(inp.value)
        : inp.value;
    });
  }
  pushUndo();
  try {
    App.ir = t.instantiate(overrides);
    App.title = `${t.name} v${t.version}`;
    App.audioSource = UnifiedAudio.synth({ bpm: App.ir.project.bpm || 120, duration: App.ir.project.duration });
    App.audioSource.setNominalDuration(App.ir.project.duration);
    App.layerId = App.ir.layers[1] ? App.ir.layers[1].id : App.ir.layers[0].id;
    BV.S.ir = App.ir; BV.S.layerId = App.layerId;
    if (App.sceneTree) App.sceneTree.syncFromLayers(App.ir.layers);
    if (App.repo) App.repo.commit(App.ir, `Remix「${t.name}」v${t.version}`, { author: '我' });
    syncSubtitlePanel(App.ir);
    syncProjectToUI(); renderLayerTree(); BV.renderBlocks(); renderInspector();
    renderProjectSettings(); buildRuler(); layoutStage(); drawFrame();
    App.market.download(t.id);
    toast(`已载入「${t.name}」—— 改坏了也不怕，模板原版还在`, 'ok', 3200);
  } catch (e) {
    toast('载入失败：' + e.message, 'err');
  }
}

function publishCurrent() {
  const ps = APP_BATCH.ParamSet.fromJSON({
    params: Object.keys(App.ir.layers[0].props || {})
      .filter(k => typeof App.ir.layers[0].props[k] === 'string' || typeof App.ir.layers[0].props[k] === 'number')
      .map((k, i) => ({ key: k, label: k, type: typeof App.ir.layers[0].props[k] === 'number' ? 'num' : 'text', value: App.ir.layers[0].props[k], group: '图层' })),
    locked: [],
  });
  const meta = {
    name: `我的模板 ${new Date().toLocaleDateString('zh-CN')}`,
    author: '我',
    category: App.marketCat && App.marketCat !== 'all' ? App.marketCat : 'official',
    version: '1.0.0',
    description: `来自工程「${App.ir.project.name}」`,
    tags: ['自建'],
    price: 0,
    params: ps.toJSON(),
  };
  try {
    const t = App.market.publish(App.ir, meta);
    App.selectedTemplateId = t.id;
    if (App.repo) App.repo.commit(App.ir, `发布模板「${t.name}」`, { author: '我' });
    renderMarketList(); renderMarketDetail(t.id);
    toast(`已发布「${t.name}」（免费，可改价上架）`, 'ok');
  } catch (e) {
    toast('发布失败：' + e.message, 'err', 4000);
  }
}

/* ============================================================
   V3/V4 · 版本与协作
   ============================================================ */
function initVersioning() {
  App.repo = new Repo();
  App.repo.init(App.ir, { message: '初始版本', author: '我' });
  renderGitLog();

  const file = $('gitFile');
  if (file) file.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      App.repo = Repo.fromJSON(JSON.parse(await f.text()));
      App.selectedRevisionId = App.repo.head(App.repo.currentBranch);
      renderGitLog();
      toast('版本库已导入', 'ok');
    } catch (err) {
      toast('版本库导入失败：' + err.message, 'err');
    }
    e.target.value = '';
  });
}

function gitCommit() {
  const input = el2('input', {
    placeholder: '这次改了什么？',
    style: 'width:100%;padding:7px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px',
  });
  showModal('提交改动', [
    el2('p', { class: 'lbl' }, '版本是不可变的 —— 提交后随时能回到任意一点，出了问题也不怕。'),
    input,
  ], [
    { label: '取消', cls: '' },
    {
      label: '提交', cls: 'primary', onClick: () => {
        closeModal();
        const r = App.repo.commit(App.ir, input.value.trim() || '未命名改动', { author: '我' });
        App.selectedRevisionId = r.id;
        renderGitLog();
        toast(`已提交 ${r.shortHash}`, 'ok');
      },
    },
  ]);
  setTimeout(() => input.focus(), 60);
}

function renderGitLog() {
  const box = $('gitLog');
  if (!box || !App.repo) return;

  // 分支下拉
  const br = $('gitBranch');
  if (br) {
    br.innerHTML = '';
    for (const name of App.repo.listBranches()) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name + (name === App.repo.currentBranch ? '（当前）' : '');
      br.appendChild(o);
    }
    br.value = App.repo.currentBranch;
  }

  box.innerHTML = '';
  const head = App.repo.head(App.repo.currentBranch);
  const items = [];

  // 先列其它分支（可合并进来）
  for (const name of App.repo.listBranches()) {
    if (name === App.repo.currentBranch) continue;
    items.push({ branch: name });
  }

  for (const r of App.repo.log()) {
    const row = document.createElement('div');
    row.className = 'git-item' + (r.id === head ? ' is-head ' : '') + (r.id === App.selectedRevisionId ? ' sel' : '');
    row.innerHTML =
      `<span class="hash">${esc(r.shortHash)}</span>` +
      `<span class="msg">${esc(r.message)}` +
      (r.tags.length ? `<span class="tags">${r.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</span>` : '') +
      `</span>` +
      `<span class="meta">${esc(r.author)}<br>${r.stats.blocks || 0} 块</span>`;
    row.addEventListener('click', () => {
      App.selectedRevisionId = r.id;
      renderGitLog();
      const box2 = $('gitMerge');
      if (box2) {
        box2.innerHTML = '';
        const d = el2('div', {}, [
          el2('div', {}, `已选中 ${r.shortHash}（${r.message}）`),
          el2('div', { class: 'lbl' }, '「载入到当前工程」会用这个版本覆盖画布（可撤销）'),
          el2('button', {
            style: 'margin-top:5px',
            onClick: () => {
              App.loadIR(clone(r.ir));
              App.title = App.ir.project.name || App.title;
              toast(`已载入 ${r.shortHash}`, 'ok');
            },
          }, '载入到当前工程'),
        ]);
        box2.appendChild(d);
      }
    });
    box.appendChild(row);
  }

  // 分支行 + 合并按钮
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'git-item';
    row.innerHTML = `<span class="hash">⑂</span><span class="msg">分支 ${esc(it.branch)}</span><span class="meta"></span>`;
    const b = document.createElement('button');
    b.textContent = '合并';
    b.className = 'primary';
    b.style.fontSize = '10px';
    b.addEventListener('click', (e) => { e.stopPropagation(); gitMerge(it.branch); });
    row.appendChild(b);
    box.insertBefore(row, box.firstChild);
  }
}

function gitCheckout() {
  const name = $('gitBranch') ? $('gitBranch').value : null;
  if (!name) return;
  try {
    App.repo.checkout(name);
    // 切分支必须把该分支的最新版本载入画布，否则看到的还是上一个分支的内容
    const rev = App.repo.get(App.repo.head(name));
    if (rev) App.loadIR(clone(rev.ir));
    renderGitLog();
    toast(`已切到分支「${name}」`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

function gitNewBranch() {
  const name = prompt('新分支名', '实验');
  if (!name) return;
  try {
    App.repo.branch_(name);
    App.repo.checkout(name);
    renderGitLog();
    toast(`已创建并切到「${name}」`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

function gitTag() {
  const name = prompt('标签名', `v${(App.repo.log().length + 1) / 10}`);
  if (!name) return;
  try {
    App.repo.tag(name, App.repo.head(App.repo.currentBranch));
    renderGitLog();
    toast(`已打标签「${name}」`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

function gitMerge(branchName) {
  const r = App.repo.merge(branchName, { author: '我' });
  App.gitMergeInfo = r;
  renderGitLog();
  const box = $('gitMerge');
  if (!box) return;
  box.innerHTML = '';

  if (r.ok) {
    // 合并结果已经提交进版本库，画布也要切到这份结果
    if (r.merged) App.loadIR(clone(r.merged));
    const okd = el2('div', { class: 'ok', style: 'color:#38c98b' },
      `✓ 已合并「${branchName}」，生成 ${r.revision.shortHash}`);
    box.appendChild(okd);
    for (const c of (r.taken || []).slice(0, 8)) {
      box.appendChild(el2('div', { class: 'taken' }, '· ' + c.msg));
    }
    if (r.conflicts && r.conflicts.length) {
      box.appendChild(el2('div', { class: 'warn', style: 'color:#ffd166;margin-top:4px' },
        `但有 ${r.conflicts.length} 处冲突，已保留你的版本：`));
      for (const c of r.conflicts) box.appendChild(el2('div', { class: 'conflict' }, '✕ ' + c.msg));
    }
    toast('合并完成', 'ok');
    return;
  }

  box.appendChild(el2('div', { class: 'conflict', style: 'font-weight:600' },
    `合并「${branchName}」有 ${r.conflicts.length} 处冲突，需要你决定：`));
  for (const c of r.conflicts) {
    box.appendChild(el2('div', { class: 'conflict' }, '✕ ' + c.msg));
  }
  const row = el2('div', { class: 'row', style: 'margin-top:6px' }, [
    el2('button', {
      onClick: () => { closeModal(); toast('已取消合并'); },
    }, '放弃'),
    el2('button', {
      class: 'primary',
      onClick: () => {
        const r2 = App.repo.merge(branchName, { force: true, author: '我' });
        if (r2.ok) {
          if (r2.merged) App.loadIR(clone(r2.merged));
          box.innerHTML = '';
          box.appendChild(el2('div', { class: 'ok', style: 'color:#38c98b' }, `✓ 已强制合并，生成 ${r2.revision.shortHash}`));
          renderGitLog();
          toast('已按你的版本合并', 'ok');
        }
      },
    }, '保留我的版本强行合并'),
  ]);
  box.appendChild(row);
}

function gitExport() {
  EX.download(new Blob([JSON.stringify(App.repo.toJSON(), null, 2)], { type: 'application/json' }),
    `版本库-${App.ir.project.name}.json`);
  toast('版本库已导出', 'ok');
}

function gitPatch() {
  const log = App.repo.log();
  if (log.length < 2) { toast('至少要两个版本才能看差异', 'warn'); return;
  }
  const prev = log[1], cur = log[0];
  const text = App.repo.patch(prev.id, cur.id);
  showModal('版本差异', [
    el2('pre', {
      style: 'white-space:pre-wrap;font-size:11px;line-height:1.7;margin:0;color:var(--fg)',
    }, text),
  ], [
    { label: '关闭', cls: '' },
    {
      label: '复制', cls: 'primary', onClick: async () => {
        try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板', 'ok'); }
        catch { toast('复制失败，请手动选中复制', 'warn'); }
      },
    },
  ]);
}

/* ============================================================
   V3/V4 · AI 辅助
   ============================================================ */
function aiParse() {
  const inp = $('aiNlInput');
  const out = $('aiNlResult');
  if (!inp || !out) return;
  const text = inp.value.trim();
  if (!text) { toast('先说点什么吧', 'warn'); return; }

  const p = new AI.NLParser({
    layers: App.ir.layers.map(l => l.name),
    markers: (App.ir.markers || []).map(m => m.label),
  });
  const r = p.parse(text);
  if (!r.actions.length) {
    out.innerHTML = '';
    out.appendChild(el2('div', { class: 'err' }, '没解析出任何动作。试试更具体的说法，例如「让标题逐字弹入，延迟 0.05 秒」。'));
    return;
  }

  out.innerHTML = '';
  out.appendChild(el2('h6', {}, `识别出 ${r.actions.length} 个动作：`));
  for (const a of r.actions) {
    const def = a.op;
    out.appendChild(el2('div', { class: 'line' }, [
      el2('span', { class: 'op' }, def),
      el2('span', {}, a.why),
    ]));
  }
  if (r.warnings.length) {
    out.appendChild(el2('h6', {}, '没听懂的片段：'));
    for (const w of r.warnings) out.appendChild(el2('div', { class: 'warn' }, '· ' + w));
  }

  // 预览编译结果
  const compiled = AI.actionsToBlocks(r.actions);
  if (compiled.skipped.length) {
    out.appendChild(el2('h6', {}, '无法转换的部分：'));
    for (const s of compiled.skipped) {
      out.appendChild(el2('div', { class: 'warn' }, `· ${s.op}：${s.reason}`));
    }
  }

  const apply = el2('button', {
    class: 'primary',
    style: 'margin-top:8px;align-self:flex-start',
    onClick: () => {
      const layer = currentLayer();
      if (!layer) { toast('没有可用图层', 'warn'); return; }
      pushUndo();
      layer.blocks = (layer.blocks || []).concat(clone(compiled.blocks));
      if (App.repo) App.repo.commit(App.ir, `AI 生成：${r.actions.map(a => a.op).join('、')}`, { author: '我' });
      BV.renderBlocks(); drawFrame(); renderInspector();
      toast(`已把 ${compiled.blocks.length} 个积木加到「${layer.name}」`, 'ok');
    },
  }, `应用到「${currentLayer() ? currentLayer().name : '图层'}」`);
  out.appendChild(apply);
}

function aiStoryboard() {
  const inp = $('aiScriptInput');
  const out = $('aiScriptResult');
  if (!inp || !out) return;
  const text = inp.value.trim();
  if (!text) { toast('先粘贴一段文案', 'warn'); return; }

  const sb = AI.scriptToStoryboard(text);
  out.innerHTML = '';
  out.appendChild(el2('h6', {}, `拆成 ${sb.scenes.length} 个场景，共 ${sb.totalDuration}s / ${sb.wordCount} 字`));
  for (const s of sb.scenes) {
    out.appendChild(el2('div', { class: 'scene' }, [
      el2('div', { class: 't' }, `SC${s.index + 1}　${s.text}`),
      el2('div', { class: 'meta' },
        `${s.start}s → ${s.end}s（${s.duration}s）　建议：${s.suggested.op}　${s.suggested.reason}`),
    ]));
  }
}

function aiStoryboardApply() {
  const inp = $('aiScriptInput');
  if (!inp || !inp.value.trim()) { toast('先粘贴一段文案', 'warn'); return; }
  const sb = AI.scriptToStoryboard(inp.value.trim());

  // 用分镜生成一个真实工程：每个场景一个文字图层，按建议的动效入场
  pushUndo();
  const W = 1080, H = 1920;
  const ir = IR_MOD.defaultProject('分镜');
  ir.project.width = W; ir.project.height = H;
  ir.project.duration = Math.max(1, Math.ceil(sb.totalDuration));
  ir.project.fps = 30;
  ir.markers = sb.scenes.flatMap(s => s.markers);
  ir.layers = [];

  // 背景
  ir.layers.push(IR_MOD.newLayer('背景', 'rect'));
  ir.layers[0].props = Object.assign(ir.layers[0].props, { x: W / 2, y: H / 2, w: W, h: H, fill: '#0d1017' });

  for (const s of sb.scenes) {
    const l = IR_MOD.newLayer(`SC${s.index + 1}`, 'text');
    l.props = Object.assign({}, l.props, {
      x: W / 2, y: H / 2, w: W * 0.86, h: 200,
      text: s.text, fontSize: s.subtitleText[0] ? Math.min(96, Math.round(120 / Math.max(1, [...s.subtitleText[0]].length / 8))) : 72,
      fontWeight: 700, fill: '#ffffff', align: 'center',
    });
    // 用建议的动效
    const act = { op: s.suggested.op, slots: { layer: IR_MOD.SEL(l.name) } };
    const compiled = AI.actionsToBlocks([act]);
    if (compiled.blocks.length) {
      const b = compiled.blocks[0];
      // 覆盖成这个场景自己的时间
      if (b.op === 'fadeIn' || b.op === 'fadeOut') {
        b.slots[1].value = IR_MOD.TIME(Math.min(0.8, s.duration * 0.4));
        b.slots[2].value = IR_MOD.TIME(s.start);
      } else if (b.op === 'charPopIn') {
        b.slots[1].value = IR_MOD.TIME(s.start);
        b.slots[2].value = IR_MOD.NUM(Math.max(0.02, Math.min(0.12, s.duration / Math.max(1, [...s.text].length) * 0.6)));
      } else if (b.op === 'typewriter') {
        b.slots[1].value = IR_MOD.NUM(Math.max(4, Math.round([...s.text].length / s.duration)));
        b.slots[2].value = IR_MOD.TIME(s.start);
      } else {
        // 其它动效统一用「在时间点 + 淡入」
        b.op = 'setAt';
        b.slots = [{ type: 'time', value: IR_MOD.TIME(s.start) }, { type: 'blocks', value: [
          { id: IR_MOD.uid('B'), k: 'C', op: 'fadeIn', slots: [
            { type: 'sel', value: IR_MOD.SEL(l.name) },
            { type: 'time', value: IR_MOD.TIME(Math.min(0.8, s.duration * 0.4)) },
            { type: 'time', value: IR_MOD.TIME(0) },
          ] },
        ] }];
      }
      l.blocks = [b];
    }
    ir.layers.push(l);
  }

  // 顺便把字幕轨也建好
  const sub = new SUB_EXPORTS.SubtitleTrack({ name: '自动字幕' });
  for (const s of sb.scenes) {
    for (const line of s.subtitleText) {
      sub.add(new SUB_EXPORTS.SubtitleCue({
        start: s.start, end: Math.min(ir.project.duration, s.end), text: line, styleId: 'default',
      }));
    }
  }

  App.ir = ir;
  App.title = 'AI 分镜';
  App.layerId = ir.layers[1] ? ir.layers[1].id : ir.layers[0].id;
  BV.S.ir = ir; BV.S.layerId = App.layerId;
  if (App.sceneTree) App.sceneTree.syncFromLayers(ir.layers);
  if (App.audioSource) { App.audioSource.setNominalDuration(ir.project.duration); }
  App.subPanel.setTrack(sub);
  App.subPanel.setDuration(ir.project.duration);
  App.ir.subtitles = App.subPanel.toJSON();
  if (App.repo) App.repo.commit(ir, `AI 分镜：${sb.scenes.length} 个场景`, { author: '我' });
  syncProjectToUI(); renderLayerTree(); BV.renderBlocks(); renderInspector();
  renderProjectSettings(); buildRuler(); layoutStage(); drawFrame();
  toast(`已生成 ${sb.scenes.length} 个场景的分镜工程（竖屏 + 自动字幕）`, 'ok', 3600);
}

function aiFromSubs() {
  const track = App.subPanel.track;
  if (!track.cues.length) { toast('先在「字幕」页导入或新增字幕', 'warn'); return; }
  const layer = currentLayer();
  const r = AI.subtitlesToBlocks(track, { layer: layer ? layer.name : '标题文字' });
  const out = $('aiSubResult');
  if (out) {
    out.innerHTML = '';
    out.appendChild(el2('h6', {}, `生成 ${r.blocks.length} 个积木、${r.markers.length} 个标记点`));
    for (const a of r.actions) {
      out.appendChild(el2('div', { class: 'line' }, [
        el2('span', { class: 'op' }, a.op),
        el2('span', {}, a.why),
      ]));
    }
  }
  // 生成结果要真正挂到当前图层的逻辑上，只显示在面板里等于没生成
  pushUndo();
  if (layer) layer.blocks = (layer.blocks || []).concat(clone(r.blocks));
  // 标记点需要保留 id（时间轴/求值器按 id 查找），不能只存 name
  App.ir.markers = (App.ir.markers || []).concat(r.markers.map(m => ({
    id: m.id, name: m.name, time: m.time, label: m.label, color: m.color || '#ffb020',
  })));
  markDirty();
  renderLayerTree(); BV.renderBlocks(); renderInspector(); buildRuler(); drawFrame();
  if (App.repo) App.repo.commit(App.ir, `按字幕生成 ${r.blocks.length} 个动画`, { author: '我' });
  toast(`已生成 ${r.blocks.length} 个积木与 ${r.markers.length} 个标记点`, 'ok');
}

function aiExplainLayer() {
  const layer = currentLayer();
  const out = $('aiReadResult');
  if (!layer || !out) { toast('没有选中的图层', 'warn'); return; }
  const lines = AI.explainLayer(layer);
  out.innerHTML = '';
  out.appendChild(el2('h6', {}, `图层「${layer.name}」的逻辑：`));
  if (!lines.length) {
    out.appendChild(el2('div', { class: 'lbl' }, '（这个图层没有积木，是静态的）'));
  } else {
    lines.forEach((l, i) => out.appendChild(el2('div', { class: 'line' }, `${i + 1}. ${l}`)));
  }
}

function aiInfer() {
  const layer = currentLayer();
  const out = $('aiReadResult');
  if (!layer || !out) { toast('没有选中的图层', 'warn'); return; }
  try {
    const r = AI.inferEffectFromFrames(App.ir, layer.id, App.audioSource || App.audio, { window: Math.min(4, App.ir.project.duration) });
    out.innerHTML = '';
    out.appendChild(el2('h6', {}, `采样 ${r.series.length} 帧，时间窗 ${r.startTime}s 起约 ${r.duration}s`));
    out.appendChild(el2('div', { class: 'ok' },
      `最可能：${r.best.effect}（置信度 ${(r.best.confidence * 100).toFixed(0)}%）`));
    out.appendChild(el2('div', { class: 'why' }, '依据：' + r.best.evidence));
    if (r.guesses.length > 1) {
      out.appendChild(el2('h6', {}, '其它可能：'));
      for (const g of r.guesses.slice(1)) {
        out.appendChild(el2('div', { class: 'line why' }, `${g.effect}（${(g.confidence * 100).toFixed(0)}%）— ${g.evidence}`));
      }
    }
    const add = el2('button', {
      style: 'margin-top:8px;align-self:flex-start',
      onClick: () => {
        const spec = r.best;
        if (spec.effect === 'none') { toast('没测出动效', 'warn'); return; }
        pushUndo();
        const act = { op: spec.effect, slots: { layer: IR_MOD.SEL(layer.name) } };
        const c = AI.actionsToBlocks([act]);
        if (!c.blocks.length) { toast('该动效无法自动生成', 'warn'); return; }
        layer.blocks = (layer.blocks || []).concat(c.blocks);
        BV.renderBlocks(); drawFrame();
        toast(`已按推断结果加上「${spec.effect}」`, 'ok');
      },
    }, '把推断结果加成积木');
    out.appendChild(add);
  } catch (e) {
    out.innerHTML = '';
    out.appendChild(el2('div', { class: 'err' }, '推断失败：' + e.message));
  }
}

function aiLint() {
  const issues = AI.lintProject(App.ir, App.audioSource || App.audio);
  const out = $('aiLintResult');
  if (!out) return;
  out.innerHTML = '';
  if (!issues.length) {
    out.appendChild(el2('div', { class: 'ok' }, '✓ 体检通过，没发现明显问题'));
    return;
  }
  const errs = issues.filter(i => i.level === 'error');
  const warns = issues.filter(i => i.level === 'warn');
  const infos = issues.filter(i => i.level === 'info');
  out.appendChild(el2('div', {}, `${errs.length} 个错误 · ${warns.length} 个提醒 · ${infos.length} 条建议`));
  for (const i of issues) {
    const cls = i.level === 'error' ? 'err' : i.level === 'warn' ? 'warn' : 'lbl';
    const icon = i.level === 'error' ? '✕' : i.level === 'warn' ? '⚠' : '·';
    const line = el2('div', { class: `line ${cls}` }, `${icon} ${i.msg}`);
    if (i.fix) {
      const b = el2('button', { style: 'margin-left:6px;font-size:10px;padding:1px 6px' }, '怎么办');
      b.addEventListener('click', () => toast(i.fix, '', 4000));
      line.appendChild(b);
    }
    out.appendChild(line);
  }
}

function aiExplainAll() {
  const lines = AI.explainProject(App.ir);
  showModal('这个工程在做什么', [
    el2('div', { style: 'font-size:12px;line-height:2' },
      lines.map(l => el2('div', { style: 'margin:4px 0' }, l))),
  ], [{ label: '知道了', cls: '' }]);
}

/** 新建/载入/切分支时清空上一份真实音轨，避免新工程沿用旧工程的音频 */
function resetAudioState() {
  App.audioTracks = [];
  if (App.audioDesk) App.audioDesk.setTracks(App.audioTracks);
  syncAudioSource();
  renderAudioStatus();
}

/** 有真实音频时用真实音源，否则用合成音源 */
function syncAudioSource() {
  const tracks = App.audioTracks || [];
  const nominal = App.ir.project.duration;
  if (tracks.length && tracks.some(t => !t.muted && t.samples && t.samples.length)) {
    App.audioSource = UnifiedAudio.fromTracks(tracks, { fps: App.ir.project.fps, bpm: App.ir.project.bpm, nominalDuration: nominal });
  } else {
    App.audioSource = UnifiedAudio.synth({ bpm: App.ir.project.bpm || 120, duration: nominal });
  }
  App.audioSource.setNominalDuration(nominal);
}

/** 批量渲染的单帧产出（复用导出通道，保证与预览同一渲染路径） */
async function renderBatchFrame(ir) {
  const t = ir.project.duration * 0.35;
  return EX.exportPNG(ir, App.audioSource || App.audio, t);
}

function renderLoudnessPresets() {
  const box = $('loudPresets');
  if (!box) return;
  box.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'lbl';
  label.textContent = '一键达标：';
  box.appendChild(label);
  for (const [key, target] of Object.entries(LOUDNESS_PRESETS)) {
    const b = document.createElement('button');
    b.textContent = `${keyLabel(key)} ${target.lufs}`;
    b.title = `把混音响度归一到 ${target.lufs} LUFS`;
    b.addEventListener('click', () => {
      const res = App.audioDesk.normalizeToPreset(key);
      if (res) toast(`已归一到 ${target.lufs} LUFS（实测 ${res.lufs.toFixed(1)}）`, 'ok');
      else toast('没有音频可处理', 'warn');
    });
    box.appendChild(b);
  }
}
function keyLabel(k) {
  return { douyin: '抖音', bilibili: 'B站', youtube: 'YouTube', wechat: '视频号', podcast: '播客' }[k] || k;
}

function renderAudioPresets() {
  const box = $('sfxRow');
  if (!box) return;
  box.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'lbl';
  label.textContent = '处理：';
  box.appendChild(label);
  for (const [key, p] of Object.entries(AUDIO_PRESETS)) {
    const b = document.createElement('button');
    b.textContent = p.label;
    b.title = p.desc || '';
    b.addEventListener('click', () => App.audioDesk.applyPreset(key));
    box.appendChild(b);
  }
}

function renderAudioStatus() {
  const st = App.audioDesk ? App.audioDesk.status() : {};
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('loudVal', st.lufs == null ? '—' : `${st.lufs} LUFS`);
  set('peakVal', st.peak == null ? '—' : `${st.peak} dB`);
  // 没检出节拍时给个明确说明，而不是一个孤零零的破折号
  set('bpmVal', st.bpm ? `${st.bpm}` : (st.duration ? '未检出' : '—'));
  if ($('bpmVal')) $('bpmVal').title = st.bpm ? '从音轨能量包络检出的节拍' : '这段音频没检出稳定节拍';
  // 响度条：-30..-6 LUFS 映射到 0..100%
  const fill = $('loudFill');
  if (fill) {
    if (st.lufs == null) fill.style.width = '100%';
    else {
      const pct = Math.max(0, Math.min(100, ((st.lufs + 30) / 24) * 100));
      fill.style.width = pct + '%';
    }
  }
}

/* ============================================================
   撤销 / 重做
   ============================================================ */
function snapshot() { return JSON.stringify(App.ir); }
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  updateUndoUI();
}
function restore(json) {
  App.ir = JSON.parse(json);
  App.audio.setDuration(App.ir.project.duration);
  BV.S.ir = App.ir;
  if (!App.ir.layers.find(l => l.id === App.layerId)) App.layerId = App.ir.layers[0] && App.ir.layers[0].id;
  BV.S.layerId = App.layerId;
  dbg.probe = App.probeLayer;
  dbg.reset(App.ir);
  // 撤销回到旧快照时，场景树也要跟着回（master 保留）
  if (App.sceneTree) App.sceneTree.syncFromLayers(App.ir.layers);
  syncSubtitlePanel(App.ir);
  syncProjectToUI();
  renderLayerTree(); BV.renderBlocks(); renderInspector(); renderProjectSettings(); buildRuler();
  refreshNodeGraph();
  drawFrame();
}
function withUndo(mutate) {
  pushUndo();
  mutate();
  markDirty();
}
function undo() {
  if (!undoStack.length) { toast('没有可撤销的操作'); return; }
  redoStack.push(snapshot());
  restore(undoStack.pop());
  updateUndoUI();
  toast('已撤销');
}
function redo() {
  if (!redoStack.length) { toast('没有可重做的操作'); return; }
  undoStack.push(snapshot());
  restore(redoStack.pop());
  updateUndoUI();
  toast('已重做');
}
function updateUndoUI() {
  document.querySelector('[data-act="edit.undo"]').disabled = !undoStack.length;
  document.querySelector('[data-act="edit.redo"]').disabled = !redoStack.length;
}

/* ============================================================
   渲染循环
   ============================================================ */
function drawFrame() {
  const ir = App.ir;
  if (!ir) return;
  // 统一音源：有真实音频就读真实音频，否则回落到合成包络
  const audio = App.audioSource || App.audio;
  const { state, ctx } = evaluateFrame(ir, App.time, audio, {
    customLibrary: App.customLibrary,
    onCustomBlockError: (layer, e) => {
      if (!drawFrame._cbErr || drawFrame._cbErr !== e.message) {
        drawFrame._cbErr = e.message;
        toast(`${layer.name}：自定义积木出错 · ${e.message}`, 'err', 4200);
      }
    },
  });
  if (ctx && ctx.budgetExceeded) {
    if (!drawFrame._budgetWarned) {
      drawFrame._budgetWarned = true;
      toast('积木嵌套过深，本帧已截断（防止界面卡死）。请简化嵌套。', 'warn', 4200);
    }
  } else {
    drawFrame._budgetWarned = false;
  }
  state.ir = ir;
  state.order = ir.layers.map(l => l.id);
  const dpr = window.devicePixelRatio || 1;
  const px = Math.max(1, Math.round(ir.project.width * App.zoomNum * dpr));
  const py = Math.max(1, Math.round(ir.project.height * App.zoomNum * dpr));
  if (canvas.width !== px || canvas.height !== py) { canvas.width = px; canvas.height = py; }
  canvas.style.width = `${ir.project.width * App.zoomNum}px`;
  canvas.style.height = `${ir.project.height * App.zoomNum}px`;
  cctx.setTransform(App.zoomNum * dpr, 0, 0, App.zoomNum * dpr, 0, 0);
  render(state, cctx, { time: App.time, selectedLayerId: App.layerId, showSafeArea: App.showSafeArea, preview: true });
  cctx.setTransform(1, 0, 0, 1, 0, 0);
  updateTimecode();
  updateDebugPanels();
  // 字幕与波形跟随播放头
  if (App.subPanel) App.subPanel.setTime(App.time);
  if (App.audioDesk && App.audioTracks.length) App.audioDesk.setTime(App.time);
}

function tick(ts) {
  App.rafId = requestAnimationFrame(tick);
  if (!App.playing) return;
  const dt = App.lastTs ? (ts - App.lastTs) / 1000 : 0;
  App.lastTs = ts;
  App.time += dt;
  if (App.time >= App.ir.project.duration) {
    if (App.loop) App.time = 0;
    else { App.time = App.ir.project.duration; setPlaying(false); }
  }
  drawFrame();
  updatePlayhead();
}

function setPlaying(on) {
  App.playing = on;
  App.lastTs = 0;
  const b = document.querySelector('[data-act="play"]');
  b.textContent = on ? '⏸ 暂停' : '▶ 播放';
  b.classList.toggle('primary', !on);
  if (on) { App.rafId = requestAnimationFrame(tick); }
  else cancelAnimationFrame(App.rafId);
}

/* ============================================================
   舞台布局
   ============================================================ */
function layoutStage() {
  const wrap = $('stageWrap');
  const ir = App.ir;
  let z = App.zoom;
  if (z === 'fit') {
    const availW = wrap.clientWidth - 36;
    const availH = wrap.clientHeight - 36;
    z = Math.min(availW / ir.project.width, availH / ir.project.height);
    z = Math.max(0.05, Math.min(1.2, z));
  }
  App.zoomNum = parseFloat(z);
  const box = $('stageBox');
  box.style.width = `${ir.project.width * App.zoomNum}px`;
  box.style.height = `${ir.project.height * App.zoomNum}px`;
  drawFrame();
}
window.addEventListener('resize', () => layoutStage());

/* ============================================================
   时间轴 UI
   ============================================================ */
function buildRuler() {
  const r = $('ruler');
  r.innerHTML = '';
  const dur = App.ir.project.duration;
  const step = dur > 30 ? 5 : dur > 12 ? 2 : dur > 6 ? 1 : 0.5;
  for (let t = 0; t <= dur + 1e-6; t += step) {
    const d = document.createElement('div');
    d.className = 'tick';
    d.style.left = `${(t / dur) * 100}%`;
    const i = document.createElement('i');
    i.textContent = fmtTime(t);
    d.appendChild(i);
    r.appendChild(d);
  }
  buildMarkers();
  updatePlayhead();
}

function buildMarkers() {
  const ml = $('markerLayer');
  ml.innerHTML = '';
  const dur = App.ir.project.duration;
  for (const m of App.ir.markers) {
    const d = document.createElement('div');
    d.className = 'marker';
    d.style.left = `${(m.time / dur) * 100}%`;
    d.innerHTML = `<div class="head"></div><div class="stem"></div><div class="lbl">${escapeHtml(m.label)}</div>`;
    d.title = `${m.label} @ ${m.time.toFixed(2)}s — 拖动可调整，双击改名`;
    d.dataset.id = m.id;
    // 拖动改时间
    d.addEventListener('mousedown', (e) => startMarkerDrag(e, m));
    d.addEventListener('dblclick', (e) => { e.stopPropagation(); renameMarker(m); });
    ml.appendChild(d);
  }
}

function startMarkerDrag(e, m) {
  e.stopPropagation();
  const track = $('track');
  const rect = track.getBoundingClientRect();
  const dur = App.ir.project.duration;
  // 撤销点必须落在 mousedown 这一下（拖动开始前），不能放 mousemove：
  // 拖动过程中 mousemove 会触发几十上百次，每帧 pushUndo 会堆出
  // 几百个撤销点，Ctrl+Z 要按到手软才能退回去。参考 renameMarker 的写法。
  pushUndo();
  const onMove = (ev) => {
    const t = clamp((ev.clientX - rect.left) / rect.width, 0, 1) * dur;
    m.time = Math.round(t * 100) / 100;
    buildMarkers();
    drawFrame();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    markDirty();
    // 重新渲染积木（菜单里有标记名）
    BV.renderBlocks();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function renameMarker(m) {
  const name = prompt('标记点名称（积木里用它做锚点）：', m.label);
  if (name == null) return;
  pushUndo();
  m.label = name || m.label;
  buildMarkers(); BV.renderBlocks(); markDirty();
}

/** 跳到指定时间（字幕/波形面板点击时用） */
function setTime(t) {
  setPlaying(false);
  App.time = Math.max(0, Math.min(App.ir.project.duration, Number(t) || 0));
  updatePlayhead();
  drawFrame();
  return App.time;
}

function updatePlayhead() {
  const dur = App.ir.project.duration;
  const ph = $('playhead');
  ph.style.left = `${(App.time / dur) * 100}%`;
  const cur = [...$('markerLayer').children].find(c => Math.abs(parseFloat(c.style.left) - (App.time / dur) * 100) < 0.6);
  for (const c of $('markerLayer').children) c.style.background = (c === cur) ? 'rgba(255,176,32,.12)' : '';
  updateTimecode();
}

function updateTimecode() {
  const dur = App.ir.project.duration;
  $('timecode').textContent = `${fmtTime(App.time)} / ${fmtTime(dur)} · 第 ${Math.round(App.time * App.ir.project.fps)}/${Math.round(dur * App.ir.project.fps)} 帧`;
}

function seekFromEvent(e) {
  const track = $('track');
  const rect = track.getBoundingClientRect();
  const dur = App.ir.project.duration;
  App.time = clamp((e.clientX - rect.left) / rect.width, 0, 1) * dur;
  updatePlayhead();
  drawFrame();
}

/* ============================================================
   场景树
   ============================================================ */
function renderLayerTree() {
  const tree = $('layerTree');
  tree.innerHTML = '';
  for (const l of App.ir.layers) {
    const row = document.createElement('div');
    row.className = 'layer' + (l.id === App.layerId ? ' sel' : '');
    const eye = document.createElement('span');
    eye.className = 'eye' + (l.visible ? '' : ' off');
    eye.textContent = l.visible ? '◉' : '○';
    eye.title = '显示/隐藏';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      pushUndo();
      l.visible = !l.visible;
      if (App.sceneTree) {
        const n = App.sceneTree.find(l.id);
        if (n) n.visible = l.visible;
        // 重新扁平化，保证组隐藏时子图层不会因手动开关而“漏出来”
        syncSceneToIR();
      }
      renderLayerTree(); drawFrame(); markDirty();
    });
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = l.name;
    nm.title = '双击改名';
    nm.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const v = prompt('图层名称', l.name);
      if (v) { pushUndo(); l.name = v; renderLayerTree(); BV.renderBlocks(); drawFrame(); markDirty(); }
    });
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = (LAYER_TYPES[l.type] || {}).icon || '?';
    const add = document.createElement('span');
    add.className = 'eye';
    add.textContent = '＋';
    add.title = '在此图层下方新增';
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      addLayer(l.type);
    });
    row.appendChild(eye); row.appendChild(nm); row.appendChild(kind); row.appendChild(add);
    row.addEventListener('click', () => {
      App.layerId = l.id;
      BV.S.layerId = l.id;
      renderLayerTree(); BV.renderBlocks(); renderInspector(); drawFrame();
    });
    tree.appendChild(row);
  }
  renderGroupsInto(tree);
}

/** 把场景树里的「组」渲染到图层列表上方（组本身不在扁平图层里） */
function renderGroupsInto(tree) {
  if (!App.sceneTree) return;
  const groups = [];
  const walk = (node, depth) => {
    if (!node.isGroup) return;
    for (const c of node.children) {
      if (c.isGroup) { groups.push({ node: c, depth }); walk(c, depth + 1); }
    }
  };
  walk(App.sceneTree.root, 0);
  if (!groups.length) return;

  const head = document.createElement('div');
  head.style.cssText = 'padding:5px 10px 2px;font-size:10px;color:var(--muted);letter-spacing:.5px';
  head.textContent = `场景组（${groups.length}）`;
  tree.appendChild(head);

  for (const { node, depth } of groups) {
    const row = document.createElement('div');
    row.className = 'layer tree-row is-group';
    row.style.paddingLeft = (10 + depth * 14) + 'px';
    row.title = '组：整体控制可见性与不透明度';

    const eye = document.createElement('span');
    eye.className = 'eye' + (node.visible ? '' : ' off');
    eye.textContent = node.visible ? '◉' : '○';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      node.visible = !node.visible;
      // 组的可见性要写进 IR，否则保存/导出时丢失
      syncSceneToIR();
      renderLayerTree(); drawFrame(); markDirty();
    });
    row.appendChild(eye);

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = '▣ ' + node.name;
    nm.title = `包含 ${node.children.length} 个子节点`;
    row.appendChild(nm);

    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = `×${node.children.length}`;
    row.appendChild(kind);

    // 透明度快调
    const op = document.createElement('span');
    op.className = 'eye';
    op.textContent = Math.round((node.opacity == null ? 1 : node.opacity) * 100) + '%';
    op.title = '点击在 0/25/50/100% 之间切换';
    op.addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = node.opacity == null ? 1 : node.opacity;
      const steps = [1, 0.75, 0.5, 0.25];
      node.opacity = steps[(steps.indexOf(cur) + 1) % steps.length];
      syncSceneToIR();
      renderLayerTree(); drawFrame(); markDirty();
    });
    row.appendChild(op);

    row.addEventListener('click', () => {
      App.selectedGroupId = node.id;
      renderLayerTree();
    });

    tree.appendChild(row);

    // 子节点缩进展示（只读高亮，点击跳到对应图层）
    for (const c of node.children) {
      if (c.isGroup) continue;
      const sub = document.createElement('div');
      sub.className = 'layer tree-child';
      sub.style.paddingLeft = (10 + (depth + 1) * 14) + 'px';
      sub.style.opacity = '.78';
      sub.innerHTML = `<span class="eye${c.visible ? '' : ' off'}">${c.visible ? '◉' : '○'}</span>` +
        `<span class="nm">${c.masterId ? '⧉ ' : ''}${c.name}</span>` +
        `<span class="kind">${(LAYER_TYPES[c.type] || {}).icon || '?'}</span>`;
      sub.addEventListener('click', () => {
        App.layerId = c.id; BV.S.layerId = c.id;
        renderLayerTree(); BV.renderBlocks(); renderInspector(); drawFrame();
      });
      tree.appendChild(sub);
    }
  }
}

function addLayer(type = 'rect') {
  withUndo(() => {
    const l = newLayer(`图层${App.ir.layers.length + 1}`, type);
    App.ir.layers.splice(App.ir.layers.length, 0, l);
    App.layerId = l.id;
    BV.S.layerId = l.id;
  });
  if (App.sceneTree) App.sceneTree.syncFromLayers(App.ir.layers);
  renderLayerTree(); BV.renderBlocks(); renderInspector(); drawFrame();
  toast('已新增图层', 'ok');
}

function deleteLayer() {
  if (App.ir.layers.length <= 1) { toast('至少保留一个图层', 'err'); return; }
  const idx = App.ir.layers.findIndex(l => l.id === App.layerId);
  if (idx < 0) return;
  const name = App.ir.layers[idx].name;
  if (!confirm(`删除图层「${name}」？其积木逻辑会一并删除。`)) return;
  withUndo(() => {
    App.ir.layers.splice(idx, 1);
    App.layerId = App.ir.layers[Math.max(0, idx - 1)].id;
    BV.S.layerId = App.layerId;
  });
  if (App.sceneTree) App.sceneTree.syncFromLayers(App.ir.layers);
  renderLayerTree(); BV.renderBlocks(); renderInspector(); drawFrame();
  toast('已删除图层');
}

/* ============================================================
   属性面板（图层属性）
   ============================================================ */
function renderLayerProps() {
  const box = $('layerProps');
  const l = App.ir.layers.find(x => x.id === App.layerId);
  box.innerHTML = '';
  if (!l) { box.innerHTML = '<div class="hint">未选中图层</div>'; return; }

  box.appendChild(field('名称', inputText(l.name, (v) => { pushUndo(); l.name = v; renderLayerTree(); BV.renderBlocks(); drawFrame(); markDirty(); })));
  box.appendChild(field('类型', selectEl(Object.entries(LAYER_TYPES).map(([k, v]) => [v.label, k]), l.type, (v) => {
    pushUndo();
    l.type = v;
    l.props = Object.assign({}, newLayer(l.name, v).props, { x: l.props.x, y: l.props.y, opacity: l.props.opacity });
    renderLayerProps(); BV.renderBlocks(); drawFrame(); markDirty();
  })));

  box.appendChild(field('X', inputNum(l.props.x, (v) => setProp(l, 'x', v))));
  box.appendChild(field('Y', inputNum(l.props.y, (v) => setProp(l, 'y', v))));
  box.appendChild(field('不透明度', inputNum(l.props.opacity, (v) => setProp(l, 'opacity', clamp(v, 0, 1)))));

  if (l.type === 'text') {
    box.appendChild(field('内容', inputText(l.props.text || '', (v) => { pushUndo(); l.props.text = v; drawFrame(); markDirty(); }), true));
    box.appendChild(field('字号', inputNum(l.props.fontSize, (v) => setProp(l, 'fontSize', v))));
    box.appendChild(field('字重', selectEl([['300 细', 300], ['400', 400], ['600', 600], ['700', 700], ['900 粗', 900]], String(l.props.fontWeight || 700), (v) => setProp(l, 'fontWeight', +v))));
    box.appendChild(field('颜色', inputColor(l.props.fill || '#ffffff', (v) => setProp(l, 'fill', v))));
    box.appendChild(field('对齐', selectEl([['左', 'left'], ['中', 'center'], ['右', 'right']], l.props.align || 'left', (v) => setProp(l, 'align', v))));
    box.appendChild(field('字距', inputNum(l.props.letterSpacing, (v) => setProp(l, 'letterSpacing', v))));
    box.appendChild(field('阴影', inputNum(l.props.shadow, (v) => setProp(l, 'shadow', v))));
  } else if (l.type !== 'image') {
    box.appendChild(field('宽', inputNum(l.props.w, (v) => setProp(l, 'w', v))));
    box.appendChild(field('高', inputNum(l.props.h, (v) => setProp(l, 'h', v))));
    box.appendChild(field('圆角', inputNum(l.props.radius, (v) => setProp(l, 'radius', v))));
    box.appendChild(field('填充', inputColor(l.props.fill || '#4a8cff', (v) => setProp(l, 'fill', v))));
  } else {
    box.appendChild(field('图片', inputText(l.props.src || '', (v) => setProp(l, 'src', v), 'URL 或 data: URI'), true));
    box.appendChild(field('宽', inputNum(l.props.w, (v) => setProp(l, 'w', v))));
    box.appendChild(field('高', inputNum(l.props.h, (v) => setProp(l, 'h', v))));
  }
  box.appendChild(field('旋转°', inputNum(l.props.rotation, (v) => setProp(l, 'rotation', v))));

  const d = document.createElement('div');
  d.className = 'hint';
  d.innerHTML = `该图层有 <b>${countBlocks(l.blocks)}</b> 个积木。默认状态由「图层属性」决定，<b>积木可以覆盖它</b>（动效类积木会改写 x/y/透明度/缩放）。`;
  box.appendChild(d);
}

function setProp(l, k, v) {
  pushUndo();
  l.props[k] = v;
  if (k === 'opacity' && App.sceneTree) {
    const n = App.sceneTree.find(l.id);
    if (n && !n.isGroup) {
      n.opacity = v;
      // 立即重新扁平化，否则组的不透明度倍率会被这次单层修改暂时覆盖
      syncSceneToIR();
    }
  }
  drawFrame();
  markDirty();
}

function countBlocks(list) {
  let n = 0;
  for (const b of list || []) {
    n++;
    if (b.slots) for (const s of b.slots) if (Array.isArray(s.value)) n += countBlocks(s.value);
  }
  return n;
}

/* ---------- 属性检查器（选中积木时显示） ---------- */
function renderInspector() {
  const box = $('inspector');
  const sel = App.selectedBlock && BV.findBlockDeep(App.ir, App.selectedBlock);
  if (!sel) {
    const l = App.ir.layers.find(x => x.id === App.layerId);
    box.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'hint';
    h.innerHTML = '未选中积木。<br><br>在右侧积木画布里点击一个积木，这里会显示它的说明与执行信息。<br><br>当前图层：<b>' + escapeHtml(l ? l.name : '-') + '</b>';
    box.appendChild(h);
    const h2 = document.createElement('div');
    h2.className = 'hint';
    h2.innerHTML = '<b>渲染一致性</b><br>预览与导出共用同一个 <code>render()</code>，只有分辨率不同，因此不会出现「预览和成片长得不一样」。';
    box.appendChild(h2);
    renderLayerProps();
    return;
  }
  const def = defOf(sel.op);
  box.innerHTML = '';
  const t1 = document.createElement('div');
  t1.className = 'hint';
  t1.innerHTML = `<b>${escapeHtml(def ? def.label : sel.op)}</b> <code>${sel.op}</code><br>${escapeHtml(def ? (def.desc || '') : '未知积木')}`;
  box.appendChild(t1);

  const t2 = document.createElement('div');
  t2.className = 'hint';
  t2.innerHTML = `类型：${sel.k === 'N' ? '表达式（N）' : '语句（C）'}<br>嵌套子积木：${countBlocks(sel.slots ? sel.slots.filter(s => Array.isArray(s.value)).map(s => s.value) : [])}<br>ID：<code>${sel.id}</code>`;
  box.appendChild(t2);

  if (sel.k === 'C' && sel.slots) {
    for (let i = 0; i < sel.slots.length; i++) {
      const s = sel.slots[i];
      if (!s || Array.isArray(s.value)) continue;
      box.appendChild(field(s.label || `参数 ${i + 1}`, paramEditor(sel, i, s), false));
    }
  }

  const bp = document.createElement('button');
  bp.className = 'insertBtn';
  bp.style.marginTop = '8px';
  bp.textContent = dbg.breakpoints.has(sel.id) ? '● 取消断点' : '○ 设断点';
  bp.addEventListener('click', () => {
    dbg.toggleBp(sel.id);
    renderInspector();
    updateDebugPanels();
    toast(dbg.breakpoints.has(sel.id) ? '已在该积木设断点' : '已取消断点');
  });
  box.appendChild(bp);

  const probe = document.createElement('button');
  probe.className = 'insertBtn';
  probe.style.marginTop = '6px';
  probe.textContent = App.selectedBlock === App.probeLayer ? '◉ 取消属性探针' : '◌ 设为属性探针';
  probe.addEventListener('click', () => {
    App.probeLayer = App.selectedBlock === App.probeLayer ? null : App.layerId;
    dbg.probe = App.probeLayer;
    renderInspector();
    updateDebugPanels();
  });
  box.appendChild(probe);

  renderLayerProps();
}

function paramEditor(block, idx, slot) {
  const v = slot.value;
  if (v && typeof v === 'object' && (v.k === 'blk' || v.k === 'audio')) {
    const d = document.createElement('button');
    d.className = 'insertBtn';
    d.textContent = v.k === 'audio' ? `♪ 音频变量：${v.metric}` : `表达式积木：${defOf(v.op) ? defOf(v.op).label : v.op}（点击编辑）`;
    d.addEventListener('click', () => openExprEditor(block.id, `${block.slots.indexOf(slot)}`));
    return d;
  }
  // 注意：这些回调只重绘画面，不重建面板，避免输入控件失焦
  if (slot.menu) {
    return selectEl(menuOpts(slot), String(v && v.v), (nv) => {
      pushUndo();
      const nd = defaultForType(slot.type);
      nd.v = nv;
      slot.value = nd;
      drawFrame(); markDirty(); syncBlockPin(slot);
    });
  }
  if (slot.type === 'col') return inputColor(v && v.v, (nv) => { pushUndo(); slot.value = COL(nv); drawFrame(); markDirty(); syncBlockPin(slot); });
  if (slot.type === 'bool') return selectEl([['是', true], ['否', false]], String(!!(v && v.v)), (nv) => { pushUndo(); slot.value = BOOL(nv === 'true'); drawFrame(); markDirty(); syncBlockPin(slot); });
  if (slot.type === 'num' || slot.type === 'time') return inputNum(v && v.v, (nv) => { pushUndo(); slot.value = slot.type === 'time' ? TIME(nv) : NUM(nv); drawFrame(); markDirty(); syncBlockPin(slot); });
  return inputText(v && v.v, (nv) => { pushUndo(); slot.value = STR(nv); drawFrame(); markDirty(); syncBlockPin(slot); });
}

/* 把积木画布里对应的槽位控件同步为最新值（不重建整棵树） */
function syncBlockPin(slot) {
  const root = $('blockCanvas');
  if (!root) return;
  for (const pin of root.querySelectorAll('.pin[data-slot="1"]')) {
    const owner = BV.findBlockDeep(App.ir, pin.dataset.owner);
    if (!owner || owner.k === 'N') continue;
    const idx = parseInt(pin.dataset.path, 10);
    if (!owner.slots || owner.slots[idx] !== slot) continue;
    const v = slot.value && slot.value.v !== undefined ? slot.value.v : '';
    if (pin.tagName === 'INPUT') pin.value = v;
    else if (pin.tagName === 'SELECT') pin.value = String(v);
  }
}

function menuOpts(slot) {
  if (slot.menu === 'markers') return [['', '（无标记）'], ...App.ir.markers.map(m => [m.label, `${m.label}`])];
  if (slot.menu === 'layersText') return App.ir.layers.filter(l => l.type === 'text').map(l => [l.name, l.name]);
  if (slot.menu === 'layersShape') return App.ir.layers.filter(l => l.type !== 'text').map(l => [l.name, l.name]);
  if (slot.menu === 'targets') return [['', '（当前图层）'], ...App.ir.layers.map(l => [l.name, l.name])];
  if (slot.menu === 'easings') return EASINGS.map(e => [e[0], e[1]]);
  if (Array.isArray(slot.menu)) return slot.menu.map(x => [x, ({ whole: '整块', line: '逐行', word: '逐词', char: '逐字', left: '从左', right: '从右', up: '从上', down: '从下', backOut: '回弹', elasticOut: '弹性', bounceOut: '弹跳', outCubic: '强渐出', outBack: '回弹', linear: '线性', inOutCubic: '强渐入渐出' })[x] || x]);
  return [['', '（无）']];
}

/* ============================================================
   项目设置
   ============================================================ */
function renderProjectSettings() {
  const box = $('projSettings');
  box.innerHTML = '';
  const p = App.ir.project;
  box.appendChild(field('工程名', inputText(p.name, (v) => { p.name = v; App.title = v; markDirty(); })));
  box.appendChild(field('时长s', inputNum(p.duration, (v) => {
    pushUndo();
    p.duration = Math.max(0.1, v);
    $('durationInput').value = p.duration;
    App.audio.setDuration(p.duration);
    buildRuler(); drawFrame(); markDirty();
  })));
  box.appendChild(field('背景', inputColor(p.background || '#000000', (v) => { p.background = v; drawFrame(); markDirty(); })));
  box.appendChild(field('响度LUFS', inputNum(p.loudnessTarget, (v) => { p.loudnessTarget = v; markDirty(); })));
  box.appendChild(field('BPM', inputNum(App.audio.bpm, (v) => { App.audio.bpm = Math.max(20, v); drawFrame(); markDirty(); })));

  const mk = document.createElement('button');
  mk.className = 'insertBtn';
  mk.textContent = '＋ 新增标记点';
  mk.style.marginTop = '6px';
  mk.addEventListener('click', () => {
    pushUndo();
    App.ir.markers.push({ id: uid('M'), time: Math.round(App.time * 100) / 100, label: `标记${App.ir.markers.length + 1}`, color: '#ffb020' });
    buildMarkers(); BV.renderBlocks(); drawFrame(); markDirty();
    toast('已新增标记点');
  });
  box.appendChild(mk);

  const hb = document.createElement('button');
  hb.className = 'insertBtn';
  hb.textContent = App.showSafeArea ? '☑ 安全区参考线' : '☐ 安全区参考线';
  hb.style.marginTop = '6px'; hb.style.marginLeft = '6px';
  hb.addEventListener('click', () => { App.showSafeArea = !App.showSafeArea; renderProjectSettings(); drawFrame(); });
  box.appendChild(hb);
}

function syncProjectToUI() {
  const p = App.ir.project;
  $('presetSelect').value = `${p.width}x${p.height}`;
  if ($('presetSelect').value !== `${p.width}x${p.height}`) {
    // 自定义尺寸
    const o = document.createElement('option');
    o.value = `${p.width}x${p.height}`;
    o.textContent = `自定义 ${p.width}×${p.height}`;
    $('presetSelect').appendChild(o);
    $('presetSelect').value = o.value;
  }
  $('fpsSelect').value = String(p.fps);
  $('durationInput').value = p.duration;
  $('zoomSelect').value = App.zoom;
}

/* ============================================================
   积木库抽屉
   ============================================================ */
function buildPalette() {
  const box = $('paletteBody');
  box.innerHTML = '';
  for (const cat of categories()) {
    const g = document.createElement('div');
    g.className = 'pl-group';
    const h = document.createElement('h4');
    h.textContent = cat.label;
    g.appendChild(h);
    const d = document.createElement('div');
    d.className = 'pl-desc';
    d.textContent = cat.desc || '';
    g.appendChild(d);
    const items = document.createElement('div');
    items.className = 'pl-items';
    for (const def of cat.defs) {
      const it = document.createElement('div');
      it.className = 'pl-item';
      it.style.setProperty('--bc', def.color);
      it.textContent = (def.isLeaf ? 'N ' : 'C ') + def.label;
      it.title = def.desc || '';
      it.addEventListener('mousedown', (e) => { e.preventDefault(); BV.startDragFromPalette(def.op, e); });
      items.appendChild(it);
    }
    g.appendChild(items);
    box.appendChild(g);
  }
}

/* ============================================================
   表达式编辑器
   ============================================================ */
function openExprEditor(ownerId, path) {
  const owner = BV.findBlockDeep(App.ir, ownerId);
  if (!owner) return;
  let current = null;
  if (owner.k === 'N') current = owner[path] || NUM(0);
  else {
    const idx = parseInt(path, 10);
    const slot = owner.slots && owner.slots[idx];
    if (!slot) return;
    current = slot.value;
  }

  const pop = document.createElement('div');
  pop.className = 'exprpop';
  const rect = canvas.getBoundingClientRect();
  pop.style.left = `${Math.max(10, Math.min(window.innerWidth - 400, window.innerWidth / 2 - 196))}px`;
  pop.style.top = `${Math.min(window.innerHeight - 480, Math.max(60, rect.top + rect.height / 2 - 180))}px`;

  pop.innerHTML = `
    <div class="pop-head"><span>表达式编辑器</span><button data-x>✕</button></div>
    <div class="pop-body">
      <div class="hint" style="margin:0 0 8px">当前槽位里的值。可以选纯数值，也可以拼一个表达式积木。</div>
      <div id="exValue"></div>
      <div class="hint" style="margin:12px 0 6px">插入表达式积木：</div>
      <div class="pl-items" id="exBlocks"></div>
      <div id="exprHint">提示：<code>实时振幅</code> 与 <code>节拍脉冲</code> 是「音频驱动画面」的核心变量；把 <code>时间</code> 积木放进表达式可以得到连续变化的数值。</div>
    </div>
    <div class="pop-foot">
      <button data-clear>清空为 0</button>
      <button data-ok class="pri">确定</button>
    </div>`;
  document.body.appendChild(pop);

  const valBox = pop.querySelector('#exValue');
  let staged = current;
  renderValue();
  function renderValue() {
    valBox.innerHTML = '';
    if (staged && typeof staged === 'object' && staged.k === 'blk') {
      const d = defOf(staged.op);
      const chip = document.createElement('span');
      chip.className = 'exprmini';
      chip.textContent = `${d ? d.label : staged.op}(${[staged.a, staged.b, staged.c].map(fmtVal).filter(Boolean).join(', ')})`;
      valBox.appendChild(chip);
    } else {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.className = 'pin num';
      inp.style.minWidth = '120px';
      inp.value = staged && staged.v !== undefined ? staged.v : 0;
      inp.addEventListener('input', () => { staged = NUM(parseFloat(inp.value) || 0); });
      valBox.appendChild(inp);
    }
  }

  const bl = pop.querySelector('#exBlocks');
  const exprDefs = BLOCK_DEFS.filter(d => d.isLeaf);
  for (const def of exprDefs) {
    const it = document.createElement('div');
    it.className = 'pl-item';
    it.style.setProperty('--bc', def.color);
    it.textContent = def.label;
    it.title = def.desc || '';
    it.addEventListener('click', () => {
      staged = BV.createBlock(def.op);
      renderValue();
    });
    bl.appendChild(it);
  }

  pop.querySelector('[data-x]').addEventListener('click', () => pop.remove());
  pop.querySelector('[data-clear]').addEventListener('click', () => { staged = NUM(0); renderValue(); });
  pop.querySelector('[data-ok]').addEventListener('click', () => {
    pushUndo();
    if (owner.k === 'N') owner[path] = staged;
    else if (owner.slots && owner.slots[parseInt(path, 10)]) owner.slots[parseInt(path, 10)].value = staged;
    pop.remove();
    BV.renderBlocks(); renderInspector(); drawFrame(); markDirty();
  });
  // 点外部关闭
  const closer = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', closer); } };
  setTimeout(() => document.addEventListener('mousedown', closer), 0);
}

function fmtVal(v) {
  if (v == null) return '';
  if (typeof v === 'object' && v.k === 'lit') return String(v.v);
  if (typeof v === 'object' && v.k === 'blk') return `${defOf(v.op) ? defOf(v.op).label : v.op}(…)`;
  return String(v);
}

/* ============================================================
   积木菜单 / 图层菜单
   ============================================================ */
function openBlockMenu(id, anchor) {
  const b = BV.findBlockDeep(App.ir, id);
  if (!b) return;
  showContext(anchor, [
    { label: '复制积木', act: () => dupBlock(id) },
    { label: '删除积木', act: () => delBlock(id) },
    { label: dbg.breakpoints.has(id) ? '取消断点' : '设为断点', act: () => { dbg.toggleBp(id); toast(dbg.breakpoints.has(id) ? '已设断点' : '已取消断点'); renderInspector(); updateDebugPanels(); } },
    { label: '复制为积木文本', act: () => copyBlockAsText(b) },
  ]);
}

function copyBlockAsText(b) {
  const one = {
    version: '1.0',
    project: Object.assign({}, App.ir.project, { duration: 0.1 }),
    markers: [], variables: [],
    layers: [{ id: 'x', name: '片段', type: 'rect', visible: false, props: { x: 0, y: 0, opacity: 1, rotation: 0, w: 100, h: 100, radius: 0, fill: '#000', stroke: '', strokeWidth: 0 }, blocks: [clone(b)] }],
  };
  const txt = toText(one);
  if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => toast('已复制为积木文本', 'ok'), () => showTextFallback('积木文本', txt));
  else showTextFallback('积木文本', txt);
}

function showTextFallback(title, text) {
  showModal(title, `<p>复制下面的内容：</p><textarea class="code" readonly>${escapeHtml(text)}</textarea>`, [{ label: '关闭', cls: 'pri', act: closeModal }]);
}

function openLayerMenu(layerId) {
  const anchor = document.querySelector(`[data-act="layerMenu"][data-layer="${layerId}"]`);
  showContext(anchor, [
    { label: '在此后插入时间轴积木', act: () => insertBlocks(['wait', 'setAt', 'atMarker', 'after', 'loop', 'parallel'], anchor) },
    { label: '插入文字积木', act: () => insertBlocks(['showText', 'setText', 'splitBy', 'stagger', 'charPopIn', 'maskWipe', 'typewriter', 'numberRoll'], anchor) },
    { label: '插入动效积木', act: () => insertBlocks(['fadeIn', 'fadeOut', 'moveIn', 'scaleIn'], anchor) },
    { label: '插入图形/音频积木', act: () => insertBlocks(['growBar', 'drawLine', 'repeater', 'audioBars', 'ringSpectrum', 'particles'], anchor) },
    { label: '清空该图层积木', act: () => { if (confirm('清空该图层的全部积木？')) { pushUndo(); App.ir.layers.find(l => l.id === layerId).blocks = []; BV.renderBlocks(); drawFrame(); markDirty(); } } },
  ]);
}

function insertBlocks(ops, anchor) {
  const l = App.ir.layers.find(x => x.id === App.layerId);
  if (!l) return;
  showContext(anchor || null, [], ops.map(op => ({
    label: defOf(op).label,
    act: () => {
      withUndo(() => {
        const b = BV.createBlock(op);
        // 目标类槽位默认指向当前图层
        if (b.slots) for (const s of b.slots) {
          if (s.menu === 'layersText' || s.menu === 'layersShape' || s.menu === 'targets') s.value = SEL(l.name);
        }
        l.blocks.push(b);
      });
      BV.renderBlocks(); drawFrame();
    },
  })));
}

function showContext(anchor, items, raw) {
  document.querySelectorAll('.ctxmenu').forEach(n => n.remove());
  const m = document.createElement('div');
  m.className = 'ctxmenu';
  m.style.cssText = 'position:fixed;z-index:300;background:#232733;border:1px solid #3c4254;border-radius:8px;padding:5px;box-shadow:0 12px 34px rgba(0,0,0,.55);min-width:200px';
  const r = anchor ? anchor.getBoundingClientRect() : { left: 300, bottom: 300 };
  for (const it of (raw || items)) {
    const d = document.createElement('div');
    d.style.cssText = 'padding:6px 10px;border-radius:5px;cursor:pointer;font-size:12px';
    d.textContent = it.label;
    d.addEventListener('mouseenter', () => d.style.background = '#4a8cff');
    d.addEventListener('mouseleave', () => d.style.background = '');
    d.addEventListener('click', () => { m.remove(); it.act(); });
    m.appendChild(d);
  }
  document.body.appendChild(m);
  m.style.left = `${Math.min(window.innerWidth - 220, r.left)}px`;
  m.style.top = `${Math.min(window.innerHeight - 300, r.bottom + 4)}px`;
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', close); } };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

function dupBlock(id) {
  const par = BV.findBlockParent(App.ir, id);
  if (!par) return;
  withUndo(() => {
    const c = clone(par.list[par.index]);
    reuid(c);
    par.list.splice(par.index + 1, 0, c);
  });
  BV.renderBlocks(); drawFrame();
}
function delBlock(id) {
  const par = BV.findBlockParent(App.ir, id);
  if (!par) return;
  withUndo(() => { par.list.splice(par.index, 1); });
  App.selectedBlock = null;
  BV.renderBlocks(); renderInspector(); drawFrame();
}
function reuid(o) {
  if (!o || typeof o !== 'object') return;
  if (o.id) o.id = uid('B');
  if (o.slots) for (const s of o.slots) if (Array.isArray(s.value)) for (const b of s.value) reuid(b);
}

/* ============================================================
   文件操作
   ============================================================ */
function newProject() {
  if (!confirm('新建工程会清空当前内容，继续？')) return;
  pushUndo();
  App.ir = defaultProject('新建工程');
  App.audio = defaultAudio(App.ir);
  resetAudioState();
  App.layerId = App.ir.layers[1].id;
  App.time = 0;
  BV.S.ir = App.ir; BV.S.layerId = App.layerId;
  dbg.reset(App.ir);
  syncSubtitlePanel(App.ir);
  syncProjectToUI(); renderLayerTree(); BV.renderBlocks(); renderInspector(); renderProjectSettings(); buildRuler(); layoutStage(); drawFrame();
  toast('已新建工程', 'ok');
}

function saveJSON() {
  try {
    EX.download(EX.exportJSON(App.ir), `${App.ir.project.name || 'project'}.json`);
    markClean();
    toast('工程已导出为 JSON', 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

function saveBlocks() {
  EX.download(EX.exportBlocksText(App.ir), `${App.ir.project.name || 'project'}.blocks.txt`);
  toast('积木文本已导出', 'ok');
}

function openFile() {
  $('fileInput').click();
}
$('fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const text = await f.text();
  try {
    let ir;
    if (f.name.endsWith('.json')) {
      ir = JSON.parse(text);
      const errs = validate(ir);
      if (errs.length) throw new Error(errs.join('；'));
    } else {
      const r = fromText(text, BLOCK_DEFS);
      ir = r.ir;
      if (r.notes.length) toast(r.notes.join('；'), 'err', 4000);
    }
    pushUndo();
    App.ir = ir;
    App.audio = defaultAudio(ir);
    resetAudioState();
    App.layerId = ir.layers[0] && ir.layers[0].id;
    App.time = 0;
    BV.S.ir = ir; BV.S.layerId = App.layerId;
    dbg.reset(ir);
    syncSubtitlePanel(ir);
    syncProjectToUI(); renderLayerTree(); BV.renderBlocks(); renderInspector(); renderProjectSettings(); buildRuler(); layoutStage(); drawFrame();
    toast(`已载入 ${f.name}`, 'ok');
  } catch (err) {
    toast('载入失败：' + err.message, 'err', 4000);
  }
  e.target.value = '';
});

/* ============================================================
   导出
   ============================================================ */
function showExportUI(title) {
  $('exportLayer').classList.remove('hidden');
  $('exportTitle').textContent = title;
  $('exportBar').style.width = '0%';
  $('exportInfo').textContent = '准备中…';
  App.exportCancel = false;
}
function hideExportUI() { $('exportLayer').classList.add('hidden'); }
function setExportProgress(p, info) {
  $('exportBar').style.width = `${Math.round(p * 100)}%`;
  $('exportInfo').textContent = info;
}

async function doExportPNG() {
  showExportUI('导出当前帧 PNG');
  try {
    const blob = await EX.exportPNG(App.ir, App.audioSource || App.audio, App.time);
    EX.download(blob, `${App.ir.project.name}_${fmtTime(App.time).replace(':', '-')}.png`);
    setExportProgress(1, '完成');
    toast('PNG 已导出', 'ok');
  } catch (e) {
    setExportProgress(0, e.message);
    toast('导出失败：' + e.message, 'err');
  }
  setTimeout(hideExportUI, 500);
}

function exportDialog() {
  const ir = App.ir;
  const dur = ir.project.duration;
  showModal('导出', [
    el2('h4', {}, '选择格式'),
    el2('div', { id: 'exportFormats', class: 'fmt-grid' }),
    el2('div', { class: 'field' }, [
      el2('label', {}, '帧率'),
      el2('select', { id: 'exFps' }, [12, 24, 25, 30, 60].map(f =>
        el2('option', { value: f, selected: f === ir.project.fps ? 'selected' : null }, String(f)))),
    ]),
    el2('div', { class: 'field' }, [
      el2('label', {}, '缩放'),
      el2('select', { id: 'exScale' }, [0.5, 1, 2].map(s =>
        el2('option', { value: s, selected: s === 1 ? 'selected' : null },
          `${Math.round(ir.project.width * s)}×${Math.round(ir.project.height * s)}`))),
    ]),
    el2('div', { class: 'field' }, [
      el2('label', {}, '区间'),
      el2('input', { id: 'exFrom', type: 'number', step: '0.1', value: '0' }),
      el2('input', { id: 'exTo', type: 'number', step: '0.1', value: String(dur) }),
    ]),
    el2('h4', {}, '工程文件'),
    el2('div', { class: 'field' }, [
      el2('button', { onClick: () => { closeModal(); saveJSON(); } }, '导出工程 JSON'),
      el2('button', { onClick: () => { closeModal(); saveBlocks(); } }, '导出积木文本'),
    ]),
    el2('div', { class: 'hint' },
      '所有格式都走同一个 render()，导出结果与预览逐帧一致。MP4 在 Chrome/Edge 上用 WebCodecs 硬件编码，其它环境自动降级。'),
  ], [
    { label: '取消', cls: '' },
    { label: '开始导出', cls: 'primary', onClick: async () => { closeModal(); await doExportVideo(); } },
  ]);
  renderExportFormats();
}

/** 统一视频导出入口（PNG 序列 / GIF / MP4 / WebM） */
async function doExportVideo() {
  const ir = App.ir;
  const fmt = App.exportFormat || 'mp4';
  const fps = Number($('exFps') ? $('exFps').value : ir.project.fps) || ir.project.fps;
  const scale = Number($('exScale') ? $('exScale').value : 1) || 1;
  const from = Number($('exFrom') ? $('exFrom').value : 0) || 0;
  const to = Number($('exTo') ? $('exTo').value : ir.project.duration) || ir.project.duration;

  showExportProgress(fmt, from, to);
  App.exportCancel = false;
  const onProgress = (p, msg) => setExportProgress(p, msg);

  try {
    // 短 GIF 走自带编码器；其余统一走 video-export
    const blob = await exportVideo(ir, App.audioSource || App.audio, {
      format: fmt === 'mp4_h265' ? 'mp4' : fmt,
      codec: fmt === 'mp4_h265' ? 'h265' : undefined,
      fps, scale, from, to,
      gifMaxWidth: 640,
      onProgress,
      shouldCancel: () => App.exportCancel,
    });

    // 有真实音频且格式是 mp4 → 尝试把音轨也合进去
    let outBlob = blob;
    if (fmt.startsWith('mp4') && App.audioTracks.length) {
      try {
        // mixTracks(tracks, duration, opts) 返回的是 Float32Array 本身，
        // 不是 {samples, sampleRate}。而且 duration 是必需参数：
        // 漏传会让 Math.ceil(undefined * sr) 得到 NaN，整段抛错，
        // 被下面的 catch 吞掉 → 导出看起来成功，实际永远是无声版本。
        const sampleRate = 48000;
        const fullDuration = Math.max(
          to,
          ...App.audioTracks.map(tr => (tr.start || 0) + (tr.samples.length / (tr.sampleRate || 48000))),
        );
        const mixed = mixTracks(App.audioTracks, fullDuration, { sampleRate });
        if (!mixed || !mixed.length) {
          throw new Error('混音结果为空');
        }
        // 导出区间不是从 0 开始时，音轨必须同步裁到 [from, to]，否则音画错位
        const startSample = Math.max(0, Math.round(from * sampleRate));
        const endSample = Math.min(mixed.length, Math.round(to * sampleRate));
        const clip = mixed.slice(startSample, endSample);
        if (!clip.length) throw new Error('所选区间内没有音频');
        const res = await exportWithAudio(blob, clip, sampleRate, {});
        if (res && res.muxed) { outBlob = res.video; toast('视频与音频已合成', 'ok'); }
        else if (res && res.audio) {
          EX.download(blob, '无声成片.mp4');
          EX.download(res.audio, '音轨.wav');
          toast('本机无 ffmpeg，已分别给出视频与音频', 'warn', 5000);
          setExportProgress(1, '完成（视频与音频分开）');
          setTimeout(hideExportUI, 900);
          return;
        }
      } catch (e) {
        toast('音视频合成失败，导出无声版本：' + e.message, 'warn', 5000);
      }
    }

    const ext = FORMAT_PRESETS[fmt] ? FORMAT_PRESETS[fmt].ext : 'mp4';
    EX.download(outBlob, `${ir.project.name || '成片'}.${ext}`);
    setExportProgress(1, '完成');
    setTimeout(hideExportUI, 700);
    toast(`已导出 ${ext.toUpperCase()}`, 'ok');
  } catch (e) {
    setExportProgress(0, e.message);
    setTimeout(hideExportUI, 1200);
    if (e.code === 'NO_MP4_SUPPORT') {
      toast('本环境不支持 MP4，请改用 WebM 或 PNG 序列帧', 'err', 5000);
    } else {
      toast('导出失败：' + e.message, 'err', 5000);
    }
  }
}

function showExportProgress(fmt, from, to) {
  const p = FORMAT_PRESETS[fmt];
  const frames = Math.max(1, Math.round((to - from) * (App.ir.project.fps || 24)));
  showExportUI(`导出 ${p ? p.label : fmt}`);
  setExportProgress(0, `共 ${frames} 帧`);
}

async function doExportFrames() {
  const fps = parseInt($('exFps') ? $('exFps').value : App.ir.project.fps, 10);
  const scale = parseFloat($('exScale') ? $('exScale').value : 1);
  const from = parseFloat($('exFrom') ? $('exFrom').value : 0);
  const to = parseFloat($('exTo') ? $('exTo').value : App.ir.project.duration);
  showExportUI('导出 PNG 序列帧');
  try {
    const blob = await EX.exportFrames(App.ir, App.audio, { fps, scale, from, to, name: 'frame' },
      (p, info) => setExportProgress(p * 0.95, info), () => App.exportCancel);
    EX.download(blob, `${App.ir.project.name}_frames_${fps}fps.zip`);
    setExportProgress(1, `完成 · ${Math.round((to - from) * fps)} 帧`);
    toast('PNG 序列帧已导出', 'ok');
  } catch (e) {
    setExportProgress(0, e.message);
    toast(e.message, e.message === '已取消' ? '' : 'err');
  }
  setTimeout(hideExportUI, 700);
}

async function doExportGIF() {
  const fps = parseInt($('gifFps') ? $('gifFps').value : 12, 10);
  const from = parseFloat($('gifFrom') ? $('gifFrom').value : 0);
  const to = parseFloat($('gifTo') ? $('gifTo').value : 4);
  showExportUI('导出 GIF（自带编码器）');
  try {
    const blob = await EX.exportGIF(App.ir, App.audio, { fps, from, to, scale: 1 },
      (p, info) => setExportProgress(p, info), () => App.exportCancel);
    EX.download(blob, `${App.ir.project.name}.gif`);
    setExportProgress(1, '完成');
    toast('GIF 已导出', 'ok');
  } catch (e) {
    setExportProgress(0, e.message);
    toast(e.message, e.message === '已取消' ? '' : 'err');
  }
  setTimeout(hideExportUI, 700);
}

/* ============================================================
   模态 / 提示
   ============================================================ */
function showModal(title, html, buttons) {
  $('modalTitle').textContent = title;
  const body = $('modalBody');
  body.innerHTML = '';
  // 既支持 HTML 字符串，也支持 DOM 节点/数组
  const nodes = typeof html === 'string'
    ? [Object.assign(document.createElement('div'), { innerHTML: html })]
    : [].concat(html || []).flat().filter(x => x !== null && x !== undefined);
  for (const n of nodes) body.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
  const foot = $('modalFoot');
  foot.innerHTML = '';
  for (const b of buttons || []) {
    const el = document.createElement('button');
    el.textContent = b.label;
    if (b.cls) el.className = b.cls;
    el.addEventListener('click', b.onClick || b.act);
    foot.appendChild(el);
  }
  $('modalLayer').classList.remove('hidden');
}
function closeModal() { $('modalLayer').classList.add('hidden'); }

let toastTimer = 0;
function toast(msg, kind = '', ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, ms);
}

let dirtyTimer = 0;
/* ============================================================
   节点图（P1-A）
   ============================================================ */
function currentLayer() {
  return App.ir.layers.find(l => l.id === App.layerId) || App.ir.layers[0] || null;
}

function refreshNodeGraph() {
  const container = $('nodeCanvas');
  const svg = $('nodeSvg');
  if (!container || !svg) return;
  // 优先当前图层；当前图层没有积木时找第一个有积木的图层
  let layer = currentLayer();
  if (!layer || !layer.blocks || !layer.blocks.length) {
    layer = App.ir.layers.find(l => l.blocks && l.blocks.length) || null;
  }
  if (!layer) {
    renderNodeGraph(container, svg, { nodes: [], edges: [] }, { emptyText: '还没有任何积木\n切到「积木」页拖几块积木进来' });
    App.nodeGraph = null;
    renderNodeReport(null);
    return;
  }
  try {
    const { graph } = blocksToGraph(layer.blocks);
    layoutGraph(graph);
    App.nodeGraph = graph;
    App.nodeGraphLayerId = layer.id;
    renderNodeGraph(container, svg, graph, {});
    renderNodeReport({ pending: true });
  } catch (e) {
    renderNodeGraph(container, svg, { nodes: [], edges: [] }, { emptyText: '节点图生成失败：' + e.message });
  }
}

function renderNodeReport(rep) {
  const el = $('nodeReport');
  if (!el) return;
  el.innerHTML = '';
  if (!rep) return;

  if (rep.pending) {
    const d = document.createElement('div');
    d.className = 'ok';
    d.textContent = `已从积木生成 ${App.nodeGraph ? App.nodeGraph.nodes.filter(n => n.kind !== 'group').length : 0} 个节点（点「回积木」验证保真度）`;
    el.appendChild(d);
    return;
  }

  const head = document.createElement('div');
  head.innerHTML = rep.lossless
    ? `<span class="ok">✓ 往返无损：${rep.before} 个积木 ↔ ${rep.after} 个节点</span>`
    : `<span class="warn">⚠ 有损：${rep.before} → ${rep.after}，差 ${rep.missing}</span>`;
  el.appendChild(head);

  for (const l of rep.losses) {
    const d = document.createElement('div');
    d.className = l.kind === 'orphan' || l.kind === 'unknownOp' ? 'err' : 'warn';
    d.textContent = '· ' + l.msg;
    el.appendChild(d);
  }
}

function nodeToBlocksAction() {
  const layer = currentLayer();
  if (!layer || !App.nodeGraph) { toast('先点「从积木」生成节点图'); return; }
  const r = roundTripReport(layer.blocks);
  App.nodeReport = r;
  renderNodeReport(r);

  if (r.lossless) {
    toast(`✓ 往返无损（${r.before} 个积木）`, 'ok');
  } else {
    // 有损：让用户决定是否接受
    showModal('节点 → 积木（有损转换）', [
      el2('p', `把 ${r.after} 个节点线性化回 ${r.before} 个积木，其中 ${r.missing} 处会丢失语义。`),
      el2('div', { class: 'node-report' }, r.losses.map(l => el2('div', { class: 'warn' }, '· ' + l.msg))),
      el2('p', { class: 'lbl' }, '接受转换会覆盖当前图层的积木，建议先保存。'),
    ], [
      { label: '取消', cls: '' },
      {
        label: '接受并覆盖', cls: 'primary', onClick: () => {
          pushUndo();
          layer.blocks = r.graph ? graphToBlocks(r.graph).blocks : layer.blocks;
          BV.renderBlocks();
          refreshNodeGraph();
          markDirty();
          toast('已按节点图重建积木', 'ok');
        },
      },
    ]);
  }
}

function nodeAutoLayout() {
  if (!App.nodeGraph) { toast('先点「从积木」'); return; }
  layoutGraph(App.nodeGraph);
  renderNodeGraph($('nodeCanvas'), $('nodeSvg'), App.nodeGraph, {});
  toast('已重新布局');
}

/* ============================================================
   场景树操作（P0-G）
   ============================================================ */
function sceneGroup() {
  const layer = currentLayer();
  if (!layer || !App.sceneTree) return;
  const node = App.sceneTree.find(layer.id);
  if (!node) return;
  pushUndo();
  const gid = App.sceneTree.autoGroup(node);
  syncSceneToIR();
  // 新组是根节点，它的子节点才是原来的图层 → 选中原图层
  const grp = App.sceneTree.find(gid);
  const inner = grp && grp.children[0];
  App.layerId = inner ? inner.id : gid;
  BV.S.layerId = App.layerId;
  renderLayerTree();
  BV.renderBlocks();
  drawFrame();
  markDirty();
  toast('已打包成组（可继续嵌套）', 'ok');
}

function sceneMakeMaster() {
  // 优先用选中的图层；选中的已被编组进组里时退回到组内第一个可绘制子节点
  if (!App.sceneTree) return;
  let node = App.layerId ? App.sceneTree.find(App.layerId) : null;
  if (!node) {
    const first = App.ir.layers[0];
    node = first ? App.sceneTree.find(first.id) : null;
  }
  if (!node || node.isGroup) { toast('先选一个具体图层（不要选组）', 'warn'); return; }
  pushUndo();
  const master = App.sceneTree.registerMaster(node, node.name + ' 组件');
  renderLayerTree();
  drawFrame();
  markDirty();
  toast(`已登记主组件「${master.name}」，可插入多个实例`, 'ok');
}

function scenePlaceInstance() {
  if (!App.sceneTree || !App.sceneTree.masters.size) { toast('还没有主组件，先把某个图层登记为组件'); return; }
  if (App.sceneTree.masters.size === 1) {
    const m = [...App.sceneTree.masters.values()][0];
    pushUndo();
    const inst = App.sceneTree.instantiate(m.id);
    syncSceneToIR();
    renderLayerTree();
    BV.renderBlocks();
    drawFrame();
    markDirty();
    toast(`已插入实例「${inst.name}」`, 'ok');
    return;
  }
  // 多组件时弹菜单
  showModal('插入实例', [el2('div', {}, [...App.sceneTree.masters.values()].map(m =>
    el2('button', {
      style: 'display:block;width:100%;margin:3px 0;text-align:left',
      onClick: () => {
        pushUndo();
        App.sceneTree.instantiate(m.id);
        syncSceneToIR();
        renderLayerTree();
        BV.renderBlocks();
        drawFrame();
        markDirty();
        closeModal();
      },
    }, `${m.name}（${m.type}）`)))], [{ label: '取消', cls: '' }]);
}

/** 场景树 → 扁平图层（保持与旧渲染管线兼容）
   注意：组节点本身没有可绘制内容，会被扁平化跳过；
   组的不透明度与可见性已经乘进了每个子节点的 props 里。 */
function syncSceneToIR() {
  if (!App.sceneTree) return;
  // 记下积木（扁平化会重建对象，不能丢）
  const blocksById = new Map();
  for (const l of App.ir.layers) {
    blocksById.set(l.id, l.blocks);
    // 属性面板可能改过名称/属性而场景树还停在旧值，先同步叶子节点。
    // 不透明度例外：它以节点自身的 opacity 为准（组倍率在 toLayers 时才乘），
    // 否则会把上次生成的组倍率当成图层属性反复相乘。
    const n = App.sceneTree.find(l.id);
    if (n && !n.isGroup) {
      n.name = l.name;
      n.locked = !!l.locked;
      // IR 的 circle ↔ 场景树的 ellipse，类型改了也要带过去
      const nodeType = { text: 'text', rect: 'rect', circle: 'ellipse', image: 'image' }[l.type];
      if (nodeType) n.type = nodeType;
      const props = Object.assign({}, l.props);
      delete props.opacity;
      n.props = Object.assign({}, n.props, props);
      n.blocks = l.blocks || [];
    }
  }

  const flat = App.sceneTree.toLayers();
  for (const l of flat) {
    const b = blocksById.get(l.id);
    if (b) l.blocks = b;
  }
  App.ir.layers = flat;
}

/* ============================================================
   导出格式卡片
   ============================================================ */
function renderExportFormats() {
  const box = $('exportFormats');
  if (!box) return;
  box.innerHTML = '';
  const caps = App.caps || {};
  for (const [key, p] of Object.entries(FORMAT_PRESETS)) {
    const card = el2('div', { class: 'fmt-card' + (key === 'mp4' ? ' on' : ''), 'data-fmt': key }, [
      el2('div', { class: 'fmt-name' }, p.label),
      el2('div', { class: 'fmt-note' }, p.note),
      el2('div', { class: 'fmt-badge' + (key.startsWith('mp4') && !caps.canMp4 ? ' warn' : '') },
        key.startsWith('mp4') ? (caps.canMp4 ? (caps.webcodecs ? 'WebCodecs 可用' : 'ffmpeg.wasm 可用') : '本环境不可用，请改用 WebM 或 PNG 序列帧') : '可用'),
    ]);
    card.addEventListener('click', () => {
      box.querySelectorAll('.fmt-card').forEach(c => c.classList.remove('on'));
      card.classList.add('on');
      App.exportFormat = key;
    });
    box.appendChild(card);
  }
  const capList = el2('div', { class: 'cap-list' }, [
    capChip('OffscreenCanvas', caps.offscreen),
    capChip('WebCodecs', caps.webcodecs),
    capChip('MediaRecorder', caps.webm),
    capChip('ffmpeg.wasm', caps.ffmpegWasm),
  ]);
  box.appendChild(capList);
}
function capChip(name, on) {
  return el2('span', { class: 'cap-chip' + (on ? '' : ' off') }, `${on ? '✓' : '×'} ${name}`);
}

function el2(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function renderMasterMenu() { /* 主组件下拉在图层树上以按钮呈现，此处预留 */ }

/* ============================================================
   字幕 / 音频 / 数据 的对话框
   ============================================================ */
function subExportMenu() {
  if (!App.subPanel.track.cues.length) { toast('还没有字幕可导出', 'warn'); return; }
  showModal('导出字幕', [
    el2('p', { class: 'lbl' }, `共 ${App.subPanel.track.cues.length} 条字幕`),
    el2('div', { class: 'fmt-grid' }, [
      ['SRT', '通用字幕，绝大多数平台都认', 'srt'],
      ['VTT', '网页视频标准', 'vtt'],
      ['ASS', '带样式与逐词高亮码，压制软件能用', 'ass'],
    ].map(([n, d, f]) => el2('div', { class: 'fmt-card' }, [
      el2('div', { class: 'fmt-name' }, n),
      el2('div', { class: 'fmt-note' }, d),
      el2('button', {
        style: 'margin-top:6px',
        onClick: () => {
          const r = App.subPanel.exportAs(f);
          if (!r) return;
          EX.download(r.blob, `字幕.${r.ext}`);
          closeModal();
          toast(`已导出 ${r.count} 条字幕（${f.toUpperCase()}）`, 'ok');
        },
      }, '下载'),
    ]))),
  ], [{ label: '关闭', cls: '' }]);
}

function audioExportMenu() {
  const tracks = App.audioTracks || [];
  if (!tracks.length) { toast('还没有音频', 'warn'); return; }
  const st = App.audioDesk.status();

  showModal('导出音频', [
    el2('p', {}, `当前：${st.name || '音频'} · ${(st.duration || 0).toFixed(1)}s`),
    el2('p', { class: 'lbl' }, `响度 ${st.lufs == null ? '—' : st.lufs + ' LUFS'}　峰值 ${st.peak == null ? '—' : st.peak + ' dB'}　BPM ${st.bpm || '—'}`),
    st.lufs != null && st.lufs < -20 ? el2('p', { style: 'color:var(--warn)' }, '⚠ 响度偏低，上传平台可能被二次压制后听不清，建议先「一键达标」') : null,
    el2('div', { class: 'fmt-grid' }, [
      el2('div', { class: 'fmt-card' }, [
        el2('div', { class: 'fmt-name' }, 'WAV（原始）'),
        el2('div', { class: 'fmt-note' }, '当前单轨，无损'),
        el2('button', {
          style: 'margin-top:6px',
          onClick: () => {
            const tr = App.audioDesk.track;
            EX.download(new Blob([encodeWav(tr.samples, tr.sampleRate)], { type: 'audio/wav' }), `${tr.name || 'audio'}.wav`);
            closeModal();
          },
        }, '下载'),
      ]),
      tracks.length > 1 ? el2('div', { class: 'fmt-card' }, [
        el2('div', { class: 'fmt-name' }, 'WAV（混音）'),
        el2('div', { class: 'fmt-note' }, `${tracks.length} 条音轨按起点混在一起`),
        el2('button', {
          style: 'margin-top:6px',
          onClick: () => {
            // mixTracks(tracks, duration) 的 duration 是必需参数：
            // 漏传会得到长度 0 的数组（不抛错），encodeWav 再拿 undefined 当参数就炸。
            const mixed = mixTracks(tracks, mixDuration(tracks));
            if (!mixed || !mixed.length) { toast('没有可混音的内容', 'warn'); return; }
            EX.download(new Blob([encodeWav(mixed, 48000)], { type: 'audio/wav' }), '混音.wav');
            closeModal();
          },
        }, '下载'),
      ]) : null,
    ]),
  ], [{ label: '关闭', cls: '' }]);
}

function dataPasteDialog() {
  const ta = el2('textarea', {
    style: 'width:100%;height:180px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px;font-family:ui-monospace,monospace;font-size:11px',
    placeholder: '第一行是表头，例如：\n产品,价格,销量\n星火,99,1200',
  });
  showModal('粘贴数据', [
    el2('p', { class: 'lbl' }, '支持 CSV / TSV；逗号分隔的表头会被自动识别，数值列可绑到图层属性。'),
    ta,
  ], [
    { label: '取消', cls: '' },
    {
      label: '载入', cls: 'primary', onClick: () => {
        App.dataPanel.loadText(ta.value, { name: '粘贴数据' });
        App.dataPanel.scanBindable(App.ir);
        switchTab('data');
        closeModal();
      },
    },
  ]);
}

function dataFetchDialog() {
  const url = el2('input', {
    type: 'url',
    placeholder: 'https://…/data.csv',
    style: 'width:100%;padding:7px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px',
  });
  showModal('从网址拉取数据', [
    el2('p', { class: 'lbl' }, '支持公开可跨域访问的 CSV 导出链接与 JSON 接口。跨域被拒时会提示改用「粘贴数据」。'),
    url,
  ], [
    { label: '取消', cls: '' },
    {
      label: '拉取', cls: 'primary', onClick: async () => {
        closeModal();
        await App.dataPanel.loadUrl(url.value.trim());
        App.dataPanel.scanBindable(App.ir);
        switchTab('data');
      },
    },
  ]);
}

async function batchZip() {
  const blob = await App.dataPanel.zipAll();
  if (!blob) return;
  EX.download(blob, '批量产物.zip');
  toast('已打包下载', 'ok');
}

function markDirty() {
  App.dirty = true;
  $('statusText').textContent = '● 未保存';
  clearTimeout(dirtyTimer);
  // 定时器只负责把状态栏文字恢复成「就绪」，
  // **绝不能清 App.dirty** —— 原来这里顺手写了 App.dirty = false，
  // 于是任何改动 1.6 秒后就被当成「已保存」，beforeunload 的
  // 「有未保存改动」拦截形同虚设，关窗口直接丢工程。
  // App.dirty 只在真正保存成功后由 markClean() 清。
  dirtyTimer = setTimeout(() => { $('statusText').textContent = '就绪'; }, 1600);
}
function markClean() { App.dirty = false; $('statusText').textContent = '已保存'; }

/* ============================================================
   调试器面板
   ============================================================ */
function toggleDebugPanel() { $('debugPanel').classList.toggle('hidden'); }
function updateDebugPanels() {
  if ($('debugPanel').classList.contains('hidden')) return;
  dbg.ir = App.ir;
  dbg.time = App.time;
  // 栈
  const st = $('dbgStack');
  st.innerHTML = '';
  const s = dbg.stats();
  const hdr = document.createElement('div');
  hdr.className = 'dbg-line cur';
  hdr.innerHTML = `<span class="frame-no">帧 ${s.frame}</span> 执行 <span class="n">${s.blocks}</span> 块 · 最深 <span class="n">${s.maxDepth}</span> 层 · 命中 <span class="b">${s.hits}</span> 断点`;
  st.appendChild(hdr);
  for (const tr of dbg.trace.slice(0, 200)) {
    const d = document.createElement('div');
    d.className = 'dbg-line' + (tr.hit ? ' hit' : '') + (App.selectedBlock === tr.id ? ' cur' : '');
    d.innerHTML = `<span class="frame-no">t=${tr.t.toFixed(2)}</span>${'　'.repeat(tr.depth)}<span class="s">${escapeHtml(tr.label)}</span>`;
    d.addEventListener('click', () => { App.selectedBlock = tr.id; BV.S.selected = tr.id; BV.renderBlocks(); renderInspector(); updateDebugPanels(); });
    st.appendChild(d);
  }
  // 变量
  const vb = $('dbgVars');
  vb.innerHTML = '';
  if (!dbg.vars.size) {
    const d = document.createElement('div');
    d.className = 'dbg-line';
    d.textContent = '（无变量写入）$time / $frame / $progress 由引擎注入';
    vb.appendChild(d);
  }
  for (const [k, v] of dbg.vars) {
    const d = document.createElement('div');
    d.className = 'dbg-line';
    d.innerHTML = `<span class="s">${escapeHtml(k)}</span> = <span class="v">${escapeHtml(fmtVal(v))}</span>`;
    vb.appendChild(d);
  }
  // 探针
  const pb = $('dbgProbe');
  pb.innerHTML = '';
  if (dbg.probeValue) {
    const d = document.createElement('div');
    d.className = 'dbg-line';
    d.innerHTML = `<span class="s">${escapeHtml(dbg.probeValue.name)}</span> visible=<span class="v">${dbg.probeValue.visible}</span>`;
    pb.appendChild(d);
    for (const k of Object.keys(dbg.probeValue.p)) {
      const d2 = document.createElement('div');
      d2.className = 'dbg-line';
      d2.innerHTML = `　<span class="s">${escapeHtml(k)}</span> = <span class="n">${escapeHtml(String(dbg.probeValue.p[k]))}</span>`;
      pb.appendChild(d2);
    }
  } else {
    const d = document.createElement('div');
    d.className = 'dbg-line';
    d.textContent = '（在属性面板点「设为属性探针」）';
    pb.appendChild(d);
  }
  // 日志
  const lg = $('dbgLog');
  lg.innerHTML = '';
  const note = document.createElement('div');
  note.className = 'dbg-line';
  note.innerHTML = `画布 <span class="n">${App.ir.project.width}×${App.ir.project.height}</span> · <span class="n">${App.ir.project.fps}fps</span> · BPM <span class="n">${App.audio.bpm}</span> · 振幅 <span class="v">${App.audio.amplitude(App.time).toFixed(3)}</span>`;
  lg.appendChild(note);
  for (let i = dbg.trace.length - 1; i >= Math.max(0, dbg.trace.length - 60); i--) {
    const tr = dbg.trace[i];
    const d = document.createElement('div');
    d.className = 'dbg-line';
    d.innerHTML = `<span class="frame-no">${i}</span>${'　'.repeat(tr.depth)}<span class="b">${escapeHtml(tr.label)}</span>`;
    lg.appendChild(d);
  }
}

/* ============================================================
   帮助
   ============================================================ */
function helpStart() {
  showModal('快速上手 · 5 分钟', `
    <h4>1 · 搭一块逻辑</h4>
    <p>右侧「积木」页签是画布。点工具条「模板…」挑一个官方模板，或点积木库里的积木拖进画布。</p>
    <h4>2 · 让它动起来</h4>
    <p><code>逐字弹入</code> 会把文字拆成单字并依次回弹弹入；<code>遮罩擦除</code> 从左到右擦出字幕；<code>音频波形柱</code> 用实时振幅驱动柱子。<b>积木顺序就是时间顺序</b>——没有需要手拖的关键帧。</p>
    <h4>3 · 绑定配音</h4>
    <p>在左侧「项目设置」加标记点，把积木放进「在标记点」。重录一句配音只要拖标记点，后面所有画面自动重排。</p>
    <h4>4 · 调试</h4>
    <p>工具条「调试器」打开单步执行：<kbd>F10</kbd> 单步、<kbd>F9</kbd> 设断点。选中积木后可在属性面板设「属性探针」看它每帧求值后的真实属性。</p>
    <h4>5 · 导出</h4>
    <p>「文件 → 导出 PNG 序列帧」得到带 Alpha 的序列帧 ZIP，「导出 GIF」得到可直接分享的动图。两者都用与预览完全相同的渲染代码。</p>
    <div class="hint">快捷键：<span class="kbd">空格</span>播放 · <span class="kbd">,</span><span class="kbd">.</span>逐帧 · <span class="kbd">Ctrl+Z</span>撤销 · <span class="kbd">F10</span>单步 · <span class="kbd">F9</span>断点</div>
  `, [{ label: '开始', cls: 'pri', act: closeModal }]);
}
function helpIR() {
  showModal('IR 规范 · 积木与节点共用的中间表示', `
    <p>积木视图和节点视图<b>不是两套编辑器</b>，它们都是同一份 IR（动画 AST）的投影。这是全产品最关键的架构决定。</p>
    <h4>工程结构</h4>
    <table><tr><th>字段</th><th>说明</th></tr>
      <tr><td>project</td><td>name / width / height / fps / duration / background / loudnessTarget</td></tr>
      <tr><td>markers</td><td>锚点数组 {id, time, label, color}，视觉轨绑定它而非固定秒数</td></tr>
      <tr><td>variables</td><td>作者暴露的可调参数（模板生态基础）</td></tr>
      <tr><td>layers</td><td>图层数组，每层含 props（静态属性）与 blocks（程序化时间轴）</td></tr>
    </table>
    <h4>两种积木节点</h4>
    <table>
      <tr><th>k</th><th>形态</th><th>语义</th></tr>
      <tr><td><code>C</code></td><td>语句积木，带 bslot</td><td>有顺序、有时间推进（wait/after/loop）</td></tr>
      <tr><td><code>N</code></td><td>表达式积木（叶子）</td><td>返回数值/颜色/布尔，可嵌进槽位</td></tr>
    </table>
    <h4>槽位里的值</h4>
    <p>槽位可以放：字面量 <code>{k:'lit',t:'num',v:5}</code>、变量 <code>{k:'var',name}</code>、表达式积木 <code>{k:'blk',op:'add',a,b}</code>、音频探针 <code>{k:'audio',metric:'amp'}</code>。</p>
    <p>积木作用域建模为「子积木列表」，将来转节点图时<strong>直接等价于一个 Group 节点</strong>，变量读写建模为隐式连线——因此双模态互转是保真投影，不是重写。</p>
    <h4>文本格式</h4>
    <p>积木可用缩进文本表示（<code>#数值</code> <code>"字符串"</code> <code>#颜色</code> <code>~时间</code> <code>!布尔</code>），「文件 → 导出积木文本」可拿到，方便版本管理与 diff。</p>
  `, [{ label: '知道了', cls: 'pri', act: closeModal }]);
}
function helpRender() {
  showModal('渲染一致性 · 为什么预览等于成片', `
    <p>规划里把这条列为<b>致命风险</b>：如果编辑用 DOM/SVG、导出用另一套实现，用户一旦发现「预览和成片长得不一样」，信任就崩了。</p>
    <h4>本原型的做法</h4>
    <p>只有 <code>renderer.js</code> 一个 <code>render(scene, ctx, env)</code>。编辑态把 canvas 用 <code>setTransform</code> 缩放到屏幕尺寸并做 DPR 适配；导出态把 canvas 换成成片尺寸。差异只有分辨率，没有第二套绘图逻辑。</p>
    <h4>时间轴是纯函数</h4>
    <p><code>evaluateFrame(ir, t, audio)</code> 对同一 <code>t</code> 永远返回同一画面。所以：</p>
    <ul>
      <li>预览播放 = 连续调用</li>
      <li>调试器单步 = t += 1/fps</li>
      <li>导出逐帧 = t = i/fps</li>
    </ul>
    <p>三条路径走同一份代码，天然逐帧一致，也天然支持拖动时间轴任意跳转与倒放。</p>
    <h4>音频同样是确定性的</h4>
    <p>音频源是程序化合成（<code>AudioSource</code>），预览和导出读同一份数学定义，所以 <code>amp/bass/beat</code> 这些「声音驱动画面」的变量在任何渲染路径下结果相同。V1 接入真实录音时，仍需保持「按采样帧对齐」。</p>
  `, [{ label: '明白了', cls: 'pri', act: closeModal }]);
}
function helpShortcuts() {
  showModal('快捷键', `
    <table>
      <tr><th><span class="kbd">空格</span></th><td>播放 / 暂停</td></tr>
      <tr><th><span class="kbd">,</span> <span class="kbd">.</span></th><td>上一帧 / 下一帧</td></tr>
      <tr><th><span class="kbd">Ctrl+Z</span></th><td>撤销（结构变更自动入栈）</td></tr>
      <tr><th><span class="kbd">Ctrl+Shift+Z</span></th><td>重做</td></tr>
      <tr><th><span class="kbd">F10</span></th><td>单步执行一帧</td></tr>
      <tr><th><span class="kbd">F9</span></th><td>切换选中积木的断点</td></tr>
      <tr><th><span class="kbd">Delete</span></th><td>删除选中积木</td></tr>
      <tr><th><span class="kbd">Ctrl+D</span></th><td>复制选中积木</td></tr>
      <tr><th><span class="kbd">Esc</span></th><td>取消选中 / 关闭弹窗</td></tr>
    </table>
  `, [{ label: '关闭', cls: 'pri', act: closeModal }]);
}

/* ============================================================
   全局事件绑定
   ============================================================ */
function bindGlobal() {
  /* 菜单 */
  document.querySelectorAll('.menu > button').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = b.parentElement;
      const wasOpen = menu.classList.contains('open');
      document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open'));
      if (!wasOpen) menu.classList.add('open');
    });
  });
  document.addEventListener('click', () => document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')));
  document.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    doAction(b.dataset.act);
  }));

  /* 标签页 */
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    switchTab(t.dataset.tab);
  }));

  /* AI 子标签 */
  document.querySelectorAll('.ai-tab').forEach(t => t.addEventListener('click', () => {
    switchAiTab(t.dataset.ai);
  }));

  /* 画布预设 / fps / 缩放 / 时长 */
  $('presetSelect').addEventListener('change', (e) => {
    const [w, h] = e.target.value.split('x').map(Number);
    pushUndo();
    App.ir.project.width = w; App.ir.project.height = h;
    App.ir.layers.forEach((l, i) => { l.props.x = w / 2; if (i === 1) l.props.y = h * 0.42; });
    layoutStage(); drawFrame(); renderLayerProps(); markDirty();
  });
  $('fpsSelect').addEventListener('change', (e) => {
    pushUndo();
    App.ir.project.fps = parseInt(e.target.value, 10);
    markDirty(); drawFrame();
  });
  $('zoomSelect').addEventListener('change', (e) => { App.zoom = e.target.value === 'fit' ? 'fit' : parseFloat(e.target.value); layoutStage(); });
  $('durationInput').addEventListener('change', (e) => {
    pushUndo();
    App.ir.project.duration = Math.max(0.1, parseFloat(e.target.value) || 1);
    App.audio.setDuration(App.ir.project.duration);
    buildRuler(); renderProjectSettings(); drawFrame(); markDirty();
  });

  /* 时间轴拖动 */
  const track = $('track');
  track.addEventListener('mousedown', (e) => { if (!e.target.closest('.marker')) seekFromEvent(e); });
  $('ruler').addEventListener('mousedown', seekFromEvent);

  /* 导出取消 */
  document.querySelector('[data-act="export.cancel"]').addEventListener('click', () => { App.exportCancel = true; });

  /* 快捷键 */
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const editing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
    if (e.code === 'Space' && !editing) { e.preventDefault(); setPlaying(!App.playing); }
    else if (e.key === ',' && !editing) { App.time = Math.max(0, App.time - 1 / App.ir.project.fps); updatePlayhead(); drawFrame(); }
    else if (e.key === '.' && !editing) { App.time = Math.min(App.ir.project.duration, App.time + 1 / App.ir.project.fps); updatePlayhead(); drawFrame(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && !editing) { e.preventDefault(); if (App.selectedBlock) dupBlock(App.selectedBlock); }
    else if (e.key === 'F10') { e.preventDefault(); debuggerStep(); }
    else if (e.key === 'F9') { e.preventDefault(); if (App.selectedBlock) { dbg.toggleBp(App.selectedBlock); updateDebugPanels(); renderInspector(); toast(dbg.breakpoints.has(App.selectedBlock) ? '已设断点' : '已取消断点'); } }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (!editing && App.selectedBlock) { e.preventDefault(); delBlock(App.selectedBlock); } }
    else if (e.key === 'Escape') { App.selectedBlock = null; BV.S.selected = null; BV.renderBlocks(); renderInspector(); closeModal(); }
  });

  window.addEventListener('beforeunload', (e) => {
    if (App.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}

function debuggerStep() {
  $('debugPanel').classList.remove('hidden');
  setPlaying(false);
  dbg.reset(App.ir);
  dbg.time = App.time;
  const res = dbg.step(App.ir, App.audio);
  App.time = dbg.time;
  drawFrame();
  updateDebugPanels();
  if (res.stoppedAt) {
    App.selectedBlock = res.stoppedAt;
    BV.S.selected = res.stoppedAt;
    BV.renderBlocks(); renderInspector();
    const hitBlock = BV.findBlockDeep(App.ir, res.stoppedAt);
    const hitDef = hitBlock ? defOf(hitBlock.op) : null;
    toast('命中断点：' + (hitDef ? hitDef.label : res.stoppedAt), 'ok');
  }
}

/* ============================================================
   动作分发
   ============================================================ */
function doAction(act) {
  switch (act) {
    case 'file.new': newProject(); break;
    case 'file.open': openFile(); break;
    case 'file.save': saveJSON(); break;
    case 'file.import': openFile(); break;
    case 'file.demo': loadTplDialog(); break;
    case 'export.png': doExportPNG(); break;
    case 'export.frames': case 'export.gif': exportDialog(); break;

    case 'edit.undo': undo(); break;
    case 'edit.redo': redo(); break;
    case 'edit.dup': if (App.selectedBlock) dupBlock(App.selectedBlock); break;
    case 'edit.del': if (App.selectedBlock) delBlock(App.selectedBlock); break;
    case 'edit.prefs': helpShortcuts(); break;

    case 'view.zoomFit': App.zoom = 'fit'; $('zoomSelect').value = 'fit'; layoutStage(); break;
    case 'view.zoomIn': App.zoom = Math.min(2, App.zoomNum * 1.25); layoutStage(); break;
    case 'view.zoomOut': App.zoom = Math.max(0.05, App.zoomNum / 1.25); layoutStage(); break;
    case 'view.panelBlocks': switchTab('blocks'); break;
    case 'view.panelLayers': focusLeft(); break;
    case 'view.panelInspector': switchTab('inspector'); break;
    case 'view.shortcuts': helpShortcuts(); break;

    case 'play': setPlaying(!App.playing); break;
    case 'rewind': App.time = 0; updatePlayhead(); drawFrame(); break;
    case 'prevFrame': App.time = Math.max(0, App.time - 1 / App.ir.project.fps); updatePlayhead(); drawFrame(); break;
    case 'nextFrame': App.time = Math.min(App.ir.project.duration, App.time + 1 / App.ir.project.fps); updatePlayhead(); drawFrame(); break;

    case 'layer.add': addLayer(); break;
    case 'layer.del': deleteLayer(); break;
    case 'block.clean': BV.renderBlocks(); toast('已整理积木'); break;

    /* ---------- 节点图 ---------- */
    case 'node.fromBlocks': refreshNodeGraph(); switchTab('nodes'); toast('已从积木生成节点图'); break;
    case 'node.toBlocks': nodeToBlocksAction(); break;
    case 'node.auto': nodeAutoLayout(); break;

    /* ---------- 场景树 ---------- */
    case 'scene.group': sceneGroup(); break;
    case 'scene.instance': sceneMakeMaster(); break;
    case 'scene.place': scenePlaceInstance(); break;

    /* ---------- 字幕 ---------- */
    case 'sub.import': $('subFile').click(); break;
    case 'sub.export': subExportMenu(); break;
    case 'sub.validate': {
      const issues = App.subPanel.validate();
      const errs = issues.filter(i => i.level === 'error').length;
      const warns = issues.filter(i => i.level === 'warn').length;
      if (!issues.length) toast('✓ 字幕检查通过', 'ok');
      else toast(`字幕：${errs} 个错误、${warns} 个提醒`, errs ? 'err' : 'warn');
      break;
    }
    case 'sub.addCue': App.subPanel.addCue(); switchTab('subtitle'); break;
    case 'sub.words': App.subPanel.fillWords(); App.ir.subtitles = App.subPanel.toJSON(); markDirty(); break;
    case 'sub.split': App.subPanel.splitLong(); App.ir.subtitles = App.subPanel.toJSON(); markDirty(); break;

    /* ---------- 音频 ---------- */
    case 'audio.import': $('audioFile').click(); break;
    case 'audio.rec': App.audioDesk.toggleRecord(); break;
    case 'audio.export': audioExportMenu(); break;

    /* ---------- 波形编辑 ---------- */
    case 'wave.zoomIn': case 'wave.zoomOut': case 'wave.fit':
    case 'wave.trim': case 'wave.delete': case 'wave.silence':
    case 'wave.fadeIn': case 'wave.fadeOut': case 'wave.gainUp': case 'wave.gainDown':
    case 'wave.removeSilence': case 'wave.normalize': case 'wave.undo':
      App.audioDesk.act(act.split('.')[1]); renderAudioStatus(); break;

    /* ---------- 数据 ---------- */
    case 'data.paste': dataPasteDialog(); break;
    case 'data.fetch': dataFetchDialog(); break;
    case 'data.clear': App.dataPanel.clear(); break;
    case 'batch.run': App.dataPanel.run(App.ir); break;
    case 'batch.pause': App.dataPanel.pause(); break;
    case 'batch.zip': batchZip(); break;

    /* ---------- V3/V4：市场 ---------- */
    case 'mkt.publish': publishCurrent(); break;
    case 'mkt.import': $('mktFile').click(); break;

    /* ---------- V3/V4：AI ---------- */
    case 'ai.parse': aiParse(); break;
    case 'ai.storyboard': aiStoryboard(); break;
    case 'ai.storyboardApply': aiStoryboardApply(); break;
    case 'ai.fromSubs': aiFromSubs(); break;
    case 'ai.explainLayer': aiExplainLayer(); break;
    case 'ai.explainAll': aiExplainAll(); break;
    case 'ai.infer': aiInfer(); break;
    case 'ai.lint': aiLint(); break;

    /* ---------- V3/V4：版本 ---------- */
    case 'git.commit': gitCommit(); break;
    case 'git.branch': gitNewBranch(); break;
    case 'git.newBranch': gitNewBranch(); break;
    case 'git.checkout': gitCheckout(); break;
    case 'git.tag': gitTag(); break;
    case 'git.export': gitExport(); break;
    case 'git.import': $('gitFile').click(); break;
    case 'git.patch': gitPatch(); break;
    case 'git.merge': gitMerge(App.gitMergeBranch || 'feature'); break;

    case 'tpl.open': loadTplDialog(); break;
    case 'debug.panel': toggleDebugPanel(); updateDebugPanels(); break;
    case 'dbg.stepIn': debuggerStep(); break;
    case 'dbg.tpToggle': if (App.selectedBlock) { dbg.toggleBp(App.selectedBlock); renderInspector(); updateDebugPanels(); toast(dbg.breakpoints.has(App.selectedBlock) ? '已设断点' : '已取消断点'); } break;
    case 'dbg.clear': dbg.breakpoints.clear(); dbg.trace = []; updateDebugPanels(); toast('已清空断点'); break;
    case 'dbg.close': $('debugPanel').classList.add('hidden'); break;

    case 'palette.close': $('paletteDrawer').classList.add('hidden'); break;
    case 'modal.close': closeModal(); break;
    case 'help.start': helpStart(); break;
    case 'help.ir': helpIR(); break;
    case 'help.render': helpRender(); break;
    default: break;
  }
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.tab-page').forEach(x => x.classList.toggle('active', x.id === 'tab-' + name));
  if (name === 'blocks') BV.renderBlocks();
  if (name === 'inspector') renderInspector();
  if (name === 'nodes') refreshNodeGraph();
  if (name === 'subtitle') { App.subPanel.render(); App.subPanel.validate(); }
  if (name === 'audio') { App.audioDesk.render(); renderAudioStatus(); }
  if (name === 'data') App.dataPanel.renderBindings();
  if (name === 'market') { renderMarketList(); renderMarketDetail(App.selectedTemplateId); }
  if (name === 'git') renderGitLog();
}

/** AI 面板内部的子页签 */
function switchAiTab(name) {
  document.querySelectorAll('.ai-tab').forEach(x => x.classList.toggle('active', x.dataset.ai === name));
  document.querySelectorAll('.ai-pane').forEach(x => x.classList.toggle('active', x.dataset.aiPane === name));
}
function focusLeft() {
  $('leftPanel').scrollIntoView();
  $('leftPanel').style.boxShadow = '0 0 0 2px var(--accent)';
  setTimeout(() => $('leftPanel').style.boxShadow = '', 900);
}

function loadTplDialog() {
  showModal('官方模板', `
    <p>每个模板都是一份完整 IR，选中后立即载入当前工程（可撤销）。</p>
    <div id="tplList"></div>
    <h4>粘贴积木文本导入</h4>
    <p>把别的工程的 <code>.blocks.txt</code> 贴进来，点「解析载入」。</p>
    <textarea id="tplPaste" class="code" placeholder="LAYER 标题文字 [text]&#10;  PROP text = &quot;你好&quot;&#10;  @ splitBy &quot;标题文字&quot; ^char"></textarea>
  `, [
    { label: '解析载入', act: importPastedText },
    { label: '取消', act: closeModal },
  ]);
  const list = $('tplList');
  for (const t of TEMPLATES) {
    const d = document.createElement('div');
    d.style.cssText = 'padding:9px 11px;border:1px solid var(--line);border-radius:7px;margin-bottom:7px;cursor:pointer';
    d.innerHTML = `<b style="color:var(--fg)">${escapeHtml(t.name)}</b><div class="hint" style="margin:3px 0 0">${escapeHtml(t.desc)}</div>`;
    d.addEventListener('mouseenter', () => d.style.borderColor = 'var(--accent)');
    d.addEventListener('mouseleave', () => d.style.borderColor = 'var(--line)');
    d.addEventListener('click', () => {
      pushUndo();
      App.ir = t.make();
      App.audio = defaultAudio(App.ir);
      App.layerId = App.ir.layers[1] ? App.ir.layers[1].id : App.ir.layers[0].id;
      App.time = 0;
      BV.S.ir = App.ir; BV.S.layerId = App.layerId;
      dbg.reset(App.ir);
      syncSubtitlePanel(App.ir);
      closeModal();
      syncProjectToUI(); renderLayerTree(); BV.renderBlocks(); renderInspector(); renderProjectSettings(); buildRuler(); layoutStage(); drawFrame();
      toast('已载入模板：' + t.name, 'ok');
    });
    list.appendChild(d);
  }
}

/**
 * 把 App.ir 里带的字幕同步到字幕面板。
 *
 * 换工程的地方（打开文件、新建、载模板、载版本、撤销…）都必须调这个，
 * 否则 IR 里字幕数据在、面板上却是空的 —— 数据和界面不一致，用户会以为字幕丢了。
 * 注意 SubtitleTrack.fromJSON 不接受 undefined/null，所以这里先兜底成空对象。
 */
function syncSubtitlePanel(ir) {
  if (!App.subPanel) return;
  App.subPanel.loadJSON(ir.subtitles || {});
  App.subPanel.setDuration((ir.project && ir.project.duration) || 6);
  // 回写规范化后的结果：工程里没有 subtitles 字段时补一个空轨道，
  // 这样导出 JSON / 提交版本拿到的 IR 结构始终一致。
  ir.subtitles = App.subPanel.toJSON();
}

function importPastedText() {
  const txt = $('tplPaste').value;
  if (!txt.trim()) { toast('请先粘贴积木文本', 'err'); return; }
  try {
    const r = fromText(txt, BLOCK_DEFS);
    pushUndo();
    App.ir = r.ir;
    App.audio = defaultAudio(App.ir);
    App.layerId = App.ir.layers[0] && App.ir.layers[0].id;
    App.time = 0;
    BV.S.ir = App.ir; BV.S.layerId = App.layerId;
    dbg.reset(App.ir);
    syncSubtitlePanel(App.ir);
    closeModal();
    syncProjectToUI(); renderLayerTree(); BV.renderBlocks(); renderInspector(); renderProjectSettings(); buildRuler(); layoutStage(); drawFrame();
    toast(r.notes.length ? '已导入（' + r.notes.join('；') + '）' : '已导入积木文本', r.notes.length ? '' : 'ok', 3200);
  } catch (e) {
    toast('解析失败：' + e.message, 'err', 3600);
  }
}

/* ============================================================
   工具函数
   ============================================================ */
function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 表单控件 ---------- */
function field(label, control, full) {
  const d = document.createElement('div');
  d.className = 'field' + (full ? ' full' : '');
  const l = document.createElement('label');
  l.textContent = label;
  d.appendChild(l);
  d.appendChild(control);
  return d;
}
function inputText(value, onChange, placeholder) {
  const i = document.createElement('input');
  i.type = 'text';
  i.value = value == null ? '' : value;
  if (placeholder) i.placeholder = placeholder;
  i.addEventListener('change', () => onChange(i.value));
  return i;
}
function inputNum(value, onChange) {
  const i = document.createElement('input');
  i.type = 'number';
  i.step = 'any';
  i.value = value == null ? 0 : value;
  i.addEventListener('change', () => onChange(parseFloat(i.value) || 0));
  return i;
}
function inputColor(value, onChange) {
  const i = document.createElement('input');
  i.type = 'color';
  i.className = 'swatch';
  i.value = /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : '#4a8cff';
  i.addEventListener('change', () => onChange(i.value));
  return i;
}
function selectEl(options, value, onChange) {
  const s = document.createElement('select');
  for (const [label, val] of options) {
    const o = document.createElement('option');
    o.value = String(val);
    o.textContent = label;
    if (String(val) === String(value)) o.selected = true;
    s.appendChild(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

/* ============================================================
   Go
   ============================================================ */
boot();

/* ============================================================
   自动化 / 批渲染接口
   ------------------------------------------------------------
   数据驱动批量渲染（V3）与自动化测试都需要「不经 UI 直接定位时间、
   载入模板、触发导出」的能力。这里把它作为一等公民暴露出去，
   而不是让脚本去点 DOM。
   ============================================================ */
window.BlockAnim = {
  get ir() { return App.ir; },
  get audio() { return App.audio; },
  get time() { return App.time; },
  get selectedLayerId() { return App.layerId; },

  setTime(t) {
    setPlaying(false);
    App.time = Math.max(0, Math.min(App.ir.project.duration, t));
    updatePlayhead();
    drawFrame();
    return App.time;
  },

  loadTemplate(key) {
    const t = TEMPLATES.find(x => x.key === key);
    if (!t) throw new Error('未知模板：' + key);
    App.ir = t.make();
    App.audio = defaultAudio(App.ir);
    resetAudioState();
    App.layerId = App.ir.layers[1] ? App.ir.layers[1].id : App.ir.layers[0].id;
    App.time = 0;
    BV.S.ir = App.ir; BV.S.layerId = App.layerId;
    dbg.reset(App.ir);
    if (App.sceneTree) App.sceneTree.syncFromLayers(App.ir.layers);
    syncSubtitlePanel(App.ir);
    syncProjectToUI(); renderLayerTree(); BV.renderBlocks(); renderInspector();
    renderProjectSettings(); buildRuler(); layoutStage(); drawFrame(); refreshNodeGraph();
    return App.ir.project.name;
  },

  loadIR(ir) {
    pushUndo();
    App.ir = ir;
    App.audio = defaultAudio(ir);
    resetAudioState();
    App.layerId = ir.layers[0] && ir.layers[0].id;
    App.time = 0;
    BV.S.ir = ir; BV.S.layerId = App.layerId;
    dbg.reset(ir);
    if (App.sceneTree) App.sceneTree.syncFromLayers(App.ir.layers);
    syncSubtitlePanel(ir);
    syncProjectToUI(); renderLayerTree(); BV.renderBlocks(); renderInspector();
    renderProjectSettings(); buildRuler(); layoutStage(); drawFrame(); refreshNodeGraph();
  },

  /* 离屏渲染单帧并返回 Blob（供批渲染队列复用） */
  async renderFramePNG(time, scale = 1) {
    return EX.exportPNG(App.ir, App.audioSource || App.audio, time, scale);
  },

  /* 批渲染：同一份模板套多份数据，逐行产出 */
  async batchRender(rows, opts = {}) {
    const results = [];
    const t0 = performance.now();
    for (let i = 0; i < rows.length; i++) {
      if (opts.onProgress) opts.onProgress(i / rows.length, rows[i]);
      const t = performance.now();
      try {
        const blob = await this.renderFramePNG(opts.time == null ? App.ir.project.duration / 2 : opts.time);
        results.push({ ok: true, row: rows[i], name: `${String(i + 1).padStart(4, '0')}_${rows[i].name || ''}.png`, blob, ms: Math.round(performance.now() - t) });
      } catch (e) {
        results.push({ ok: false, row: rows[i], error: e.message });
      }
    }
    if (opts.onProgress) opts.onProgress(1, null);
    return { results, totalMs: Math.round(performance.now() - t0) };
  },

  /* ---------- P0/P1/P2 自动化 API ---------- */

  selectLayer(id) {
    App.layerId = id;
    BV.S.layerId = id;
    renderLayerTree();
    BV.renderBlocks();
    renderInspector();
    drawFrame();
    return id;
  },

  /* 节点图：积木 → 节点 → 积木 往返保真度 */
  nodeRoundTrip(blocks) {
    const list = blocks || (currentLayer() || {}).blocks || [];
    const r = roundTripReport(list);
    return {
      nodeCount: r.graph ? r.graph.nodes.filter(n => n.kind !== 'group').length : 0,
      edgeCount: r.graph ? r.graph.edges.length : 0,
      before: r.before, after: r.after,
      lossless: r.lossless,
      losses: r.losses.map(l => l.msg),
    };
  },

  nodeGraphJSON() {
    if (!App.nodeGraph) refreshNodeGraph();
    return App.nodeGraph ? App.nodeGraph.toJSON() : null;
  },

  /* 字幕 */
  get subtitles() { return App.subPanel.track.toJSON(); },
  loadSubtitles(j) { App.subPanel.loadJSON(j); App.ir.subtitles = App.subPanel.toJSON(); },
  subtitleSrt() { return SUB_EXPORTS.toSRT(App.subPanel.track); },
  subtitleVtt() { return SUB_EXPORTS.toVTT(App.subPanel.track); },
  subtitleAss() { return SUB_EXPORTS.toASS(App.subPanel.track, { width: App.ir.project.width, height: App.ir.project.height }); },
  parseSubtitles(text) { return SUB_EXPORTS.importSubtitles(text).toJSON(); },

  /* 音频 */
  get audioSource() { return App.audioSource; },
  get audioTracks() { return App.audioTracks; },
  audioStatus() { return App.audioDesk.status(); },
  /** 直接塞一段测试音频（自动化用） */
  setAudio(samples, sampleRate, opts = {}) {
    const tr = new AudioTrack({ samples: Float32Array.from(samples), sampleRate: sampleRate || 48000, kind: opts.kind || 'voice', name: opts.name || '测试音频' });
    tr.ensureAnalysis();
    App.audioTracks = [tr];
    App.audioDesk.setTracks(App.audioTracks);
    syncAudioSource();
    renderAudioStatus();
    drawFrame();
    return tr.duration;
  },

  /* 场景树 */
  sceneMasters() { return App.sceneTree ? [...App.sceneTree.masters.values()] : []; },
  sceneTreeRef() { return App.sceneTree; },
  sceneNodeType(id) { const n = App.sceneTree && id ? App.sceneTree.find(id) : null; return n ? (n.isGroup ? 'group' : n.type) : null; },
  sceneFlat() { return App.sceneTree ? App.sceneTree.flatRenderList().map(r => ({ id: r.node.id, name: r.node.name, type: r.node.type, opacity: r.opacity })) : []; },

  /* 数据：没有已载入的数据集时，用「标签即键」直接替换 */
  interpolate(str, row) {
    const ds = App.dataPanel.ds;
    const cols = ds ? ds.columns : Object.keys(row).map(k => ({ key: k, label: k, type: typeof row[k] === 'number' ? 'num' : 'str' }));
    return APP_BATCH.interpolate(str, row, cols, APP_BATCH.FORMATTERS);
  },
  dataPanelSnapshot() {
    return App.dataPanel.ds ? App.dataPanel.ds.toJSON() : { columns: [], rows: [] };
  },
  /** 重新扫描可绑定字段（数据载入后调用） */
  scanDataBindings() {
    const n = App.dataPanel.scanBindable(App.ir);
    return n.length;
  },

  /* 自定义积木 */
  customBlockDemo() {
    const lib = new CustomBlockLibrary();
    const cb = lib.add(new CustomBlock({
      name: '淡入并停顿', op: 'custom.fiw',
      params: [
        { name: 'dur', label: '淡入', type: 'time', defaultValue: TIME(0.6) },
        { name: 'pause', label: '停顿', type: 'time', defaultValue: TIME(0.5) },
      ],
      body: [
        { id: 'd1', k: 'C', op: 'fadeIn', slots: [
          { type: 'sel', value: SEL('t') },
          { type: 'time', value: { k: 'lit', t: 'str', v: '{dur}' } },
          { type: 'time', value: TIME(0) },
        ] },
        { id: 'd2', k: 'C', op: 'wait', slots: [{ type: 'time', value: { k: 'lit', t: 'str', v: '{pause}' } }] },
      ],
    }));
    const call = cb.instantiate({ dur: TIME(1.25) });
    const r = expandCustomBlocks([call], lib);
    return { expanded: r.blocks.length, dur: r.blocks[0] ? r.blocks[0].slots[1].value.v : null };
  },

  /** 构造一个递归调用的自定义积木，验证深度保护 */
  recursiveCustomBlock() {
    const lib = new CustomBlockLibrary();
    const cb = lib.add(new CustomBlock({
      name: '递归', op: 'custom.rec',
      params: [{ name: 'n', type: 'num', defaultValue: NUM(0) }],
      body: [{ id: 'r1', k: 'C', op: 'custom.rec', slots: [{ type: 'num', value: { k: 'lit', t: 'str', v: '{n}' } }] }],
    }));
    void cb;
    return expandCustomBlocks([{ id: 'call', k: 'C', op: 'custom.rec', slots: [{ type: 'num', value: NUM(1) }] }], lib, { maxDepth: 8 });
  },

  /* 导出能力探测 */
  async capabilities() {
    if (!App.caps) App.caps = await detectCapabilities();
    return App.caps;
  },

  /* ---------- V3/V4 自动化 API ---------- */
  market() {
    return {
      count: App.market.list().length,
      templates: App.market.list().map(t => ({
        id: t.id, name: t.name, author: t.author, version: t.version,
        category: t.category, price: t.price, free: t.isFree,
        downloads: t.stats.downloads, likes: t.stats.likes,
        rating: Math.round(t.avgRating * 10) / 10, sales: t.stats.sales,
      })),
      owned: App.market.owned().map(t => t.name),
      earnings: App.market.earnings(App.market.currentUser),
    };
  },
  publishTemplate(meta) {
    const t = App.market.publish(App.ir, Object.assign({
      name: '未命名模板', author: App.market.currentUser, version: '1.0.0',
    }, meta || {}));
    renderMarketList();
    return { id: t.id, name: t.name, version: t.version };
  },
  remixTemplate(id, overrides) {
    const t = App.market.get(id);
    if (!t) throw new Error('模板不存在');
    const can = App.market.canUse(id);
    if (!can.ok) throw new Error(can.reason === 'paid' ? '付费模板需先购买' : '无法使用');
    remixTemplate(t, overrides || {});
    return App.ir.project.name;
  },

  /* AI */
  aiParse(text) {
    const p = new AI.NLParser({
      layers: App.ir.layers.map(l => l.name),
      markers: (App.ir.markers || []).map(m => m.label),
    });
    const r = p.parse(text || '');
    const c = AI.actionsToBlocks(r.actions);
    return {
      actions: r.actions.map(a => ({ op: a.op, why: a.why })),
      warnings: r.warnings,
      blockCount: c.blocks.length,
      skipped: c.skipped.map(s => ({ op: s.op, reason: s.reason })),
      blocks: c.blocks,
    };
  },
  aiBlocksToIR(blocks, layerName) {
    const layer = App.ir.layers.find(l => l.name === layerName) || currentLayer();
    if (!layer) throw new Error('找不到图层');
    layer.blocks = clone(blocks);
    if (App.repo) App.repo.commit(App.ir, 'AI 生成积木', { author: '我' });
    BV.renderBlocks(); drawFrame();
    return layer.blocks.length;
  },
  aiStoryboard(text) {
    const sb = AI.scriptToStoryboard(text || '');
    return {
      sceneCount: sb.scenes.length,
      totalDuration: sb.totalDuration,
      wordCount: sb.wordCount,
      scenes: sb.scenes.map(s => ({
        text: s.text, start: s.start, end: s.end, duration: s.duration,
        effect: s.suggested.op, reason: s.suggested.reason,
        confidence: Math.round(s.suggested.confidence * 100),
        subtitles: s.subtitleText,
      })),
    };
  },
  aiApplyStoryboard(text) {
    const inp = $('aiScriptInput');
    if (inp) inp.value = text || '';
    aiStoryboardApply();
    return { layers: App.ir.layers.length, duration: App.ir.project.duration };
  },
  aiExplain() { return AI.explainProject(App.ir); },
  aiExplainLayer(layerName) {
    const l = App.ir.layers.find(x => x.name === layerName) || currentLayer();
    return l ? AI.explainLayer(l) : [];
  },
  aiInfer(layerName) {
    const l = App.ir.layers.find(x => x.name === layerName) || currentLayer();
    if (!l) throw new Error('找不到图层');
    const r = AI.inferEffectFromFrames(App.ir, l.id, App.audioSource || App.audio, {
      window: Math.min(4, App.ir.project.duration),
    });
    return { best: r.best, guesses: r.guesses, samples: r.series.length, startTime: r.startTime };
  },
  aiLint() {
    return AI.lintProject(App.ir, App.audioSource || App.audio).map(i => ({
      level: i.level, kind: i.kind, msg: i.msg, fix: i.fix,
    }));
  },

  /* 版本 */
  repo() {
    return {
      branch: App.repo.currentBranch,
      branches: App.repo.listBranches(),
      head: App.repo.head(App.repo.currentBranch),
      count: App.repo.log().length,
      log: App.repo.log().map(r => ({
        id: r.shortHash, message: r.message, author: r.author,
        tags: r.tags, blocks: r.stats.blocks || 0,
      })),
    };
  },
  gitCommit(message) {
    const r = App.repo.commit(App.ir, message || '自动提交', { author: '我' });
    renderGitLog();
    return r.shortHash;
  },
  gitBranch(name, checkout = true) {
    App.repo.branch_(name);
    if (checkout) App.repo.checkout(name);
    renderGitLog();
    return App.repo.listBranches();
  },
  gitCheckout(name) { App.repo.checkout(name); renderGitLog(); return name; },
  gitMerge(name, force = false) {
    const r = App.repo.merge(name, { force, author: '我' });
    renderGitLog();
    return {
      ok: r.ok,
      conflicts: (r.conflicts || []).map(c => ({ kind: c.kind, msg: c.msg })),
      revision: r.revision ? r.revision.shortHash : null,
    };
  },
  gitTag(name) { App.repo.tag(name, App.repo.head(App.repo.currentBranch)); renderGitLog(); return name; },
  gitDiff(a, b) {
    const log = App.repo.log();
    const idA = a || (log[1] && log[1].id);
    const idB = b || (log[0] && log[0].id);
    return App.repo.patch(idA, idB);
  },

  /* 素材库 */
  assets(kind, query) {
    const list = query ? App.assets.search(query, kind) : App.assets.all(kind);
    return list.map(a => ({ kind: a.kind, key: a.key, name: a.name, license: a.license, tags: a.tags }));
  },
  sfx(key) {
    const a = App.assets.get('sfx', key);
    if (!a) throw new Error('没有这个音效：' + key);
    const pcm = synthSfx(a.synth);
    return { key, sampleRate: 48000, length: pcm.length, peak: Math.max(...pcm.map(Math.abs)) };
  },
};
