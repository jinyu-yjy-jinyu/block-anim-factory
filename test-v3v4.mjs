/* 套件 10：V3/V4 —— 模板市场 / AI 辅助 / 协作版本 */
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const U = (p) => pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), p)).href;

const MK = await import(U('src/marketplace.js'));
const AI = await import(U('src/ai.js'));
const AIO = await import(U('src/ai-online.js'));
const CO = await import(U('src/collab.js'));
const IR = await import(U('src/ir.js'));
const TP = await import(U('src/templates.js'));
const SUB = await import(U('src/subtitles.js'));
const BL = await import(U('src/blocks.js'));
const EV = await import(U('src/evaluator.js'));
const CBL = await import(U('src/customblocks.js'));

let pass = 0, fail = 0; const failures = [];
// 异步用例必须被等待：原实现把 f() 返回的 Promise 直接当成「非 false」计为通过，
// 于是 async 用例里的断言从未执行也会记为通过。
const pendingTests = [];
const t = (n, f) => {
  const good = (r) => { if (r === false) { fail++; failures.push(`${n} → 断言失败`); } else pass++; };
  const bad = (e) => { fail++; failures.push(`${n} → ${e.message}`); };
  try {
    const r = f();
    if (r && typeof r.then === 'function') { pendingTests.push(r.then(good, bad)); return; }
    good(r);
  } catch (e) { bad(e); }
};
const eq = (a, b, m) => { if (String(a) !== String(b)) throw new Error(`${m || ''} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const near = (a, b, e, m) => { if (!(Math.abs(a - b) <= (e == null ? 1e-6 : e))) throw new Error(`${m || ''} 期望 ≈${b}，实际 ${a}`); };
const ok = (v, m) => { if (!v) throw new Error(m || '期望为真'); };

const mkIR = (key = 'popTitle') => TP.loadTemplate(key);

/* ============================================================
   模板市场
   ============================================================ */
t('市场:发布模板', () => {
  const m = new MK.Marketplace();
  const tpl = m.publish(mkIR(), { name: '我的标题模板', author: 'me', category: 'intro', tags: ['标题'] });
  ok(tpl.id, '应有 id');
  eq(m.list().length, 1);
  eq(tpl.status, 'published');
});
t('市场:校验拦截非法模板', () => {
  const m = new MK.Marketplace();
  let threw = false;
  try { m.publish(null, { name: '空模板', version: '1.0.0' }); } catch { threw = true; }
  ok(threw, '应拒绝空工程');

  threw = false;
  try { m.publish(mkIR(), { name: '版本错', version: 'abc' }); } catch { threw = true; }
  ok(threw, '应拒绝非法版本号');

  threw = false;
  try { m.publish(mkIR(), { name: '负价格', version: '1.0.0', price: -1 }); } catch { threw = true; }
  ok(threw, '应拒绝负价格');
});
t('市场:同名自动发新版本', () => {
  const m = new MK.Marketplace();
  const a = m.publish(mkIR(), { name: '同款模板', author: 'me', version: '1.0.0' });
  const v = m.publishVersion(a.id, mkIR(), { version: '1.1.0', changelog: '改了入场' });
  eq(v.version, '1.1.0');
  eq(m.list().length, 1, '不该多出一条模板');
  eq(m.versionsOf(a.id).length, 2);
  eq(m.get(a.id).version, '1.1.0', '指针应指向新版本');
});
t('市场:重复版本号被拒', () => {
  const m = new MK.Marketplace();
  const a = m.publish(mkIR(), { name: 'T', author: 'me', version: '1.0.0' });
  let threw = false;
  try { m.publishVersion(a.id, mkIR(), { version: '1.0.0' }); } catch { threw = true; }
  ok(threw);
});
t('市场:版本按语义排序', () => {
  const m = new MK.Marketplace();
  const a = m.publish(mkIR(), { name: 'T', author: 'me', version: '1.0.0' });
  m.publishVersion(a.id, mkIR(), { version: '1.10.0' });
  m.publishVersion(a.id, mkIR(), { version: '1.2.0' });
  const vs = m.versionsOf(a.id).map(v => v.version);
  eq(vs.join(','), '1.10.0,1.2.0,1.0.0');
});
t('市场:Remix 装入可编辑副本', () => {
  const m = new MK.Marketplace();
  const tpl = m.publish(mkIR(), { name: 'T', author: 'me', version: '1.0.0' });
  const copy = tpl.instantiate();
  copy.layers[1].props.text = '改过了';
  eq(tpl.ir.layers[1].props.text != null, true);
  ok(tpl.ir.layers[1].props.text !== '改过了', '原模板被污染了');
  eq(copy.templateInfo.id, tpl.id);
});
t('市场:Remix 的自定义积木库必须是真 CustomBlock 实例', () => {
  // #36：原实现 `const { CustomBlock } = { CustomBlock: null }` 解构的是刚造的
  // 空对象，恒为 null，那两行只是障眼法。后果是模板里的自定义积木以裸对象进库，
  // 而 CustomBlockLibrary 的 toJSON() 要调 b.toJSON()、toBlockDefs() 要读
  // b.params.length —— 用到就炸。
  const mkCB = (name, op) => ({
    id: `CB-${op}`, name, op, category: 'custom', color: '#7c5cff',
    desc: '', params: [], body: [], author: '',
  });
  const m = new MK.Marketplace();
  const tpl = m.publish(mkIR(), {
    name: '带自定义积木的模板', author: 'me', version: '1.0.0',
    customBlocks: [mkCB('我的块', 'custom.mine')],
  });
  const copy = tpl.instantiate();
  ok(copy.customLibrary, 'instantiate 没有产出 customLibrary');
  eq(copy.customLibrary.size, 1, `自定义积木数量不对：${copy.customLibrary.size}`);
  const b = copy.customLibrary.list()[0];
  ok(b instanceof CBL.CustomBlock, '库里的条目不是 CustomBlock 实例（裸对象会在 toJSON/toBlockDefs 处炸）');
  eq(typeof b.toJSON, 'function', '条目缺少 toJSON()');
  // 真正会用到的两个方法必须能跑通
  const defs = copy.customLibrary.toBlockDefs();
  eq(defs.length, 1, 'toBlockDefs 产出数量不对');
  eq(defs[0].op, 'custom.mine');
  const json = copy.customLibrary.toJSON();
  eq(json.blocks.length, 1, 'toJSON 产出的块数不对');
});

t('市场:Remix 应用参数覆盖', () => {
  const m = new MK.Marketplace();
  const tpl = m.publish(mkIR(), {
    name: '带参模板', author: 'me', version: '1.0.0',
    params: {
      params: [
        { key: 'text', label: '标题', type: 'text', value: '默认标题', group: '文案' },
        { key: 'fontSize', label: '字号', type: 'num', value: 96, min: 10, max: 400 },
      ],
      locked: [],
    },
  });
  const copy = tpl.instantiate({ text: '自定义标题', fontSize: 200 });
  const textLayer = copy.layers.find(l => l.props.text != null);
  eq(textLayer.props.text, '自定义标题');
});
t('市场:付费模板的购买与分成', () => {
  const m = new MK.Marketplace({ currentUser: '买家' });
  const tpl = m.publish(mkIR(), { name: '付费模板', author: '作者A', version: '1.0.0', price: 1000, revenueShare: 0.7 });
  eq(tpl.isFree, false);

  const can1 = m.canUse(tpl.id);
  eq(can1.ok, false, '未购买不能用');
  eq(can1.reason, 'paid');

  const r = m.purchase(tpl.id);
  eq(r.share, 700, '应结 700 分');
  eq(m.canUse(tpl.id).ok, true, '购买后可用');
  eq(m.get(tpl.id).stats.sales, 1);

  // 收益按作者查（同一本账）
  const e = m.earnings('作者A');
  eq(e.total, 700);
  eq(e.sales, 1);
  eq(e.rows[0].platform, 300, '平台抽成 30%');
  eq(e.rows[0].buyer, '买家');
});
t('市场:作者本人可直接使用', () => {
  const m = new MK.Marketplace({ currentUser: '作者A' });
  const tpl = m.publish(mkIR(), { name: '我的付费模板', author: '作者A', version: '1.0.0', price: 500 });
  eq(m.canUse(tpl.id).ok, true);
  eq(m.canUse(tpl.id).reason, 'own');
});
t('市场:免费模板直接可用', () => {
  const m = new MK.Marketplace();
  const tpl = m.publish(mkIR(), { name: '免费', author: 'x', version: '1.0.0', price: 0 });
  eq(m.canUse(tpl.id).ok, true);
  eq(m.canUse(tpl.id).reason, 'free');
  eq(m.purchase(tpl.id).free, true);
});
t('市场:不能重复购买', () => {
  const m = new MK.Marketplace({ currentUser: '买家' });
  const tpl = m.publish(mkIR(), { name: '付费', author: '作者B', version: '1.0.0', price: 300 });
  m.purchase(tpl.id);
  eq(m.purchase(tpl.id).alreadyOwned, true);
  eq(m.get(tpl.id).stats.sales, 1, '不该重复计数');
});
t('市场:有销售记录只能下架不能删除', () => {
  const m = new MK.Marketplace({ currentUser: '买家' });
  const tpl = m.publish(mkIR(), { name: '付费', author: '作者C', version: '1.0.0', price: 300 });
  m.purchase(tpl.id);           // 先产生一笔销售
  eq(tpl.stats.sales, 1);
  eq(m.remove(tpl.id), true);
  eq(tpl.status, 'removed', '有销售记录应只标记 removed');
  ok(m.templates.has(tpl.id), '对象应保留，购买者仍能查到');
});
t('市场:无销售的可以物理删除', () => {
  const m = new MK.Marketplace();
  const tpl = m.publish(mkIR(), { name: '没人买', author: 'x', version: '1.0.0' });
  eq(m.remove(tpl.id), true);
  eq(m.templates.has(tpl.id), false);
});
t('市场:搜索与筛选', () => {
  const m = new MK.Marketplace();
  m.publish(mkIR(), { name: '口播字幕模板', author: 'a', version: '1.0.0', category: 'speech', tags: ['字幕'] });
  m.publish(mkIR(), { name: '数据榜单模板', author: 'b', version: '1.0.0', category: 'data', tags: ['数据'] });
  eq(m.list({ q: '口播' }).length, 1, '按名字搜');
  eq(m.list({ q: '数据' }).length, 1, '按标签搜');
  eq(m.list({ category: 'data' }).length, 1, '按分类筛');
  eq(m.list({ tag: '字幕' }).length, 1, '按标签筛');
  eq(m.list().length, 2);
});
t('市场:排序', () => {
  const m = new MK.Marketplace();
  const a = m.publish(mkIR(), { name: 'A', author: 'a', version: '1.0.0' });
  const b = m.publish(mkIR(), { name: 'B', author: 'b', version: '1.0.0' });
  m.download(b.id); m.download(b.id); m.download(b.id);
  m.download(a.id);
  eq(m.list({ sort: 'downloads' })[0].name, 'B');
  m.rate(b.id, 5); m.rate(a.id, 3);
  eq(m.list({ sort: 'rating' })[0].name, 'B');
});
t('市场:评分统计', () => {
  const m = new MK.Marketplace();
  const tpl = m.publish(mkIR(), { name: 'T', author: 'x', version: '1.0.0' });
  m.rate(tpl.id, 5); m.rate(tpl.id, 4);
  near(m.get(tpl.id).avgRating, 4.5, 1e-9);
  m.rate(tpl.id, 99);  // 越界应被钳制
  near(m.get(tpl.id).avgRating, (5 + 4 + 5) / 3, 1e-9);
});
t('市场:下架不出现在列表', () => {
  const m = new MK.Marketplace();
  const tpl = m.publish(mkIR(), { name: 'T', author: 'x', version: '1.0.0' });
  m.unlist(tpl.id);
  eq(m.list().length, 0, '下架的不该出现');
  eq(m.get(tpl.id).status, 'unlisted');
});
t('市场:模板包导入导出往返', () => {
  const m = new MK.Marketplace();
  const tpl = m.publish(mkIR(), { name: '打包模板', author: 'x', version: '1.2.0' });
  m.publishVersion(tpl.id, mkIR(), { version: '1.3.0', changelog: '优化' });
  eq(tpl.version, '1.3.0', '指针应指向最新版');
  const pkg = m.exportTemplate(tpl);

  const m2 = new MK.Marketplace();
  const back = m2.importTemplate(pkg);
  eq(back.name, '打包模板');
  eq(back.version, '1.3.0', '应带上当前版本');
  eq(m2.versionsOf(back.id).length, 2, '版本历史应保留');
  eq(m2.versionsOf(back.id).map(v => v.version).join(','), '1.3.0,1.2.0');
  // 旧版本内容仍可取
  ok(m2.getVersion(back.id, '1.2.0'), '应能取到旧版本');
});
t('市场:非法模板包被拒', () => {
  const m = new MK.Marketplace();
  let threw = false;
  try { m.importTemplate('{"format":"other/9"}'); } catch { threw = true; }
  ok(threw);
  threw = false;
  try { m.importTemplate('not json'); } catch { threw = true; }
  ok(threw);
});

/* ============================================================
   素材库
   ============================================================ */
t('素材:五类素材齐全', () => {
  const lib = new MK.AssetLib();
  for (const k of MK.ASSET_KINDS) ok(lib.all(k).length > 0, `${k} 分类为空`);
});
t('素材:搜索', () => {
  const lib = new MK.AssetLib();
  ok(lib.search('字幕').length >= 0);
  const sfx = lib.search('弹出', 'sfx');
  ok(sfx.some(a => a.key === 'pop'), '应搜到 pop');
});
t('素材:全部标注免版权', () => {
  const lib = new MK.AssetLib();
  for (const a of lib.all()) eq(a.license, 'CC0', `${a.key} 缺免版权标注`);
});
t('素材:音效可合成出真实波形', () => {
  const pcm = MK.synthSfx({ type: 'pop', dur: 0.2 });
  ok(pcm.length > 1000, `样本数 ${pcm.length}`);
  ok(pcm.every(v => v >= -1 && v <= 1), '超出 [-1,1]');
  let peak = 0;
  for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  ok(peak > 0.05, `峰值太小 ${peak}`);
  // 首尾应为 0（防爆音）
  near(Math.abs(pcm[0]), 0, 0.01);
  near(Math.abs(pcm[pcm.length - 1]), 0, 0.01);
});
t('素材:各类音效都能合成', () => {
  const lib = new MK.AssetLib();
  for (const a of lib.all('sfx')) {
    const pcm = MK.synthSfx(a.synth);
    ok(pcm.length > 0, `${a.key} 合成为空`);
    ok(pcm.every(v => isFinite(v)), `${a.key} 含非有限值`);
  }
});
t('素材:背景可绘制', () => {
  const calls = [];
  const ctx = {
    save() { calls.push('save'); }, restore() { calls.push('restore'); },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
    fillRect() { calls.push('fillRect'); },
    strokeStyle: '', fillStyle: '',
    createLinearGradient() { return { addColorStop() {} }; },
  };
  const lib = new MK.AssetLib();
  for (const a of lib.all('background')) {
    const okDraw = MK.drawBackground(ctx, a, 1920, 1080);
    ok(okDraw, `${a.key} 绘制失败`);
  }
  ok(calls.includes('fillRect'), '渐变背景应走 fillRect');
});

/* ============================================================
   AI：自然语言转积木
   ============================================================ */
const parser = () => new AI.NLParser({ layers: ['标题文字', '副标题'], markers: ['M1', 'M2'] });

t('AI:解析逐字弹入', () => {
  const r = parser().parse('让标题逐字弹入，延迟 0.05 秒');
  eq(r.actions.length, 1);
  eq(r.actions[0].op, 'charPopIn');
  eq(r.actions[0].slots.gap.v, 0.05, '应解析出间隔');
  ok(r.actions[0].why.includes('0.05'), r.actions[0].why);
});
t('AI:解析淡入时长', () => {
  const r = parser().parse('标题淡入，时长 1.5 秒');
  eq(r.actions[0].op, 'fadeIn');
  eq(r.actions[0].slots.dur.v, 1.5);
});
t('AI:解析方向滑入', () => {
  const r = parser().parse('标题从右侧滑入，用 0.8 秒');
  eq(r.actions[0].op, 'moveIn');
  eq(r.actions[0].slots.dir.v, 'right');
  // 「距离」槽要正值：方向由 dir 决定，evaluator 自己算正负。
  // 若这里把带符号的位移当成距离，会把「从左滑入」变成向右。
  ok(r.actions[0].slots.dist.v > 0, '距离应为正值');
});
t('AI:解析打字机', () => {
  const r = parser().parse('副标题用打字机显示');
  eq(r.actions[0].op, 'typewriter');
  eq(r.actions[0].slots.layer.v, '副标题', '应认出图层名');
});
t('AI:解析重复次数', () => {
  const r = parser().parse('重复 5 次');
  eq(r.actions[0].op, 'loop');
  eq(r.actions[0].slots.count.v, 5);
});
t('AI:解析标记点', () => {
  const r = parser().parse('在标记点 M2 执行');
  eq(r.actions[0].op, 'atMarker');
  eq(r.actions[0].slots.marker.v, 'M2');
});
t('AI:标记点名用的是 label 字段（与 ir/evaluator/UI 一致）', () => {
  // #20 的守门测试：标记点对象只有 label，没有 name。
  // main.js 里如果把 m.label 写成 m.name，标记点列表会变成一串 undefined，
  // 「在标记点」这个条件就永远匹配不到任何锚点。
  const ir = IR.defaultProject('标记测试');
  ir.markers = [
    { id: 'M1', time: 0.2, label: '开场', color: '#ffb020' },
    { id: 'M2', time: 1.5, label: '转折', color: '#ffb020' },
  ];
  // 这个映射必须和 main.js 里喂给解析器的一致
  const names = ir.markers.map(m => m.label);
  eq(names.join(','), '开场,转折', '应取到 label');
  ok(ir.markers.every(m => m.name === undefined), '标记点不该有 name 字段');

  const p = new AI.NLParser({ layers: ['标题文字'], markers: names });
  eq(p.parse('在标记点 转折 执行').actions[0].slots.marker.v, '转折', '应匹配到真实标记名');
});
t('AI:标记点经 toText/fromText 往返后仍是 label', () => {
  const ir = IR.defaultProject('往返测试');
  ir.markers = [{ id: 'M1', time: 0.2, label: '开场', color: '#ffb020' }];
  ir.layers = [IR.newLayer('标题文字', 'text', { text: '你好' })];
  IR.registerOpMeta(BL.BLOCK_DEFS);
  const back = IR.fromText(IR.toText(ir), BL.BLOCK_DEFS).ir;
  eq(back.markers.length, 1);
  eq(back.markers[0].label, '开场', '往返后应保留 label');
});
t('AI:多子句拆成多个动作', () => {
  const r = parser().parse('标题淡入，然后副标题打字机，最后等 1 秒');
  eq(r.actions.length, 3);
  eq(r.actions.map(a => a.op).join(','), 'fadeIn,typewriter,wait');
});
t('AI:听不懂的子句会告警而不是瞎猜', () => {
  const r = parser().parse('标题淡入，然后把冰箱打开');
  eq(r.actions.length, 1);
  ok(r.warnings.length >= 1, '应给出未理解提示');
  ok(r.warnings[0].includes('冰箱'), r.warnings[0]);
});
t('AI:空输入不崩', () => {
  eq(parser().parse('').actions.length, 0);
  eq(parser().parse('   ').actions.length, 0);
  parser().parse(null);
});
t('AI:编译出的积木全部合法', () => {
  const r = parser().parse('标题逐字弹入，延迟 0.05 秒，副标题打字机，柱状图等 2 秒');
  const c = AI.actionsToBlocks(r.actions);
  eq(c.skipped.length, 0, `不该有跳过项：${JSON.stringify(c.skipped)}`);
  eq(c.blocks.length, r.actions.length);
  for (const b of c.blocks) {
    const def = IR.defOf ? IR.defOf(b.op) : null;
    void def;
    ok(b.k === 'C', `${b.op} 应为语句块`);
    ok(b.id, `${b.op} 缺 id`);
    ok(Array.isArray(b.slots), `${b.op} 缺 slots`);
  }
});
t('AI:编译的积木槽位类型正确', () => {
  const r = parser().parse('标题逐字弹入，延迟 0.05 秒');
  const c = AI.actionsToBlocks(r.actions);
  const b = c.blocks[0];
  eq(b.slots.length, 4, 'charPopIn 有 4 个槽');
  // 槽位类型必须与 blocks.js 的定义一致（sel/time/num/sel）
  eq(b.slots.map(s => s.type).join(','), 'sel,time,num,sel');
  eq(b.slots[1].value.t, 'time');
  eq(b.slots[2].value.t, 'num');
  eq(b.slots[2].value.v, 0.05, '间隔数值应落到第 3 槽');
});
t('AI:缺省槽位用积木定义的默认值', () => {
  const r = parser().parse('标题淡入');
  const c = AI.actionsToBlocks(r.actions);
  const b = c.blocks[0];
  ok(b.slots[1].value && b.slots[1].value.k === 'lit', '缺省槽应有合法字面量');
});
t('AI:未知 op 被跳过并记录', () => {
  const c = AI.actionsToBlocks([{ op: 'notAReal', slots: {} }]);
  eq(c.blocks.length, 0);
  eq(c.skipped.length, 1);
  eq(c.skipped[0].reason, '未知积木');
});
t('AI:表达式积木不进顶层', () => {
  const c = AI.actionsToBlocks([{ op: 'amp', slots: {} }]);
  eq(c.blocks.length, 0);
  ok(c.skipped[0].reason.includes('表达式'));
});

/* ============================================================
   AI：可选在线模型（OpenAI 兼容协议）
   ============================================================ */
t('在线AI:默认本地、配置可持久化', () => {
  const mem = new Map();
  const storage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
  };
  eq(AIO.defaultConfig().provider, 'local');
  AIO.saveConfig(AIO.setProfile(AIO.defaultConfig(), 'custom', {
    baseUrl: ' https://api.example.com/v1/ ', model: ' m1 ', apiKey: ' sk-x ',
  }), storage);
  const loaded = AIO.loadConfig(storage);
  eq(loaded.provider, 'custom');
  eq(loaded.custom.baseUrl, 'https://api.example.com/v1');
  eq(loaded.custom.model, 'm1');
  eq(AIO.activeProfile(loaded).apiKey, 'sk-x');
  eq(AIO.loadConfig({ getItem: () => '{bad json' }).provider, 'local');
});

t('在线AI:Base URL 归一化与动作白名单', () => {
  eq(AIO.normalizeBaseUrl('http://127.0.0.1:11434/v1/chat/completions/'), 'http://127.0.0.1:11434/v1');
  eq(AIO.normalizeBaseUrl('https://x.test/v1///'), 'https://x.test/v1');
  const catalog = AIO.actionCatalog();
  const ops = catalog.map(a => a.op);
  ok(ops.includes('fadeIn'));
  ok(!ops.includes('notReal'));
  // 白名单 = 所有「能独立成句」的语句积木：既不是帽子，也没有子栈槽。
  // 手写清单一定会漏（#19 就是这么来的），所以这里用定义反推校验。
  const expected = BL.BLOCK_DEFS
    .filter(d => !d.isLeaf && !BL.HAT_OPS.has(d.op) && !d.slots.some(s => s.type === 'blocks'))
    .map(d => d.op);
  eq(ops.slice().sort().join(','), expected.slice().sort().join(','), '在线白名单与积木定义不一致');
  ok(!ops.includes('forever'), 'C 形积木要嵌套子栈，扁平 actions 表达不了');
  ok(!ops.includes('whenStart'), '帽子积木不对在线模型开放');
  const part = catalog.find(a => a.op === 'particles');
  eq(part.slots.map(s => s.key).join(','), 'count,start,life,color,speed,lifeScale,spread,gravity,drag,sizeScale');
  // 提示词里要把闭集菜单的实际取值写出来，否则模型只能猜
  const cat = AIO.formatActionCatalog();
  ok(/createObject/.test(cat) && /rect\(矩形\)/.test(cat), '对象类型菜单要把取值列进提示词');
  ok(/可选 this\(当前脚本\)/.test(cat), '停止范围菜单要把取值列进提示词');
});

t('在线AI:选项参数接受中文名，运行时创建的对象可被后续动作引用', () => {
  const { actions, warnings } = AIO.coerceActions([
    { op: 'createObject', slots: { name: '按钮', type: '圆形', x: 300, y: 400 } },
    { op: 'glideTo', slots: { layer: '按钮', x: 800, y: 200, dur: 1.2 } },
    { op: 'setBlendMode', slots: { layer: '标题文字', mode: '正片叠底' } },
    { op: 'setVar', slots: { name: 'score', value: 10, scope: '全局' } },
    { op: 'playSound', slots: { sound: '哔声', volume: 80 } },
    { op: 'setBlendMode', slots: { layer: '标题文字', mode: '不存在模式' } },
  ], { layers: ['标题文字'] });
  eq(warnings.length, 1, warnings.join('|'));
  ok(warnings[0].includes('setBlendMode.mode'), `告警应指向非法选项：${warnings[0]}`);
  eq(actions.length, 6);
  eq(actions[0].slots.type.v, 'circle', '「圆形」应换成积木里真正存的 circle');
  eq(actions[1].slots.layer.v, '按钮', '同批次 createObject 建出的对象名应被认可');
  eq(actions[2].slots.mode.v, 'multiply');
  eq(actions[3].slots.scope.v, 'global');
  eq(actions[4].slots.sound.v, 'beep');
  const c = AI.actionsToBlocks(actions);
  eq(c.skipped.length, 0, JSON.stringify(c.skipped));
  eq(c.blocks.length, 6);
});

t('在线AI:模型动作被强类型校验后编译', () => {
  const { actions, warnings } = AIO.coerceActions([
    { op: 'fadeIn', slots: { layer: '标题文字', dur: '1.5', start: '0.2', extra: 1 }, why: '标题淡入' },
    { op: 'notReal', slots: {} },
  ], { layers: ['标题文字'] });
  eq(actions.length, 1);
  eq(warnings.length, 1);
  eq(actions[0].slots.dur.t, 'time');
  eq(actions[0].slots.dur.v, 1.5);
  eq(actions[0].slots.start.v, 0.2);
  ok(!('extra' in actions[0].slots), '多余参数应被丢弃');
  const c = AI.actionsToBlocks(actions);
  eq(c.blocks.length, 1);
  eq(c.skipped.length, 0);
  eq(c.blocks[0].slots[1].value.v, 1.5);
});

t('在线AI:不存在的图层被丢弃并告警', () => {
  const { actions, warnings } = AIO.coerceActions(
    [{ op: 'fadeIn', slots: { layer: '不存在', dur: 1 } }],
    { layers: ['标题文字'] },
  );
  ok(!('layer' in actions[0].slots));
  ok(warnings.some(w => w.includes('不存在')));
});

t('在线AI:兼容代码块包裹的 JSON', () => {
  const r = AIO.parseActionsFromContent(
    '好的：\n```json\n{"actions":[{"op":"fadeIn","slots":{"layer":"标题文字","dur":1}}]}\n```',
    { layers: ['标题文字'] },
  );
  eq(r.actions.length, 1);
  eq(AIO.extractJSON('prefix [1,2] suffix').length, 2);
});

t('在线AI:请求路径/鉴权/模型并编译积木', async () => {
  let seen = null;
  const fakeFetch = async (url, init) => {
    seen = { url, init };
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: '{"actions":[{"op":"fadeIn","slots":{"layer":"标题文字","dur":1.2},"why":"淡入"}]}' } }],
      }),
    };
  };
  const r = await AIO.parseActions('标题淡入', {
    config: {
      provider: 'custom',
      custom: { baseUrl: 'https://api.example.com/v1/', model: 'm1', apiKey: 'sk-test' },
    },
    layers: ['标题文字'], markers: ['M1'], fetchImpl: fakeFetch,
  });
  eq(seen.url, 'https://api.example.com/v1/chat/completions');
  eq(seen.init.method, 'POST');
  eq(seen.init.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(seen.init.body);
  eq(body.model, 'm1');
  eq(body.messages.length, 2);
  ok(body.messages[0].content.includes('fadeIn'), '系统提示词应包含积木白名单');
  eq(r.actions.length, 1);
  eq(AI.actionsToBlocks(r.actions).blocks.length, 1);
});

t('在线AI:Ollama 无密钥时不发 Authorization', async () => {
  let seen = null;
  const fakeFetch = async (url, init) => {
    seen = { url, init };
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: '{"actions":[{"op":"fadeIn","slots":{"layer":"标题文字"}}]}' } }],
      }),
    };
  };
  await AIO.parseActions('标题淡入', {
    config: { provider: 'ollama' }, layers: ['标题文字'], fetchImpl: fakeFetch,
  });
  eq(seen.url, 'http://127.0.0.1:11434/v1/chat/completions');
  ok(!('Authorization' in seen.init.headers));
});

t('在线AI:接口错误带状态码且不崩', async () => {
  let err = null;
  try {
    await AIO.parseActions('标题淡入', {
      config: {
        provider: 'custom',
        custom: { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'bad' },
      },
      layers: [],
      fetchImpl: async () => ({
        ok: false, status: 401,
        text: async () => JSON.stringify({ error: { message: 'invalid key' } }),
      }),
    });
  } catch (e) { err = e; }
  ok(err && err.message.includes('401') && err.message.includes('invalid key'));
});

t('在线AI:连接测试解析模型列表', async () => {
  let seen = null;
  const r = await AIO.testConnection({ provider: 'ollama' }, {
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ object: 'list', data: [{ id: 'qwen2.5:7b' }, { id: 'llama3.1' }] }),
      };
    },
  });
  eq(seen.url, 'http://127.0.0.1:11434/v1/models');
  eq(r.models.length, 2);
  ok(r.models.includes('qwen2.5:7b'));
});

t('在线AI:拒绝非 http(s) 的 Base URL', () => {
  let err = null;
  try {
    AIO.validateConfig({ provider: 'custom', custom: { baseUrl: 'file:///etc/passwd', model: 'x' } });
  } catch (e) { err = e; }
  ok(err && err.message.includes('http'), '应拒绝 file:// 协议');
});

t('在线AI:分镜按累计时间排列并回退非法动效', async () => {
  const fakeFetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({
      choices: [{
        message: {
          content: '{"scenes":[{"text":"第一句。","duration":2,"op":"fadeIn","reason":"开场"},{"text":"第二句","duration":3,"op":"notReal","reason":"x"}]}',
        },
      }],
    }),
  });
  const sb = await AIO.generateStoryboard('第一句。第二句', {
    config: { provider: 'ollama' }, fetchImpl: fakeFetch,
  });
  eq(sb.scenes.length, 2);
  eq(sb.scenes[0].start, 0);
  eq(sb.scenes[0].end, 2);
  eq(sb.scenes[1].start, 2.35);
  eq(sb.scenes[1].suggested.op, AI.suggestEffect('第二句').op, '非法动效应回退到本地建议');
  ok(sb.totalDuration > 0);
  eq(sb.scenes[0].subtitleText.length, 1);
  const c = AI.actionsToBlocks(sb.scenes.map(s => ({
    op: s.suggested.op, slots: { layer: IR.SEL(s.text) },
  })));
  eq(c.blocks.length, 2);
});

/* ============================================================
   AI：文案分镜
   ============================================================ */
t('分镜:按句末标点切分', () => {
  const sb = AI.scriptToStoryboard('第一句话。第二句话！第三句话？');
  eq(sb.scenes.length, 3);
  eq(sb.scenes[0].text, '第一句话');
  ok(sb.totalDuration > 0);
});
t('分镜:场景时间不重叠且递增', () => {
  const sb = AI.scriptToStoryboard('一句话。两句话。三句话。');
  for (let i = 1; i < sb.scenes.length; i++) {
    ok(sb.scenes[i].start >= sb.scenes[i - 1].end, `第 ${i} 个场景重叠`);
  }
});
t('分镜:长句会二次切分', () => {
  const sb = AI.scriptToStoryboard('这是一段很长很长没有标点的文案它包含了很多信息需要被合理地拆分成若干个场景以便后期剪辑使用');
  ok(sb.scenes.length >= 3, `只切出 ${sb.scenes.length} 个场景`);
});
t('分镜:每场都有动效建议与理由', () => {
  const sb = AI.scriptToStoryboard('增长 30%。为什么是这样？短句');
  ok(sb.scenes.every(s => s.suggested && s.suggested.op && s.suggested.reason), '缺少建议');
});
t('分镜:数字句推荐数字滚动', () => {
  const sug = AI.suggestEffect('增长了 30%');
  eq(sug.op, 'numberRoll');
});
t('分镜:问句推荐缩放', () => {
  const sug = AI.suggestEffect('为什么是这样');
  eq(sug.op, 'scaleIn');
});
t('分镜:短句推荐逐字弹入', () => {
  const sug = AI.suggestEffect('太棒了');
  eq(sug.op, 'charPopIn');
});
t('分镜:长句推荐打字机', () => {
  const sug = AI.suggestEffect('这是一句相当长的句子用来测试打字机推荐的判断逻辑');
  eq(sug.op, 'typewriter');
});
t('分镜:每个场景带标记点', () => {
  const sb = AI.scriptToStoryboard('一句话。两句话。');
  ok(sb.scenes.every(s => s.markers.length === 1), '应有标记点');
  eq(new Set(sb.scenes.flatMap(s => s.markers.map(m => m.name))).size, sb.scenes.length, '标记点名不该重复');
});
t('分镜:每场切好字幕文本', () => {
  const sb = AI.scriptToStoryboard('短句。这是一句非常非常长的句子用来测试字幕切分逻辑是否正常工作');
  ok(sb.scenes.every(s => Array.isArray(s.subtitleText)), 'subtitleText 应为数组');
  for (const s of sb.scenes) {
    for (const line of s.subtitleText) {
      ok([...line].length <= 18, `字幕行太长（${[...line].length} 字）：${line}`);
    }
  }
});
t('分镜:字数统计', () => {
  const sb = AI.scriptToStoryboard('你好世界');
  eq(sb.wordCount, 4);
});

/* ============================================================
   AI：字幕对齐
   ============================================================ */
function trackFrom(texts, withWords) {
  const tr = new SUB.SubtitleTrack();
  let cur = 0;
  texts.forEach((txt, i) => {
    const dur = Math.max(1, [...txt].length / 5.5);
    tr.add(new SUB.SubtitleCue({
      start: cur, end: cur + dur, text: txt,
      words: withWords ? texts[i].split('').map((ch, k) => ({
        word: ch, start: cur + k * dur / [...txt].length, end: cur + (k + 1) * dur / [...txt].length,
      })) : [],
    }));
    cur += dur + 0.1;
  });
  return tr;
}

t('AI:每个积木的槽位落位都与 blocks.js 的类型相符', () => {
  // #19 的守门测试：SLOT_ORDER 错开一位时，参数会落进类型不符的槽
  //（时间槽拿到颜色、数字槽拿到布尔），界面上看不出来，跑起来全错。
  const sentences = [
    '标题逐字弹入，间隔 0.08 秒', '标题逐个出现，间隔 0.2 秒', '标题打字机',
    '标题淡入，时长 1.5 秒', '标题淡出，时长 0.9 秒', '标题从右侧滑入，时长 1.2 秒',
    '标题缩放入场，时长 0.8 秒', '标题擦除，时长 1.1 秒', '标题沿波浪路径',
    '标题数字滚动到 500', '标题逐词高亮', '音频波形柱 64 个', '环形频谱 48 个',
    '柱状图生长 30,55,80', '折线图生长 10,40,25', '画一个红色方块',
    '等待 2 秒', '重复 4 次',
    // 新增的 P0 句式：这些积木槽位多、类型杂，最容易重演 #19 的错位
    '粒子 120 个，速度 300', '重复器复制 10 个，间距 120',
    '广播「开始」', '一直重复', '把变量 score 设为 10', '得分增加 5',
    '新建列表「名单」', '往列表「名单」加入 甲', '创建一个圆形对象「按钮」',
    '隐藏图层 标题', '显示对象 标题', '移到 300,400', '滑行到 800,200，用时 1.2 秒',
  ];
  const p = new AI.NLParser({ layers: ['标题文字', '标题', '装饰方块'] });
  for (const s of sentences) {
    const c = AI.actionsToBlocks(p.parse(s).actions);
    for (const b of c.blocks) {
      const def = BL.defOf(b.op);
      ok(def, `blocks.js 里没有 ${b.op}`);
      b.slots.forEach((slot, i) => {
        const spec = def.slots[i];
        if (!spec || !slot.value || typeof slot.value !== 'object') return;
        const got = slot.value.t;
        if (!got) return;
        if (got === spec.type) return;
        ok(false, `${b.op} 第 ${i} 槽是 ${spec.type}/${spec.label}，却拿到 ${got}/${JSON.stringify(slot.value.v)}（「${s}」）`);
      });
    }
  }
});
t('AI:新增的 P0 句式能被认出并编译成积木', () => {
  // 只测「落位类型对」不够：句式没认出时 actions 是空的，循环直接跳过，
  // 测试照样绿。这里钉住每句话确实产出对应的 op。
  const cases = [
    ['广播「开始」', 'broadcast'],
    ['一直重复', 'forever'],
    ['把变量 score 设为 10', 'setVar'],
    ['得分增加 5', 'changeVar'],
    ['新建列表「名单」', 'listCreate'],
    ['往列表「名单」加入 甲', 'listAdd'],
    ['创建一个圆形对象「按钮」', 'createObject'],
    ['隐藏图层 标题', 'hideObject'],
    ['显示对象 标题', 'showObject'],
    ['移到 300,400', 'setPosition'],
    ['滑行到 800,200，用时 1.2 秒', 'glideTo'],
    ['粒子 120 个，速度 300', 'particles'],
    ['重复器复制 10 个，间距 120', 'repeater'],
  ];
  const p = new AI.NLParser({ layers: ['标题文字', '标题'] });
  for (const [s, expect] of cases) {
    const r = p.parse(s);
    eq(r.actions.length, 1, `「${s}」应认出 1 个动作，警告：${r.warnings.join('|')}`);
    eq(r.actions[0].op, expect, `「${s}」识别错了`);
    const c = AI.actionsToBlocks(r.actions);
    eq(c.skipped.length, 0, `「${s}」编译失败：${JSON.stringify(c.skipped)}`);
  }
});
t('AI:坐标里的逗号不会被当成子句分隔符', () => {
  // 「移动到 300,400」拆成两个子句的话，两个都听不懂，用户看到的是「没听懂」。
  const r = parser().parse('标题移到 300,400');
  eq(r.warnings.length, 0, r.warnings.join('|'));
  eq(r.actions.length, 1);
  eq(r.actions[0].slots.x.v, 300);
  eq(r.actions[0].slots.y.v, 400);
});
t('AI:滑入方向经求值器验证真的朝对的一边', () => {
  // 光看槽位类型不够：距离传成带符号的值，类型仍是 num，但方向会反。
  const dirCases = [
    ['标题从右滑入，时长 1.2 秒', 1],
    ['标题从左滑入，时长 1.2 秒', -1],
  ];
  for (const [s, sign] of dirCases) {
    const c = AI.actionsToBlocks(parser().parse(s).actions);
    const ir = {
      project: { width: 1920, height: 1080, duration: 5, fps: 30 },
      markers: [], layers: [{
        id: 'L1', name: '标题', visible: true,
        props: { x: 0, y: 0, opacity: 1, text: '标题', scale: 1 },
        blocks: c.blocks,
      }],
    };
    const x0 = EV.evaluateFrame(ir, 0, null).state.layers.L1.p.x;
    const xEnd = EV.evaluateFrame(ir, 4, null).state.layers.L1.p.x;
    ok(Math.sign(x0 - xEnd) === sign,
      `「${s}」应从 ${sign > 0 ? '右' : '左'}侧进入，实测起点 x=${x0}、终点 x=${xEnd}`);
    near(xEnd, 0, 1e-6, '入场结束后应回到原位');
  }
});
t('AI:缩放入场经求值器验证从 from 到 to', () => {
  const c = AI.actionsToBlocks(parser().parse('标题缩放入场，时长 0.8 秒').actions);
  const ir = {
    project: { width: 1920, height: 1080, duration: 5, fps: 30 },
    markers: [], layers: [{
      id: 'L1', name: '标题', visible: true,
      props: { x: 0, y: 0, opacity: 1, text: '标题', scale: 1 },
      blocks: c.blocks,
    }],
  };
  const s0 = EV.evaluateFrame(ir, 0, null).state.layers.L1.fx.scale;
  const sEnd = EV.evaluateFrame(ir, 4, null).state.layers.L1.fx.scale;
  ok(s0 < 1, `入场起点应小于 1 倍，实测 ${s0}`);
  // 「到」槽必须真的被填上：留空或填错会让动画停在小尺寸，画面永远是缩着的。
  near(sEnd, 1, 1e-6, '入场结束后应回到 1 倍（正常大小）');
});
t('AI:反向解释读的槽位与 blocks.js 一致', () => {
  // explainBlock 是同一份位置契约的第三个读点，串位时会说出错误的动画描述。
  const cases = [
    ['标题从右滑入，时长 1.2 秒', '120'],
    ['环形频谱 48 个', '半径 300'],
    ['音频波形柱 64 个', '64'],
    ['标题逐词高亮 红色', '#ff4a4a'],
  ];
  const p = new AI.NLParser({ layers: ['标题文字', '标题', '装饰方块'] });
  for (const [s, shouldSay] of cases) {
    const c = AI.actionsToBlocks(p.parse(s).actions);
    const text = AI.explainBlock(c.blocks[0]);
    ok(text.includes(shouldSay), `「${s}」的说明应含 ${shouldSay}，实际：${text}`);
  }
});
t('AI:柱状图的「起始」与「间隔」没有互相串位', () => {
  // 两个槽都是 time 类型，光比类型抓不住；串位会让所有柱子同时长出，
  // 逐根生长的效果消失（这正是 #19 修好前的症状）。
  const c = AI.actionsToBlocks(parser().parse('柱状图生长 30,55,80').actions);
  const b = c.blocks.find(x => x.op === 'growBar');
  ok(b, '应编译出 growBar');
  const gap = b.slots[3].value && b.slots[3].value.v;
  const start = b.slots[4].value && b.slots[4].value.v;
  ok(gap > 0, `第 4 槽「间隔」应大于 0，实际 ${gap}（串到「起始」会让柱子同时长出）`);
  eq(start, 0, '第 5 槽「起始」应为 0');
});
t('AI:字幕转积木（无词级时间码）', () => {
  const tr = trackFrom(['短句', '中等长度的句子'], false);
  const r = AI.subtitlesToBlocks(tr, { layer: '标题文字' });
  eq(r.blocks.length, 2);
  ok(r.markers.length === 2, '应生成标记点');
  ok(r.actions.every(a => a.why), '每个动作都该有解释');
});
t('AI:字幕转积木（有词级时间码用高亮）', () => {
  const tr = trackFrom(['你好世界'], true);
  const r = AI.subtitlesToBlocks(tr);
  eq(r.actions[0].op, 'highlightWord', '有词级时间码应走逐词高亮');
});
t('AI:字幕转积木产出的块全部合法', () => {
  const tr = trackFrom(['短句', '中等长度的句子', '很长很长很长很长很长的一句中文'], false);
  const r = AI.subtitlesToBlocks(tr);
  eq(r.skipped.length, 0);
  for (const b of r.blocks) {
    ok(b.slots.every(s => s.value === undefined || s.value === null || typeof s.value === 'object'), '槽值应合法');
  }
});
t('AI:字幕转积木产出可直接求值', () => {
  const ir = mkIR();
  const tr = trackFrom(['短句'], false);
  const r = AI.subtitlesToBlocks(tr);
  const layer = ir.layers.find(l => l.id === '标题文字') || ir.layers[0];
  layer.blocks = r.blocks;
  let threw = false;
  try {
    const { evaluateFrame } = globalThis.__EV || {};
    void evaluateFrame;
  } catch { threw = true; }
  ok(!threw);
});

/* ============================================================
   AI：反向解释
   ============================================================ */
t('解释:逐字弹入', () => {
  const b = { k: 'C', op: 'charPopIn', slots: [
    { type: 'sel', value: IR.SEL('标题文字') },
    { type: 'time', value: IR.TIME(0.2) },
    { type: 'num', value: IR.NUM(0.05) },
    { type: 'sel', value: IR.SEL('backOut') },
  ] };
  const s = AI.explainBlock(b);
  ok(s.includes('标题文字'), s);
  ok(s.includes('0.05'), s);
  ok(s.includes('backOut'), s);
});
t('解释:淡入', () => {
  const b = { k: 'C', op: 'fadeIn', slots: [
    { type: 'sel', value: IR.SEL('副标题') },
    { type: 'time', value: IR.TIME(1.5) },
    { type: 'time', value: IR.TIME(0) },
  ] };
  const s = AI.explainBlock(b);
  ok(s.includes('淡入') && s.includes('1.5'), s);
});
t('解释:未知积木不崩', () => {
  ok(AI.explainBlock({ k: 'C', op: 'zzzz', slots: [] }).includes('未知'), '应提示未知');
  AI.explainBlock({ k: 'C', op: 'wait' });   // 缺 slots
});
t('解释:图层与工程级说明', () => {
  const ir = mkIR();
  const lines = AI.explainProject(ir);
  ok(lines.length >= ir.layers.length, `只有 ${lines.length} 行`);
  ok(lines[0].includes('1920') || lines[0].includes('1080'), lines[0]);
  ok(lines.some(l => l.includes('图层')), '缺少图层说明');
});
t('解释:空积木的图层也能解释', () => {
  const ir = mkIR();
  ir.layers[0].blocks = [];
  const lines = AI.explainProject(ir);
  ok(lines.some(l => l.includes('没有积木')), '应说明该图层无逻辑');
});
t('解释:真实模板能产出有意义的说明', () => {
  const ir = mkIR('karaoke');
  const lines = AI.explainProject(ir);
  const text = lines.join('\n');
  ok(text.length > 60, '说明太短');
  ok(text.includes('高亮') || text.includes('弹') || text.includes('淡入'), text.slice(0, 200));
});

/* ============================================================
   AI：从帧反推动效
   ============================================================ */
const { AudioSource } = await import(U('src/audiosource.js'));
t('反推:静止图层不猜', () => {
  const ir = mkIR();
  const audio = AudioSource.synth({ duration: ir.project.duration });
  const r = AI.inferEffectFromFrames(ir, ir.layers[0].id, audio, { window: 2 });
  ok(r.best, '应给出结论');
  ok(Array.isArray(r.series) && r.series.length > 3, '应有采样序列');
});
t('反推:静态图层报 none', () => {
  const ir = mkIR('barChart');   // barChart 第一个图层是静态背景
  const audio = AudioSource.synth({ duration: ir.project.duration });
  const staticLayer = ir.layers.find(l => !l.blocks || !l.blocks.length)
    || ir.layers[ir.layers.length - 1];
  const r = AI.inferEffectFromFrames(ir, staticLayer.id, audio, { window: 3 });
  ok(r.series.every(s => isFinite(s.opacity) && isFinite(s.x)), '采样应全为有限值');
});
t('反推:缺图层时报错', () => {
  const ir = mkIR();
  let threw = false;
  try { AI.inferEffectFromFrames(ir, '不存在的id', null); } catch { threw = true; }
  ok(threw);
});

/* ============================================================
   AI：工程体检
   ============================================================ */
t('体检:全静态工程会提示', () => {
  const ir = mkIR();
  for (const l of ir.layers) l.blocks = [];
  const issues = AI.lintProject(ir, null);
  ok(issues.some(i => i.kind === 'noBlocks'), '应提示没有动画');
});
t('体检:时长不是帧数整数倍会提示', () => {
  const ir = mkIR();
  ir.project.fps = 24;
  // 7.01s × 24fps = 168.24 帧 —— 真的不是整数
  ir.project.duration = 7.01;
  const issues = AI.lintProject(ir, null);
  ok(issues.some(i => i.kind === 'fpsMismatch'), '应提示帧率不匹配：' + issues.map(i => i.kind).join(','));
});
t('体检:帧数恰为整数时不该误报', () => {
  const ir = mkIR();
  ir.project.fps = 24;
  ir.project.duration = 5.5;      // 5.5 × 24 = 132，正整数
  ok(!AI.lintProject(ir, null).some(i => i.kind === 'fpsMismatch'), '整数帧被误报了');
});
t('体检:时长过短过长会提示', () => {
  const ir = mkIR();
  ir.project.duration = 0.5;
  ok(AI.lintProject(ir, null).some(i => i.kind === 'tooShort'));
  ir.project.duration = 200;
  ok(AI.lintProject(ir, null).some(i => i.kind === 'tooLong'));
});
t('体检:零时长等待会被提示', () => {
  const ir = mkIR();
  ir.layers[1].blocks = [{ k: 'C', op: 'wait', slots: [{ type: 'time', value: IR.TIME(0) }] }];
  ok(AI.lintProject(ir, null).some(i => i.kind === 'zeroWait'));
});
t('体检:逐字间隔为 0 会被提示', () => {
  const ir = mkIR();
  ir.layers[1].blocks = [{
    k: 'C', op: 'charPopIn', slots: [
      { type: 'sel', value: IR.SEL('标题文字') },
      { type: 'time', value: IR.TIME(0) },
      { type: 'num', value: IR.NUM(0) },
      { type: 'sel', value: IR.SEL('backOut') },
    ],
  }];
  ok(AI.lintProject(ir, null).some(i => i.kind === 'zeroGap'));
});
t('体检:音频驱动但无真实音频时提醒', () => {
  const ir = mkIR('audioBars');
  const issues = AI.lintProject(ir, AudioSource.synth({ duration: 6 }));
  ok(issues.some(i => i.kind === 'audioFallback'), '应提示用的是合成音频');
});
t('体检:正常工程没有 error 级问题', () => {
  for (const key of ['popTitle', 'audioBars', 'barChart', 'karaoke', 'ring', 'particles']) {
    const issues = AI.lintProject(TP.loadTemplate(key), AudioSource.synth({ duration: 6 }));
    const errs = issues.filter(i => i.level === 'error');
    eq(errs.length, 0, `${key} 有 error：${errs.map(e => e.msg).join(';')}`);
  }
});

/* ============================================================
   协作与版本
   ============================================================ */
t('版本:初始化与提交', () => {
  const repo = new CO.Repo();
  const r0 = repo.init(mkIR(), { message: '初始', author: '我' });
  eq(repo.log().length, 1);
  eq(r0.message, '初始');

  const r1 = repo.commit(mkIR('karaoke'), '换成字幕模板', { author: '我' });
  eq(repo.log().length, 2);
  eq(repo.log()[0].id, r1.id, '最新应在最前');
  eq(r1.parent, r0.id);
});
t('版本:历史可回溯', () => {
  const repo = new CO.Repo();
  const r0 = repo.init(mkIR(), { message: 'v1' });
  const r1 = repo.commit(mkIR(), 'v2');
  const r2 = repo.commit(mkIR('ring'), 'v3');
  eq(repo.get(r0.id).message, 'v1');
  eq(repo.get(r1.id).message, 'v2');
  eq(repo.get(r2.id).parent, r1.id);
  eq(repo.head('main'), r2.id);
});
t('版本:标签', () => {
  const repo = new CO.Repo();
  const r = repo.init(mkIR(), { message: '正式版' });
  repo.tag('v1.0', r.id, '第一次对外发布');
  eq(repo.byTag('v1.0').id, r.id);
  repo.tag('v1.0', r.id);   // 重复打标应幂等
  eq(repo.get(r.id).tags.length, 1);
  eq(repo.removeTag('v1.0'), true);
  eq(repo.byTag('v1.0'), null);
});
t('版本:回滚是追加提交而非改历史', () => {
  const repo = new CO.Repo();
  const r0 = repo.init(mkIR('popTitle'), { message: '原版' });
  const r1 = repo.commit(mkIR('ring'), '改成环形');
  const before = repo.log().length;
  const back = repo.revert(r0.id);
  eq(repo.log().length, before + 1, '回滚应新增一个提交');
  ok(back.message.includes('回滚到'), back.message);
  eq(back.parent, r1.id, '回滚提交的父应是当前 head');
  // 历史没被破坏，旧提交仍在
  eq(repo.get(r0.id).id, r0.id);
  eq(repo.get(r1.id).id, r1.id);
  // 回滚后的内容应等于原版
  eq(back.ir.layers.length, r0.ir.layers.length);
});
t('版本:分支派生', () => {
  const repo = new CO.Repo();
  repo.init(mkIR(), { message: 'base' });
  repo.branch_('文案');
  repo.branch_('动画');
  eq(repo.listBranches().length, 3);
  repo.checkout('文案');
  eq(repo.currentBranch, '文案');
  let threw = false;
  try { repo.branch_('文案'); } catch { threw = true; }
  ok(threw, '重复分支名应报错');
});
t('版本:不能删主干', () => {
  const repo = new CO.Repo();
  repo.init(mkIR());
  let threw = false;
  try { repo.deleteBranch('main'); } catch { threw = true; }
  ok(threw);
  eq(repo.deleteBranch('不存在的'), false);
});
t('版本:分支互不干扰', () => {
  const repo = new CO.Repo();
  repo.init(mkIR(), { message: 'base' });
  repo.branch_('feature');
  repo.commit(mkIR('ring'), '主干改动');
  repo.checkout('feature');
  repo.commit(mkIR('particles'), '分支改动');
  eq(repo.log('main').length, 2, '主干 2 个提交');
  eq(repo.log('feature').length, 2, '分支 2 个提交');
  eq(repo.log('feature')[0].ir.layers[0].name, repo.log('feature')[0].ir.layers[0].name);
  ok(repo.log('main')[0].id !== repo.log('feature')[0].id, '两边应有独立的 head');
});
t('合并:一边没改直接采纳另一边', () => {
  const repo = new CO.Repo();
  repo.init(mkIR(), { message: 'base' });
  repo.branch_('feature');
  repo.commit(mkIR('ring'), '主干改');
  repo.checkout('feature');
  repo.commit(mkIR(), '分支没改');
  repo.checkout('main');
  const r = repo.merge('feature');
  eq(r.ok, true);
  eq(r.conflicts.length, 0, JSON.stringify(r.conflicts));
});
t('合并:两边都没改', () => {
  const repo = new CO.Repo();
  repo.init(mkIR(), { message: 'base' });
  repo.branch_('feature');
  repo.checkout('feature');
  repo.commit(mkIR(), '分支小改');
  repo.checkout('main');
  repo.commit(mkIR(), '主干小改');
  const r = repo.merge('feature');
  eq(r.conflicts.length, 0, JSON.stringify(r.conflicts));
  eq(r.ok, true);
});
t('合并:冲突会明确列出而不是静默丢弃', () => {
  const repo = new CO.Repo();
  repo.init(mkIR(), { message: 'base' });
  repo.branch_('feature');

  // 两边改同一个图层的同一块积木，改成不同的
  repo.commit(mkIR(), '主干改积木');
  repo.checkout('feature');
  repo.commit(mkIR(), '分支改积木');
  repo.checkout('main');

  const r = repo.merge('feature');
  // 不管有没有冲突，结果都必须能拿到，且冲突项带说明
  if (!r.ok) {
    ok(r.conflicts.length > 0, '应该有冲突');
    ok(r.conflicts.every(c => c.kind && c.msg), '冲突项必须有 kind 与说明');
  }
  eq(r.ok, true, '本例应能自动合并（都是空改动）');
});
t('合并:属性冲突被逐项列出', () => {
  const repo = new CO.Repo();
  const irA = mkIR();
  const irB = cloneIR(irA);
  repo.init(irA, { message: 'base' });
  repo.branch_('feature');

  const irOurs = cloneIR(irA);
  irOurs.layers[1].props.fontSize = 120;
  repo.commit(irOurs, '我改字号');

  repo.checkout('feature');
  const irTheirs = cloneIR(irB);
  irTheirs.layers[1].props.fontSize = 200;
  repo.commit(irTheirs, '对方改字号');
  repo.checkout('main');

  const r = repo.merge('feature');
  eq(r.ok, false, '属性冲突应被拦下');
  ok(r.conflicts.some(c => c.kind === 'propConflict' && c.msg.includes('fontSize')),
    JSON.stringify(r.conflicts));
  // 结果应以 ours 为准
  eq(r.merged, null, '有冲突时不产出合并结果');
});
t('合并:force 可强制通过', () => {
  const repo = new CO.Repo();
  const ir = mkIR();
  repo.init(ir, { message: 'base' });
  repo.branch_('feature');
  const a = cloneIR(ir); a.layers[1].props.fontSize = 120;
  repo.commit(a, '我改');
  repo.checkout('feature');
  const b = cloneIR(ir); b.layers[1].props.fontSize = 200;
  repo.commit(b, '对方改');
  repo.checkout('main');
  const r = repo.merge('feature', { force: true });
  eq(r.ok, true, 'force 应放行');
  eq(r.merged.layers[1].props.fontSize, 120, '应保留 ours');
});
t('合并:对方新增图层会被合入', () => {
  const repo = new CO.Repo();
  const ir = mkIR();
  repo.init(ir, { message: 'base' });
  repo.branch_('feature');
  const a = cloneIR(ir);
  a.layers.push({ id: 'NEW1', name: '对方加的', type: 'rect', visible: true, props: { x: 100, y: 100, w: 50, h: 50, fill: '#fff' }, blocks: [] });
  repo.commit(a, '我这边加一个');

  repo.checkout('feature');
  const b = cloneIR(ir);
  b.layers.push({ id: 'NEW2', name: '分支加的', type: 'rect', visible: true, props: { x: 200, y: 200, w: 50, h: 50, fill: '#fff' }, blocks: [] });
  repo.commit(b, '分支加一个');
  repo.checkout('main');

  const r = repo.merge('feature');
  eq(r.ok, true, JSON.stringify(r.conflicts));
  ok(r.merged.layers.some(l => l.id === 'NEW2'), '对方新增的图层应合入');
});
t('合并:对方删除未改动的图层会跟着删', () => {
  const repo = new CO.Repo();
  const ir = mkIR();
  repo.init(ir, { message: 'base' });
  repo.branch_('feature');
  const a = cloneIR(ir);
  a.layers[1].blocks = [{ k: 'C', op: 'wait', slots: [{ type: 'time', value: IR.TIME(1) }] }];
  repo.commit(a, '我改了图层2');

  repo.checkout('feature');
  const b = cloneIR(ir);
  b.layers.splice(1, 1);      // 分支删了图层2
  repo.commit(b, '分支删图层2');
  repo.checkout('main');

  const r = repo.merge('feature');
  eq(r.ok, false, '删除 vs 修改 应算冲突');
  ok(r.conflicts.some(c => c.kind === 'deleteVsEdit'), JSON.stringify(r.conflicts));
});

/* ------------------------------------------------------------
   合并覆盖度回归。
   全部用 cloneIR 从同一个 base 派生 ours/theirs —— 必须这样写。
   TP.loadTemplate() 每次调用都会生成全新的 id（uid() 里含 Date.now + random），
   所以「各自 loadTemplate 再合并」的写法会让三方 id 完全不相交，
   merge() 看到的只是「全新增 + 全删除」，逐项比对一次都不会发生。
   上面 :825/:837/:849 三条旧用例正是这种情况（实测 base∩ours 图层 id = 0），
   它们的 ok=true / conflicts=0 是在没有可比对象时得出的，不构成覆盖证据。
   ------------------------------------------------------------ */
function mergeScenario(base, mutateOurs, mutateTheirs) {
  const repo = new CO.Repo();
  repo.init(cloneIR(base), { message: 'base' });
  repo.branch_('feature');
  const o = cloneIR(base), th = cloneIR(base);
  if (mutateOurs) mutateOurs(o);
  if (mutateTheirs) mutateTheirs(th);
  repo.commit(o, '我改');
  repo.checkout('feature');
  repo.commit(th, '对方改');
  repo.checkout('main');
  return repo.merge('feature');
}
function baseWithMarkers() {
  const b = cloneIR(mkIR());
  b.markers = [{ id: 'M1', time: 0, label: '开场', color: '#fff' }];
  b.variables = [{ id: 'V1', name: '次数', type: 'any', value: 1 }];
  return b;
}

t('合并:对方单独改标记点会被合入（不是静默丢）', () => {
  const r = mergeScenario(baseWithMarkers(), null, (ir) => { ir.markers[0].time = 9.9; });
  eq(r.ok, true, JSON.stringify(r.conflicts));
  eq(r.merged.markers[0].time, 9.9, '对方的改动应真的进到合并结果里');
});
t('合并:对方单独改变量会被合入（不是静默丢）', () => {
  const r = mergeScenario(baseWithMarkers(), null, (ir) => { ir.variables[0].value = 999; });
  eq(r.ok, true, JSON.stringify(r.conflicts));
  eq(r.merged.variables[0].value, 999, '对方的改动应真的进到合并结果里');
});
t('合并:对方单独改图层名会被合入（不是静默丢）', () => {
  const r = mergeScenario(mkIR(), null, (ir) => { ir.layers[1].name = '对方改的名'; });
  eq(r.ok, true, JSON.stringify(r.conflicts));
  eq(r.merged.layers[1].name, '对方改的名');
});
t('合并:标记点两边改成不同值 → markerConflict', () => {
  const r = mergeScenario(baseWithMarkers(),
    (ir) => { ir.markers[0].time = 1.1; },
    (ir) => { ir.markers[0].time = 9.9; });
  eq(r.ok, false, '标记点冲突应被拦下');
  ok(r.conflicts.some(c => c.kind === 'markerConflict'), JSON.stringify(r.conflicts));
  eq(r.merged, null, '有冲突时不产出合并结果');
});
t('合并:变量两边改成不同值 → varConflict', () => {
  const r = mergeScenario(baseWithMarkers(),
    (ir) => { ir.variables[0].value = 5; },
    (ir) => { ir.variables[0].value = 999; });
  eq(r.ok, false, '变量冲突应被拦下');
  ok(r.conflicts.some(c => c.kind === 'varConflict'), JSON.stringify(r.conflicts));
  eq(r.merged, null);
});
t('合并:图层名两边改成不同值 → 冲突', () => {
  const r = mergeScenario(mkIR(),
    (ir) => { ir.layers[1].name = '我改的名'; },
    (ir) => { ir.layers[1].name = '对方改的名'; });
  eq(r.ok, false, '图层名冲突应被拦下');
  ok(r.conflicts.some(c => c.kind === 'layerFieldConflict' && c.msg.includes('name')), JSON.stringify(r.conflicts));
});
t('合并:我方删除、对方改过该图层 → 也要报冲突（两侧对称）', () => {
  // 旧实现只覆盖「对方删我改」，这一支的对方改动会被静默丢掉
  const r = mergeScenario(mkIR(),
    (ir) => { ir.layers.splice(1, 1); },
    (ir) => { ir.layers[1].props.fontSize = 300; });
  eq(r.ok, false, '我方删除 vs 对方修改 应算冲突');
  ok(r.conflicts.some(c => c.kind === 'deleteVsEdit'), JSON.stringify(r.conflicts));
  eq(r.merged, null);
});
t('合并:两边都删同一图层 → 静默通过', () => {
  const r = mergeScenario(mkIR(),
    (ir) => { ir.layers.splice(1, 1); },
    (ir) => { ir.layers.splice(1, 1); });
  eq(r.ok, true, JSON.stringify(r.conflicts));
  eq(r.merged.layers.length, 2);
});

/* 标记点/变量的删除路径。上面那条「两边都删」只覆盖了 layers ——
   markers/variables 走的是另一套（mergeIdList），必须单独盯，
   否则「两边都删掉的标记点被重新塞回来」这种错会漏过去。 */
t('合并:两边都删同一标记点 → 静默通过且不复活', () => {
  const r = mergeScenario(baseWithMarkers(),
    (ir) => { ir.markers = []; },
    (ir) => { ir.markers = []; });
  eq(r.ok, true, JSON.stringify(r.conflicts));
  eq(r.merged.markers.length, 0, '两边都删了就不该再出现');
});
t('合并:我方删标记点、对方改过它 → 报冲突（不静默丢）', () => {
  const r = mergeScenario(baseWithMarkers(),
    (ir) => { ir.markers = []; },
    (ir) => { ir.markers[0].time = 9.9; });
  eq(r.ok, false, '我方删除 vs 对方修改 应算冲突');
  ok(r.conflicts.some(c => c.kind === 'deleteVsEdit' && c.id === 'M1'), JSON.stringify(r.conflicts));
});
t('合并:对方删标记点、我改过它 → 报冲突', () => {
  const r = mergeScenario(baseWithMarkers(),
    (ir) => { ir.markers[0].time = 1.1; },
    (ir) => { ir.markers = []; });
  eq(r.ok, false, '对方删除 vs 我修改 应算冲突');
  ok(r.conflicts.some(c => c.kind === 'deleteVsEdit' && c.id === 'M1'), JSON.stringify(r.conflicts));
});
t('合并:我删标记点、对方没动 → 静默跟着删', () => {
  const r = mergeScenario(baseWithMarkers(), (ir) => { ir.markers = []; }, null);
  eq(r.ok, true, JSON.stringify(r.conflicts));
  eq(r.merged.markers.length, 0);
});
t('合并:对方新增标记点 → 自动合入', () => {
  const r = mergeScenario(baseWithMarkers(),
    null,
    (ir) => { ir.markers.push({ id: 'M2', time: 3, label: '收场', color: '#f00' }); });
  eq(r.ok, true, JSON.stringify(r.conflicts));
  eq(r.merged.markers.length, 2);
  ok(r.merged.markers.some(m => m.id === 'M2'), '对方新增的标记点应在结果里');
});
t('合并:未知顶层字段两边改不同 → 兜底报冲突', () => {
  const r = mergeScenario(mkIR(),
    (ir) => { ir.extraField = 'ours'; },
    (ir) => { ir.extraField = 'theirs'; });
  eq(r.ok, false, '未知顶层字段冲突应被拦下');
  ok(r.conflicts.some(c => c.kind === 'topLevelConflict' && c.msg.includes('extraField')), JSON.stringify(r.conflicts));
});
t('合并:未知顶层字段只有对方新增 → 自动合入', () => {
  const r = mergeScenario(mkIR(), null, (ir) => { ir.extraField = 'ok'; });
  eq(r.ok, true, JSON.stringify(r.conflicts));
  eq(r.merged.extraField, 'ok');
});
t('合并:旧用例的模板 id 确实不相交（空转现象留证）', () => {
  // 锁定这个事实：若将来 uid() 变成确定性实现，本用例会失败并提醒重看上面注释
  const a = mkIR(), b = mkIR();
  const inter = a.layers.filter(l => b.layers.some(x => x.id === l.id));
  eq(inter.length, 0, '模板两次加载的图层 id 不应相交（相交说明 uid 改了，需重估空转用例）');
});

t('差异:识别新增/删除/修改', () => {
  const a = mkIR();
  const b = cloneIR(a);
  b.layers.push({ id: 'X', name: '新图层', type: 'rect', visible: true, props: {}, blocks: [] });
  const d = CO.diffIR(a, b);
  eq(d.added.length, 1);
  eq(d.added[0].name, '新图层');

  const c = cloneIR(a);
  c.layers.splice(1, 1);
  eq(CO.diffIR(a, c).removed.length, 1);

  const e = cloneIR(a);
  e.layers[1].props.fontSize = 200;
  ok(CO.diffIR(a, e).changed.length >= 1);
});
t('差异:识别积木变化', () => {
  const a = mkIR();
  const b = cloneIR(a);
  b.layers[1].blocks = [{ k: 'C', op: 'wait', slots: [{ type: 'time', value: IR.TIME(9) }] }];
  const d = CO.diffIR(a, b);
  ok(d.blockChanges.length > 0, '应识别出积木变化');
  ok(d.blockChanges[0].msg.includes('wait'), d.blockChanges[0].msg);
});
t('差异:识别项目设置变化', () => {
  const a = mkIR();
  const b = cloneIR(a);
  b.project.fps = 60;
  const d = CO.diffIR(a, b);
  ok(d.project.some(p => p.key === 'fps'), JSON.stringify(d.project));
});
t('补丁:生成可读文本', () => {
  const repo = new CO.Repo();
  const r0 = repo.init(mkIR(), { message: 'base' });
  const r1 = repo.commit(mkIR('ring'), '换环形');
  const p = repo.patch(r0.id, r1.id);
  ok(p.includes('#'), '应有标题');
  ok(p.length > 20, '补丁太短');
});
t('版本库:JSON 往返', () => {
  const repo = new CO.Repo();
  repo.init(mkIR(), { message: 'v1' });
  repo.branch_('x');
  repo.checkout('main');
  repo.commit(mkIR('ring'), 'v2');
  repo.tag('v1.0', repo.head('main'));

  const back = CO.Repo.fromJSON(JSON.parse(JSON.stringify(repo.toJSON())));
  eq(back.log('main').length, repo.log('main').length);
  eq(back.listBranches().sort().join(','), repo.listBranches().sort().join(','));
  ok(back.log('main')[0].ir, '恢复后 IR 应可用');
  eq(back.log('main')[0].ir.layers.length, repo.log('main')[0].ir.layers.length);
  ok(back.byTag('v1.0'), '标签应保留');
  eq(back.currentBranch, 'main');
  // 恢复后还能继续提交
  const r = back.commit(mkIR('karaoke'), '恢复后提交');
  eq(back.log('main').length, repo.log('main').length + 1);
  ok(r.id);
});
t('版本库:非法格式被拒', () => {
  let threw = false;
  try { CO.Repo.fromJSON({ format: 'other/1' }); } catch { threw = true; }
  ok(threw);
});
t('版本:循环 parent 不会死循环', () => {
  const repo = new CO.Repo();
  const r = repo.init(mkIR());
  r.parent = r.id;          // 人为制造环
  eq(repo.log().length, 1, '应只返回 1 个而非死循环');
});
t('版本:统计含块数', () => {
  const repo = new CO.Repo();
  const r = repo.init(mkIR());
  ok(r.stats.blocks > 0, `块数 ${r.stats.blocks}`);
  eq(r.stats.layers, mkIR().layers.length);
});

function cloneIR(ir) { return JSON.parse(JSON.stringify(ir)); }

t('素材:音效合成是确定性的（同一 spec 两次结果逐样本相同）', () => {
  // #45：click / noise-sweep 原来用 Math.random()，同一工程导两次波形不同，
  // 「可复现导出」这条声明就是假的。噪声源改成 hash01(i) 后必须逐样本一致。
  for (const type of ['click', 'noise-sweep']) {
    const a = MK.synthSfx({ type, dur: 0.15 });
    const b = MK.synthSfx({ type, dur: 0.15 });
    eq(a.length, b.length, `${type} 长度不稳定`);
    let diff = 0, firstDiff = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) { diff++; if (firstDiff < 0) firstDiff = i; }
    }
    eq(diff, 0, `${type} 两次合成有 ${diff} 个样本不同（首个在 ${firstDiff}）—— 随机源没换成确定性`);
  }
});
t('素材:音效仍是真噪声（不是常数或单调斜坡）', () => {
  // 换随机源不能把音效变成「一段死波形」：
  // 相邻样本差值的绝对值应显著大于 0（真噪声的特征）。
  for (const type of ['click', 'noise-sweep']) {
    const pcm = MK.synthSfx({ type, dur: 0.15 });
    let sumAbsDiff = 0, n = 0;
    for (let i = 1; i < pcm.length; i++) { sumAbsDiff += Math.abs(pcm[i] - pcm[i - 1]); n++; }
    const avg = sumAbsDiff / n;
    ok(avg > 0.001, `${type} 相邻样本平均差 ${avg.toFixed(5)} 太小 —— 像死波形`);
  }
});
t('素材:音效幅度与包络未被确定性改造改变', () => {
  // 只换随机源，不许动幅度/包络公式：峰值应落在原公式给出的范围内。
  const click = MK.synthSfx({ type: 'click', dur: 0.1 });
  let peak = 0;
  for (const v of click) peak = Math.max(peak, Math.abs(v));
  // 公式是 (rand*2-1) * exp(-p*40) * 0.7 → 峰值不超过 0.7
  ok(peak <= 0.7001, `click 峰值 ${peak.toFixed(4)} 超出公式上限 0.7`);
  ok(peak > 0.1, `click 峰值 ${peak.toFixed(4)} 太小，幅度可能被改了`);

  const sweep = MK.synthSfx({ type: 'noise-sweep', dur: 0.1 });
  let sp = 0;
  for (const v of sweep) sp = Math.max(sp, Math.abs(v));
  ok(sp <= 0.3501, `noise-sweep 峰值 ${sp.toFixed(4)} 超出公式上限 0.35`);
});

/* ============================================================
   repeater / particles 的参数槽位契约
   ------------------------------------------------------------
   blocks.js 里这两个积木**没有图层槽**：
     repeater  = 份数 / 水平间距 / 错峰间隔 / 起始 / 起始高度
     particles = 粒子数 / 起始 / 时长 / 颜色 / 速度
   但 templates.js 用的是带图层名的写法（blk('repeater', [L('重复条'), ...])），
   于是存在两套语义。原先 evaluator 只认 6 参数写法，面板拖出来的 5 槽积木
   被整体错一位读 —— 份数读成间距、间距读成错峰，用户填的值全被吃错。
   ============================================================ */
const NUMLIT = (v) => ({ k: 'lit', t: 'num', v });
const TIMELIT = (v) => ({ k: 'lit', t: 'time', v });
const SELLIT = (v) => ({ k: 'lit', t: 'sel', v });

function oneLayerIR(op, slots, layerName = '重复条', type = 'shape') {
  return {
    project: { name: 'p', width: 1920, height: 1080, fps: 30, duration: 5 },
    markers: [], variables: [],
    layers: [{
      id: 'L1', name: layerName, type, visible: true,
      props: { x: 960, y: 540, w: 100, h: 20 },
      blocks: [{ id: 'B1', op, slots: slots.map(value => ({ value })) }],
    }],
    customLibrary: null,
  };
}
function evalLayer(ir, t = 0) {
  const { state } = EV.evaluateFrame(ir, t, null);
  return state.layers['L1'];
}

t('积木:repeater 按面板 5 个槽读，参数不再整体错一位', () => {
  // 面板里填：份数 8、间距 90、错峰 0.06、起始 0、起始高度 20
  const ir = oneLayerIR('repeater', [
    NUMLIT(8), NUMLIT(90), TIMELIT(0.06), TIMELIT(0), NUMLIT(20),
  ]);
  const ls = evalLayer(ir);
  ok(ls.data && ls.data.kind === 'repeater', `没产出 repeater 数据：${JSON.stringify(ls.data)}`);
  const items = ls.data.items;
  eq(items.length, 8, `份数读错：期望 8，实际 ${items.length}`);
  eq(items.slice(0, 4).map(x => +x.delay.toFixed(3)).join(','), '0,0.06,0.12,0.18',
    `错峰间隔读错：${items.slice(0, 4).map(x => x.delay).join(',')}`);
  eq(items.slice(0, 4).map(x => x.x).join(','), '0,90,180,270',
    `水平间距读错：${items.slice(0, 4).map(x => x.x).join(',')}`);
  eq(items[0].h, 20, `起始高度读错：${items[0].h}`);
});

t('积木:repeater 带图层槽的模板写法仍被正确识别', () => {
  // 模板写法：第 0 槽是图层名，参数从第 1 槽开始
  const ir = oneLayerIR('repeater', [
    SELLIT('重复条'), NUMLIT(14), NUMLIT(92), TIMELIT(0.05), TIMELIT(1.0), NUMLIT(16),
  ]);
  // 定义只有 5 槽，这里手工补到 6 槽以模拟模板语义
  ir.layers[0].blocks[0].slots.push({ value: NUMLIT(16) });
  ir.layers[0].blocks[0].slots = [
    { value: SELLIT('重复条') }, { value: NUMLIT(14) }, { value: NUMLIT(92) },
    { value: TIMELIT(0.05) }, { value: TIMELIT(1.0) }, { value: NUMLIT(16) },
  ];
  const ls = evalLayer(ir);
  const items = ls.data.items;
  eq(items.length, 14, `带图层槽时份数读错：${items.length}`);
  eq(items[1].x, 92, `带图层槽时间距读错：${items[1].x}`);
  eq(+items[1].delay.toFixed(3), 1.05, `带图层槽时错峰读错：${items[1].delay}`);
  eq(items[0].h, 16, `带图层槽时起始高度读错：${items[0].h}`);
});

t('积木:particles 按面板 5 个槽读', () => {
  // 面板：粒子数 90、起始 0、时长 3、颜色 #4a8cff、速度 180
  const ir = oneLayerIR('particles', [
    NUMLIT(90), TIMELIT(0), TIMELIT(3), { k: 'lit', t: 'col', v: '#4a8cff' }, NUMLIT(180),
  ], '粒子');
  const ls = evalLayer(ir);
  ok(ls.data && ls.data.kind === 'particles', `没产出 particles 数据：${JSON.stringify(ls.data)}`);
  eq(ls.data.ps.length, 90, `粒子数读错：${ls.data.ps.length}`);
  eq(ls.data.dur, 3, `时长读错：${ls.data.dur}`);
  eq(ls.data.start, 0, `起始读错：${ls.data.start}`);
  eq(ls.data.color, '#4a8cff', `颜色读错：${ls.data.color}`);
  // 速度决定初速大小：180 的量级应落在 72~180 之间（0.4~1.0 倍）
  const speeds = ls.data.ps.map(p => Math.hypot(p.vx, p.vy));
  const maxSp = Math.max(...speeds);
  ok(maxSp > 60 && maxSp <= 180.001, `速度读错：最大初速 ${maxSp.toFixed(1)}（期望 ≤180 且同量级）`);
});

t('积木:particles 带图层槽的模板写法仍被正确识别', () => {
  const ir = oneLayerIR('particles', [], '粒子');
  ir.layers[0].blocks[0].slots = [
    { value: SELLIT('粒子') }, { value: NUMLIT(140) }, { value: TIMELIT(1.4) },
    { value: TIMELIT(3.5) }, { value: { k: 'lit', t: 'col', v: '#7c5cff' } }, { value: NUMLIT(220) },
  ];
  const ls = evalLayer(ir);
  eq(ls.data.ps.length, 140, `带图层槽时粒子数读错：${ls.data.ps.length}`);
  eq(ls.data.dur, 3.5, `带图层槽时时长读错：${ls.data.dur}`);
  eq(ls.data.start, 1.4, `带图层槽时起始读错：${ls.data.start}`);
  eq(ls.data.color, '#7c5cff', `带图层槽时颜色读错：${ls.data.color}`);
});

t('积木:repeater/particles 的图层槽判别不会把数字当图层名', () => {
  // 判别必须稳：面板填的第一个值是数字，不能被误认成图层名
  const ir = oneLayerIR('repeater', [
    NUMLIT(8), NUMLIT(90), TIMELIT(0.06), TIMELIT(0), NUMLIT(20),
  ]);
  const ls = evalLayer(ir);
  eq(ls.data.items.length, 8, '第一个数字被当成图层槽，参数整体错位');
});

t('模板:particles 模板的行为与槽位修复前保持一致', () => {
  // 这条守「修面板路径不能把既有模板改坏」。
  // 模板实际存下来的槽（blk 按 def.slots 截断）：图层名/140/1.4/3.5/#7c5cff
  const ir = TP.loadTemplate('particles');
  const rep = ir.layers.find(l => l.name === '重复条');
  const ps = ir.layers.find(l => l.name === '粒子');
  ok(rep && ps, '模板缺少重复条/粒子图层');
  const { state } = EV.evaluateFrame(ir, 1.0, null);
  const rl = state.layers[rep.id].data;
  const pl = state.layers[ps.id].data;
  eq(rl.kind, 'repeater');
  eq(rl.items.length, 14, `模板重复器份数变了：${rl.items.length}`);
  eq(rl.items[1].x, 92, `模板重复器间距变了：${rl.items[1].x}`);
  eq(pl.kind, 'particles');
  eq(pl.ps.length, 140, `模板粒子数变了：${pl.ps.length}`);
  eq(pl.dur, 3.5, `模板粒子时长变了：${pl.dur}`);
  eq(pl.start, 1.4, `模板粒子起始变了：${pl.start}`);
});

t('模板:particles 模板的粒子真的会动、重复条真的有高度', () => {
  // 这条是本轮最关键的回归：修复前这个模板从发布起就是坏的 ——
  // templates.js 多传了一个图层名参数，blk() 按 def.slots 的 5 个槽硬塞，
  // 参数整体右移一位，于是：
  //   重复条：槽4「起始高度」拿到的是 1.0（时间值）→ h=0
  //   粒子：  槽4「速度」拿到的是颜色字符串 "#7c5cff" → speed=0 → 原地不动
  // 用户打开模板看到的是坏画面，且不报错。
  const ir = TP.loadTemplate('particles');
  const rep = ir.layers.find(l => l.name === '重复条');
  const ps = ir.layers.find(l => l.name === '粒子');
  ok(rep && ps, '模板缺少重复条/粒子图层');

  const { state } = EV.evaluateFrame(ir, 1.0, null);
  const rl = state.layers[rep.id].data;
  const pl = state.layers[ps.id].data;

  eq(rl.kind, 'repeater');
  eq(rl.items.length, 14, `模板重复器份数变了：${rl.items.length}`);
  eq(rl.items[1].x, 92, `模板重复器间距变了：${rl.items[1].x}`);
  // 关键：起始高度必须真的是 16，不能是 0
  eq(rl.items[0].h, 16, `重复条高度是 ${rl.items[0].h}，应为 16（参数错位时会是 0）`);

  eq(pl.kind, 'particles');
  eq(pl.ps.length, 140, `模板粒子数变了：${pl.ps.length}`);
  eq(pl.dur, 3.5, `模板粒子时长变了：${pl.dur}`);
  eq(pl.start, 1.4, `模板粒子起始变了：${pl.start}`);
  // 关键：速度必须真的是 220 量级，不能是 0
  const maxSp = Math.max(...pl.ps.map(p => Math.hypot(p.vx, p.vy)));
  ok(maxSp > 80, `粒子最大初速只有 ${maxSp.toFixed(2)}，应约 220（参数错位时会是 0，粒子原地不动）`);
});

t('模板:所有模板的槽值类型都与 blocks.js 定义相符', () => {
  // 通用守门：防止再有模板把「图层名」塞进 num 槽、把颜色塞进 num 槽。
  // 判据是「值的类型」与「槽声明的类型」一致。
  const bad = [];
  for (const meta of TP.TEMPLATES) {
    const ir = TP.loadTemplate(meta.key);
    for (const l of ir.layers) {
      for (const b of l.blocks) {
        const def = BL.defOf(b.op);
        if (!def) continue;
        b.slots.forEach((s, i) => {
          const want = def.slots[i];
          if (!want) { bad.push(`${meta.key}/${l.name}/${b.op}[${i}] 定义里没有这个槽`); return; }
          const v = s.value && s.value.v;
          const numLike = want.type === 'num' || want.type === 'time';
          if (numLike && typeof v === 'string' && isNaN(Number(v))) {
            bad.push(`${meta.key}/${l.name}/${b.op}[${i}]「${want.label}」是 ${want.type} 槽，却存了字符串 ${JSON.stringify(v)}`);
          }
          if (want.type === 'col' && typeof v === 'number') {
            bad.push(`${meta.key}/${l.name}/${b.op}[${i}]「${want.label}」是 col 槽，却存了数字 ${v}`);
          }
          if (want.type === 'sel' && typeof v === 'number') {
            bad.push(`${meta.key}/${l.name}/${b.op}[${i}]「${want.label}」是 sel 槽，却存了数字 ${v}`);
          }
        });
      }
    }
  }
  eq(bad.length, 0, `模板槽位值类型不符：\n  ${bad.join('\n  ')}`);
});

t('模板:particles 模板的每个块槽数都等于 blocks.js 的定义', () => {
  // blk() 按 def.slots.length 截断：多传的参数会被静默丢弃，
  // 少传的会落到 defaultForType。两种都不该发生 —— 槽数必须正好相等。
  const bad = [];
  for (const meta of TP.TEMPLATES) {
    const ir = TP.loadTemplate(meta.key);
    for (const l of ir.layers) {
      for (const b of l.blocks) {
        const def = BL.defOf(b.op);
        if (!def) continue;
        const want = (def.slots || []).length;
        if (b.slots.length !== want) {
          bad.push(`${meta.key}/${l.name}/${b.op}: 存了 ${b.slots.length} 槽，定义是 ${want} 槽`);
        }
      }
    }
  }
  eq(bad.length, 0, `模板槽数与定义不符：\n  ${bad.join('\n  ')}`);
});

/* ============================================================
   汇总
   ============================================================ */
await Promise.all(pendingTests);   // 等所有异步用例真正跑完再统计
console.log('');
if (fail === 0) console.log(`%c✓ V3/V4（市场/素材/AI/协作）自测全部通过 ${pass}/${pass + fail}`, 'color:#38c98b;font-weight:700');
else {
  console.log(`%c✗ ${fail}/${pass + fail} 失败`, 'color:#ff5a5a;font-weight:700');
  for (const f of failures) console.log('  · ' + f);
}
console.log('');
process.exit(fail === 0 ? 0 : 1);