/* ============================================================
   debugger.js · 程序化时间轴调试器
   ------------------------------------------------------------
   规划里的 P0 项：「没有调试器的可视化编程工具一定会被用户放弃」。
   由于时间轴是纯函数，调试器可以做到真正的单步：
     · 单步 = t += 1/fps 后重新求值整棵树
     · 断点 = 在指定积木上暂停
     · 监视 = 记录执行过程中写入的变量
     · 探针 = 记录目标图层本帧求值后的属性
   ============================================================ */

import { evaluateFrame, num } from './evaluator.js';
import { defOf } from './blocks.js';

export class TimelineDebugger {
  constructor() {
    this.time = 0;
    this.fps = 24;
    this.running = false;
    this.breakpoints = new Set();
    this.stopAt = null;           // 命中断点时停住的积木 id
    this.trace = [];              // 本帧执行轨迹
    this.vars = new Map();
    this.probe = null;            // 被探针的图层 id
    this.lastHit = null;
    this.mode = 'run';            // run | paused
  }

  reset(ir) {
    this.ir = ir;
    this.fps = ir.project.fps;
    this.time = 0;
    this.trace = [];
    this.vars.clear();
    this.stopAt = null;
  }

  /* 单步：前进一帧并返回求值结果 */
  step(ir, audio) {
    this.ir = ir;
    this.fps = ir.project.fps;
    this.time += 1 / this.fps;
    if (this.time > ir.project.duration) this.time = 0;
    return this.evaluate(ir, audio);
  }

  seek(t, ir, audio) {
    this.ir = ir;
    this.fps = ir.project.fps;
    this.time = t;
    return this.evaluate(ir, audio);
  }

  evaluate(ir, audio) {
    this.trace = [];
    this.vars.clear();
    this.stopAt = null;

    // 深度表：整棵树扫一遍，得到 id → 嵌套深度。
    // 原实现在 onBlock 里对**每执行一块**调 depthOf()，而 depthOf 会
    // 从图层列表开始重扫全树 —— 一块一次全树遍历，整帧就是
    // O(块数²)。大工程里单步调试因此明显发卡。
    const depthMap = buildDepthMap(ir);

    const dbg = this;
    const hooks = {
      onBlock(b, def, tNow) {
        dbg.trace.push({
          id: b.id, op: b.op, label: def ? def.label : b.op,
          depth: depthMap.has(b.id) ? depthMap.get(b.id) : 0, t: tNow,
          hit: dbg.breakpoints.has(b.id),
        });
        if (dbg.breakpoints.has(b.id)) {
          dbg.stopAt = b.id;
          dbg.lastHit = b.id;
        }
      },
      onVar(k, v) { dbg.vars.set(k, v); },
    };

    const res = evaluateFrame(ir, this.time, audio, hooks);
    this.probeValue = null;
    if (this.probe && res.state.layers[this.probe]) {
      const ls = res.state.layers[this.probe];
      this.probeValue = { name: ls.name, p: Object.assign({}, ls.p), visible: ls.visible, fx: Object.assign({}, ls.fx) };
    }
    res.traced = true;
    res.stoppedAt = this.stopAt;
    return res;
  }

  toggleBp(id) {
    if (this.breakpoints.has(id)) this.breakpoints.delete(id);
    else this.breakpoints.add(id);
    return this.breakpoints.has(id);
  }

  /* 当前帧命中到的第一个断点之后停止继续（返回是否应该暂停） */
  shouldPause() { return this.stopAt !== null; }

  stats() {
    return {
      time: this.time,
      frame: Math.round(this.time * this.fps),
      blocks: this.trace.length,
      maxDepth: this.trace.reduce((m, x) => Math.max(m, x.depth), 0),
      hits: this.trace.filter(x => x.hit).length,
    };
  }
}

/* 一次性建「积木 id → 嵌套深度」表。
   原来每块都要 depthOf() 全树重扫，整帧是 O(n²)；
   现在一次 O(n) 建表，之后每块 O(1) 查。 */
function buildDepthMap(ir) {
  const map = new Map();
  if (!ir || !ir.layers) return map;
  const walk = (list, d) => {
    for (const b of list || []) {
      if (!b) continue;
      if (!map.has(b.id)) map.set(b.id, d);
      if (b.slots) {
        for (const s of b.slots) {
          if (Array.isArray(s.value)) walk(s.value, d + 1);
        }
      }
    }
  };
  for (const l of ir.layers) walk(l.blocks, 0);
  return map;
}

/* 积木嵌套深度（按 id 查找路径）。保留给外部/兼容用；evaluate 内部已改用 depthMap。 */
function depthOf(dbg, id) {
  if (!dbg.ir) return 0;
  const layer = dbg.ir.layers.find(l => (l.blocks || []).some(b => b.id === id));
  if (!layer) {
    for (const l of dbg.ir.layers) {
      const d = findDepth(l.blocks, id, 0);
      if (d >= 0) return d;
    }
    return 0;
  }
  return findDepth(layer.blocks, id, 0);
}
function findDepth(list, id, d) {
  for (const b of list || []) {
    if (b.id === id) return d;
    if (b.slots) for (const s of b.slots) if (Array.isArray(s.value)) {
      const r = findDepth(s.value, id, d + 1);
      if (r >= 0) return r;
    }
  }
  return -1;
}
