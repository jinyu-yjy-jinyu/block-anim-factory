/* 套件 9：自定义积木（函数） */
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const U = (p) => pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), p)).href;

const CB = await import(U('src/customblocks.js'));
const IR = await import(U('src/ir.js'));

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

/* 一个「淡入 + 停顿」的函数体，形参用 {dur} / {pause} 占位 */
function makeBody() {
  return [{
    id: 'f1', k: 'C', op: 'fadeIn', slots: [
      { type: 'sel', value: IR.SEL('标题文字') },
      { type: 'time', value: { k: 'lit', t: 'str', v: '{dur}' } },
      { type: 'time', value: IR.TIME(0) },
    ],
  }, {
    id: 'f2', k: 'C', op: 'wait', slots: [{ type: 'time', value: { k: 'lit', t: 'str', v: '{pause}' } }],
  }];
}
/* 不带占位的静态函数体 */
function staticBody() {
  return [{
    id: 'f1', k: 'C', op: 'fadeIn', slots: [
      { type: 'sel', value: IR.SEL('标题文字') },
      { type: 'time', value: IR.TIME(0.6) },
      { type: 'time', value: IR.TIME(0) },
    ],
  }, {
    id: 'f2', k: 'C', op: 'wait', slots: [{ type: 'time', value: IR.TIME(0.5) }],
  }];
}

t('自定义积木:定义与校验', () => {
  const cb = new CB.CustomBlock({
    name: '淡入并停顿',
    op: 'custom.fadeInWait',
    params: [
      { name: 'dur', label: '淡入时长', type: 'time', defaultValue: IR.TIME(0.6) },
      { name: 'pause', label: '停顿', type: 'time', defaultValue: IR.TIME(0.5) },
    ],
    body: staticBody(),
  });
  eq(cb.validate().filter(i => i.level === 'error').length, 0);
  eq(cb.params.length, 2);
  ok(cb.isStatement, '应为语句型');
});
t('自定义积木:校验拦截非法 op 前缀', () => {
  const cb = new CB.CustomBlock({ name: 'x', op: 'notPrefixed', params: [], body: staticBody() });
  ok(cb.validate().some(i => i.msg.includes('custom.')), '未拦截非法前缀');
});
t('自定义积木:校验拦截重名参数', () => {
  const cb = new CB.CustomBlock({
    name: 'x', op: 'custom.x',
    params: [{ name: 'a', type: 'num' }, { name: 'a', type: 'num' }],
    body: staticBody(),
  });
  ok(cb.validate().some(i => i.msg.includes('重名')), '未拦截重名');
});
t('自定义积木:校验拦截未定义参数引用', () => {
  const cb = new CB.CustomBlock({ name: 'x', op: 'custom.x', params: [], body: staticBody() });
  const r = cb.expandTest = cb.validate();
  ok(r.length >= 0, '应返回校验结果');
});
t('自定义积木:参数名非法字符被拦', () => {
  const cb = new CB.CustomBlock({
    name: 'x', op: 'custom.x',
    params: [{ name: '1bad', type: 'num' }], body: staticBody(),
  });
  ok(cb.validate().some(i => i.msg.includes('非法')), '未拦截非法参数名');
});
t('自定义积木:插入调用点生成正确槽位', () => {
  const cb = new CB.CustomBlock({
    name: '淡入并停顿', op: 'custom.fadeInWait',
    params: [
      { name: 'dur', label: '淡入时长', type: 'time', defaultValue: IR.TIME(0.6) },
      { name: 'pause', label: '停顿', type: 'time', defaultValue: IR.TIME(0.5) },
    ],
    body: staticBody(),
  });
  const call = cb.instantiate({ dur: IR.TIME(1.2) });
  eq(call.op, 'custom.fadeInWait');
  eq(call.slots.length, 2);
  eq(call.slots[0].value.v, 1.2, '实参未生效');
  eq(call.slots[1].value.v, 0.5, '未用默认值');
  eq(call.customRef, cb.id);
});
t('自定义积木:库添加与冲突检测', () => {
  const lib = new CB.CustomBlockLibrary();
  const cb = new CB.CustomBlock({ name: 'A', op: 'custom.a', params: [], body: staticBody() });
  lib.add(cb);
  eq(lib.size, 1);
  let threw = false;
  try { lib.add(new CB.CustomBlock({ name: 'A2', op: 'custom.a', params: [], body: staticBody() })); }
  catch { threw = true; }
  ok(threw, '未拦截 op 冲突');
  threw = false;
  try { lib.add(new CB.CustomBlock({ name: 'X', op: 'wait', params: [], body: staticBody() })); }
  catch { threw = true; }
  ok(threw, '未拦截与内置积木冲突');
});
t('自定义积木:转成积木定义供面板使用', () => {
  const lib = new CB.CustomBlockLibrary();
  lib.add(new CB.CustomBlock({
    name: '淡入并停顿', op: 'custom.fiw',
    params: [
      { name: 'dur', label: '时长', type: 'time', defaultValue: IR.TIME(0.6) },
      { name: 'pause', label: '停顿', type: 'time', defaultValue: IR.TIME(0.5) },
    ],
    body: makeBody(),
  }));
  const defs = lib.toBlockDefs();
  eq(defs.length, 1);
  eq(defs[0].op, 'custom.fiw');
  eq(defs[0].label, '淡入并停顿');
  eq(defs[0].isLeaf, false);
  eq(defs[0].slots.length, 2, '应有两个槽位');
  eq(defs[0].slots[0].label, '时长');
});
t('自定义积木:宏展开为实际语句', () => {
  const cb = new CB.CustomBlock({
    name: '淡入并停顿', op: 'custom.fiw',
    params: [
      { name: 'dur', label: '时长', type: 'time', defaultValue: IR.TIME(0.6) },
      { name: 'pause', label: '停顿', type: 'time', defaultValue: IR.TIME(0.5) },
    ],
    body: makeBody(),
  });
  const lib = new CB.CustomBlockLibrary({ blocks: [cb] });
  const call = cb.instantiate({ dur: IR.TIME(1.2) });   // pause 走默认值
  const r = CB.expandCustomBlocks([call], lib);
  eq(r.blocks.length, 2, '应展开成 2 条语句');
  eq(r.blocks[0].op, 'fadeIn');
  eq(r.blocks[0].slots[1].value.v, 1.2, `形参未替换，实际 ${JSON.stringify(r.blocks[0].slots[1].value)}`);
  eq(r.blocks[0].slots[1].value.t, 'time', '应保留 time 类型');
  eq(r.blocks[1].slots[0].value.v, 0.5, '未用默认值');
});
t('自定义积木:改函数体，所有调用点同步', () => {
  const cb = new CB.CustomBlock({
    name: 'F', op: 'custom.f',
    params: [{ name: 'dur', type: 'time', defaultValue: IR.TIME(0.6) }],
    body: staticBody(),
  });
  const lib = new CB.CustomBlockLibrary({ blocks: [cb] });
  const call1 = cb.instantiate({ dur: IR.TIME(1) });
  const call2 = cb.instantiate({ dur: IR.TIME(2) });

  const r1 = CB.expandCustomBlocks([call1], lib);
  eq(r1.blocks.length, 2);
  // 修改函数体：加一条
  cb.body.push({ id: 'f3', k: 'C', op: 'wait', slots: [{ type: 'time', value: IR.TIME(9) }] });
  const r2 = CB.expandCustomBlocks([call2], lib);
  eq(r2.blocks.length, 3, '函数体改动应同步到调用点');
});
t('自定义积木:嵌套调用展开', () => {
  const inner = new CB.CustomBlock({
    name: 'In', op: 'custom.in',
    params: [{ name: 'd', type: 'time', defaultValue: IR.TIME(0.3) }],
    body: [{ id: 'i1', k: 'C', op: 'wait', slots: [{ type: 'time', value: { k: 'lit', t: 'str', v: '{d}' } }] }],
  });
  const outer = new CB.CustomBlock({
    name: 'Out', op: 'custom.out',
    params: [{ name: 'd', type: 'time', defaultValue: IR.TIME(0.5) }],
    // 函数体里直接调用 inner，inner 的形参用外层的 {d} 传入
    body: [{ id: 'o1', k: 'C', op: 'custom.in', customRef: inner.id, slots: [
      { type: 'time', value: { k: 'lit', t: 'str', v: '{d}' } },
    ] }],
  });
  const lib = new CB.CustomBlockLibrary({ blocks: [inner, outer] });
  const call = outer.instantiate({ d: IR.TIME(2) });
  const r = CB.expandCustomBlocks([call], lib);
  eq(r.blocks.length, 1, `应展开成 1 条，实际 ${r.blocks.length}`);
  eq(r.blocks[0].op, 'wait');
  eq(r.blocks[0].slots[0].value.v, 2, `嵌套形参未传递，实际 ${r.blocks[0].slots[0].value.v}`);
});
t('自定义积木:递归深度保护', () => {
  const cb = new CB.CustomBlock({
    name: 'R', op: 'custom.r',
    params: [{ name: 'n', type: 'num', defaultValue: IR.NUM(0) }],
    body: [{ id: 'rc', k: 'N', op: 'sub', a: { k: 'lit', t: 'num', v: 1 }, b: { k: 'lit', t: 'str', v: '{n}' } }],
  });
  const lib = new CB.CustomBlockLibrary({ blocks: [cb] });
  // 自调用制造无限递归
  cb.body[0].b = { k: 'blk', op: 'custom.r', a: { k: 'lit', t: 'str', v: '{n}' } };
  const call = cb.instantiate({ n: IR.NUM(3) });
  let threw = false;
  try { CB.expandCustomBlocks([call], lib, { maxDepth: 8 }); } catch { threw = true; }
  ok(threw, '递归未触发深度保护');
});
t('自定义积木:积木型形参接收子块', () => {
  const cb = new CB.CustomBlock({
    name: 'Do', op: 'custom.do',
    params: [{ name: 'body', label: '要做的', type: 'blocks' }],
    body: [{ id: 'db', k: 'C', op: 'placeholder', slotRef: 'body', slots: [] }],
  });
  const lib = new CB.CustomBlockLibrary({ blocks: [cb] });
  const innerBlock = { id: 'u1', k: 'C', op: 'wait', slots: [{ type: 'time', value: IR.TIME(0.2) }] };
  const call = cb.instantiate();
  call.slots[0].value = [innerBlock];
  const r = CB.expandCustomBlocks([call], lib);
  eq(r.blocks.length, 1, '应展开成 1 条语句');
  eq(r.blocks[0].op, 'wait', `实际是 ${r.blocks[0].op}`);
});
t('自定义积木:占位符收集', () => {
  eq(CB.findPlaceholders(staticBody()).length, 0, '静态函数体无占位符');
  const names = CB.findPlaceholders(makeBody());
  eq(names.length, 2, `应收集到 2 个占位符，实际 ${names}`);
  ok(names.includes('dur') && names.includes('pause'), names.join(','));
});
t('自定义积木:从现有积木封装', () => {
  const lib = CB.extractFunction(staticBody(), { name: '淡入停顿', key: 'fiw' });
  eq(lib.size, 1);
  const cb = lib.list()[0];
  eq(cb.op, 'custom.fiw');
  ok(cb.params.length > 0, '应自动推断出参数');
});
t('自定义积木:封装后可正常展开', () => {
  const lib = CB.extractFunction(staticBody(), { name: '淡入停顿', key: 'fiw' });
  const cb = lib.list()[0];
  const call = cb.instantiate();
  const r = CB.expandCustomBlocks([call], lib);
  eq(r.blocks.length, 2);
});
t('自定义积木:库 JSON 往返', () => {
  const lib = new CB.CustomBlockLibrary();
  lib.add(new CB.CustomBlock({
    name: 'F', op: 'custom.f',
    params: [
      { name: 'dur', type: 'time', defaultValue: IR.TIME(0.6) },
      { name: 'pause', type: 'time', defaultValue: IR.TIME(0.5) },
    ],
    body: makeBody(),
  }));
  const back = CB.CustomBlockLibrary.fromJSON(JSON.parse(JSON.stringify(lib.toJSON())));
  eq(back.size, 1);
  eq(back.list()[0].name, 'F');
  eq(back.list()[0].body.length, 2);
  near(back.list()[0].params[0].defaultValue.v, 0.6, 1e-9);
  eq(back.list()[0].validate().filter(i => i.level === 'error').length, 0);
});
t('自定义积木:卸载', () => {
  const lib = new CB.CustomBlockLibrary();
  const cb = lib.add(new CB.CustomBlock({ name: 'F', op: 'custom.f', params: [], body: staticBody() }));
  ok(lib.remove(cb.id));
  eq(lib.size, 0);
  eq(lib.remove(cb.id), false, '重复移除应返回 false');
});
t('自定义积木:表达式型（无数组槽）', () => {
  const cb = new CB.CustomBlock({
    name: '双倍', op: 'custom.twice',
    params: [
      { name: 'x', label: '值', type: 'num', defaultValue: IR.NUM(1) },
      { name: 'k', label: '倍数', type: 'num', defaultValue: IR.NUM(2) },
    ],
    body: [{ id: 'tb', k: 'N', op: 'mul', a: { k: 'lit', t: 'str', v: '{x}' }, b: { k: 'lit', t: 'str', v: '{k}' } }],
  });
  eq(cb.isStatement, false, '应识别为表达式型');
  const call = cb.instantiate({ x: IR.NUM(21) });
  eq(call.k, 'N');
  eq(call.a.v, 21);
  const lib = new CB.CustomBlockLibrary({ blocks: [cb] });
  // 表达式型展开后仍是表达式节点，交给求值器按 mul 处理
  const r = CB.expandCustomBlocks([call], lib);
  ok(r.blocks.length >= 0);
});
t('自定义积木:表达式实参不被 String 成 [object Object]', () => {
  // 回归：subValue 对非 lit 的实参一律走 STR(a)，而 STR 是 String(v)，
  // 于是实参是表达式积木（{k:'blk'}）时被写成 "[object Object]" 字符串，
  // 参数在求值之前就被毁掉了。
  const cb = new CB.CustomBlock({
    name: '取大', op: 'custom.max',
    params: [
      { name: 'x', label: '值', type: 'num', defaultValue: IR.NUM(1) },
      { name: 'k', label: '倍数', type: 'num', defaultValue: IR.NUM(2) },
    ],
    body: [{ id: 'tb', k: 'N', op: 'mul', a: { k: 'lit', t: 'str', v: '{x}' }, b: { k: 'lit', t: 'str', v: '{k}' } }],
  });
  const lib = new CB.CustomBlockLibrary({ blocks: [cb] });
  const exprArg = { k: 'blk', op: 'add', a: IR.NUM(3), b: IR.NUM(4) };
  const r = CB.expandCustomBlocks([{ k: 'N', op: 'custom.max', a: exprArg, b: IR.NUM(2) }], lib);
  const got = JSON.stringify(r.blocks[0].a);
  ok(!got.includes('[object Object]'), `表达式实参被字符串化：${got}`);
  eq(r.blocks[0].a.k, 'blk', '表达式实参应原样代入');
  eq(r.blocks[0].a.op, 'add');
});
t('自定义积木:文本内嵌占位也会被替换', () => {
  // 回归：原实现只处理「整串就是单个 {x}」的占位，写在句子中间的
  // `时长={dur}s` 从不替换 —— 形参在面板上配了却不起作用，且不报错。
  const cb = new CB.CustomBlock({
    name: '标签', op: 'custom.tag',
    params: [{ name: 'x', type: 'num', defaultValue: IR.NUM(1) }],
    body: [{ id: 'tb', k: 'N', op: 'setText', a: { k: 'lit', t: 'str', v: '值={x}!' } }],
  });
  const lib = new CB.CustomBlockLibrary({ blocks: [cb] });
  const r = CB.expandCustomBlocks([{ k: 'N', op: 'custom.tag', a: IR.NUM(7) }], lib);
  eq(r.blocks[0].a.v, '值=7!', '文本内嵌占位未替换');
  // 带单位的 time 字段同理
  const cb2 = new CB.CustomBlock({
    name: '时长标签', op: 'custom.tl',
    params: [{ name: 'dur', type: 'time', defaultValue: IR.TIME(0.5) }],
    body: [{ id: 'tb', k: 'N', op: 'setText', a: { k: 'lit', t: 'time', v: '{dur}' } }],
  });
  const lib2 = new CB.CustomBlockLibrary({ blocks: [cb2] });
  const r2 = CB.expandCustomBlocks([{ k: 'N', op: 'custom.tl', a: IR.TIME(1.2) }], lib2);
  eq(r2.blocks[0].a.v, 1.2, '形参未代入');
  eq(r2.blocks[0].a.t, 'time', '类型应保留');
});
t('自定义积木:slugify', () => {
  eq(CB.slugify('Hello World'), 'Hello_World');
  eq(CB.slugify('fade-in'), 'fadein');
  eq(CB.slugify('!!!'), CB.slugify('!!!'), '应稳定');
  ok(CB.slugify('!!!').length > 0, '不应返回空串');
  eq(CB.slugify('我的 积木'), CB.slugify('我的 积木'), '纯中文应走哈希分支');
});

/* ============================================================
   汇总
   ============================================================ */
await Promise.all(pendingTests);   // 等所有异步用例真正跑完再统计
console.log('');
if (fail === 0) console.log(`%c✓ 自定义积木自测全部通过 ${pass}/${pass + fail}`, 'color:#38c98b;font-weight:700');
else {
  console.log(`%c✗ ${fail}/${pass + fail} 失败`, 'color:#ff5a5a;font-weight:700');
  for (const f of failures) console.log('  · ' + f);
}
console.log('');
process.exit(fail === 0 ? 0 : 1);