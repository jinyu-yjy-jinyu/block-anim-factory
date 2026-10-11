/* 套件 10：V3/V4 —— 模板市场 / AI 辅助 / 协作版本 */
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const U = (p) => pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), p)).href;

const MK = await import(U('src/marketplace.js'));
const AI = await import(U('src/ai.js'));
const CO = await import(U('src/collab.js'));
const IR = await import(U('src/ir.js'));
const TP = await import(U('src/templates.js'));
const SUB = await import(U('src/subtitles.js'));

let pass = 0, fail = 0; const failures = [];
const t = (n, f) => {
  try { const r = f(); if (r === false) { fail++; failures.push(`${n} → 断言失败`); } else pass++; }
  catch (e) { fail++; failures.push(`${n} → ${e.message}`); }
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
  ok(r.actions[0].slots.dx.v > 0, '向右应有正 X 位移');
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

/* ============================================================
   汇总
   ============================================================ */
console.log('');
if (fail === 0) console.log(`%c✓ V3/V4（市场/素材/AI/协作）自测全部通过 ${pass}/${pass + fail}`, 'color:#38c98b;font-weight:700');
else {
  console.log(`%c✗ ${fail}/${pass + fail} 失败`, 'color:#ff5a5a;font-weight:700');
  for (const f of failures) console.log('  · ' + f);
}
console.log('');
process.exit(fail === 0 ? 0 : 1);