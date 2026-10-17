/* 图片缓存失败重试（#33）
   原实现 img.onerror 里 `img = { ok: false }` 只换局部引用，
   缓存里仍是同一个未标记的 Image —— 该 src 之后每次取出来都走
   「未就绪」分支，永远修不好。 */
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const U = (p) => pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), p)).href;

let pass = 0, fail = 0; const failures = [];
/* 注意：这些用例都操作同一个模块级图片缓存，**必须串行**。
   用 queue 逐个 await，不能像其他套件那样并发 push —— 否则
   后一条的 _clearImageCache() 会在前一条的 await 之前跑，互相踩。 */
const queue = [];
const t = (n, f) => {
  queue.push(async () => {
    try { await f(); pass++; }
    catch (e) { fail++; failures.push(`${n} → ${e.message}`); }
  });
};
const ok = (v, m) => { if (!v) throw new Error(m || '期望为真'); };
const eq = (a, b, m) => { if (String(a) !== String(b)) throw new Error(`${m || ''} 期望 ${b}，实际 ${a}`); };

/* 可编程的 Image 桩：src 赋值后由测试决定触发 load 还是 error */
class FakeImage {
  constructor() {
    this._src = '';
    this.complete = false;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    FakeImage.instances.push(this);
  }
  get src() { return this._src; }
  set src(v) {
    this._src = v;
    const beh = FakeImage.nextBehavior.shift() || 'error';
    setImmediate(() => {
      this.complete = true;
      if (beh === 'load') {
        this.naturalWidth = 64;
        this.naturalHeight = 64;
        if (this.onload) this.onload();
      } else if (this.onerror) this.onerror();
    });
  }
}
FakeImage.instances = [];
FakeImage.nextBehavior = [];

const savedImage = globalThis.Image;
globalThis.Image = FakeImage;

const RD = await import(U('src/renderer.js'));
const HC = await import(U('src/headless-canvas.mjs'));

/** 用最小 scene 触发 drawImageLayer */
function drawSrc(src) {
  const ctx = HC.makeCtx([]);
  const scene = {
    ir: { project: { width: 100, height: 100 }, layers: [] },
    order: ['L1'],
    layers: {
      L1: { id: 'L1', name: 'L1', type: 'image', visible: true, p: { src, x: 50, y: 50, w: 64, h: 64 }, fx: {} },
    },
    time: 0,
  };
  RD.render(scene, ctx, { time: 0 });
  return ctx;
}
const tick = () => new Promise(r => setImmediate(r));

t('图片缓存:加载失败要把 failed 写回缓存条目', async () => {
  RD._clearImageCache();
  FakeImage.nextBehavior = ['error'];
  drawSrc('http://x/bad.png');
  await tick(); await tick();
  const info = RD._imageCacheInfo();
  eq(info.length, 1, `缓存条目数 ${info.length}`);
  eq(info[0].failed, true, 'onerror 没有把失败写回缓存条目（又只改了局部变量）');
  eq(info[0].ok, false, 'ok 应为 false');
});

t('图片缓存:重试窗口内不重复发起请求', async () => {
  RD._clearImageCache();
  FakeImage.nextBehavior = ['error'];
  drawSrc('http://x/bad2.png');
  await tick(); await tick();
  const before = FakeImage.instances.length;
  drawSrc('http://x/bad2.png');
  await tick();
  eq(FakeImage.instances.length, before, '重试窗口内不应新建 Image');
});

t('图片缓存:过了重试窗口会重新加载（槽位能被修好）', async () => {
  RD._clearImageCache();
  FakeImage.nextBehavior = ['error'];
  drawSrc('http://x/retry.png');
  await tick(); await tick();
  const before = FakeImage.instances.length;
  const savedNow = Date.now;
  Date.now = () => savedNow() + 60_000;   // 快进超过 IMG_RETRY_MS
  try {
    FakeImage.nextBehavior = ['load'];
    drawSrc('http://x/retry.png');
    await tick(); await tick();
  } finally {
    Date.now = savedNow;
  }
  eq(FakeImage.instances.length, before + 1, '过了重试窗口仍不重新加载 —— 该槽位永远修不好');
  const info = RD._imageCacheInfo();
  eq(info[0].ok, true, '重试成功后 ok 应为 true');
  eq(info[0].failed, false, '重试成功后 failed 应被清掉');
});

t('图片缓存:成功加载后正常绘制（不抛错、走 drawImage）', async () => {
  RD._clearImageCache();
  FakeImage.nextBehavior = ['load'];
  const ctx = drawSrc('http://x/good.png');
  await tick(); await tick();
  const info = RD._imageCacheInfo();
  eq(info.length, 1);
  eq(info[0].ok, true, '成功加载后 ok 应为 true');
  // 再画一次（已就绪）不应抛错
  const ctx2 = drawSrc('http://x/good.png');
  ok(ctx2, '第二次绘制失败');
});

for (const run of queue) await run();   // 必须串行：共用同一个模块级缓存
globalThis.Image = savedImage;

console.log('');
if (fail === 0) console.log(`✓ 图片缓存自测全部通过 ${pass}/${pass + fail}`);
else {
  console.log(`✗ ${fail}/${pass + fail} 失败`);
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail === 0 ? 0 : 1);
