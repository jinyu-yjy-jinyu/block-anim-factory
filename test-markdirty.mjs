/* #35：markDirty 的 1.6 秒定时器不得清 App.dirty
   原实现定时器里顺手写了 App.dirty = false，于是任何改动 1.6 秒后
   就被当成「已保存」，beforeunload 拦截形同虚设，关窗口直接丢工程。 */
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0; const failures = [];
const t = (n, f) => {
  try { f(); pass++; } catch (e) { fail++; failures.push(`${n} → ${e.message}`); }
};
const ok = (v, m) => { if (!v) throw new Error(m || '期望为真'); };
const eq = (a, b, m) => { if (String(a) !== String(b)) throw new Error(`${m || ''} 期望 ${b}，实际 ${a}`); };

const SRC = readFileSync(new URL('./src/main.js', import.meta.url), 'utf8');

t('markDirty:定时器回调里不得出现 App.dirty = false', () => {
  // 精确取出 markDirty 函数体
  const m = SRC.match(/function markDirty\(\)\s*\{([\s\S]*?)\n\}/);
  ok(m, '没找到 markDirty 函数');
  const body = m[1];
  // 定时器那一行
  const timerLine = body.split('\n').find(l => l.includes('setTimeout') && l.includes('dirtyTimer'));
  ok(timerLine, '没找到 dirtyTimer 的 setTimeout');
  ok(!/App\.dirty\s*=\s*false/.test(timerLine),
    `定时器回调仍在清 App.dirty：${timerLine.trim()}`);
});

t('markDirty:函数体开头仍然置 dirty 为 true', () => {
  const m = SRC.match(/function markDirty\(\)\s*\{([\s\S]*?)\n\}/);
  ok(m, '没找到 markDirty 函数');
  ok(/App\.dirty\s*=\s*true/.test(m[1]), 'markDirty 没有把 App.dirty 置 true');
});

t('markClean:仍然是唯一清 App.dirty 的地方', () => {
  const m = SRC.match(/function markClean\(\)\s*\{([\s\S]*?)\n\}/);
  ok(m, '没找到 markClean 函数');
  ok(/App\.dirty\s*=\s*false/.test(m[1]), 'markClean 没有清 App.dirty');
});

t('markDirty:定时器仍会恢复状态栏文字（否则「● 未保存」永远不消失）', () => {
  const m = SRC.match(/function markDirty\(\)\s*\{([\s\S]*?)\n\}/);
  const body = m[1];
  ok(/statusText/.test(body) && /就绪/.test(body),
    '定时器不再恢复状态栏文字 —— 删定时器不能把功能一起删掉');
});

t('beforeunload:仍然拦未保存改动', () => {
  ok(/beforeunload/.test(SRC), '找不到 beforeunload 监听');
  ok(/if\s*\(\s*App\.dirty\s*\)\s*\{[^}]*preventDefault/.test(SRC),
    'beforeunload 里没有依据 App.dirty 拦截');
});

/* ---------- #44：batch.js 只导入一次 ---------- */
t('import:batch.js 只被导入一次（不产生两个命名空间）', () => {
  // 原实现第 30 行 `import * as APP_INTERP from './batch.js'`、
  // 第 37 行 `import * as APP_BATCH from './batch.js'` —— 同一模块两个名字，
  // 谁在用哪个全凭运气，改一处漏一处。
  const hits = SRC.match(/^\s*import\s+\*\s+as\s+\w+\s+from\s+['"]\.\/batch\.js['"]/gm) || [];
  eq(hits.length, 1, `batch.js 被 import 了 ${hits.length} 次：${hits.map(s => s.trim()).join(' | ')}`);
});

t('import:不再有 APP_INTERP 这个残留命名空间（注释里提及不算）', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok(!/APP_INTERP/.test(code), 'APP_INTERP 仍出现在可执行代码里（应统一用 APP_BATCH）');
});

/* ---------- #59：拖动标记点要能撤销 ---------- */
t('标记点:startMarkerDrag 在 mousedown 阶段就 pushUndo', () => {
  // 撤销点必须在拖动开始前那一下压栈，不能放 mousemove：
  // mousemove 会触发几十上百次，每帧 pushUndo 会堆出几百个撤销点。
  const m = SRC.match(/function startMarkerDrag\(e, m\)\s*\{([\s\S]*?)\n\}/);
  ok(m, '没找到 startMarkerDrag');
  const body = m[1];
  const pushIdx = body.indexOf('pushUndo()');
  ok(pushIdx >= 0, 'startMarkerDrag 里没有 pushUndo —— 拖动标记点撤不掉');
  const moveIdx = body.indexOf('const onMove');
  ok(moveIdx >= 0, '没找到 onMove');
  ok(pushIdx < moveIdx,
    'pushUndo 落在了 onMove 之后 —— 会随每次 mousemove 反复压栈（应放在拖动开始前）');
  // 且不能在 onMove 内部
  const onMoveBody = body.slice(moveIdx);
  ok(!/pushUndo\(\)/.test(onMoveBody.split('const onUp')[0]),
    'onMove 内部调用了 pushUndo —— 拖动过程会堆出几百个撤销点');
});

t('标记点:renameMarker 仍然先 pushUndo', () => {
  const m = SRC.match(/function renameMarker\(m\)\s*\{([\s\S]*?)\n\}/);
  ok(m, '没找到 renameMarker');
  ok(/pushUndo\(\)/.test(m[1]), 'renameMarker 丢了 pushUndo');
});

/* ---------- #42：拖拽时不得每帧遍历所有 dropzone ---------- */
t('拖拽:dropzone 列表在拖拽开始时取一次快照', () => {
  const src = readFileSync(new URL('./src/blockview.js', import.meta.url), 'utf8');
  // pickDrop 的兜底分支不得每次现查 DOM
  const m = src.match(/function pickDrop\(e\)\s*\{([\s\S]*?)\n\}/);
  ok(m, '没找到 pickDrop');
  const body = m[1];
  ok(/_dragDropzones\s*\|\|/.test(body),
    'pickDrop 兜底分支没有使用拖拽快照（会每次 mousemove 都 querySelectorAll + 全部 getBoundingClientRect）');
  // 快照必须在 startDrag 里捕获、在 onUp 里释放
  const sd = src.match(/function startDrag\(payload, ev\)\s*\{([\s\S]*?)\n\}/);
  ok(sd, '没找到 startDrag');
  ok(/captureDropzones\(\)/.test(sd[1]), 'startDrag 没有捕获 dropzone 快照');
  ok(/releaseDropzones\(\)/.test(sd[1]), 'startDrag 没有释放快照（会泄漏并拿到过期节点）');
});

console.log('');
if (fail === 0) console.log(`✓ markDirty 自测全部通过 ${pass}/${pass + fail}`);
else {
  console.log(`✗ ${fail}/${pass + fail} 失败`);
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail === 0 ? 0 : 1);
