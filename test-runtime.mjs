/* ============================================================
   test-runtime.mjs · 运行时解释器
   ------------------------------------------------------------
   M1：固定步长、seek 重放、预览/导出同源、wait/after 顺序。
   后续里程碑继续在此文件追加事件、对象、关键帧等用例。
   ============================================================ */

import { createRuntime, evaluateFrame, resetEvaluationCache } from './src/runtime.js';
import { render } from './src/renderer.js';
import { ease as easeFn } from './src/evaluator.js';
import { createRecordingContext, digestCalls } from './scripts/golden.mjs';
import { loadTemplate } from './src/templates.js';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; failures.push(`${name} → ${e.message}`); console.log(`  ✗ ${name}\n     ${e.message}`); }
}
function ok(v, msg) { if (!v) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg || '不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
  }
}

/* ---------- IR 构造 ---------- */
const NUM = (v) => ({ k: 'lit', t: 'num', v });
const TIME = (v) => ({ k: 'lit', t: 'time', v });
const STR = (v) => ({ k: 'lit', t: 'str', v });
const SEL = (v) => ({ k: 'lit', t: 'sel', v });

const stmt = (op, slots = []) => ({ id: op + Math.random().toString(36).slice(2, 6), k: 'C', op, slots });
const wait = (d) => stmt('wait', [{ type: 'time', value: TIME(d) }]);
const waitS = (d) => wait(d);
const changeVar = (name, d) => stmt('changeVar', [
  { type: 'str', value: STR(name) },
  { type: 'num', value: NUM(d) },
]);
const setVar = (name, v) => stmt('setVar', [
  { type: 'str', value: STR(name) },
  { type: 'num', value: NUM(v) },
]);
const loopOf = (n, body) => stmt('loop', [
  { type: 'num', value: NUM(n) },
  { type: 'blocks', value: body },
]);
const forever = (body) => stmt('forever', [{ type: 'blocks', value: body }]);
const hat = (op, body, slots = []) => ({ id: op, k: 'H', op, slots: slots.concat([{ type: 'blocks', value: body }]) });
const after = (d, sub) => stmt('after', [{ type: 'time', value: TIME(d) }, { type: 'blocks', value: sub }]);
const fadeIn = () => stmt('fadeIn', [
  { type: 'sel', value: SEL('L1') },
  { type: 'time', value: TIME(0.5) },
  { type: 'time', value: TIME(0) },
]);
const fadeOut = () => stmt('fadeOut', [
  { type: 'sel', value: SEL('L1') },
  { type: 'time', value: TIME(0.4) },
  { type: 'time', value: TIME(0) },
]);

function mkIR(blocks, opts = {}) {
  return {
    version: '1.0',
    project: { name: 't', width: 320, height: 180, fps: 24, duration: opts.duration || 4 },
    markers: opts.markers || [],
    variables: opts.variables || [],
    layers: [{
      id: 'L1', name: 'L1', type: 'text', visible: true,
      props: { text: 'x', x: 160, y: 90 },
      blocks,
    }],
    customLibrary: null,
  };
}

function seqStates(ir, times, rev = 1) {
  return times.map(t => JSON.stringify(evaluateFrame(ir, t, null, { rev }).state.layers));
}
function freshStates(ir, times) {
  return times.map(t => {
    const rt = createRuntime(ir, null);
    rt.advanceTo(t);
    return JSON.stringify(rt.compose().layers);
  });
}

/* ---------- 用例 ---------- */
console.log('=== 运行时解释器 ===');

t('固定步长：t 取整到最近帧，state.t 与帧号一致', () => {
  const ir = mkIR([wait(10)]);
  const { ctx } = evaluateFrame(ir, 0.1, null, {});
  eq(ctx.frame, 2, '0.1s @24fps 应落在第 2 帧');
  eq(ctx.time, 2 / 24);
  eq(ctx.compose().t, 2 / 24);
});

t('顺序播放 = 每次新建运行时 seek（状态型脚本）', () => {
  const ir = mkIR([hat('whenStart', forever([changeVar('score', 1), waitS(0.1)]))], {
    variables: [{ id: 'V1', name: 'score', type: 'num', value: 0 }],
  });
  const times = [];
  for (let f = 0; f <= 24; f++) times.push(f / 24);
  const seq = seqStates(ir, times);
  resetEvaluationCache();
  const fresh = freshStates(ir, times);
  for (let i = 0; i < times.length; i++) {
    if (seq[i] !== fresh[i]) throw new Error(`第 ${i} 帧状态不一致`);
  }
  const score = JSON.parse(seq[24]).L1;
  ok(score, '第 24 帧缺少图层状态');
});

t('向后 seek 会 reset 重放，再前进结果不变', () => {
  const ir = mkIR([hat('whenStart', forever([changeVar('score', 1), waitS(0.1)]))], {
    variables: [{ id: 'V1', name: 'score', type: 'num', value: 0 }],
  });
  const direct = JSON.stringify(evaluateFrame(ir, 1, null, { rev: 2 }).state.layers);
  evaluateFrame(ir, 0.2, null, { rev: 2 });
  evaluateFrame(ir, 3, null, { rev: 2 });
  evaluateFrame(ir, 0.1, null, { rev: 2 });
  eq(JSON.stringify(evaluateFrame(ir, 1, null, { rev: 2 }).state.layers), direct, 'seek 后回放不一致');
});

t('rev 变化触发 reset，不复用旧状态', () => {
  const ir = mkIR([hat('whenStart', forever([changeVar('score', 1), waitS(0.1)]))], {
    variables: [{ id: 'V1', name: 'score', type: 'num', value: 0 }],
  });
  const a = evaluateFrame(ir, 2, null, { rev: 1 });
  const b = evaluateFrame(ir, 2, null, { rev: 2 });
  eq(JSON.stringify(a.state.layers), JSON.stringify(b.state.layers), 'rev 变更后同一时间应得到全新重放结果');
  eq(b.ctx.totalSteps, a.ctx.totalSteps, 'rev 变更后累计步数应重置');
});

const opacityOf = (ls) => (ls.p.opacity == null ? 1 : ls.p.opacity);

t('wait 真正阻塞：1s 前不登记动效，1s 后才开始', () => {
  const ir = mkIR([waitS(1), fadeIn()]);
  const at05 = evaluateFrame(ir, 0.5, null, { rev: 3 }).state.layers.L1;
  eq(opacityOf(at05), 1, 'wait 未结束时图层不应被改动');
  const at125 = evaluateFrame(ir, 1.25, null, { rev: 3 }).state.layers.L1;
  ok(opacityOf(at125) > 0.1 && opacityOf(at125) < 0.9, `1.25s 应在淡入中，实际 ${at125.p.opacity}`);
  const at16 = evaluateFrame(ir, 1.6, null, { rev: 3 }).state.layers.L1;
  eq(opacityOf(at16), 1, '淡入结束应完全不透明');
});

t('after 接在上一个动效结束之后', () => {
  const ir = mkIR([fadeOut(), after(0, [fadeIn()])]);
  const at02 = evaluateFrame(ir, 0.2, null, { rev: 4 }).state.layers.L1;
  ok(opacityOf(at02) < 0.8, `0.2s 应处于淡出中，实际 ${at02.p.opacity}`);
  const at05 = evaluateFrame(ir, 0.5, null, { rev: 4 }).state.layers.L1;
  ok(opacityOf(at05) > 0 && opacityOf(at05) < 0.35, `0.5s 应刚开始淡入，实际 ${at05.p.opacity}`);
  const at10 = evaluateFrame(ir, 1.0, null, { rev: 4 }).state.layers.L1;
  eq(opacityOf(at10), 1, '淡入结束应完全不透明');
});

t('forever 每帧让出一次，不会冻结界面', () => {
  const ir = mkIR([forever([changeVar('score', 1)])], {
    variables: [{ id: 'V1', name: 'score', type: 'num', value: 0 }],
  });
  const t0 = Date.now();
  const { ctx } = evaluateFrame(ir, 1, null, { rev: 5 });
  const ms = Date.now() - t0;
  ok(ms < 1000, `${ms}ms 过慢`);
  ok(!ctx.budgetExceeded, 'forever 每帧让出，不应触发步数预算');
  eq(ctx.getVar('score'), 25, '24fps 下 0~1s 应执行 25 次');
});

t('嵌套 loop 超预算被截断且不抛异常', () => {
  let blocks = [setVar('n', 1)];
  for (let i = 0; i < 4; i++) blocks = [loopOf(500, blocks)];
  const ir = mkIR(blocks);
  const t0 = Date.now();
  const { ctx } = evaluateFrame(ir, 0, null, { rev: 6, maxSteps: 500 });
  const ms = Date.now() - t0;
  ok(ctx.budgetExceeded, '预算未被触发');
  ok(ms < 1000, `${ms}ms 过慢`);
  ok(ctx.logs.some(l => l.level === 'warn'), '超预算应写入日志');
});

t('渲染指令：顺序播放与独立 seek 逐条一致', () => {
  const ir = loadTemplate('popTitle');
  const draw = (state, time) => {
    const { ctx, calls } = createRecordingContext();
    render(state, ctx, { time });
    return digestCalls(calls);
  };
  const fps = ir.project.fps;
  for (const f of [0, 7, 23, 48, 90]) {
    const time = f / fps;
    const a = draw(evaluateFrame(ir, time, null, { rev: 7 }).state, time);
    resetEvaluationCache();
    const rt = createRuntime(ir, null);
    rt.advanceTo(time);
    const b = draw(rt.compose(), time);
    if (a !== b) throw new Error(`第 ${f} 帧预览与独立导出指令不一致`);
  }
});

t('compose 输出运行时顺序与舞台信息', () => {
  const ir = mkIR([wait(10)]);
  const { state } = evaluateFrame(ir, 0, null, { rev: 8 });
  eq(state.order, ['L1']);
  ok(state.ir === ir, 'state.ir 应指向同一 IR');
  eq(state.stage.width, 320);
  eq(state.stage.height, 180);
  eq(state.stage.fps, 24);
  eq(state.stage.duration, 4);
});

t('未实现积木只记日志，不静默改透明度', () => {
  const ir = mkIR([stmt('__nope__')]);
  const { state, ctx } = evaluateFrame(ir, 0, null, { rev: 9 });
  ok(ctx.logs.some(l => l.msg.includes('__nope__')), '应记录未知积木');
  eq(opacityOf(state.layers.L1), 1, '未知积木不应改透明度');
});

/* ---------- M2：事件 / 控制 / 变量 / 列表 ---------- */
const lit = (t, v) => ({ type: t, value: { k: 'lit', t, v } });
const expr = (op, extra = {}) => ({ k: 'blk', op, ...extra });
const selSlot = (v) => lit('sel', v);
const strSlot = (v) => lit('str', v);
const numSlot = (v) => lit('num', v);
const blkSlot = (body) => ({ type: 'blocks', value: body });
const broadcast = (msg) => stmt('broadcast', [strSlot(msg)]);
const broadcastWait = (msg) => stmt('broadcastWait', [strSlot(msg)]);
const setExprVar = (name, value) => stmt('setVar', [strSlot(name), { type: 'num', value }]);

function mkIRLayers(layers, opts = {}) {
  return {
    version: '1.0',
    project: { name: 't', width: 320, height: 180, fps: 24, duration: opts.duration || 4 },
    markers: opts.markers || [],
    variables: opts.variables || [],
    layers: layers.map(l => ({
      id: l.id, name: l.id, type: l.type || 'text', visible: true,
      props: l.props || { text: 'x', x: 160, y: 90 },
      blocks: l.blocks || [],
    })),
    customLibrary: null,
  };
}

t('whenStart 在第 0 帧启动，whenAt 只触发一次', () => {
  const ir = mkIR([
    hat('whenStart', [setVar('started', 1)]),
    hat('whenAt', [changeVar('hits', 1)], [numSlot(0.5), selSlot('time')]),
  ], {
    variables: [{ id: 'V1', name: 'started', type: 'num', value: 0 }, { id: 'V2', name: 'hits', type: 'num', value: 0 }],
  });
  eq(evaluateFrame(ir, 0, null, { rev: 10 }).ctx.getVar('started'), 1);
  eq(evaluateFrame(ir, 0.25, null, { rev: 10 }).ctx.getVar('hits'), 0, '时刻未到不应触发');
  const at1 = evaluateFrame(ir, 1, null, { rev: 10 }).ctx;
  eq(at1.getVar('hits'), 1, 'whenAt 只应触发一次');
  eq(evaluateFrame(ir, 2, null, { rev: 10 }).ctx.getVar('hits'), 1);
});

t('broadcast 下一帧派发；broadcastWait 等接收线程结束', () => {
  const ir = mkIRLayers([
    { id: 'L1', blocks: [broadcast('go'), setVar('sent', 1)] },
    { id: 'L2', blocks: [hat('whenReceive', [setVar('hit', 1)], [selSlot('go')])] },
  ], {
    variables: [
      { id: 'V1', name: 'sent', type: 'num', value: 0 },
      { id: 'V2', name: 'hit', type: 'num', value: 0 },
    ],
  });
  const at0 = evaluateFrame(ir, 0, null, { rev: 11 }).ctx;
  eq(at0.getVar('sent'), 1);
  eq(at0.getVar('hit'), 0, '广播应在下一帧派发');
  eq(evaluateFrame(ir, 0.05, null, { rev: 11 }).ctx.getVar('hit'), 1);

  const ir2 = mkIRLayers([
    { id: 'L1', blocks: [broadcastWait('go'), setVar('done', 1)] },
    { id: 'L2', blocks: [hat('whenReceive', [waitS(0.2), setVar('hit', 1)], [selSlot('go')])] },
  ], {
    variables: [
      { id: 'V1', name: 'done', type: 'num', value: 0 },
      { id: 'V2', name: 'hit', type: 'num', value: 0 },
    ],
  });
  const mid = evaluateFrame(ir2, 0.1, null, { rev: 12 }).ctx;
  eq(mid.getVar('hit'), 0, '接收线程未结束时不应继续');
  eq(mid.getVar('done'), 0);
  const end = evaluateFrame(ir2, 0.3, null, { rev: 12 }).ctx;
  eq(end.getVar('hit'), 1);
  eq(end.getVar('done'), 1, 'broadcastWait 应在接收线程结束后继续');
});

t('waitUntil 条件成立后继续；stop all 截断全部线程', () => {
  const ir = mkIRLayers([
    { id: 'L1', blocks: [forever([changeVar('n', 1), waitS(0.1)])] },
    {
      id: 'L2',
      blocks: [
        stmt('waitUntil', [{ type: 'num', value: expr('gt', { a: { k: 'var', name: 'n' }, b: NUM(2) }) }]),
        setVar('done', 1),
      ],
    },
  ], { variables: [{ id: 'V1', name: 'n', type: 'num', value: 0 }, { id: 'V2', name: 'done', type: 'num', value: 0 }] });
  eq(evaluateFrame(ir, 0.05, null, { rev: 13 }).ctx.getVar('done'), 0);
  eq(evaluateFrame(ir, 0.5, null, { rev: 13 }).ctx.getVar('done'), 1, '条件成立后应继续');

  const ir2 = mkIR([
    hat('whenStart', [waitS(0.1), stmt('stop', [selSlot('all')])]),
    forever([changeVar('x', 1)]),
  ], { variables: [{ id: 'V1', name: 'x', type: 'num', value: 0 }] });
  const late = evaluateFrame(ir2, 1, null, { rev: 14 }).ctx;
  ok(late.stopped, 'stop all 应把运行时标记为停止');
  const x = late.getVar('x');
  ok(x > 0 && x < 8, `停止后不应继续递增，实际 ${x}`);
});

t('私有变量按对象隔离，全局变量共享', () => {
  const ir = mkIRLayers([
    { id: 'L1', blocks: [stmt('setVar', [strSlot('hp'), numSlot(1), selSlot('private')]), stmt('setVar', [strSlot('shared'), numSlot(10)])] },
    { id: 'L2', blocks: [stmt('setVar', [strSlot('hp'), numSlot(2), selSlot('private')]), changeVar('shared', 5)] },
  ]);
  const { ctx } = evaluateFrame(ir, 0.2, null, { rev: 15 });
  eq(ctx.objects.get('L1').localVars.get('$hp'), 1);
  eq(ctx.objects.get('L2').localVars.get('$hp'), 2);
  eq(ctx.getVar('shared'), 15, '全局变量应被两个图层累加');
});

t('列表增删改查：索引从 1 开始，越界不抛错', () => {
  const ir = mkIR([
    stmt('listCreate', [strSlot('seq')]),
    stmt('listAdd', [strSlot('seq'), strSlot('a')]),
    stmt('listAdd', [strSlot('seq'), strSlot('b')]),
    stmt('listInsert', [strSlot('seq'), numSlot(2), strSlot('x')]),
    stmt('listSet', [strSlot('seq'), numSlot(1), strSlot('z')]),
    stmt('listDelete', [strSlot('seq'), numSlot(2)]),
    stmt('listDelete', [strSlot('seq'), numSlot(99)]),
    stmt('listSet', [strSlot('seq'), numSlot(99), strSlot('nope')]),
    setExprVar('len', expr('listLength', { a: STR('seq') })),
    setExprVar('first', expr('itemOf', { a: STR('seq'), b: NUM(1) })),
    setExprVar('hasB', expr('listContains', { a: STR('seq'), b: STR('b') })),
  ]);
  const { ctx } = evaluateFrame(ir, 0.1, null, { rev: 16 });
  eq(ctx.getList('seq'), ['z', 'b']);
  eq(ctx.getVar('len'), 2);
  eq(ctx.getVar('first'), 'z');
  eq(ctx.getVar('hasB'), true);
});

/* ---------- M3：对象 / 运动 / 关键帧 / 舞台 ---------- */
t('运动积木写进运行时属性，渲染状态同步', () => {
  const ir = mkIR([
    stmt('setPosition', [strSlot(''), numSlot(100), numSlot(50)]),
    stmt('changeX', [strSlot(''), numSlot(20)]),
    stmt('setSize', [strSlot(''), numSlot(200)]),
    stmt('rotateBy', [strSlot(''), numSlot(30)]),
    stmt('setOpacity', [strSlot(''), numSlot(40)]),
  ]);
  const ls = evaluateFrame(ir, 0, null, { rev: 20 }).state.layers.L1;
  eq(ls.p.x, 120);
  eq(ls.p.y, 50);
  eq(ls.p.scaleX, 2);
  eq(ls.p.scaleY, 2);
  eq(ls.p.rotation, 30);
  eq(ls.p.opacity, 0.4);
});

t('glideTo 按缓动推进，关键帧按时间分段插值', () => {
  const ir = mkIR([
    stmt('setPosition', [strSlot(''), numSlot(0), numSlot(0)]),
    stmt('glideTo', [strSlot(''), numSlot(100), numSlot(0), numSlot(1), selSlot('linear')]),
  ]);
  const mid = evaluateFrame(ir, 0.5, null, { rev: 21 }).state.layers.L1;
  ok(Math.abs(mid.p.x - 50) < 1, `0.5s 应滑到一半，实际 ${mid.p.x}`);
  const end = evaluateFrame(ir, 1, null, { rev: 21 }).state.layers.L1;
  eq(end.p.x, 100);

  const ir2 = mkIR([
    stmt('setKeyframe', [strSlot(''), selSlot('x'), numSlot(0), numSlot(0)]),
    stmt('setKeyframe', [strSlot(''), selSlot('x'), numSlot(1), numSlot(80)]),
  ]);
  const kf = evaluateFrame(ir2, 0.5, null, { rev: 22 }).state.layers.L1;
  ok(Math.abs(kf.p.x - 40) < 1, `关键帧中点应插值到 40，实际 ${kf.p.x}`);
  eq(evaluateFrame(ir2, 1, null, { rev: 22 }).state.layers.L1.p.x, 80);
});

t('舞台积木改写背景、尺寸与时长', () => {
  const ir = mkIR([
    stmt('switchBackdrop', [lit('col', '#123456')]),
    stmt('setStageSize', [numSlot(640), numSlot(360)]),
    stmt('setDuration', [lit('time', 2.5)]),
  ]);
  const { state } = evaluateFrame(ir, 0, null, { rev: 23 });
  eq(state.stage.background, '#123456');
  eq(state.stage.width, 640);
  eq(state.stage.height, 360);
  eq(state.stage.duration, 2.5);
});

t('运行时创建/删除对象与 z 顺序，不写回 IR', () => {
  const ir = mkIR([
    stmt('createObject', [strSlot('新矩形'), selSlot('rect'), numSlot(100), numSlot(80)]),
    stmt('bringToFront', [strSlot('新矩形')]),
  ]);
  const { state, ctx } = evaluateFrame(ir, 0, null, { rev: 24 });
  const created = Object.values(state.layers).find(l => l.name === '新矩形');
  ok(created, '应创建运行时对象');
  eq(state.order[state.order.length - 1], created.id, 'bringToFront 应排到最后');
  eq(state.layers.L1.p.x, 160, '原图层不应被创建对象改写');
  eq(ir.layers.length, 1, '运行时对象不得写回 IR');
  eq(ctx.objects.size, 2);
});

t('克隆继承位置与私有变量，父级变换拍平到子对象', () => {
  const ir = mkIRLayers([
    {
      id: 'L1',
      blocks: [hat('whenClone', [stmt('changeX', [strSlot(''), numSlot(10)])])],
      props: { x: 10, y: 20, text: 'x' },
    },
    {
      id: 'L2',
      blocks: [
        stmt('setPosition', [strSlot(''), numSlot(100), numSlot(80)]),
        stmt('setParent', [strSlot(''), strSlot('L1')]),
      ],
    },
    {
      id: 'L3',
      blocks: [
        stmt('cloneObject', [strSlot('L1')]),
        stmt('setPosition', [strSlot('L1'), numSlot(50), numSlot(50)]),
      ],
    },
  ]);
  const { state } = evaluateFrame(ir, 0, null, { rev: 25 });
  const parent = state.layers.L1;
  const child = state.layers.L2;
  eq(parent.p.x, 50);
  eq(parent.p.y, 50);
  eq(child.p.x, 150, '子对象应叠加父级世界坐标');
  eq(child.p.y, 130);
  const clone = Object.values(state.layers).find(l => l.isClone);
  ok(clone, '应生成克隆体');
  eq(clone.p.x, 20, 'whenClone 应在克隆体自己的坐标上执行');
  eq(clone.type, 'text');

  const ir2 = mkIR([loopOf(400, [stmt('cloneObject', [strSlot('')])])]);
  const capped = evaluateFrame(ir2, 0.05, null, { rev: 26 }).ctx;
  ok(capped._cloneCount <= 300, `克隆上限应生效，实际 ${capped._cloneCount}`);
  ok(capped.logs.some(l => l.msg.includes('克隆数超过上限')), '达到克隆上限应写日志');
});

t('关键帧/补间/克隆在 seek 重放后结果一致', () => {
  const ir = mkIRLayers([
    { id: 'L1', blocks: [stmt('setKeyframe', [strSlot(''), selSlot('x'), numSlot(0), numSlot(0)]), stmt('setKeyframe', [strSlot(''), selSlot('x'), numSlot(1), numSlot(120)])] },
    { id: 'L2', blocks: [stmt('cloneObject', [strSlot('L1')])] },
  ]);
  const snap = (t) => JSON.stringify(evaluateFrame(ir, t, null, { rev: 27 }).state.layers);
  const direct = snap(0.75);
  resetEvaluationCache();
  evaluateFrame(ir, 2, null, { rev: 27 });
  evaluateFrame(ir, 0.1, null, { rev: 27 });
  eq(snap(0.75), direct, 'seek 重放后关键帧与克隆结果应一致');
});

t('whenKey / whenClicked 只响应注入的输入事件', () => {
  const ir = mkIRLayers([
    { id: 'L1', blocks: [hat('whenKey', [setVar('pressed', 1)], [selSlot('space')])] },
    { id: 'L2', type: 'rect', props: { x: 100, y: 100, w: 80, h: 80 }, blocks: [hat('whenClicked', [setVar('clicked', 1)])] },
  ], {
    variables: [
      { id: 'V1', name: 'pressed', type: 'num', value: 0 },
      { id: 'V2', name: 'clicked', type: 'num', value: 0 },
    ],
  });
  const rt = createRuntime(ir, null);
  rt.advanceTo(0);
  eq(rt.getVar('pressed'), 0);
  rt.pushInput({ kind: 'key', key: 'not-space' });
  rt.advanceTo(1 / 24);
  eq(rt.getVar('pressed'), 0, '不匹配的按键不应触发');
  rt.pushInput({ kind: 'key', key: ' ' });
  rt.advanceTo(2 / 24);
  eq(String(rt.getVar('pressed')), '1', '空格应触发 whenKey');
  rt.pushInput({ kind: 'click', x: 5, y: 5 });
  rt.advanceTo(3 / 24);
  eq(rt.getVar('clicked'), 0, '点空白不应触发对象点击');
  rt.pushInput({ kind: 'click', x: 100, y: 100 });
  rt.advanceTo(4 / 24);
  eq(String(rt.getVar('clicked')), '1', '命中对象应触发 whenClicked');
});

/* ---------- M4：外观 / 声音 / 造型 / 路径 ---------- */

t('外观滤镜、混合、裁剪与遮罩进入图层状态，并被渲染器消费', () => {
  const ir = mkIRLayers([
    {
      id: 'L1', type: 'rect', props: { x: 160, y: 90, w: 120, h: 80, fill: '#4a8cff' },
      blocks: [
        stmt('setBrightness', [strSlot(''), numSlot(60)]),
        stmt('setSaturation', [strSlot(''), numSlot(120)]),
        stmt('setContrast', [strSlot(''), numSlot(130)]),
        stmt('setBlur', [strSlot(''), numSlot(3)]),
        stmt('addGlow', [strSlot(''), numSlot(10), lit('col', '#4a8cff')]),
        stmt('addShadow', [strSlot(''), numSlot(6), lit('col', '#00000080')]),
        stmt('setBlendMode', [strSlot(''), selSlot('multiply')]),
        stmt('setClipRect', [strSlot(''), numSlot(10), numSlot(20), numSlot(120), numSlot(90)]),
        stmt('maskWith', [strSlot(''), strSlot('L2')]),
      ],
    },
    { id: 'L2', type: 'circle', props: { x: 100, y: 100, w: 80, h: 80 }, blocks: [] },
  ]);
  const { state } = evaluateFrame(ir, 0, null, { rev: 28 });
  const st = state.layers.L1;
  eq(st.effects.brightness, 60);
  eq(st.effects.saturation, 120);
  eq(st.effects.contrast, 130);
  eq(st.effects.blur, 3);
  eq(st.effects.glow, 10);
  eq(st.effects.glowColor, '#4a8cff');
  eq(st.effects.shadow, 6);
  eq(st.blend, 'multiply');
  eq(st.clip, { x: 10, y: 20, w: 120, h: 90 });
  eq(st.mask, 'L2');

  const raw = createRecordingContext();
  const filters = [];
  const composites = [];
  const ctx = new Proxy(raw.ctx, {
    set(target, prop, value) {
      if (prop === 'filter') filters.push(String(value));
      if (prop === 'globalCompositeOperation') composites.push(String(value));
      target[prop] = value;
      return true;
    },
  });
  render(state, ctx, { time: 0 });
  ok(filters.some(f => f.includes('brightness(60%)') && f.includes('saturate(120%)')
    && f.includes('contrast(130%)') && f.includes('blur(3px)')), `滤镜应写入 ctx.filter，实际 ${filters.join(' | ')}`);
  ok(composites.includes('multiply'), '混合模式应写入 ctx.globalCompositeOperation');
  ok(raw.calls.some(c => c.op === 'rect' && c.args[0] === 10 && c.args[1] === 20), '矩形裁剪应绘制裁剪区域');
  ok(raw.calls.some(c => c.op === 'clip'), '裁剪或遮罩应调用 clip（headless 下降级为形状裁剪）');
});

t('声音积木记录 cue，并驱动预览播放器', () => {
  const plays = [];
  const stops = [];
  const player = {
    play: (name, vol) => plays.push([name, vol]),
    stopAll: () => stops.push(1),
    setVolume: () => {},
    duration: () => 0.2,
  };
  const ir = mkIRLayers([
    {
      id: 'L1',
      blocks: [
        stmt('playSound', [selSlot('click'), numSlot(50)]),
        stmt('triggerSoundAt', [selSlot('pop'), lit('time', 0.5), numSlot(80)]),
        stmt('setVolume', [numSlot(40)]),
      ],
    },
  ]);
  const rt = createRuntime(ir, null, { sound: player });
  rt.advanceTo(0.25);
  eq(rt.compose().soundCues.map(c => c.name), ['click'], '第 0 帧只应播放 click');
  eq(plays.length, 1);
  eq(Math.round(plays[0][1] * 100) / 100, 0.5, '音量应按 50% 传给播放器');
  rt.advanceTo(0.5);
  const cues = rt.compose().soundCues;
  eq(cues.map(c => c.name), ['click', 'pop'], '定时声音应在 0.5s 触发');
  eq(Math.round(cues[1].at * 24) / 24, 0.5);

  const ir2 = mkIR([stmt('stopAllSounds', [])]);
  createRuntime(ir2, null, { sound: player }).advanceTo(0);
  eq(stops.length, 1, 'stopAllSounds 应调用播放器 stopAll');
});

t('playSoundWait 按声音时长阻塞线程', () => {
  const player = { play: () => {}, stopAll: () => {}, setVolume: () => {}, duration: () => 0.2 };
  const ir = mkIR([
    stmt('playSoundWait', [selSlot('pop'), numSlot(100)]),
    setExprVar('after', 1),
  ], {
    variables: [{ id: 'V1', name: 'after', type: 'num', value: 0 }],
  });
  const rt = createRuntime(ir, null, { sound: player });
  rt.advanceTo(0.15);
  eq(rt.getVar('after'), 0, '等待期间不应继续');
  rt.advanceTo(0.25);
  eq(String(rt.getVar('after')), '1', '声音结束后应继续');
});

t('切换造型与列表驱动序列改写 sprite 图片源', () => {
  const ir = mkIRLayers([
    {
      id: 'L1', type: 'sprite', props: { x: 160, y: 90, w: 80, h: 80, src: '' },
      blocks: [
        stmt('switchCostume', [strSlot(''), strSlot('a.png')]),
        stmt('playSequence', [strSlot(''), strSlot('frames'), numSlot(2)]),
      ],
    },
  ], {
    variables: [{ id: 'V1', name: 'frames', type: 'list', value: ['s0.png', 's1.png', 's2.png'] }],
  });
  const srcAt = (t) => {
    const rt = createRuntime(ir, null);
    rt.advanceTo(t);
    return rt.compose().layers.L1.p.src;
  };
  eq(srcAt(0), 's0.png');
  eq(srcAt(0.5), 's1.png', '0.5s @2fps 应切到第 2 帧');
  eq(srcAt(1), 's2.png');
  eq(srcAt(1.5), 's0.png', '序列应循环');
});

t('路径运动与公式运动按固定步长采样，可重放', () => {
  const ir = mkIRLayers([
    {
      id: 'L1', props: { x: 10, y: 20, text: 'x' },
      blocks: [stmt('moveAlongPath', [strSlot(''), strSlot('0,0;100,0'), numSlot(1)])],
    },
    {
      id: 'L2', props: { x: 100, y: 50, text: 'y' },
      blocks: [stmt('formulaMove', [strSlot(''), selSlot('ellipse'), numSlot(30), numSlot(10), numSlot(1), lit('time', 0)])],
    },
  ]);
  const rt = createRuntime(ir, null);
  rt.advanceTo(0.5);
  const mid = rt.compose().layers;
  ok(Math.abs(mid.L1.p.x - 60) < 1, `路径中点应在 x=60，实际 ${mid.L1.p.x}`);
  eq(mid.L1.p.y, 20);
  ok(Math.abs(mid.L2.p.x - 70) < 1, `椭圆半圈应在 x=70，实际 ${mid.L2.p.x}`);
  ok(Math.abs(mid.L2.p.y - 50) < 1e-6);

  const direct = JSON.stringify(mid);
  const rt2 = createRuntime(ir, null);
  rt2.advanceTo(1.5);
  rt2.advanceTo(0.5);
  eq(JSON.stringify(rt2.compose().layers), direct, '向后 seek 重放路径结果应一致');
});

/* ---------- M5：P2 轻量项（物理 / 贝塞尔 / 高级粒子） ---------- */

t('自定义贝塞尔缓动端点精确、过程单调', () => {
  eq(easeFn('bezier:0.42,0,0.58,1', 0), 0);
  eq(easeFn('bezier:0.42,0,0.58,1', 1), 1);
  ok(Math.abs(easeFn('bezier:0.42,0,0.58,1', 0.5) - 0.5) < 0.01, '对称控制点中点应接近 0.5');
  let prev = -1;
  for (let i = 0; i <= 20; i++) {
    const v = easeFn('bezier:0.42,0,0.58,1', i / 20);
    ok(v >= prev - 1e-9, `贝塞尔在 ${i / 20} 处回退`);
    prev = v;
  }
  ok(easeFn('bezier:0.42,0,1,1', 0.25) < 0.25, 'ease-in 控制点应让前段更慢');
});

t('tweenProp 的 customBezier 控制点进入运行时补间', () => {
  const ir = mkIRLayers([{
    id: 'L1', props: { x: 0, y: 0, text: 'x' },
    blocks: [stmt('tweenProp', [
      strSlot(''), strSlot('x'), numSlot(0), numSlot(100), numSlot(1), selSlot('customBezier'),
      numSlot(0.42), numSlot(0), numSlot(0.58), numSlot(1),
    ])],
  }]);
  const rt = createRuntime(ir, null);
  rt.advanceTo(0.5);
  const x = rt.compose().layers.L1.p.x;
  ok(Math.abs(x - 50) < 2, `对称贝塞尔中点的 x 应约为 50，实际 ${x}`);
});

t('物理运动按固定步长积分，重力与摩擦可重放', () => {
  const ir = mkIRLayers([{
    id: 'L1', props: { x: 100, y: 40, w: 20, h: 20, text: 'x' },
    blocks: [stmt('physicsMove', [
      strSlot(''), numSlot(0), numSlot(0), numSlot(600), numSlot(0.5), numSlot(0),
    ])],
  }]);
  const rt = createRuntime(ir, null);
  const at = (t) => { rt.advanceTo(t); return rt.compose().layers.L1.p.y; };
  const y0 = at(0);
  eq(y0, 40, '第 0 帧不应提前积分');
  const y12 = at(0.5);
  const expect = 40 + (600 / 576) * 78; // 半隐式欧拉 12 步
  ok(Math.abs(y12 - expect) < 0.5, `0.5s 后 y 应约 ${expect.toFixed(2)}，实际 ${y12.toFixed(2)}`);
  ok(at(1) > y12, '重力应让对象继续下落');

  const direct = JSON.stringify(rt.compose().layers);
  rt.advanceTo(2);
  rt.advanceTo(1);
  eq(JSON.stringify(rt.compose().layers), direct, '向后 seek 重放物理状态应一致');
});

t('物理运动碰到舞台边缘按反弹系数回弹', () => {
  const ir = mkIRLayers([{
    id: 'L1', props: { x: 280, y: 90, w: 20, h: 20, text: 'x' },
    blocks: [stmt('physicsMove', [
      strSlot(''), numSlot(400), numSlot(0), numSlot(0), numSlot(0.5), numSlot(0),
    ])],
  }]);
  const rt = createRuntime(ir, null);
  let maxX = 0;
  for (let f = 0; f <= 48; f++) {
    rt.advanceTo(f / 24);
    const x = rt.compose().layers.L1.p.x;
    maxX = Math.max(maxX, x);
    ok(x >= 9.9 && x <= 310.1, `对象越出舞台边界：x=${x}`);
  }
  ok(maxX > 300, `对象应撞到右边缘，实际最大 x=${maxX.toFixed(2)}`);
  const after = rt.compose().layers.L1.p.x;
  ok(after < maxX - 1, '反弹后 x 应回落');
});

t('高级粒子参数生成固定轨迹，seek 重放绘制一致', () => {
  const ir = mkIRLayers([{
    id: 'L1', props: { x: 160, y: 90, text: 'x' },
    blocks: [stmt('particles', [
      numSlot(30), lit('time', 0), lit('time', 2), lit('col', '#4a8cff'), numSlot(100),
      numSlot(1.2), numSlot(120), numSlot(-50), numSlot(0.5), numSlot(2),
    ])],
  }]);
  const rt = createRuntime(ir, null);
  rt.advanceTo(1);
  const state = rt.compose();
  const data = state.layers.L1.data;
  ok(data && data.kind === 'particles', '应输出粒子数据层');
  eq(data.trailFps, 24);
  ok(data.ps.length === 30);
  ok(data.ps[0].xs instanceof Float32Array && data.ps[0].xs.length > 10, '高级粒子应带固定步长轨迹');
  ok(data.ps[0].xs.some(v => v !== 0), '轨迹应随模拟推进');

  const snap = (runtime) => {
    runtime.advanceTo(1);
    const st = runtime.compose();
    const { ctx, calls } = createRecordingContext();
    render(st, ctx, { time: 1 });
    return digestCalls(calls);
  };
  const a = snap(createRuntime(ir, null));
  const b = snap(createRuntime(ir, null));
  eq(a, b, '两个独立运行时的粒子绘制应完全一致');
  const rt2 = createRuntime(ir, null);
  rt2.advanceTo(2.5);
  const c = snap(rt2);
  eq(c, a, '向后 seek 后重放粒子应一致');
});

const total = pass + fail;
if (fail === 0) {
  console.log(`\n运行时自测全部通过 ${pass}/${total} ✓\n`);
} else {
  console.log(`\n${fail}/${total} 失败 ✗`);
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail === 0 ? 0 : 1);
