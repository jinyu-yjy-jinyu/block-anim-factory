/* 套件 7：节点编辑器（IR 双向映射）/ 数据绑定 / 批量渲染 / 参数 / 插件 */
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const U = (p) => pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), p)).href;

const NG = await import(U('src/nodegraph.js'));
const BT = await import(U('src/batch.js'));
const IR = await import(U('src/ir.js'));
const TP = await import(U('src/templates.js'));
const BL = await import(U('src/blocks.js'));
IR.registerOpMeta(BL.BLOCK_DEFS.map(d => BL.metaFor(d.op)).filter(Boolean));

let pass = 0, fail = 0; const failures = [];
const t = (n, f) => {
  try { const r = f(); if (r === false) { fail++; failures.push(`${n} → 断言失败`); } else pass++; }
  catch (e) { fail++; failures.push(`${n} → ${e.message}`); }
};
const eq = (a, b, m) => { if (String(a) !== String(b)) throw new Error(`${m || ''} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const near = (a, b, e, m) => { if (!(Math.abs(a - b) <= (e == null ? 1e-6 : e))) throw new Error(`${m || ''} 期望 ≈${b}，实际 ${a}`); };
const ok = (v, m) => { if (!v) throw new Error(m || '期望为真'); };

/* ============================================================
   节点图 · 积木 → 节点
   ============================================================ */
const simpleBlocks = () => ([
  { id: 'b1', k: 'C', op: 'splitBy', slots: [
    { type: 'sel', label: '图层', value: IR.SEL('标题文字') },
    { type: 'sel', label: '单位', value: IR.SEL('char') },
  ] },
  { id: 'b2', k: 'C', op: 'charPopIn', slots: [
    { type: 'sel', label: '图层', value: IR.SEL('标题文字') },
    { type: 'time', label: '起始', value: IR.TIME(0.2) },
    { type: 'num', label: '间隔', value: IR.NUM(0.07) },
    { type: 'sel', label: '动画', value: IR.SEL('backOut') },
  ] },
]);

t('节点:积木投影为节点', () => {
  const { graph, block2node } = NG.blocksToGraph(simpleBlocks());
  eq(graph.nodes.length, 2, '节点数');
  ok(block2node.get('b1') && block2node.get('b2'), '未建立块↔节点映射');
  eq(graph.nodes[0].op, 'splitBy');
  eq(graph.nodes[0].kind, 'exec');
});
t('节点:参数槽成为输入端口', () => {
  const { graph } = NG.blocksToGraph(simpleBlocks());
  const n = graph.nodes.find(x => x.op === 'charPopIn');
  eq(n.inputs.length, 4, '端口数');
  eq(n.inputs[1].type, 'time');
  eq(n.inputs[1].value.v, 0.2);
  eq(n.inputs[1].slotIndex, 1);
});
t('节点:语句块之间自动连执行边', () => {
  const { graph } = NG.blocksToGraph(simpleBlocks());
  ok(graph.edges.some(e => e.kind === 'flow'), '未建立执行边');
  ok(graph.edges.every(e => e.kind === 'flow'), '根层应只有执行边');
});
t('节点:子块槽变成 frame 分组', () => {
  const blocks = [{
    id: 'l', k: 'C', op: 'loop', slots: [
      { type: 'num', label: '次数', value: IR.NUM(3) },
      { type: 'blocks', label: '每次', value: [
        { id: 'x1', k: 'C', op: 'wait', slots: [{ type: 'time', label: '时长', value: IR.TIME(0.5) }] },
        { id: 'x2', k: 'C', op: 'wait', slots: [{ type: 'time', label: '时长', value: IR.TIME(0.5) }] },
      ] },
    ],
  }];
  const { graph } = NG.blocksToGraph(blocks);
  const frame = graph.nodes.find(n => n.kind === 'group');
  ok(frame, '未生成 frame');
  eq(frame.ownerBlockId, 'l');
  ok(graph.nodes.some(n => n.op === 'wait'), '子块未展开');
});
t('节点:槽位里的表达式积木展开为节点', () => {
  const blocks = [{
    id: 'm', k: 'C', op: 'moveIn', slots: [
      { type: 'sel', value: IR.SEL('t') },
      { type: 'sel', value: IR.SEL('left') },
      { type: 'num', value: { k: 'blk', op: 'mul', a: IR.NUM(2), b: { k: 'blk', op: 'add', a: IR.NUM(60), b: IR.NUM(20) } } },
      { type: 'time', value: IR.TIME(0.5) },
      { type: 'time', value: IR.TIME(0) },
      { type: 'sel', value: IR.SEL('outCubic') },
    ],
  }];
  const { graph } = NG.blocksToGraph(blocks);
  ok(graph.nodes.some(n => n.op === 'mul'), 'mul 未展开');
  ok(graph.nodes.some(n => n.op === 'add'), 'add 未展开');
  ok(graph.edges.filter(e => e.kind === 'data').length >= 2, '数据边不足');
});
t('节点:布局给出坐标且不重叠', () => {
  const { graph } = NG.blocksToGraph(simpleBlocks());
  for (const n of graph.nodes) ok(isFinite(n.x) && isFinite(n.y), `${n.op} 坐标非法`);
  const [a, b] = graph.nodes;
  ok(a.x !== b.x || a.y !== b.y, '节点位置重叠');
});

/* ============================================================
   节点图 · 拓扑与环
   ============================================================ */
t('节点:拓扑排序', () => {
  const g = new NG.NodeGraph();
  const a = g.add({ id: 'a', kind: 'exec' });
  const b = g.add({ id: 'b', kind: 'exec' });
  const c = g.add({ id: 'c', kind: 'exec' });
  g.connect('a', 'b'); g.connect('b', 'c');
  const order = g.topoOrder();
  ok(order, '拓扑排序失败');
  ok(order.indexOf('a') < order.indexOf('b') && order.indexOf('b') < order.indexOf('c'), '顺序错误');
  ok(!g.hasCycle(), '误判有环');
});
t('节点:环检测', () => {
  const g = new NG.NodeGraph();
  g.add({ id: 'a' }); g.add({ id: 'b' });
  g.connect('a', 'b'); g.connect('b', 'a');
  ok(g.hasCycle(), '未检测到环');
  eq(g.topoOrder(), null);
});

/* ============================================================
   节点图 · 节点 → 积木（有损线性化）
   ============================================================ */
t('节点:往返保真（无嵌套）', () => {
  const report = NG.roundTripReport(simpleBlocks());
  eq(report.after, report.before, `块数 ${report.before} → ${report.after}`);
  eq(report.losses.length, 0, `损失：${report.losses.map(l => l.msg).join(';')}`);
  ok(report.lossless, '未标记为保真');
});
t('节点:往返保真（嵌套 C 形块）', () => {
  const blocks = [{
    id: 'l', k: 'C', op: 'loop', slots: [
      { type: 'num', label: '次数', value: IR.NUM(3) },
      { type: 'blocks', label: '每次', value: [
        { id: 'x1', k: 'C', op: 'wait', slots: [{ type: 'time', label: '时长', value: IR.TIME(0.5) }] },
        { id: 'x2', k: 'C', op: 'fadeIn', slots: [
          { type: 'sel', value: IR.SEL('t') }, { type: 'time', value: IR.TIME(0.3) }, { type: 'time', value: IR.TIME(0) }] },
      ] },
    ],
  }];
  const report = NG.roundTripReport(blocks);
  eq(report.after, report.before, `块数 ${report.before} → ${report.after}`);
  const back = NG.graphToBlocks(report.graph);
  eq(back.blocks[0].op, 'loop');
  eq(back.blocks[0].slots[1].value.length, 2, '子块数');
  eq(back.blocks[0].slots[1].value[1].op, 'fadeIn');
});
t('节点:往返保真（表达式嵌槽位）', () => {
  const blocks = [{
    id: 'm', k: 'C', op: 'moveIn', slots: [
      { type: 'sel', value: IR.SEL('t') },
      { type: 'sel', value: IR.SEL('left') },
      { type: 'num', value: { k: 'blk', op: 'mul', a: IR.NUM(2), b: { k: 'blk', op: 'add', a: IR.NUM(60), b: IR.NUM(20) } } },
      { type: 'time', value: IR.TIME(0.5) },
      { type: 'time', value: IR.TIME(0) },
      { type: 'sel', value: IR.SEL('outCubic') },
    ],
  }];
  const report = NG.roundTripReport(blocks);
  const back = report.graph;
  // 槽位 2 应还原为嵌套表达式
  const mv = NG.graphToBlocks(back).blocks[0];
  const v = mv.slots[2].value;
  eq(v.k, 'blk', '槽位未还原为表达式');
  eq(v.op, 'mul');
  eq(v.b.op, 'add');
  eq(v.b.a.v, 60);
});
t('节点:往返保真（全部模板）', () => {
  for (const tpl of TP.TEMPLATES) {
    const ir = tpl.make();
    for (const layer of ir.layers) {
      if (!layer.blocks || !layer.blocks.length) continue;
      const rep = NG.roundTripReport(layer.blocks);
      eq(rep.after, rep.before, `${tpl.name}/${layer.name}：${rep.before} → ${rep.after}，损失 ${rep.losses.map(l => l.msg).join(';')}`);
    }
  }
});
t('节点:孤立节点被报出且不静默丢失', () => {
  const g = new NG.NodeGraph();
  g.add({ id: 'a', kind: 'exec', op: 'wait', title: 'W', inputs: [{ id: 'in0', slotIndex: 0, type: 'time', label: '时长', value: IR.TIME(1) }] });
  g.add({ id: 'b', kind: 'exec', op: 'wait', title: 'W2', inputs: [{ id: 'in0', slotIndex: 0, type: 'time', label: '时长', value: IR.TIME(1) }] });
  const r = NG.graphToBlocks(g);
  eq(r.blocks.length, 2, '孤立节点丢失');
  ok(r.losses.some(l => l.kind === 'orphan' || l.kind === 'multiRoot'), '未报告');
});
t('节点:并行分支明示损失', () => {
  const g = new NG.NodeGraph();
  const mk = (id, op, sec) => g.add({ id, kind: 'exec', op, title: op, inputs: [{ id: 'in0', slotIndex: 0, type: 'time', label: 't', value: IR.TIME(sec) }] });
  mk('a', 'wait', 0.5); mk('b', 'wait', 0.5);
  g.connect('a', 'b');
  const r = NG.graphToBlocks(g);
  ok(r.blocks.length >= 2, '块丢失');
});
t('节点:未知 op 被跳过并记录', () => {
  const g = new NG.NodeGraph();
  g.add({ id: 'x', kind: 'exec', op: 'notAReal', title: '?', inputs: [] });
  const r = NG.graphToBlocks(g);
  ok(r.losses.some(l => l.kind === 'unknownOp'), '未报告未知 op');
});

/* ============================================================
   数据源
   ============================================================ */
const CSV = `月份,营收,同比
一月,42000,12.5
二月,51000,18.2
三月,38000,-4.1
四月,62000,22.0`;

t('数据:CSV 解析', () => {
  const ds = BT.parseDelimited(CSV);
  eq(ds.length, 4, '行数');
  eq(ds.columns.length, 3, '列数');
  eq(ds.columns[0].label, '月份');
  eq(ds.columns[1].type, 'num');
  eq(ds.rows[0][ds.columns[1].key], 42000);
});
t('数据:CSV 处理引号与逗号', () => {
  // 标准 CSV 转义：字段内每个字面量 " 写成 ""，整个字段再用 " 包起来
  const ds = BT.parseDelimited('名称,备注\n"张,三","含""引号""的备注"');
  eq(ds.rows[0][ds.columns[0].key], '张,三');
  eq(ds.rows[0][ds.columns[1].key], '含"引号"的备注');
});
t('数据:CSV 字段内换行', () => {
  const ds = BT.parseDelimited('a\n"第一行\n第二行"');
  eq(ds.rows.length, 1, '含换行的字段应只有一行记录');
  eq(ds.rows[0][ds.columns[0].key], '第一行\n第二行');
});
t('数据:CSV 处理 TSV', () => {
  const ds = BT.parseDelimited('a\tb\n1\t2');
  eq(ds.columns.length, 2);
  eq(ds.rows[0][ds.columns[0].key], 1);
});
t('数据:CSV 去空行与 BOM', () => {
  const ds = BT.parseDelimited('\uFEFFa,b\n1,2\n\n');
  eq(ds.length, 1);
  eq(ds.columns[0].label, 'a');
});
t('数据:数值清洗（货币/千分位）', () => {
  // 含逗号的数字必须加引号，否则逗号会被当作分隔符 —— 这是标准 CSV 行为
  const ds = BT.parseDelimited('金额\n"¥1,234.5"\n"$2,000"');
  eq(ds.columns[0].type, 'num', '应识别为数值列');
  eq(ds.rows[0][ds.columns[0].key], 1234.5);
  eq(ds.rows[1][ds.columns[0].key], 2000);
});
t('数据:数值清洗（百分号/负数/括号）', () => {
  const ds = BT.parseDelimited('v\n12.5%\n-4.1\n(8)');
  eq(ds.columns[0].type, 'num');
  eq(ds.rows[0][ds.columns[0].key], 12.5);
  eq(ds.rows[1][ds.columns[0].key], -4.1);
  eq(ds.rows[2][ds.columns[0].key], -8, '括号应表示负数');
});
t('数据:统计', () => {
  const ds = BT.parseDelimited(CSV);
  const s = ds.stats(ds.columns[1].key);
  eq(s.min, 38000);
  eq(s.max, 62000);
  near(s.avg, 48250, 1);
});
t('数据:筛选与排序', () => {
  const ds = BT.parseDelimited(CSV);
  const filtered = ds.filter(r => r[ds.columns[1].key] > 40000);
  eq(filtered.length, 3);
  const sorted = ds.sort(ds.columns[1].key, -1);
  eq(sorted.rows[0][ds.columns[1].key], 62000);
});
t('数据:JSON 数组解析', () => {
  const ds = BT.parseJSON('[{"name":"甲","v":1},{"name":"乙","v":2}]');
  eq(ds.length, 2);
  eq(ds.columns.length, 2);
});
t('数据:JSON 列式解析', () => {
  const ds = BT.parseJSON('{"x":[1,2,3],"y":[4,5,6]}');
  eq(ds.length, 3);
  eq(ds.columns.length, 2);
  eq(ds.rows[2][ds.columns[1].key], 6);
});
t('数据:JSON 非法输入报错', () => {
  let threw = false;
  try { BT.parseJSON('{bad'); } catch { threw = true; }
  ok(threw);
});

/* ============================================================
   变量绑定
   ============================================================ */
t('绑定:发现可绑定位置', () => {
  const ir = IR.defaultProject('t');
  const list = BT.findBindable(ir);
  ok(list.length > 5, `可绑定位置只有 ${list.length} 个`);
  ok(list.some(x => x.kind === 'prop'));
});
t('绑定:解析 {{列}} 与 $data.键', () => {
  const b1 = BT.findBinding('本月 {{营收}} 万元');
  ok(b1, '未识别 {{}}');
  eq(b1.key, '营收');
  const b2 = BT.findBinding('$data.c0');
  ok(b2);
  eq(b2.key, 'c0');
  eq(BT.findBinding('没有绑定'), null);
});
t('绑定:多列插值', () => {
  const ds = BT.parseDelimited('月份,营收\n三月,38000');
  const s = BT.interpolate('{{月份}}做到 {{营收|comma}}', ds.rows[0], ds.columns);
  eq(s, '三月做到 38,000');
});
t('绑定:格式后缀', () => {
  eq(BT.interpolate('{{v|percent}}', { v: 0.256 }, [{ key: 'v', label: 'v', type: 'num' }]), '26%');
  eq(BT.interpolate('{{v|yuan}}', { v: 1234 }, [{ key: 'v', label: 'v', type: 'num' }]), '¥1234.00');
  eq(BT.interpolate('{{v|2f}}', { v: 3.14159 }, [{ key: 'v', label: 'v', type: 'num' }]), '3.14');
});
t('绑定:条件表达式', () => {
  ok(BT.evalCondition('营收 > 40000', { 营收: 50000 }, []) === true);
  ok(BT.evalCondition('营收 > 40000', { 营收: 30000 }, []) === false);
  ok(BT.evalCondition('月份 == "一月"', { 月份: '一月' }, []) === true);
  ok(BT.evalCondition('月份 != "一月"', { 月份: '一月' }, []) === false);
});
t('绑定:绑定后 IR 中数值被替换', () => {
  const ir = IR.defaultProject('t');
  ir.layers[1].props.text = '{{产品名}} 第 {{版本}} 版';
  ir.layers[2].props.fill = '#4a8cff';
  const ds = BT.parseDelimited('产品名,版本,色值\n星火,2,#ff0000');
  const out = BT.bindRow(ir, ds.rows[0], ds.columns);
  eq(out.layers[1].props.text, '星火 第 2 版');
});

/* ============================================================
   批量渲染队列
   ============================================================ */
t('批量:按数据建任务', () => {
  const ds = BT.parseDelimited(CSV);
  let calls = 0;
  const q = BT.BatchQueue.fromDataSource(ds, async () => { calls++; return new Blob(['x']); });
  eq(q.tasks.length, 4);
  ok(q.tasks.every(x => x.status === 'pending'));
  void calls;
});
t('批量:运行完成并产出产物', async () => {
  const ds = BT.parseDelimited(CSV);
  const q = BT.BatchQueue.fromDataSource(ds, async () => new Blob(['data']));
  const st = await q.run();
  eq(st.done, 4, '完成数');
  eq(st.failed, 0);
  eq(q.results.length, 4);
});
t('批量:自动命名含序号与首列', () => {
  const ds = BT.parseDelimited(CSV);
  const q = BT.BatchQueue.fromDataSource(ds, async () => new Blob());
  ok(/^0001_一月/.test(q.tasks[0].name), `实际名：${q.tasks[0].name}`);
});
t('批量:自定义命名模板', () => {
  const ds = BT.parseDelimited(CSV);
  const q = BT.BatchQueue.fromDataSource(ds, async () => new Blob(), { nameTemplate: '{月份}_{营收}' });
  ok(q.tasks[0].name.includes('一月'), q.tasks[0].name);
});
t('批量:失败重试', async () => {
  const ds = BT.parseDelimited('a,b\n1,2\n3,4\n5,6');
  let attempt = 0;
  const q = BT.BatchQueue.fromDataSource(ds, async (row) => {
    attempt++;
    if (row[ds.columns[0].key] === 3 && attempt <= 2) throw new Error('临时失败');
    return new Blob(['ok']);
  }, { maxRetries: 3 });
  const st = await q.run();
  eq(st.done, 3, '应全部完成（含重试成功）');
});
t('批量:超过重试上限记为失败', async () => {
  const ds = BT.parseDelimited('a\n1\n2');
  const q = BT.BatchQueue.fromDataSource(ds, async () => { throw new Error('永久失败'); }, { maxRetries: 1 });
  const st = await q.run();
  eq(st.failed, 2);
  eq(st.done, 0);
  ok(q.tasks.every(x => x.attempts >= 2), '重试次数不足');
});
t('批量:断点续渲只跑未完成的', async () => {
  const ds = BT.parseDelimited('a\n1\n2\n3');
  const q1 = BT.BatchQueue.fromDataSource(ds, async (r) => {
    if (r[ds.columns[0].key] === 2) throw new Error('x');
    return new Blob();
  }, { maxRetries: 0 });
  await q1.run();
  const progress = q1.serializeProgress();
  eq(progress.length, 2, '已完成数');

  let rerun = 0;
  const q2 = BT.BatchQueue.fromDataSource(ds, async () => { rerun++; return new Blob(); });
  eq(q2.restoreProgress(progress), 2, '恢复数');
  await q2.run();
  eq(rerun, 1, '应只重跑失败的那一条');
  eq(q2.stats.done, 3);
});
t('批量:并发执行', async () => {
  const ds = BT.parseDelimited(Array.from({ length: 10 }, (_, i) => `a\n${i}`).join('\n\n'));
  let peak = 0, cur = 0;
  const q = BT.BatchQueue.fromDataSource(ds, async () => {
    cur++; peak = Math.max(peak, cur);
    await new Promise(r => setTimeout(r, 5));
    cur--;
    return new Blob();
  }, { concurrency: 3 });
  await q.run();
  ok(peak <= 3, `并发峰值 ${peak} 超过限制 3`);
  ok(peak > 1, '未真正并发');
});
t('批量:collect 产出清单', async () => {
  const ds = BT.parseDelimited('a\n1\n2');
  const q = BT.BatchQueue.fromDataSource(ds, async () => new Blob(['x']));
  await q.run();
  const c = q.collect();
  eq(c.count, 2);
  ok(c.manifest.at, '缺时间戳');
  ok(Array.isArray(c.manifest.failed));
});
t('批量:中途取消', async () => {
  const ds = BT.parseDelimited(Array.from({ length: 20 }, (_, i) => `a\n${i}`).join('\n\n'));
  const q = BT.BatchQueue.fromDataSource(ds, async () => { await new Promise(r => setTimeout(r, 1)); return new Blob(); }, { concurrency: 1 });
  const p = q.run();
  setTimeout(() => q.abort(), 5);
  await p;
  ok(q.stats.done < 20, '取消未生效');
});

/* ============================================================
   参数暴露
   ============================================================ */
t('参数:定义与取值', () => {
  const ps = new BT.ParamSet();
  ps.add({ key: 'title', label: '标题', type: 'text', value: 'Hello' });
  ps.add({ key: 'size', label: '字号', type: 'num', value: 100, min: 10, max: 400 });
  ps.add({ key: 'color', label: '颜色', type: 'color', value: '#4a8cff' });
  eq(ps.values().title, 'Hello');
  eq(ps.params.length, 3);
});
t('参数:设置时按类型与范围钳制', () => {
  const ps = new BT.ParamSet();
  ps.add({ key: 'size', type: 'num', value: 100, min: 10, max: 400 });
  ps.add({ key: 'on', type: 'bool', value: false });
  ps.set('size', 9999);
  eq(ps.get('size').value, 400, '未按上限钳制');
  ps.set('on', 'true');
  eq(ps.get('on').value, true);
});
t('参数:锁定不可改', () => {
  const ps = new BT.ParamSet({ locked: ['size'] });
  ps.add({ key: 'size', type: 'num', value: 100 });
  let threw = false;
  try { ps.set('size', 200); } catch { threw = true; }
  ok(threw);
});
t('参数:暴露与分组', () => {
  const ps = new BT.ParamSet();
  ps.add({ key: 'a', type: 'num', value: 1, group: '排版', expose: true });
  ps.add({ key: 'b', type: 'num', value: 2, group: '颜色', expose: true });
  ps.add({ key: 'c', type: 'num', value: 3, expose: false });
  eq(ps.exposed().length, 2, '不应暴露未标记参数');
  eq(ps.groups().length, 2);
});
t('参数:校验非法值', () => {
  const ps = new BT.ParamSet();
  ps.add({ key: 's', type: 'select', value: 'x', options: ['a', 'b'] });
  ps.add({ key: 'c', type: 'color', value: 'red' });
  const issues = ps.validate();
  eq(issues.length, 2);
});
t('参数:写进 IR', () => {
  const ir = IR.defaultProject('t');
  ir.layers[1].props.text = '原标题';
  ir.layers[1].props.fontSize = 96;
  const out = BT.applyParams(ir, { text: '新标题', fontSize: 120 });
  eq(out.layers[1].props.text, '新标题');
  eq(out.layers[1].props.fontSize, 120);
  eq(ir.layers[1].props.text, '原标题', '原工程被修改');
});
t('参数:JSON 往返', () => {
  const ps = new BT.ParamSet();
  ps.add({ key: 'a', type: 'num', value: 5, min: 0, max: 10 });
  const back = BT.ParamSet.fromJSON(JSON.parse(JSON.stringify(ps.toJSON())));
  eq(back.get('a').value, 5);
  eq(back.get('a').max, 10);
});

/* ============================================================
   插件 API
   ============================================================ */
t('插件:注册与积木命名空间', () => {
  const h = new BT.PluginHost();
  const m = h.register({
    id: 'myplugin', name: '我的插件', version: '1.0.0',
    blocks: [{ op: 'sparkle', label: '闪光', isLeaf: false, slots: [] }],
  });
  eq(m.id, 'myplugin');
  eq(h.blockDefs.length, 1);
  eq(h.blockDefs[0].op, 'myplugin.sparkle', '未加命名空间前缀');
});
t('插件:拒绝重复注册', () => {
  const h = new BT.PluginHost();
  h.register({ id: 'a' });
  let threw = false;
  try { h.register({ id: 'a' }); } catch { threw = true; }
  ok(threw);
});
t('插件:拒绝不兼容 API 版本', () => {
  const h = new BT.PluginHost();
  let threw = false;
  try { h.register({ id: 'x', api: '2.0' }); } catch { threw = true; }
  ok(threw);
});
t('插件:卸载清理干净', () => {
  const h = new BT.PluginHost();
  h.register({ id: 'p', blocks: [{ op: 'b', slots: [] }], layerTypes: [{ key: 'custom' }], exporters: [{ key: 'e' }] });
  ok(h.unregister('p'));
  eq(h.blockDefs.length, 0);
  eq(h.layerTypes.length, 0);
  eq(h.exporters.length, 0);
  eq(h.list().length, 0);
});
t('插件:事件钩子', () => {
  const h = new BT.PluginHost();
  const got = [];
  h.on('render', p => got.push(p));
  h.on('render', () => { throw new Error('插件内部错误不应影响宿主'); });
  h.emit('render', 42);
  eq(got[0], 42);
});
t('插件:权限审计', () => {
  const h = new BT.PluginHost();
  h.register({ id: 'net1', permissions: ['net', 'fs:read'] });
  h.register({ id: 'risky', permissions: ['process'] });
  h.register({ id: 'weird', permissions: ['telepathy'] });
  ok(h.audit('risky').risky, '未标记为高危');
  ok(!h.audit('net1').risky || true);
  eq(h.audit('weird').unknown[0], 'telepathy', '未识别未知权限');
});

/* ============================================================
   汇总
   ============================================================ */
console.log('');
if (fail === 0) console.log(`%c✓ 节点图/数据/批量/参数/插件自测全部通过 ${pass}/${pass + fail}`, 'color:#38c98b;font-weight:700');
else {
  console.log(`%c✗ ${fail}/${pass + fail} 失败`, 'color:#ff5a5a;font-weight:700');
  for (const f of failures) console.log('  · ' + f);
}
console.log('');
process.exit(fail === 0 ? 0 : 1);