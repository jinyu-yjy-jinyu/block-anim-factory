/* ============================================================
   selftest.js · 纯逻辑自测（无需 DOM）
   ------------------------------------------------------------
   浏览器控制台执行：
     const m = await import('./selftest.js'); m.run(); await m.runAsync();
   覆盖：缓动 / 颜色 / 确定性噪声 / IR 文本往返 / 积木求值 /
        程序化时间轴纯函数性 / 音频驱动 / ZIP 结构
   ============================================================ */

import {
  defaultProject, toText, fromText, registerOpMeta, validate,
  NUM, STR, COL, TIME, SEL, BOOL, parsePin,
} from './ir.js';
import { BLOCK_DEFS, metaFor } from './blocks.js';
import {
  ease, mixHex, hsl2hex, hex2rgb, rgb2hex, hash01, noise1,
  evaluateFrame, AudioSource, EvalContext, evalExpr,
  buildUnits, parseData,
} from './evaluator.js';
import { TEMPLATES, loadTemplate } from './templates.js';
import { createZip } from './zip.js';
import { render } from './renderer.js';
import { makeCtx } from './headless-canvas.mjs';

registerOpMeta(BLOCK_DEFS.map(d => metaFor(d.op)).filter(Boolean));

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    const r = fn();
    if (r === false) { fail++; failures.push(`${name} → 断言失败`); }
    else pass++;
  } catch (e) {
    fail++;
    failures.push(`${name} → ${e.message}`);
  }
}
function eq(a, b, msg) {
  if (String(a) !== String(b)) throw new Error(`${msg ? msg + ' ' : ''}期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function near(a, b, eps, msg) {
  if (!(Math.abs(a - b) <= (eps == null ? 1e-6 : eps))) throw new Error(`${msg ? msg + ' ' : ''}期望 ≈${b}，实际 ${a}`);
}
function truthy(v, msg) { if (!v) throw new Error(msg || '期望为真'); }

export function run() {
  pass = 0; fail = 0; failures.length = 0;

  /* ---------- 缓动 ---------- */
  t('缓动:端点', () => { near(ease('linear', 0), 0); near(ease('linear', 1), 1); });
  t('缓动:钳制越界', () => { near(ease('inCubic', -1), 0); near(ease('inCubic', 2), 1); });
  t('缓动:单调性', () => {
    for (const name of ['inCubic', 'outCubic', 'inOutQuad', 'outExpo']) {
      let prev = -1;
      for (let x = 0; x <= 1.0001; x += 0.05) {
        const v = ease(name, x);
        if (!(v >= prev - 1e-6)) throw new Error(`${name} 在 x=${x.toFixed(2)} 非单调`);
        prev = v;
      }
    }
  });
  t('缓动:别名一致', () => {
    near(ease('backOut', 0.5), ease('outBack', 0.5));
    near(ease('elasticOut', 0.5), ease('outElastic', 0.5));
    near(ease('bounceOut', 0.5), ease('outBounce', 0.5));
  });
  t('缓动:全部预设无 NaN', () => {
    for (const [name] of [['linear'], ['inQuad'], ['outQuad'], ['inOutQuad'], ['inCubic'], ['outCubic'],
      ['inOutCubic'], ['outExpo'], ['outBack'], ['outElastic'], ['outBounce']]) {
      for (let x = 0; x <= 1.0001; x += 0.1) {
        const v = ease(name, x);
        if (!isFinite(v)) throw new Error(`${name}(${x}) = ${v}`);
      }
    }
  });

  /* ---------- 颜色 ---------- */
  t('颜色:hex 往返', () => {
    near(hex2rgb('#ff8000').r, 255); near(hex2rgb('#ff8000').g, 128); near(hex2rgb('#ff8000').b, 0);
    eq(rgb2hex(255, 128, 0), '#ff8000');
  });
  t('颜色:混合端点', () => {
    eq(mixHex('#000000', '#ffffff', 0), '#000000');
    eq(mixHex('#000000', '#ffffff', 1), '#ffffff');
    eq(mixHex('#000000', '#ffffff', 0.5), '#808080');
  });
  t('颜色:HSL 原色', () => {
    eq(hsl2hex(0, 100, 50), '#ff0000');
    eq(hsl2hex(120, 100, 50), '#00ff00');
    eq(hsl2hex(240, 100, 50), '#0000ff');
    eq(hsl2hex(0, 0, 100), '#ffffff');
  });

  /* ---------- 确定性 ---------- */
  t('噪声:确定性', () => { eq(hash01(3.7), hash01(3.7)); eq(noise1(7, 1.3), noise1(7, 1.3)); });
  t('噪声:范围 [0,1]', () => {
    for (let i = 0; i < 200; i++) {
      const v = noise1(i, 2.1);
      if (!(v >= 0 && v <= 1)) throw new Error(`越界 ${v}`);
    }
  });

  /* ---------- 值解析 ---------- */
  t('解析:数值', () => eq(parsePin('#42').v, 42));
  t('解析:时间', () => eq(parsePin('~1.5').t, 'time'));
  t('解析:颜色', () => eq(parsePin('c#ff0000').v, '#ff0000'));
  t('解析:布尔', () => eq(parsePin('!1').v, true));
  t('解析:选项', () => eq(parsePin('sbackOut').v, 'backOut'));
  t('解析:空选项', () => { const v = parsePin('s'); eq(v.k, 'lit'); eq(v.t, 'sel'); eq(v.v, ''); });
  t('解析:以 s 开头的字符串仍是字符串', () => eq(parsePin('"splitBy"').v, 'splitBy'));  t('解析:字符串', () => eq(parsePin('"你好"').v, '你好'));
  t('解析:字符串转义', () => eq(parsePin('"a\\"b"').v, 'a"b'));
  t('解析:表达式', () => {
    const e = parsePin('$mul(#2,#3)');
    eq(e.k, 'blk'); eq(e.op, 'mul'); eq(e.a.v, 2); eq(e.b.v, 3);
  });
  t('解析:嵌套表达式', () => {
    const e = parsePin('$lerp($add(#1,#2),#10,#0.5)');
    eq(e.op, 'lerp'); eq(e.a.op, 'add'); eq(e.b.v, 10);
  });
  t('解析:五参数表达式', () => {
    const e = parsePin('$tween(#0,#1,~1,~0,soutCubic)');
    eq(e.op, 'tween'); eq(e.c.t, 'time'); eq(e.p.t, 'time'); eq(e.p2.v, 'outCubic');
  });
  t('解析:变量引用', () => { const v = parsePin('$myVar'); eq(v.k, 'var'); eq(v.name, 'myVar'); });
  t('解析:音频变量带偏移', () => { const a = parsePin('♪amp(#0.5)'); eq(a.k, 'audio'); eq(a.metric, 'amp'); eq(a.offset.v, 0.5); });
  t('解析:音频变量', () => { const a = parsePin('♪amp'); eq(a.k, 'audio'); eq(a.metric, 'amp'); });

  /* ---------- IR 往返 ---------- */
  t('IR:所有模板通过校验', () => {
    for (const tpl of TEMPLATES) {
      const ir = tpl.make();
      const errs = validate(ir);
      if (errs.length) throw new Error(`${tpl.name}: ${errs.join(';')}`);
    }
  });
  t('IR:积木数往返一致', () => {
    for (const tpl of TEMPLATES) {
      const ir = tpl.make();
      const back = fromText(toText(ir), BLOCK_DEFS);
      if (back.notes.length) throw new Error(`${tpl.name} 解析告警: ${back.notes.join(';')}`);
      eq(countOps(back.ir), countOps(ir), tpl.name);
    }
  });
  t('IR:标记点往返', () => {
    for (const tpl of TEMPLATES) {
      const ir = tpl.make();
      const back = fromText(toText(ir), BLOCK_DEFS);
      eq(back.ir.markers.length, ir.markers.length, tpl.name + ' 数量');
      for (let i = 0; i < ir.markers.length; i++) {
        near(back.ir.markers[i].time, ir.markers[i].time, 1e-3, tpl.name + ' 时间');
        eq(back.ir.markers[i].label, ir.markers[i].label, tpl.name + ' 名称');
      }
    }
  });
  t('IR:图层与属性往返', () => {
    for (const tpl of TEMPLATES) {
      const ir = tpl.make();
      const back = fromText(toText(ir), BLOCK_DEFS);
      eq(back.ir.layers.length, ir.layers.length, tpl.name + ' 图层数');
      for (let i = 0; i < ir.layers.length; i++) {
        const a = ir.layers[i], b = back.ir.layers[i];
        eq(b.name, a.name, tpl.name + ' 名称');
        eq(b.type, a.type, tpl.name + ' 类型');
        eq(b.visible, a.visible, tpl.name + ' 可见');
        eq(b.props.text, a.props.text, tpl.name + ' 文本');
        eq(b.props.x, a.props.x, tpl.name + ' X');
        eq(b.props.y, a.props.y, tpl.name + ' Y');
        eq(b.props.w, a.props.w, tpl.name + ' 宽');
      }
    }
  });
  t('IR:嵌套 C 形块往返', () => {
    const ir = defaultProject('x');
    ir.layers[1].blocks = [{
      id: 'b1', k: 'C', op: 'loop', slots: [
        { type: 'num', label: '次数', value: NUM(3) },
        { type: 'blocks', label: '每次', value: [
          { id: 'b2', k: 'C', op: 'wait', slots: [{ type: 'time', value: TIME(0.5) }] },
          { id: 'b3', k: 'C', op: 'fadeIn', slots: [
            { type: 'sel', value: SEL('') },
            { type: 'time', value: TIME(0.3) },
            { type: 'time', value: TIME(0) },
          ] },
        ] },
      ],
    }];
    const back = fromText(toText(ir), BLOCK_DEFS);
    if (back.notes.length) throw new Error(back.notes.join(';'));
    const lp = back.ir.layers[1].blocks[0];
    eq(lp.op, 'loop');
    eq(lp.slots[0].value.v, 3);
    eq(lp.slots[1].value.length, 2, '子块数');
    eq(lp.slots[1].value[0].op, 'wait');
    eq(lp.slots[1].value[0].slots[0].value.v, 0.5);
    eq(lp.slots[1].value[1].op, 'fadeIn');
  });
  t('IR:表达式嵌在槽位里往返', () => {
    // after [time 延迟, blocks 做什么] —— 真实带子块槽的语句积木
    const ir = defaultProject('x');
    ir.layers[1].blocks = [{
      id: 'b1', k: 'C', op: 'after',
      slots: [
        { type: 'time', label: '延迟', value: TIME(0.2) },
        { type: 'blocks', label: '做什么', value: [
          { id: 'b2', k: 'N', op: 'mul', a: NUM(2), b: parsePin('$add(#60,#20)') },
        ] },
      ],
    }];
    const back = fromText(toText(ir), BLOCK_DEFS);
    if (back.notes.length) throw new Error(back.notes.join(';'));
    const af = back.ir.layers[1].blocks[0];
    eq(af.op, 'after');
    eq(af.slots[0].value.t, 'time');
    eq(af.slots[0].value.v, 0.2);
    const inner = af.slots[1].value[0];
    eq(inner.op, 'mul');
    eq(inner.a.v, 2);
    eq(inner.b.op, 'add');
    eq(inner.b.a.v, 60);
    eq(inner.b.b.v, 20);
  });
  t('IR:槽位值往返（含选项/字符串/颜色/时间）', () => {
    const ir = loadTemplate('barChart');
    const back = fromText(toText(ir), BLOCK_DEFS);
    if (back.notes.length) throw new Error(back.notes.join(';'));
    const gb = back.ir.layers.find(l => l.name === '柱状图').blocks[0];
    eq(gb.op, 'growBar');
    eq(gb.slots[0].value.v, '柱状图', '图层选择器');
    eq(gb.slots[0].value.t, 'sel', '选择器类型');
    eq(gb.slots[1].value.v, '42,68,91,57', '数据串');
    eq(gb.slots[1].value.t, 'str', '字符串类型');
    eq(gb.slots[2].value.v, 0.7, '单根时长');
    eq(gb.slots[2].value.t, 'time', '时间类型');
    eq(gb.slots[5].value.v, '#38c98b', '颜色');
    eq(gb.slots[5].value.t, 'col', '颜色类型');
  });
  t('IR:未知积木被记录不崩溃', () => {
    const r = fromText('LAYER A [text]\n  @ notARealBlock #1', BLOCK_DEFS);
    eq(r.notes.length, 1);
    truthy(r.notes[0].indexOf('notARealBlock') >= 0);
  });

  /* ---------- 文本拆分 ---------- */
  t('拆分:逐字', () => eq(buildUnits('你好abc', 'char').length, 5));
  t('拆分:逐词', () => eq(buildUnits('你好 world', 'word').length, 3));
  t('拆分:整块', () => eq(buildUnits('abc', 'whole').length, 1));
  t('拆分:逐行', () => eq(buildUnits('a\nb\nc', 'line').length, 3));
  t('数据解析', () => eq(parseData('30, 55，80').join(','), '30,55,80'));

  /* ---------- 求值器 ---------- */
  t('求值:算术', () => {
    const ctx = mkCtx(0);
    eq(evalOp('add', NUM(1), NUM(2), null, ctx), 3);
    eq(evalOp('sub', NUM(5), NUM(2), null, ctx), 3);
    eq(evalOp('mul', NUM(4), NUM(2), null, ctx), 8);
    eq(evalOp('div', NUM(1), NUM(0), null, ctx), 0, '除零应返回 0');
    eq(evalOp('mod', NUM(7), NUM(3), null, ctx), 1);
    eq(evalOp('abs', NUM(-3), null, null, ctx), 3);
  });
  t('求值:钳制与插值', () => {
    const ctx = mkCtx(0);
    eq(evalOp('clamp', NUM(5), NUM(0), NUM(1), ctx), 1);
    eq(evalOp('clamp', NUM(-5), NUM(0), NUM(1), ctx), 0);
    eq(evalOp('lerp', NUM(0), NUM(10), NUM(0.25), ctx), 2.5);
  });
  t('求值:表达式嵌套', () => {
    const ctx = mkCtx(0);
    const e = { k: 'blk', op: 'mul', a: { k: 'blk', op: 'add', a: NUM(2), b: NUM(3) }, b: NUM(4) };
    eq(evalExpr(e, ctx), 20);
  });
  t('求值:逻辑', () => {
    const ctx = mkCtx(0);
    eq(evalOp('gt', NUM(3), NUM(2), null, ctx), true);
    eq(evalOp('lt', NUM(3), NUM(2), null, ctx), false);
    eq(evalOp('eq', NUM(3), NUM(3), null, ctx), true);
    eq(evalOp('and', BOOL(true), BOOL(false), null, ctx), false);
    eq(evalOp('or', BOOL(false), BOOL(true), null, ctx), true);
    eq(evalOp('not', BOOL(false), null, null, ctx), true);
  });
  t('求值:颜色表达式', () => {
    const ctx = mkCtx(0);
    eq(evalOp('mixCol', COL('#000000'), COL('#ffffff'), NUM(0.5), ctx), '#808080');
    eq(evalOp('hsl', NUM(0), NUM(100), NUM(50), ctx), '#ff0000');
  });
  t('求值:确定性 — 同帧两次结果相同', () => {
    const ir = loadTemplate('audioBars');
    const audio = new AudioSource({ bpm: 120, duration: 8, seed: 7, intensity: 1 });
    eq(JSON.stringify(evaluateFrame(ir, 2.5, audio).state.layers),
       JSON.stringify(evaluateFrame(ir, 2.5, audio).state.layers));
  });
  t('求值:任意跳转稳定（纯函数）', () => {
    const ir = loadTemplate('audioBars');
    const audio = new AudioSource({ bpm: 120, duration: 8, seed: 7, intensity: 1 });
    const direct = JSON.stringify(evaluateFrame(ir, 3.7, audio).state.layers);
    evaluateFrame(ir, 1.2, audio);
    evaluateFrame(ir, 7.9, audio);
    evaluateFrame(ir, 0.1, audio);
    eq(JSON.stringify(evaluateFrame(ir, 3.7, audio).state.layers), direct);
  });
  t('求值:逐帧推进产生不同画面', () => {
    const ir = loadTemplate('popTitle');
    const audio = new AudioSource({ bpm: 120, duration: 6, seed: 7, intensity: 1 });
    const fps = ir.project.fps;
    const drawAt = (time) => {
      const { state } = evaluateFrame(ir, time, audio);
      state.ir = ir;
      state.order = ir.layers.map(l => l.id);
      const rec = [];
      render(state, makeCtx(rec), { time });
      return rec.join('\n');
    };
    const seen = new Set();
    for (let f = 0; f < 6 * fps; f++) seen.add(drawAt(f / fps));
    if (seen.size < fps * 2) throw new Error(`相邻帧画面几乎不变：仅 ${seen.size} 种（${6 * fps} 帧）`);
  });
  t('求值:所有模板全程无异常', () => {
    for (const tpl of TEMPLATES) {
      const ir = tpl.make();
      const audio = new AudioSource({ bpm: 120, duration: ir.project.duration, seed: 7, intensity: 1 });
      for (let f = 0; f <= ir.project.duration * 24; f += 3) {
        const r = evaluateFrame(ir, f / 24, audio);
        if (!r.state || !r.state.layers) throw new Error(`${tpl.name} 状态缺失`);
      }
    }
  });
  t('求值:文本积木产生非空数据', () => {
    const ir = defaultProject('t');
    ir.layers[2].blocks = [{
      id: 'g', k: 'C', op: 'growBar', slots: [
        { type: 'sel', value: SEL('装饰方块') },
        { type: 'str', value: STR('30,55,80,45') },
        { type: 'time', value: TIME(0.5) },
        { type: 'time', value: TIME(0.12) },
        { type: 'time', value: TIME(0) },
        { type: 'col', value: COL('#38c98b') },
      ],
    }];
    const audio = new AudioSource({ bpm: 120, duration: 6 });
    const d = evaluateFrame(ir, 2.5, audio).state.layers[ir.layers[2].id].data;
    truthy(d && d.bars.length === 4, `柱数应为 4，实际 ${d && d.bars.length}`);
    eq(d.bars[0].p, 1, '第一根应已长满');
    eq(d.bars[3].p, 1, '第四根在 t=2.5 应已长满');
  });
  t('求值:wait 推进时间游标', () => {
    const ir = defaultProject('t');
    ir.layers[2].blocks = [
      { id: 'w', k: 'C', op: 'wait', slots: [{ type: 'time', value: TIME(2) }] },
      { id: 'g', k: 'C', op: 'growBar', slots: [
        { type: 'sel', value: SEL('装饰方块') },
        { type: 'str', value: STR('50,50') },
        { type: 'time', value: TIME(0.5) },
        { type: 'time', value: TIME(0) },
        { type: 'time', value: TIME(0) },
        { type: 'col', value: COL('#fff') },
      ] },
    ];
    const audio = new AudioSource({ bpm: 120, duration: 6 });
    // t=1：块还没开始（等待 2s），但 executeBlock 对 wait 直接推进游标并继续求值，
    // 因此 growBar 会在游标 2s 处求值 → 第一根应已长满
    const at1 = evaluateFrame(ir, 1, audio).state.layers[ir.layers[2].id].data;
    truthy(at1 && at1.bars.length === 2, '柱数应为 2');
    eq(at1.bars[0].p, 1, 'wait 之后应立即开始生长');
  });
  t('求值:音频变量有界', () => {
    const audio = new AudioSource({ bpm: 120, duration: 6, seed: 7, intensity: 1 });
    for (let i = 0; i < 500; i++) {
      const time = i / 50;
      for (const v of [audio.amplitude(time), audio.bass(time), audio.mid(time), audio.treble(time), audio.beatPulse(time)]) {
        if (!(v >= 0 && v <= 1)) throw new Error(`音频变量越界：${v}`);
      }
    }
  });
  t('音频:频谱长度与范围', () => {
    const audio = new AudioSource({ bpm: 120, duration: 6, seed: 7 });
    const spec = audio.spectrum(1.5, 32);
    eq(spec.length, 32);
    if (!spec.every(v => v >= 0 && v <= 1)) throw new Error('频谱越界');
  });
  t('音频:确定性', () => {
    const a = new AudioSource({ bpm: 120, seed: 7, intensity: 1 });
    const b = new AudioSource({ bpm: 120, seed: 7, intensity: 1 });
    eq(a.amplitude(2.3), b.amplitude(2.3));
    eq(JSON.stringify(a.spectrum(1, 16)), JSON.stringify(b.spectrum(1, 16)));
  });
  t('音频:节拍与 BPM 一致', () => {
    const a = new AudioSource({ bpm: 120, seed: 7 });
    eq(a.bpmValue(), 120);
    // 120 BPM → 每 0.5s 一个强拍
    truthy(a.beatPulse(0) > 0.9, 't=0 应是强拍');
    truthy(a.beatPulse(0.49) < 0.2, '拍尾应衰减');
    truthy(a.beatPulse(0.5) > 0.9, 't=0.5 应是下一个强拍');
  });

  /* ---------- 渲染管线 ---------- */
  t('渲染:所有模板全程不抛异常', () => {
    for (const tpl of TEMPLATES) {
      const ir = tpl.make();
      const audio = new AudioSource({ bpm: 120, duration: ir.project.duration, seed: 7, intensity: 1 });
      const fps = ir.project.fps;
      const n = Math.round(ir.project.duration * fps);
      // 步长 2 帧，兼顾覆盖率与速度
      for (let f = 0; f <= n; f += 2) {
        const { state } = evaluateFrame(ir, f / fps, audio);
        state.ir = ir;
        state.order = ir.layers.map(l => l.id);
        const rec = [];
        try {
          render(state, makeCtx(rec), { time: f / fps });
        } catch (e) {
          throw new Error(`${tpl.name} 第 ${f} 帧渲染失败：${e.message}`);
        }
        if (!rec.length) throw new Error(`${tpl.name} 第 ${f} 帧没有任何绘图指令`);
      }
    }
  });

  t('渲染:同一 env 下完全确定性', () => {
    const ir = loadTemplate('audioBars');
    const audio = new AudioSource({ bpm: 120, duration: 8, seed: 7, intensity: 1 });
    const draw = () => {
      const { state } = evaluateFrame(ir, 2.5, audio);
      state.ir = ir;
      state.order = ir.layers.map(l => l.id);
      const rec = [];
      render(state, makeCtx(rec), { time: 2.5 });
      return rec.join('\n');
    };
    if (draw() !== draw()) throw new Error('相同输入产生了不同指令');
  });

  t('渲染:分辨率缩放不改变内容指令（预览 = 成片）', () => {
    // 规划里的「致命风险」：预览与成片长得不一样。
    // 本实现的保证是：编辑态与导出态调用的是同一个 render()，
    // 差异只有 setTransform 的缩放系数，绘图内容指令逐条相同。
    for (const tpl of TEMPLATES) {
      const ir = tpl.make();
      const audio = new AudioSource({ bpm: 120, duration: ir.project.duration, seed: 7, intensity: 1 });
      const time = 1.4;
      const { state } = evaluateFrame(ir, time, audio);
      state.ir = ir;
      state.order = ir.layers.map(l => l.id);

      // 编辑态：屏幕缩放 0.4 + DPR 2 → setTransform(0.8,...)
      const preview = [];
      const pc = makeCtx(preview);
      pc.setTransform(0.8, 0, 0, 0.8, 0, 0);
      render(state, pc, { time });

      // 导出态：成片尺寸 → setTransform(1,...)
      const exported = [];
      const ec = makeCtx(exported);
      ec.setTransform(1, 0, 0, 1, 0, 0);
      render(state, ec, { time });

      // 剔除各自唯一的 setTransform 调用后，内容必须逐条相同
      const strip = (recs) => recs.filter(x => !x.startsWith('setTransform(')).join('\n');
      const a = strip(preview), b = strip(exported);
      if (a !== b) {
        const la = a.split('\n'), lb = b.split('\n');
        let i = 0;
        while (i < la.length && la[i] === lb[i]) i++;
        throw new Error(`${tpl.name} 内容不一致，第 ${i} 行：\n 预览 ${la[i]}\n 导出 ${lb[i]}`);
      }
      if (!a.trim()) throw new Error(`${tpl.name} 内容指令为空`);
    }
  });

  t('渲染:叠加层只出现在编辑态', () => {
    const ir = loadTemplate('popTitle');
    const audio = new AudioSource({ bpm: 120, duration: 6, seed: 7, intensity: 1 });
    const { state } = evaluateFrame(ir, 1, audio);
    state.ir = ir;
    state.order = ir.layers.map(l => l.id);
    const withOverlay = [];
    render(state, makeCtx(withOverlay), { time: 1, selectedLayerId: ir.layers[0].id, showSafeArea: true });
    const plain = [];
    render(state, makeCtx(plain), { time: 1 });
    if (!withOverlay.some(x => x.includes('setLineDash'))) throw new Error('编辑态应画出安全区参考线');
    if (plain.some(x => x.includes('setLineDash'))) throw new Error('导出态不应画出安全区参考线');
  });

  t('渲染:选中的图层被高亮框包围', () => {
    const ir = loadTemplate('popTitle');
    const audio = new AudioSource({ bpm: 120, duration: 6, seed: 7, intensity: 1 });
    const { state } = evaluateFrame(ir, 1, audio);
    state.ir = ir;
    state.order = ir.layers.map(l => l.id);
    const rec = [];
    render(state, makeCtx(rec), { time: 1, selectedLayerId: ir.layers[1].id, showSafeArea: false });
    if (!rec.some(x => x.includes('74,140,255'))) {
      throw new Error('未看到选中高亮；前 6 条指令：\n  ' + rec.slice(0, 6).join('\n  '));
    }
  });

  t('渲染:透明图层不产生指令', () => {
    const ir = loadTemplate('popTitle');
    const audio = new AudioSource({ bpm: 120, duration: 6, seed: 7, intensity: 1 });
    const { state } = evaluateFrame(ir, 2, audio);
    state.ir = ir;
    state.order = ir.layers.map(l => l.id);
    // 把标题图层设为完全透明
    const lid = ir.layers[1].id;
    state.layers[lid].p.opacity = 0;
    state.layers[lid].visible = true;
    const rec = [];
    render(state, makeCtx(rec), { time: 2 });
    if (rec.some(x => x.includes('fillText'))) throw new Error('透明度 0 的图层不应绘制文字');
  });

  /* ---------- 汇总 ---------- */
  const total = pass + fail;
  if (fail === 0) {
    console.log(`%c✓ 自测全部通过 ${pass}/${total}`, 'color:#38c98b;font-weight:700');
  } else {
    console.log(`%c✗ ${fail}/${total} 失败`, 'color:#ff5a5a;font-weight:700');
    for (const f of failures) console.log('  · ' + f);
  }
  return { pass, fail, total, failures: failures.slice() };
}

/* ---------- 工具 ---------- */
function countOps(ir) {
  let n = 0;
  for (const l of ir.layers) n += countList(l.blocks);
  return n;
}
function countList(list) {
  let n = 0;
  for (const b of list || []) {
    n++;
    if (b.slots) for (const s of b.slots) if (Array.isArray(s.value)) n += countList(s.value);
  }
  return n;
}
function mkCtx(time) {
  return new EvalContext(defaultProject('t'), time, new AudioSource({ bpm: 120, duration: 6 }));
}
function evalOp(op, a, b, c, ctx) {
  return evalExpr({
    k: 'blk', op,
    a: a === undefined ? null : a,
    b: b === undefined ? null : b,
    c: c === undefined ? null : c,
    p: null, p2: null,
  }, ctx);
}

/* ---------- ZIP 结构检查 ---------- */
export async function runAsync() {
  const enc = new TextEncoder();
  const blob = await createZip([
    { name: 'a.txt', data: enc.encode('hello 积木动画工厂'.repeat(60)) },
    { name: 'dir/b.bin', data: new Uint8Array(2000).fill(7) },
  ]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const head = buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  const tail = buf[buf.length - 22] === 0x50 && buf[buf.length - 21] === 0x4b
            && buf[buf.length - 20] === 0x05 && buf[buf.length - 19] === 0x06;
  console.log(`${head && tail ? '✓' : '✗'} ZIP 结构（${buf.length} 字节，头${head ? 'OK' : 'BAD'} 尾${tail ? 'OK' : 'BAD'}）`);
  return head && tail;
}
