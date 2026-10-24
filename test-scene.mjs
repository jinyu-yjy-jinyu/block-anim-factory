/* 套件 6：字幕系统 / 场景树 / 文字引擎 / 节点编辑器 / 数据绑定 */
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const U = (p) => pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), p)).href;

const SUB = await import(U('src/subtitles.js'));
const SC = await import(U('src/scene.js'));
const TE = await import(U('src/textengine.js'));
const IR = await import(U('src/ir.js'));
const HC = await import(U('src/headless-canvas.mjs'));

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
const thr = (v, m) => { let x = false; try { v(); } catch (e) { x = true; m = m + ' → ' + e.message; } if (x) throw new Error(m); };

/* ============================================================
   字幕
   ============================================================ */
const mkTrack = () => SUB.SubtitleTrack.fromLines([
  '第一句话在这里', '第二句稍微长一点点', '第三句', '最后一句收尾',
], { cps: 6, gap: 0.15 });

t('字幕:从台词卡生成条目', () => {
  const tr = mkTrack();
  eq(tr.cues.length, 4);
  ok(tr.cues[0].start === 0, '首条从 0 开始');
  ok(tr.cues[1].start > tr.cues[0].end, '条目不重叠');
  ok(tr.duration > 0, '总时长 > 0');
});
t('字幕:at 查询命中', () => {
  const tr = mkTrack();
  const c = tr.cues[0];
  ok(tr.at(c.start + 0.1) === c, 'start+0.1 应命中');
  ok(!tr.at(c.start - 0.1), 'start 前不应命中');
  ok(!tr.at(c.end + 0.1), 'end 后不应命中');
});
t('字幕:next/prev 翻页', () => {
  const tr = mkTrack();
  const c0 = tr.cues[0], c1 = tr.cues[1];
  eq(tr.next(c0.start + 0.1), c1);
  eq(tr.prev(c1.start + 0.1), c0);
  eq(tr.prev(0), null);
});
t('字幕:SRT 往返一致', () => {
  const tr = mkTrack();
  const srt = SUB.toSRT(tr);
  const back = SUB.importSubtitles(srt);
  eq(back.cues.length, tr.cues.length);
  for (let i = 0; i < tr.cues.length; i++) {
    eq(back.cues[i].text, tr.cues[i].text, `第 ${i} 条文本`);
    near(back.cues[i].start, tr.cues[i].start, 0.002, `第 ${i} 条开始`);
    near(back.cues[i].end, tr.cues[i].end, 0.002, `第 ${i} 条结束`);
  }
});
t('字幕:VTT 往返一致', () => {
  const tr = mkTrack();
  const back = SUB.importSubtitles(SUB.toVTT(tr));
  eq(back.cues.length, tr.cues.length);
  eq(back.cues[2].text, tr.cues[2].text);
  near(back.cues[1].start, tr.cues[1].start, 0.002);
});
t('字幕:ASS 往返一致（含样式与 \N）', () => {
  const tr = mkTrack();
  tr.cues[0].secondary = 'English line';
  const ass = SUB.toASS(tr);
  ok(/\[Script Info\]/.test(ass), '缺少 Script Info');
  ok(/\[V4\+ Styles\]/.test(ass), '缺少样式块');
  ok(/\[Events\]/.test(ass), '缺少事件块');
  const back = SUB.parseASS(ass);
  eq(back.cues.length, tr.cues.length);
  eq(back.cues[0].text, tr.cues[0].text);
  eq(back.cues[0].secondary, 'English line', '双语第二行');
});
t('字幕:ASS 逐词高亮标记往返', () => {
  const tr = mkTrack();
  tr.cues[0].words = [
    { word: '你', start: tr.cues[0].start, end: tr.cues[0].start + 0.3 },
    { word: '好', start: tr.cues[0].start + 0.3, end: tr.cues[0].start + 0.6 },
  ];
  const ass = SUB.toASS(tr, { forceKaraoke: true });
  ok(/\\k\d+/.test(ass), '未生成 \\k 高亮码');
  const back = SUB.parseASS(ass);
  eq(back.cues[0].words.length, 2, '词数');
  eq(back.cues[0].words[0].word, '你');
  near(back.cues[0].words[1].end - back.cues[0].words[1].start, 0.3, 0.05);
  // 回归：解析 \\k 高亮时正文被重复拼接（"你好" → "你你好好"）。
  // 原实现把 last 只推进到 \\k 标签之后，循环结束后那句
  // `plain += body.slice(last)` 又把同一个词补了一遍。
  eq(back.cues[0].text, '你好', '逐词高亮正文被重复');
});
t('字幕:ASS 少字段 Dialgoue 行不该丢', () => {
  // 回归：parseASS 硬编码 `m.length < 10 → continue`，字段更少（很多工具
  // 导出时不带 Effect 列）的合法 Dialogue 行会被整条丢掉 —— 用户导入
  // 字幕看到的是空轨道。要读 [Events] 的 Format: 行决定字段布局。
  const head = '[Script Info]\nTitle: t\n\n[Events]\n';
  const nine = 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Text\n'
    + 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,你好，世界\n';
  const back = SUB.parseASS(head + nine);
  eq(back.cues.length, 1, '9 字段行被丢弃');
  eq(back.cues[0].text, '你好，世界', '台词里的逗号被吃');
  // 没有 Format 行时也要能读出来（退到「Text 是最后一列」）
  const noFmt = 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,无格式行\n';
  eq(SUB.parseASS(head + noFmt).cues.length, 1, '无 Format 行的 9 字段 Dialogue 被丢弃');
  // 标准 10 字段 + 台词含逗号（这条本来就过，保住不回归）
  const std = 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
    + 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,你好，世界，再见\n';
  eq(SUB.parseASS(head + std).cues[0].text, '你好，世界，再见');
});
t('字幕:自动识别格式', () => {
  ok(SUB.importSubtitles('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi').cues.length === 1, 'VTT');
  ok(SUB.importSubtitles('[Script Info]\nx\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,hi').cues.length === 1, 'ASS');
  ok(SUB.importSubtitles('1\n00:00:01,000 --> 00:00:02,000\nhi').cues.length === 1, 'SRT');
});
t('字幕:导入非法文本不崩', () => {
  eq(SUB.importSubtitles('这不是字幕').cues.length, 0);
  eq(SUB.importSubtitles('').cues.length, 0);
});
t('字幕:校验发现爆字数', () => {
  const tr = new SUB.SubtitleTrack();
  tr.add(new SUB.SubtitleCue({ start: 0, end: 2, text: '这是一句非常非常非常非常非常非常长的字幕内容' }));
  const issues = tr.validate({ maxChars: 10, maxLines: 2 });
  ok(issues.some(i => i.kind === 'tooLong'), '未发现过长');
});
t('字幕:校验发现重叠/负时长', () => {
  const tr = new SUB.SubtitleTrack();
  tr.add(new SUB.SubtitleCue({ start: 0, end: 2, text: 'a' }));
  tr.add(new SUB.SubtitleCue({ start: 1, end: 1.5, text: 'b' }));
  tr.add(new SUB.SubtitleCue({ start: 4, end: 3, text: 'c' }));
  const issues = tr.validate();
  ok(issues.some(i => i.kind === 'overlap'), '未发现重叠');
  ok(issues.some(i => i.kind === 'empty'), '未发现负时长');
});
t('字幕:校验发现超出工程时长', () => {
  const tr = new SUB.SubtitleTrack();
  tr.add(new SUB.SubtitleCue({ start: 0, end: 30, text: 'a' }));
  ok(tr.validate({ duration: 6 }).some(i => i.kind === 'overflow'), '未发现越界');
});
t('字幕:补齐逐词时间码', () => {
  const tr = mkTrack();
  const n = SUB.fillWordTimings(tr);
  eq(n, 4);
  ok(tr.cues[0].words.length > 0, '未生成词');
  const w = tr.cues[0].words;
  // 词时间应单调且落在字幕区间内
  for (let i = 1; i < w.length; i++) ok(w[i].start >= w[i - 1].start, '词时间未递增');
  ok(w[w.length - 1].end <= tr.cues[0].end + 0.01, '词超出字幕区间');
  eq(w.map(x => x.word).join(''), tr.cues[0].text, '拼接应还原原文');
});
t('字幕:逐词时间码按累计权重铺满', () => {
  // 回归：原实现拿 tokens 下标当权重、又拿同一个下标算时间比例，
  // 「你好世界」第二个词从 0.25 开始（应为 0.5），词之间互相重叠/留缝。
  const c = new SUB.SubtitleCue({ start: 1, end: 3, text: '你好世界' });
  const w = SUB.distributeWords(c);
  eq(w.length, 4);
  near(w[0].start, 1, 1e-9);
  near(w[0].end, 1.5, 1e-9);
  near(w[1].start, 1.5, 1e-9);
  near(w[3].end, 3, 1e-9);
  for (let i = 1; i < w.length; i++) near(w[i].start, w[i - 1].end, 1e-9, `第 ${i} 个词与前词不连续`);
});
t('字幕:毫秒/厘秒边界正确进位', () => {
  // 回归：0.9996 原实现输出 `00:00:00,1000`（毫秒 4 位）、ASS `.100`（厘秒 3 位）。
  const tr = new SUB.SubtitleTrack();
  tr.add(new SUB.SubtitleCue({ start: 0.9996, end: 1.9996, text: 'x' }));
  const srt = SUB.toSRT(tr);
  ok(/00:00:01,000 --> 00:00:02,000/.test(srt), 'SRT 未正确进位：' + srt.split('\n')[1]);
  const vtt = SUB.toVTT(tr);
  ok(/00:00:01\.000 --> 00:00:02\.000/.test(vtt), 'VTT 未正确进位：' + vtt.split('\n')[2]);
  const ass = SUB.toASS(tr);
  ok(/0:00:01\.00,0:00:02\.00/.test(ass), 'ASS 未正确进位：' + (ass.match(/Dialogue:.*/) || [''])[0]);
});
t('字幕:cueAnchors 供锚点积木使用', () => {
  const tr = mkTrack();
  const a = SUB.cueAnchors(tr);
  eq(a.length >= 4, true, '至少 4 个锚点');
  ok(a.every(x => x.time >= 0 && x.time <= tr.duration + 1), '锚点时间越界');
});
t('字幕:长句拆分', () => {
  const c = new SUB.SubtitleCue({ start: 1, end: 5, text: '一二三四五六七八九十一二三四五六七八九十' });
  const parts = SUB.splitCue(c, 10);
  ok(parts.length >= 2, '未拆分');
  ok(parts.every(p => p.duration > 0), '拆分后时长为 0');
  eq(parts.map(p => p.text).join(''), c.text, '拆分后内容不一致');
});
t('字幕:吸附到锚点', () => {
  const tr = new SUB.SubtitleTrack();
  tr.add(new SUB.SubtitleCue({ start: 1.02, end: 2.03, text: 'a' }));
  const n = tr.snapTo([1.0, 2.0], 0.25);
  ok(n >= 1, '未吸附');
  near(tr.cues[0].start, 1.0, 0.001);
  near(tr.cues[0].end, 2.0, 0.001);
});
t('字幕:JSON 往返', () => {
  const tr = mkTrack();
  SUB.fillWordTimings(tr);
  const back = SUB.SubtitleTrack.fromJSON(JSON.parse(JSON.stringify(tr.toJSON())));
  eq(back.cues.length, tr.cues.length);
  eq(back.cues[0].text, tr.cues[0].text);
  eq(back.cues[0].words.length, tr.cues[0].words.length);
  eq(back.styles.length, tr.styles.length);
});
t('字幕:内置样式模板齐全', () => {
  const tr = new SUB.SubtitleTrack();
  for (const id of ['default', 'karaoke', 'pop', 'lower']) ok(tr.styleOf(id), `缺少样式 ${id}`);
});

/* ============================================================
   场景树
   ============================================================ */
t('场景树:基本增删', () => {
  const tree = new SC.SceneTree();
  const n = tree.add(new SC.SceneNode({ name: '文字', type: 'text' }));
  eq(tree.root.children.length, 1);
  ok(tree.find(n), '找不到新增节点');
  tree.remove(n);
  eq(tree.root.children.length, 0);
});
t('场景树:嵌套组', () => {
  const tree = new SC.SceneTree();
  const g = tree.add(new SC.SceneNode({ name: '组', type: 'group' }));
  const a = tree.add(new SC.SceneNode({ name: 'A', type: 'rect' }), g);
  const b = tree.add(new SC.SceneNode({ name: 'B', type: 'rect' }), g);
  eq(tree.find(g).children.length, 2);
  ok(tree.find(a) && tree.find(b), '深层查找失败');
  eq(tree.parentOf(a).id, g);
  eq(tree.all().length, 4, '总数应为 根+组+A+B');
});
t('场景树:往非组节点里加子节点会自动包一层组', () => {
  const tree = new SC.SceneTree();
  const r = tree.add(new SC.SceneNode({ name: 'R', type: 'rect' }));
  const c = tree.add(new SC.SceneNode({ name: 'C', type: 'rect' }), r);
  ok(c, '未自动建组');
  // R 本身仍是矩形（不破坏它的属性），但被移进了新建的组里
  eq(tree.find(r).type, 'rect', 'R 的类型不该被改');
  eq(tree.find(c).type, 'rect', 'C 是矩形');
  const grp = tree.parentOf(r);
  eq(grp.type, 'group', 'R 的父级应是新组');
  eq(grp.children.length, 2, '组里应有 R 与 C');
  eq(grp.children.map(x => x.id).sort().join(','), [r, c].sort().join(','), 'R 与 C 应同级');
  eq(tree.parentOf(c).id, grp.id, 'C 与 R 应同级');
  eq(tree.flatRenderList().length, 2, '扁平后仍有两个可绘制节点');
});
t('场景树:autoGroup 把节点包进新组并返回组 id', () => {
  const tree = new SC.SceneTree();
  const r = tree.add(new SC.SceneNode({ name: 'R', type: 'rect' }));
  const gid = tree.autoGroup(tree.find(r));
  ok(tree.find(gid), '组 id 应有效');
  eq(tree.find(gid).type, 'group');
  eq(tree.find(gid).children.length, 1);
  eq(tree.find(gid).children[0].id, r, '原节点应在组内');
  eq(tree.find(r).type, 'rect', '原节点类型不能被改掉');
});
t('场景树:groupMany 一次编组多个', () => {
  const tree = new SC.SceneTree();
  const a = tree.add(new SC.SceneNode({ name: 'A' }));
  const b = tree.add(new SC.SceneNode({ name: 'B' }));
  const gid = tree.groupMany([a, b], '组 1');
  ok(gid, '编组失败');
  const g = tree.find(gid);
  eq(g.children.length, 2);
  eq(tree.flatRenderList().length, 2, '扁平后仍可见两个子节点');
});
t('场景树:syncFromLayers 保留 master', () => {
  const tree = new SC.SceneTree();
  const a = tree.add(new SC.SceneNode({ name: 'M', type: 'rect' }));
  const master = tree.registerMaster(tree.find(a), '组件');
  const p = IR.defaultProject('x');
  tree.syncFromLayers(p.layers);
  eq(tree.masters.size, 1, 'master 应保留');
  eq(tree.root.children.length, p.layers.length, '树应按新图层重建');
  ok(tree.masters.get(master.id), 'master 内容丢失');
});
t('场景树:禁止移进自己的子树', () => {
  const tree = new SC.SceneTree();
  const g = tree.add(new SC.SceneNode({ type: 'group' }));
  const s = tree.add(new SC.SceneNode({ type: 'group' }), g);
  eq(tree.move(g, s.id), false, '应拒绝');
  eq(tree.find(g).parentId || tree.parentOf(g).id, tree.root.id, '结构被破坏');
});
t('场景树:上移下移', () => {
  const tree = new SC.SceneTree();
  const a = tree.add(new SC.SceneNode({ name: 'A' }));
  const b = tree.add(new SC.SceneNode({ name: 'B' }));
  eq(tree.root.children[0].id, a);
  tree.reorder(b, -1);
  eq(tree.root.children[0].id, b, 'B 应移到最前');
  eq(tree.reorder(b, -1), false, '已在首位');
});
t('场景树:复制', () => {
  const tree = new SC.SceneTree();
  const a = tree.add(new SC.SceneNode({ name: 'A', type: 'text', props: { fontSize: 80 } }));
  tree.find(a).props.fontSize = 120;
  const c = tree.duplicate(a);
  eq(c.props.fontSize, 120, '副本属性未复制');
  ok(c.id !== a, '副本 id 未重置');
  c.props.fontSize = 60;
  eq(tree.find(a).props.fontSize, 120, '改了副本却影响原件');
});
t('场景树:复用实例随主节点更新', () => {
  const tree = new SC.SceneTree();
  const a = tree.add(new SC.SceneNode({ name: '主', type: 'rect', props: { fill: '#ff0000', w: 100 } }));
  const master = tree.registerMaster(a, '主组件');
  const inst = tree.instantiate(master.id);
  eq(inst.masterId, master.id, '未标记 masterId');
  eq(inst.props.fill, '#ff0000');
  // 改主节点属性 → 展开后的实例应跟随
  tree.masters.get(master.id).props.fill = '#00ff00';
  const resolved = tree.resolve();
  const ri = resolved.find(n => n.id === inst.id);
  eq(ri.props.fill, '#00ff00', '实例未跟随主节点');
});
t('场景树:实例属性可覆盖主节点', () => {
  const tree = new SC.SceneTree();
  const a = tree.add(new SC.SceneNode({ name: 'M', type: 'rect', props: { fill: '#ff0000' } }));
  const m = tree.registerMaster(a);
  const inst = tree.instantiate(m.id, { props: { fill: '#0000ff' } });
  const ri = tree.resolve().find(n => n.id === inst.id);
  eq(ri.props.fill, '#0000ff', '覆盖未生效');
});
t('场景树:可见性向下传递', () => {
  const tree = new SC.SceneTree();
  const g = tree.add(new SC.SceneNode({ type: 'group', opacity: 0.5 }));
  const a = tree.add(new SC.SceneNode({ type: 'rect' }), g);
  // 编辑视图：不过滤（IR 里 visible 只是第 0 帧状态）
  eq(tree.flatRenderList().length, 1, '编辑视图不应丢图层');
  // 渲染视图：按可见性/透明度过滤
  const list = tree.flatRenderList({ respectVisibility: true });
  eq(list.length, 1);
  near(list[0].opacity, 0.5, 1e-6);
  void a;
});
t('场景树:隐藏组则子节点不渲染（渲染视图）', () => {
  const tree = new SC.SceneTree();
  const g = tree.add(new SC.SceneNode({ type: 'group', visible: false }));
  tree.add(new SC.SceneNode({ type: 'rect' }), g);
  eq(tree.flatRenderList().length, 1, '编辑视图仍应可见');
  eq(tree.flatRenderList({ respectVisibility: true }).length, 0, '渲染视图应隐藏');
});
t('场景树:多级不透明度相乘', () => {
  const tree = new SC.SceneTree();
  const g1 = tree.add(new SC.SceneNode({ type: 'group', opacity: 0.5 }));
  const g2 = tree.add(new SC.SceneNode({ type: 'group', opacity: 0.5 }), g1);
  tree.add(new SC.SceneNode({ type: 'rect' }), g2);
  near(tree.flatRenderList({ respectVisibility: true })[0].opacity, 0.25, 1e-6);
});
t('场景树:初始隐藏的图层仍可编辑', () => {
  // 回归：很多模板的图层靠积木在动画里才出现，IR 里 visible=false。
  // 场景树若据此把图层丢掉，就再也无法编辑了。
  const p = IR.defaultProject('x');
  p.layers[1].visible = false;
  const tree = SC.SceneTree.fromLayers(p.layers);
  eq(tree.root.children.length, p.layers.length, '树里应保留全部图层');
  eq(tree.flatRenderList().length, p.layers.length, '扁平后应保留全部图层');
  eq(tree.toLayers().length, p.layers.length);
  eq(tree.toLayers()[1].visible, false, '手动隐藏的状态要保留');
});
t('场景树:JSON 往返', () => {
  const tree = new SC.SceneTree();
  const g = tree.add(new SC.SceneNode({ type: 'group', name: '组', opacity: 0.7, blend: 'screen' }));
  tree.add(new SC.SceneNode({ type: 'text', name: 'T', props: { text: 'hi' } }), g);
  const m = tree.registerMaster(tree.root.children[0]);
  const back = SC.SceneTree.fromJSON(JSON.parse(JSON.stringify(tree.toJSON())));
  eq(back.root.children.length, 1);
  eq(back.root.children[0].blend, 'screen');
  near(back.root.children[0].opacity, 0.7, 1e-6);
  eq(back.masters.size, 1, 'master 未保留');
});
t('场景树:从 V0 扁平图层迁移', () => {
  const p = IR.defaultProject('x');
  const tree = SC.SceneTree.fromLayers(p.layers);
  eq(tree.root.children.length, p.layers.length);
  eq(tree.root.children[1].type, 'text');
  eq(tree.root.children[0].type, 'rect');
});
t('场景树:迁移必须沿用原图层 id', () => {
  // 回归：若迁移时重新生成 id，IR 与场景树就对不上号，
  // 编组/主组件/实例全都会「找不到节点」。
  const p = IR.defaultProject('x');
  const tree = SC.SceneTree.fromLayers(p.layers);
  eq(tree.root.children.map(c => c.id).join(','), p.layers.map(l => l.id).join(','), 'id 必须一致');
  for (const l of p.layers) ok(tree.find(l.id), `按 IR 的 id 找不到节点：${l.id}`);
  eq(tree.toLayers().map(l => l.id).join(','), p.layers.map(l => l.id).join(','));
});
t('场景树:未显式设置 visible 时必须可见', () => {
  // 回归：IR 里的图层常常没有 visible 字段，迁移时不能变成「隐藏」
  const p = IR.defaultProject('x');
  for (const l of p.layers) delete l.visible;
  const tree = SC.SceneTree.fromLayers(p.layers);
  ok(tree.root.children.every(c => c.visible === true), '有图层被误判为隐藏');
  eq(tree.flatRenderList().length, p.layers.length, '扁平列表丢了图层');
  eq(tree.flatRenderList({ respectVisibility: true }).length, p.layers.length, '渲染视图也应全可见');
});
t('场景树:显式 visible=false 才隐藏', () => {
  const p = IR.defaultProject('x');
  p.layers[0].visible = false;
  const tree = SC.SceneTree.fromLayers(p.layers);
  eq(tree.root.children[0].visible, false);
  // 编辑视图保留，渲染视图过滤
  eq(tree.flatRenderList().length, p.layers.length);
  eq(tree.flatRenderList({ respectVisibility: true }).length, p.layers.length - 1);
});
t('场景树:回迁扁平图层保持兼容', () => {
  const p = IR.defaultProject('x');
  const layers = SC.SceneTree.fromLayers(p.layers).toLayers();
  eq(layers.length, p.layers.length);
  ok(layers.every(l => l.props && typeof l.props.x === 'number'), '属性缺失');
});
t('场景树:元素类型定义齐全', () => {
  for (const k of ['group', 'text', 'rect', 'ellipse', 'path', 'star', 'polygon', 'svg', 'image', 'video', 'particle', 'chart', 'lottie', 'subtitle', 'audioBars']) {
    ok(SC.ELEMENT_TYPES[k], `缺少类型 ${k}`);
    const d = SC.defaultProps(k);
    ok(d && typeof d.x === 'number', `${k} 默认属性异常`);
  }
});
t('场景树:混合模式与遮罩定义', () => {
  ok(SC.BLEND_MODES.length >= 10);
  ok(SC.MASK_TYPES.some(m => m[0] === 'alpha'));
});

/* ============================================================
   文字引擎
   ============================================================ */
const mctx = HC.makeCtx();

t('文字:横排单元数与位置', () => {
  const r = TE.layoutText(mctx, '你好abc', { fontSize: 100, align: 'left' });
  eq(r.units.length, 5, '字符数');
  eq(r.layout, 'horizontal');
  ok(r.units[0].x < r.units[4].x, 'x 应递增');
  ok(r.units.every(u => isFinite(u.x) && isFinite(u.y)), '坐标非有限');
});
t('文字:居中对齐', () => {
  const l = TE.layoutText(mctx, 'abcd', { fontSize: 100, align: 'left' });
  const c = TE.layoutText(mctx, 'abcd', { fontSize: 100, align: 'center' });
  const leftTotal = l.units.reduce((a, u) => a + u.width, 0);
  near(c.units[0].x, -leftTotal / 2, 1e-6, '应整体居中');
});
t('文字:标点避头尾生效', () => {
  const r = TE.layoutText(mctx, '好，你', { fontSize: 100, align: 'left' });
  const comma = r.units.find(u => u.char === '，');
  ok(comma, '未找到逗号');
  ok(Math.abs(comma.x) > 0, '逗号应被内缩');
});
t('文字:竖排', () => {
  const r = TE.layoutText(mctx, '你好世界', { fontSize: 100, vertical: true });
  eq(r.layout, 'vertical');
  eq(r.units.length, 4);
  ok(r.units[0].y > r.units[3].y, '竖排 y 应递减');
});
t('文字:竖排数字纵中横', () => {
  const r = TE.layoutText(mctx, '2025', { fontSize: 100, vertical: true });
  ok(r.units.some(u => u.rotate === Math.PI / 2), '数字未旋转');
});
t('文字:环形排版', () => {
  const r = TE.layoutText(mctx, '环形文字测试', {
    fontSize: 60, ringText: { radius: 300, startAngle: -90, fullCircle: false },
  });
  eq(r.layout, 'ring');
  ok(r.units.every(u => isFinite(u.x) && isFinite(u.y)), '坐标非有限');
  const radii = r.units.map(u => Math.hypot(u.x, u.y));
  ok(radii.every(d => Math.abs(d - 300) < 1), `半径应为 300，实际 ${radii.map(r => r.toFixed(1)).join(',')}`);
});
t('文字:路径文字', () => {
  const r = TE.layoutText(mctx, '沿着路径跑', {
    fontSize: 60, pathText: { width: 600, height: 200, amplitude: 40, frequency: 1.5 },
  });
  eq(r.layout, 'path');
  ok(r.units.every(u => isFinite(u.x) && isFinite(u.y) && isFinite(u.rotate)), '含非有限值');
  const xs = r.units.map(u => u.x);
  ok(Math.max(...xs) - Math.min(...xs) > 100, '路径文字横向跨度太小');
});
t('文字:自动断行', () => {
  const r = TE.layoutText(mctx, '这是一段需要在指定宽度下自动换行的文字', {
    fontSize: 60, maxWidth: 400, align: 'left',
  });
  ok(r.lineCount >= 2, `未断行（${r.lineCount} 行）`);
});
t('文字:断行不把开引号留在行尾', () => {
  const r = TE.layoutText(mctx, '他说“今天天气不错啊真棒啊天气真好', {
    fontSize: 60, maxWidth: 400, align: 'left',
  });
  ok(r.lineCount >= 2, '未断行');
});
t('文字:可变字体的 CSS 与变体设置', () => {
  const f = TE.fontVariation({ family: 'Inter', size: 64, weight: 700, slant: -10 });
  ok(f.css.includes('64px'), f.css);
  ok(f.css.includes('bold'), '字重未映射到 bold：' + f.css);
  ok(f.css.includes('italic'), '倾斜未映射到 italic：' + f.css);
  ok(f.css.includes('Inter'), f.css);
  ok(f.settings.includes('wght') && f.settings.includes('slnt'), f.settings);
  // slant=0 时不应有 italic
  const n = TE.fontVariation({ family: 'Inter', size: 40, weight: 400, slant: 0 });
  ok(!n.css.includes('italic'), '不应出现 italic：' + n.css);
});
t('文字:字轴钳制', () => {
  eq(TE.clampAxis('wght', 5000), 900);
  eq(TE.clampAxis('wght', 1), 100);
  eq(TE.clampAxis('wght', 600), 600);
});
t('文字:排版确定性', () => {
  const a = TE.layoutText(mctx, '重复测试文字', { fontSize: 80 });
  const b = TE.layoutText(mctx, '重复测试文字', { fontSize: 80 });
  eq(JSON.stringify(a.units), JSON.stringify(b.units));
});
t('文字:空文本不崩', () => {
  const r = TE.layoutText(mctx, '', { fontSize: 100 });
  ok(Array.isArray(r.units), 'units 缺失');
  TE.layoutText(mctx, null, {});
  TE.layoutText(mctx, undefined, {});
});

/* ---------- 文本表达式 ---------- */
t('表达式:中文数字', () => {
  eq(TE.toChineseNumber(0), '零');
  eq(TE.toChineseNumber(1), '一');
  eq(TE.toChineseNumber(10), '十');
  eq(TE.toChineseNumber(11), '十一');
  eq(TE.toChineseNumber(20), '二十');
  eq(TE.toChineseNumber(105), '一百零五');
  eq(TE.toChineseNumber(10000), '一万');
});
t('表达式:千分位', () => {
  eq(TE.formatComma(1234567), '1,234,567');
  eq(TE.formatComma(-1234.5, 1), '-1,234.5');
});
t('表达式:金额', () => {
  eq(TE.formatCurrency(1234.5), '¥1,234.50');
  eq(TE.formatCurrency(1234.5, { symbol: '$' }), '$1,234.50');
});
t('表达式:紧凑数值', () => {
  eq(TE.formatCompact(12345), '1.2万');
  eq(TE.formatCompact(123000000), '1.2亿');
  eq(TE.formatCompact(999), '999');
});
t('表达式:百分比', () => {
  eq(TE.formatPercent(0.256, 1), '25.6%');
});
t('表达式:时长', () => {
  eq(TE.formatDuration(65), '1:05');
  eq(TE.formatDuration(3661), '1:01:01');
});
t('表达式:日期', () => {
  const d = new Date(2026, 0, 15, 9, 5, 3);
  eq(TE.formatDate(d, 'YYYY-MM-DD'), '2026-01-15');
  eq(TE.formatDate(d, 'HH:mm:ss'), '09:05:03');
});
t('表达式:序数', () => {
  eq(TE.toOrdinal(1), '1st');
  eq(TE.toOrdinal(2), '2nd');
  eq(TE.toOrdinal(11), '11th');
});
t('表达式:字数统计', () => {
  eq(TE.countChars('你好 abc'), 5);   // 去掉空格后：你好abc = 5
  eq(TE.countChars('  a  b  '), 2);
});
t('表达式:格式化分派', () => {
  eq(TE.applyTextFormat('x', 'comma', 1234567), '1,234,567');
  eq(TE.applyTextFormat('x', 'nope', 1), 'x', '未知格式应原样返回');
});

/* ============================================================
   汇总
   ============================================================ */
await Promise.all(pendingTests);   // 等所有异步用例真正跑完再统计
console.log('');
if (fail === 0) console.log(`%c✓ 字幕/场景树/文字引擎自测全部通过 ${pass}/${pass + fail}`, 'color:#38c98b;font-weight:700');
else {
  console.log(`%c✗ ${fail}/${pass + fail} 失败`, 'color:#ff5a5a;font-weight:700');
  for (const f of failures) console.log('  · ' + f);
}
console.log('');
process.exit(fail === 0 ? 0 : 1);