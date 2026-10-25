/* ============================================================
   runtime.js · 可暂停 / 可恢复的积木解释器
   ------------------------------------------------------------
   旧 evaluator 每帧从 t=0 重跑全部积木，因此 wait 只能推进游标，
   变量、循环、广播、克隆都没有真正的时序状态。这里改成固定步长
   的线程解释器：

   · 每个图层顶层积木编译成线程；hat 积木待命，由事件唤醒。
   · 线程用显式帧栈保存位置，wait 后挂起、到点继续，不递归。
   · 旧视觉积木走 fxops 的 enter/sample：进入时登记描述符，
     之后每帧按时间采样，所以旧模板的绝对 start 仍然有效。
   · 变量 / 列表 / 对象 / 克隆 / 关键帧全部是运行时状态，
     seek 后退 = reset + 重放到目标帧，保证确定性。
   ============================================================ */

import {
  num, ease, clamp01, mixHex, buildUnits, parseData, evalExpr, DEFAULT_MAX_STEPS,
} from './evaluator.js';
import { defOf, HAT_OPS } from './blocks.js';
import { expandCustomBlocks } from './customblocks.js';
import { enterFx, applyFxDefs, resolveObject } from './fxops.js';

export const RUNTIME_MAX_STEPS = 20000;
export const MAX_THREADS = 500;
export const MAX_CLONES = 300;
const EPS = 1e-9;
const COLOR_PROPS = new Set(['fill', 'color', 'stroke', 'background']);
const BUILTIN_SOUND_DURATIONS = { beep: 0.18, click: 0.08, pop: 0.15, whoosh: 0.5 };

export function isHatOp(op) { return HAT_OPS.has(op); }

function normVarKey(k) {
  const s = String(k == null ? '' : k);
  return s.startsWith('$') ? s : '$' + s;
}
function truthy(v) { return !!v; }
function listName(v) { return String(v == null ? '' : v).replace(/^\$/, '').trim(); }
function subSlot(b) {
  if (!b || !b.slots) return [];
  for (const s of b.slots) if (Array.isArray(s.value)) return s.value;
  return [];
}
function findMarker(ir, name) {
  if (!ir.markers) return null;
  if (!name) return ir.markers[0] || null;
  return ir.markers.find(m => m.label === name || m.id === name) || null;
}

function fxDuration(d) {
  const start = d.start || 0;
  switch (d.op) {
    case 'fadeIn': case 'fadeOut': case 'moveIn': case 'scaleIn':
    case 'maskWipe': case 'pathSweep': case 'numberRoll': case 'charPopIn':
      return start + (d.dur || 0) + (d.gap && d.op === 'charPopIn' ? d.gap * 8 : 0);
    case 'setFill': return start + (d.dur || 0);
    case 'growBar': return start + (d.per || 0.5) + (d.gap || 0) * Math.max(0, (d.n || 1) - 1);
    case 'drawLine': return start + (d.dur || 0);
    case 'repeater': return start + (d.gap || 0) * Math.max(0, (d.n || 1) - 1) + 0.5;
    case 'particles': return start + (d.dur || 0);
    default: return start;
  }
}

class RuntimeObject {
  constructor(rt, layer, z) {
    this.rt = rt;
    this.id = layer.id;
    this.name = layer.name || layer.id;
    this.type = layer.type || 'rect';
    this.base = Object.assign({}, layer.props || {});
    this.p = Object.assign({}, this.base);
    this.baseVisible = !!layer.visible;
    this.visibleOverride = null;
    this.deleted = false;
    this.parentName = layer.parent || null;
    this.z = z;
    this.fxDefs = [];
    this.anims = [];
    this.localVars = new Map();
    this.effects = {};
    this.blend = layer.blend || 'source-over';
    this.clip = null;
    this.maskName = null;
    this.hats = [];
    this.blocks = (layer.blocks || []).slice();
    this.isClone = false;
    this.cloneOf = null;
    this.paths = [];
    this.formulas = [];
    this.physics = null;
    this.maskId = null;
    this.costume = null;
    this.sequence = null;
    this.lastState = null;
    this.commands = null;
  }
  get visible() {
    return this.visibleOverride == null ? this.baseVisible : !!this.visibleOverride;
  }
}

class Thread {
  constructor(rt, owner, kind, opts = {}) {
    this.rt = rt;
    this.id = rt.nextThreadId();
    this.owner = owner;
    this.kind = kind;
    this.frames = [];
    if (Array.isArray(opts.body) && opts.body.length) this.frames.push({ list: opts.body, ip: 0, loop: null });
    this.cursor = Math.max(0, opts.cursor || 0);
    this.lastEnd = this.cursor;
    this.state = this.frames.length ? 'run' : 'done';
    this.wakeAt = 0;
    this.yieldFrame = -1;
    this.waitExpr = null;
    this.deferred = null;
    this.parent = opts.parent || null;
    this.children = [];
    this.done = this.state === 'done';
  }

  halt() {
    this.frames = [];
    this.state = 'done';
    this.done = true;
  }

  push(list) {
    if (!list || !list.length) return;
    this.frames.push({ list, ip: 0, loop: null });
  }

  endFrame(f) {
    const loop = f.loop;
    if (loop) {
      if (loop.kind === 'count') {
        if (loop.left > 0) { loop.left--; f.ip = 0; return; }
      } else if (loop.kind === 'forever') {
        f.ip = 0;
        this.state = 'next';
        this.yieldFrame = this.rt.frame + 1;
        return;
      } else if (loop.kind === 'until') {
        this.rt.currentObject = this.owner;
        const ok = truthy(evalExpr(loop.cond, this.rt));
        if (!ok) {
          f.ip = 0;
          this.state = 'next';
          this.yieldFrame = this.rt.frame + 1;
          return;
        }
      }
    }
    this.frames.pop();
    if (!this.frames.length) { this.state = 'done'; this.done = true; }
  }

  runFrame() {
    const rt = this.rt;
    if (this.done || rt.stopped) { if (rt.stopped) this.halt(); return; }
    if (this.state === 'sleep') {
      if (rt.time + EPS < this.wakeAt) return;
      this.cursor = Math.max(this.cursor, this.wakeAt, rt.time);
      this.state = 'run';
      if (this.deferred) {
        const d = this.deferred;
        this.deferred = null;
        this.cursor = Math.max(this.cursor, d.at || 0);
        this.push(d.sub || []);
        if (!this.frames.length) { this.state = 'done'; this.done = true; return; }
      }
    } else if (this.state === 'cond') {
      rt.currentObject = this.owner;
      if (!truthy(evalExpr(this.waitExpr, rt))) return;
      this.waitExpr = null;
      this.cursor = Math.max(this.cursor, rt.time);
      this.state = 'run';
    } else if (this.state === 'join') {
      if (this.children.some(c => c && !c.done)) return;
      this.children = [];
      this.cursor = Math.max(this.cursor, rt.time);
      this.state = 'run';
    } else if (this.state === 'next') {
      if (rt.frame < this.yieldFrame) return;
      this.state = 'run';
    }
    if (this.state !== 'run') return;

    rt.currentObject = this.owner;
    let guard = 0;
    while (this.state === 'run' && !this.done) {
      if (rt.budgetStop) return;
      const f = this.frames[this.frames.length - 1];
      if (!f) { this.done = true; this.state = 'done'; return; }
      if (f.ip >= f.list.length) { this.endFrame(f); continue; }
      const b = f.list[f.ip++];
      if (!b) continue;
      this.exec(b);
      if (++guard > RUNTIME_MAX_STEPS * 4) {
        rt.failBudget(`线程 ${this.id} 单帧步数过多`);
        this.halt();
        return;
      }
    }
  }

  exec(b) {
    const rt = this.rt;
    const op = b.op;
    const def = defOf(op);
    if (!rt.tickStep()) { this.halt(); return; }
    if (rt.hooks.onBlock) rt.hooks.onBlock(b, def, rt.time, this.cursor);

    const S = (i) => (b.slots && b.slots[i] ? b.slots[i].value : undefined);
    const E = (i) => evalExpr(S(i), rt);
    const owner = this.owner;
    const now = () => Math.max(rt.time, this.cursor);

    switch (op) {
      /* ---------------- 时间 / 控制 ---------------- */
      case 'wait': {
        const d = Math.max(0, num(E(0), 0));
        const base = now();
        this.cursor = base;
        if (d <= EPS) {
          this.state = 'next';
          this.yieldFrame = rt.frame + 1;
        } else {
          this.state = 'sleep';
          this.wakeAt = base + d;
        }
        return;
      }
      case 'waitUntilTime': {
        const at = Math.max(0, num(E(0), 0));
        const base = now();
        if (at <= base + EPS) { this.cursor = Math.max(this.cursor, at); return; }
        this.state = 'sleep';
        this.wakeAt = at;
        return;
      }
      case 'waitUntilMarker': {
        const m = findMarker(rt.ir, String(E(0) ?? ''));
        if (!m) return;
        if (m.time <= rt.time + EPS) return;
        this.state = 'sleep';
        this.wakeAt = m.time;
        return;
      }
      case 'waitUntil': {
        this.waitExpr = S(0);
        if (truthy(evalExpr(this.waitExpr, rt))) { this.cursor = Math.max(this.cursor, rt.time); return; }
        this.state = 'cond';
        return;
      }
      case 'setAt': {
        const at = Math.max(0, num(E(0), 0));
        const sub = subSlot(b);
        if (at > now() + EPS) {
          this.state = 'sleep';
          this.wakeAt = at;
          this.deferred = { at, sub };
        } else {
          this.cursor = Math.max(now(), at);
          this.push(sub);
        }
        return;
      }
      case 'atMarker': {
        const m = findMarker(rt.ir, String(E(0) ?? ''));
        const at = m ? m.time : now();
        const sub = subSlot(b);
        if (at > now() + EPS) {
          this.state = 'sleep';
          this.wakeAt = at;
          this.deferred = { at, sub };
        } else {
          this.cursor = Math.max(now(), at);
          this.push(sub);
        }
        return;
      }
      case 'after': {
        const d = Math.max(0, num(E(0), 0));
        const at = Math.max(now(), this.lastEnd) + d;
        const sub = subSlot(b);
        if (at > now() + EPS) {
          this.state = 'sleep';
          this.wakeAt = at;
          this.deferred = { at, sub };
        } else {
          this.cursor = at;
          this.push(sub);
          if (!this.frames.length && sub.length === 0) this.cursor = at;
        }
        return;
      }
      case 'loop': {
        const n = Math.max(0, Math.min(500, Math.round(num(E(0), 1))));
        if (n <= 0) return;
        this.frames.push({ list: subSlot(b), ip: 0, loop: { kind: 'count', left: n - 1 } });
        return;
      }
      case 'repeatUntil': {
        this.frames.push({ list: subSlot(b), ip: 0, loop: { kind: 'until', cond: S(0) } });
        return;
      }
      case 'forever': {
        this.frames.push({ list: subSlot(b), ip: 0, loop: { kind: 'forever' } });
        return;
      }
      case 'parallel': {
        const curs = now();
        this.cursor = curs;
        const kids = [];
        for (const s of b.slots || []) {
          if (!Array.isArray(s.value) || !s.value.length) continue;
          const child = rt.spawnThread(owner, 'parallel', { body: s.value, cursor: curs, parent: this });
          if (child) kids.push(child);
        }
        if (!kids.length) return;
        this.children = kids;
        this.state = 'join';
        return;
      }
      case 'if': {
        const cond = truthy(E(0));
        this.push(subSlotAt(b, cond ? 0 : 1));
        return;
      }
      case 'stop': {
        const mode = String(E(0) ?? 'this');
        if (mode === 'all') rt.stopAll();
        else if (mode === 'other') rt.stopOthers(this);
        else this.halt();
        return;
      }
      case 'broadcast': {
        const msg = String(E(0) ?? '');
        if (msg) rt.pendingBroadcasts.push({ msg, at: rt.frame + 1, sender: owner });
        return;
      }
      case 'broadcastWait': {
        const msg = String(E(0) ?? '');
        if (!msg) return;
        const kids = rt.spawnReceivers(msg, owner);
        if (!kids.length) return;
        this.children = kids;
        this.state = 'join';
        return;
      }

      /* ---------------- 变量 / 列表 ---------------- */
      case 'setVar': {
        const name = String(E(0) ?? '').trim();
        if (!name) return;
        const scope = b.slots && b.slots[2] ? String(E(2) ?? 'global') : 'global';
        rt.setVar(name, evalExpr(S(1), rt), scope, owner);
        return;
      }
      case 'changeVar': {
        const name = String(E(0) ?? '').trim();
        if (!name) return;
        const scope = b.slots && b.slots[2] ? String(E(2) ?? 'global') : 'global';
        const cur = num(rt.getVar(name), 0);
        rt.setVar(name, cur + num(E(1), 0), scope, owner);
        return;
      }
      case 'listCreate': {
        const name = listName(E(0));
        if (!name) return;
        rt.lists.set(name, []);
        return;
      }
      case 'listAdd': {
        const name = listName(E(0));
        if (!name) return;
        const arr = rt.getList(name);
        arr.push(String(E(1) ?? ''));
        rt.lists.set(name, arr);
        return;
      }
      case 'listDelete': {
        const arr = rt.getList(listName(E(0)));
        const i = Math.round(num(E(1), 1)) - 1;
        if (i >= 0 && i < arr.length) arr.splice(i, 1);
        return;
      }
      case 'listInsert': {
        const arr = rt.getList(listName(E(0)));
        const i = Math.max(0, Math.min(arr.length, Math.round(num(E(1), 1)) - 1));
        arr.splice(i, 0, String(E(2) ?? ''));
        return;
      }
      case 'listSet': {
        const arr = rt.getList(listName(E(0)));
        const i = Math.round(num(E(1), 1)) - 1;
        if (i >= 0 && i < arr.length) arr[i] = String(E(2) ?? '');
        return;
      }
      case 'listClear': {
        rt.lists.set(listName(E(0)), []);
        return;
      }

      /* ---------------- 对象 / 舞台 ---------------- */
      case 'createObject': {
        rt.createObject({
          name: String(E(0) ?? '') || `对象${rt.objects.size + 1}`,
          type: String(E(1) ?? 'rect'),
          x: num(E(2), rt.stage.width / 2),
          y: num(E(3), rt.stage.height / 2),
        });
        return;
      }
      case 'deleteObject': {
        const o = resolveObject(rt, E(0), owner);
        if (o) rt.deleteObject(o);
        return;
      }
      case 'showObject': {
        const o = resolveObject(rt, E(0), owner);
        if (o) o.visibleOverride = true;
        return;
      }
      case 'hideObject': {
        const o = resolveObject(rt, E(0), owner);
        if (o) o.visibleOverride = false;
        return;
      }
      case 'cloneObject': {
        const o = resolveObject(rt, E(0), owner);
        if (o) rt.cloneObject(o);
        return;
      }
      case 'bringToFront': {
        const o = resolveObject(rt, E(0), owner);
        if (o) rt.reorder(o, 'front');
        return;
      }
      case 'sendToBack': {
        const o = resolveObject(rt, E(0), owner);
        if (o) rt.reorder(o, 'back');
        return;
      }
      case 'goForward': {
        const o = resolveObject(rt, E(0), owner);
        if (o) rt.reorder(o, 'forward');
        return;
      }
      case 'goBackward': {
        const o = resolveObject(rt, E(0), owner);
        if (o) rt.reorder(o, 'backward');
        return;
      }
      case 'setParent': {
        const o = resolveObject(rt, E(0), owner);
        const p = resolveObject(rt, E(1), null);
        if (o) o.parentName = p && p !== o ? p.name : null;
        return;
      }
      case 'switchBackdrop': {
        const v = String(E(0) ?? '');
        if (v) rt.stage.background = v;
        return;
      }
      case 'setStageSize': {
        rt.stage.width = Math.max(16, Math.round(num(E(0), rt.stage.width)));
        rt.stage.height = Math.max(16, Math.round(num(E(1), rt.stage.height)));
        return;
      }
      case 'setStageFps': {
        rt.stage.fps = Math.max(1, Math.min(120, Math.round(num(E(0), rt.fps))));
        return;
      }
      case 'setDuration': {
        rt.stage.duration = Math.max(0.1, num(E(0), rt.stage.duration));
        return;
      }

      /* ---------------- 运动 ---------------- */
      case 'setPosition': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        o.p.x = num(E(1), o.p.x || 0);
        o.p.y = num(E(2), o.p.y || 0);
        return;
      }
      case 'changeX': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        o.p.x = num(o.p.x, 0) + num(E(1), 0);
        return;
      }
      case 'changeY': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        o.p.y = num(o.p.y, 0) + num(E(1), 0);
        return;
      }
      case 'setSize': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        const k = Math.max(0, num(E(1), 100)) / 100;
        o.p.scaleX = k; o.p.scaleY = k;
        return;
      }
      case 'setDirection': {
        const o = resolveObject(rt, E(0), owner);
        if (o) o.p.direction = num(E(1), 90);
        return;
      }
      case 'rotateBy': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        o.p.rotation = num(o.p.rotation, 0) + num(E(1), 0);
        return;
      }
      case 'setOpacity': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        o.p.opacity = clamp01(num(E(1), 100) / 100);
        return;
      }
      case 'glideTo': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        const dur = Math.max(0, num(E(3), 1));
        const ez = String(E(4) ?? 'inOutQuad');
        const tx = num(E(1), o.p.x || 0), ty = num(E(2), o.p.y || 0);
        if (dur <= 0) { o.p.x = tx; o.p.y = ty; return; }
        rt.addTween(o, 'x', o.p.x || 0, tx, dur, ez);
        rt.addTween(o, 'y', o.p.y || 0, ty, dur, ez);
        return;
      }
      case 'moveSteps': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        const steps = num(E(1), 10);
        const dir = num(o.p.direction, 90);
        const rad = (dir - 90) * Math.PI / 180;
        o.p.x = num(o.p.x, 0) + Math.sin(rad) * steps;
        o.p.y = num(o.p.y, 0) - Math.cos(rad) * steps;
        return;
      }
      case 'pointTowards': {
        const o = resolveObject(rt, E(0), owner);
        const t = resolveObject(rt, E(1), null);
        if (!o || !t) return;
        const dx = num(t.p.x, 0) - num(o.p.x, 0);
        const dy = num(t.p.y, 0) - num(o.p.y, 0);
        o.p.direction = Math.atan2(dx, -dy) * 180 / Math.PI;
        return;
      }
      case 'bounceOffEdge': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        const hw = Math.max(1, num(o.p.w, 100)) / 2;
        const hh = Math.max(1, num(o.p.h, 100)) / 2;
        let dir = num(o.p.direction, 90);
        let x = num(o.p.x, 0), y = num(o.p.y, 0);
        if (x - hw < 0) { x = hw; dir = -dir; }
        if (x + hw > rt.stage.width) { x = rt.stage.width - hw; dir = -dir; }
        if (y - hh < 0) { y = hh; dir = 180 - dir; }
        if (y + hh > rt.stage.height) { y = rt.stage.height - hh; dir = 180 - dir; }
        o.p.x = x; o.p.y = y; o.p.direction = dir;
        return;
      }
      case 'moveAlongPath': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        const pts = parsePathPoints(String(E(1) ?? ''));
        if (pts.length < 2) return;
        o.paths.push({
          points: pts,
          start: now(),
          dur: Math.max(0.001, num(E(2), 1)),
        });
        return;
      }
      case 'formulaMove': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        o.formulas.push({
          mode: String(E(1) ?? 'sine'),
          ax: num(E(2), 200),
          ay: num(E(3), 100),
          period: Math.max(0.01, num(E(4), 2)),
          start: atTime(now(), E(5)),
        });
        return;
      }
      case 'physicsMove': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        o.physics = {
          vx: num(E(1), 200),
          vy: num(E(2), -300),
          gravity: num(E(3), 600),
          bounce: Math.max(0, Math.min(1, num(E(4), 0.8))),
          friction: Math.max(0, num(E(5), 0)),
        };
        return;
      }

      /* ---------------- 关键帧 / 补间 ---------------- */
      case 'setKeyframe': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        const prop = String(E(1) ?? 'opacity');
        rt.setKeyframe(o, prop, num(E(2), 0), E(3));
        return;
      }
      case 'setKeyframeColor': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        rt.setKeyframe(o, 'fill', num(E(2), 0), String(E(1) ?? '#ffffff'));
        return;
      }
      case 'tweenProp': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        const prop = String(E(1) ?? 'opacity');
        const fromRaw = String(E(2) ?? '');
        const from = fromRaw === '' ? num(o.p[prop], 0) : num(E(2), 0);
        const to = num(E(3), from);
        const dur = Math.max(0, num(E(4), 1));
        rt.addTween(o, prop, from, to, dur, easingName(E(5), b, 6, E, num));
        return;
      }
      case 'tweenColor': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        const from = String(E(1) ?? o.p.fill ?? '#ffffff');
        const to = String(E(2) ?? '#ffffff');
        const dur = Math.max(0, num(E(3), 1));
        rt.addTween(o, 'fill', from, to, dur, easingName(E(4), b, 5, E, num), true);
        return;
      }

      /* ---------------- 外观（M4 渲染器消费） ---------------- */
      case 'setColorEffect': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        const k = String(E(1) ?? 'color');
        o.effects[k] = num(E(2), 0);
        return;
      }
      case 'changeColorEffect': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        const k = String(E(1) ?? 'color');
        o.effects[k] = (o.effects[k] || 0) + num(E(2), 0);
        return;
      }
      case 'setBrightness': case 'setSaturation': case 'setContrast': case 'setBlur': case 'addGlow': case 'addShadow': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        if (op === 'setBrightness') o.effects.brightness = num(E(1), 100);
        else if (op === 'setSaturation') o.effects.saturation = num(E(1), 100);
        else if (op === 'setContrast') o.effects.contrast = num(E(1), 100);
        else if (op === 'setBlur') o.effects.blur = Math.max(0, num(E(1), 0));
        else if (op === 'addGlow') {
          o.effects.glow = Math.max(0, num(E(1), 0));
          if (b.slots[2]) o.effects.glowColor = String(E(2) ?? '#4a8cff');
        } else {
          o.effects.shadow = Math.max(0, num(E(1), 0));
          if (b.slots[2]) o.effects.shadowColor = String(E(2) ?? '#00000080');
        }
        return;
      }
      case 'clearEffects': {
        const o = resolveObject(rt, E(0), owner);
        if (o) o.effects = {};
        return;
      }
      case 'setBlendMode': {
        const o = resolveObject(rt, E(0), owner);
        if (o) o.blend = String(E(1) ?? 'source-over');
        return;
      }
      case 'setClipRect': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        const w = Math.max(0, num(E(3), 0)), h = Math.max(0, num(E(4), 0));
        o.clip = w > 0 && h > 0 ? { x: num(E(1), 0), y: num(E(2), 0), w, h } : null;
        return;
      }
      case 'maskWith': {
        const o = resolveObject(rt, E(0), owner);
        const mask = resolveObject(rt, E(1), null);
        if (o) o.maskId = mask && mask !== o ? mask.id : null;
        return;
      }
      case 'switchCostume': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        o.costume = String(E(1) ?? '');
        if (o.type === 'sprite' || o.type === 'image') o.p.src = o.costume;
        return;
      }
      case 'playSequence': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        const name = listName(E(1));
        const arr = rt.getList(name);
        if (!arr.length) {
          rt.log('warn', `序列列表「${name}」为空或不存在`);
          return;
        }
        o.sequence = { list: name, fps: Math.max(0.1, num(E(2), 12)), start: rt.time };
        return;
      }

      /* ---------------- 声音 ---------------- */
      case 'playSound': case 'playSoundWait': {
        const name = String(E(0) ?? 'beep');
        const vol = Math.max(0, Math.min(100, num(E(1), 100)));
        const cue = rt.playSound(name, vol);
        if (op === 'playSoundWait') {
          const d = rt.soundDuration(name);
          if (d > 0) {
            this.cursor = now();
            this.state = 'sleep';
            this.wakeAt = this.cursor + d;
          }
        }
        void cue;
        return;
      }
      case 'stopAllSounds': {
        if (rt.sound && rt.sound.stopAll) rt.sound.stopAll();
        rt.soundSchedules = [];
        return;
      }
      case 'setVolume': {
        rt.soundVolume = Math.max(0, Math.min(100, num(E(0), 100)));
        if (rt.sound && rt.sound.setVolume) rt.sound.setVolume(rt.soundVolume);
        return;
      }
      case 'triggerSoundAt': {
        const name = String(E(0) ?? 'click');
        const at = Math.max(0, num(E(1), 0));
        const vol = Math.max(0, Math.min(100, num(E(2), 100)));
        if (at <= rt.time + EPS) rt.playSound(name, vol);
        else rt.soundSchedules.push({ name, volume: vol, at });
        return;
      }
      case 'setTextStyle': {
        const o = resolveObject(rt, E(0), owner);
        if (!o) return;
        o.p.fontSize = Math.max(1, num(E(1), o.p.fontSize || 96));
        o.p.fill = String(E(2) ?? o.p.fill ?? '#ffffff');
        if (b.slots[3]) o.p.fontWeight = Math.max(100, Math.min(900, num(E(3), o.p.fontWeight || 700)));
        return;
      }

      default: {
        /* 旧视觉 / 文字 / 数据积木：进入时登记描述符，之后每帧采样 */
        const entered = enterFx(rt, owner, b, S, E, now());
        if (entered) {
          const defs = owner.fxDefs;
          const last = defs[defs.length - 1];
          if (last) this.lastEnd = Math.max(this.lastEnd, fxDuration(last));
          return;
        }
        rt.unknownOps.add(op);
        if (!rt.unknownOpWarned.has(op)) {
          rt.unknownOpWarned.add(op);
          rt.log('warn', `未实现的积木已跳过：${op}`);
        }
        return;
      }
    }
  }
}

function subSlotAt(b, index) {
  const subs = (b.slots || []).filter(s => Array.isArray(s.value));
  return subs[index] ? subs[index].value : [];
}

export class Runtime {
  constructor(ir, audio, opts = {}) {
    this.ir = ir;
    this.audio = audio || null;
    this.hooks = opts.hooks || {};
    this.sound = opts.sound || this.hooks.sound || null;
    this.fps = (ir.project && ir.project.fps) > 0 ? ir.project.fps : 24;
    this.stepBudget = Number.isFinite(this.hooks.maxSteps) && this.hooks.maxSteps > 0
      ? this.hooks.maxSteps : RUNTIME_MAX_STEPS;
    this.stage = {};
    this.reset();
  }

  /* ---------- 生命周期 ---------- */
  reset() {
    const ir = this.ir;
    this.fps = (ir.project && ir.project.fps) > 0 ? ir.project.fps : 24;
    this.stage = {
      width: (ir.project && ir.project.width) || 1920,
      height: (ir.project && ir.project.height) || 1080,
      fps: this.fps,
      duration: (ir.project && ir.project.duration) || 6,
      background: (ir.project && ir.project.background) || '#000000',
    };
    this.frame = -1;
    this.time = 0;
    this.t = 0;
    this.prevTime = -1;
    this.stopped = false;
    this.steps = 0;
    this.totalSteps = 0;
    this.budgetExceeded = false;
    this.budgetStop = false;
    this.unknownOps = new Set();
    this.unknownOpWarned = new Set();
    this.logs = [];
    this.vars = new Map();
    this.lists = new Map();
    this.currentObject = null;
    this.objects = new Map();
    this.order = [];
    this.threads = [];
    this.hats = [];
    this.pendingBroadcasts = [];
    this.inputQueue = [];
    this.soundCues = [];
    this.soundSchedules = [];
    this.soundVolume = 100;
    this.tracks = new Map();
    this._threadSeq = 0;
    this._objectSeq = 0;
    this._cloneCount = 0;

    for (const v of ir.variables || []) {
      if (!v || !v.name) continue;
      if (v.type === 'list' || Array.isArray(v.value)) {
        this.lists.set(listName(v.name), Array.isArray(v.value) ? v.value.map(x => String(x)) : []);
      } else {
        this.vars.set(normVarKey(v.name), v.value === undefined ? '' : v.value);
      }
    }
    this._updateBuiltins();

    const lib = ir.customLibrary || this.hooks.customLibrary || null;
    ir.layers.forEach((layer, i) => {
      const obj = new RuntimeObject(this, layer, i);
      this.objects.set(obj.id, obj);
      this.order.push(obj.id);
      let blocks = layer.blocks || [];
      if (lib && lib.size) {
        try {
          blocks = expandCustomBlocks(blocks, lib, { maxDepth: 16 }).blocks;
        } catch (e) {
          if (this.hooks.onCustomBlockError) this.hooks.onCustomBlockError(layer, e);
          this.log('warn', `${layer.name || layer.id}：自定义积木出错 · ${e.message}`);
          blocks = [];
        }
      }
      this._compile(obj, blocks, false);
    });
    this.currentObject = null;
  }

  _compile(obj, blocks, isClone) {
    let run = [];
    const flush = () => {
      if (!run.length) return;
      // 克隆体只跑 whenClone，不重新执行源图层的普通脚本
      if (!isClone) this.spawnThread(obj, 'implicit', { body: run, cursor: 0 });
      run = [];
    };
    for (const b of blocks || []) {
      if (!b) continue;
      if (isHatOp(b.op)) {
        flush();
        const hat = {
          type: b.op, owner: obj, block: b, body: subSlot(b),
          fired: false, lastTime: -Infinity,
        };
        obj.hats.push(hat);
        this.hats.push(hat);
      } else {
        run.push(b);
      }
    }
    flush();
    if (isClone) {
      for (const hat of obj.hats) {
        if (hat.type === 'whenClone') this._spawnHat(hat, { cursor: this.time });
      }
    }
  }

  _updateBuiltins() {
    this.vars.set('$time', this.time);
    this.vars.set('$frame', Math.max(0, this.frame));
    const dur = this.stage.duration || 0;
    this.vars.set('$progress', dur > 0 ? clamp01(this.time / dur) : 0);
    this.t = this.time;
  }

  nextThreadId() { return ++this._threadSeq; }

  get ctx() { return this; }

  /* ---------- 时间推进 ---------- */
  advanceTo(t) {
    const target = Math.max(0, Math.round((Number(t) || 0) * this.fps));
    if (target < this.frame) this.reset();
    while (this.frame < target) this.advanceFrame();
    if (this.frame < 0) this.advanceFrame();
    return this.compose();
  }

  seek(t) { return this.advanceTo(t); }

  advanceFrame() {
    this.prevTime = this.time;
    this.frame += 1;
    this.time = this.frame / this.fps;
    this.steps = 0;
    this.budgetExceeded = false;
    this.budgetStop = false;
    this._updateBuiltins();
    // 先积分上一帧配置的物理状态，再执行本帧积木：
    // 第 0 帧设置的速度从第 1 帧开始生效，seek 重放与顺序播放一致。
    this._stepPhysics();

    for (const obj of this.objects.values()) {
      obj.lastState = null;
      // 每帧重建一次效果临时层；描述符本身留在 fxDefs 里
      obj.commands = null;
    }

    if (!this.stopped) {
      this._dispatchBroadcasts();
      this._fireSoundSchedules();
      this._fireStartHats();
      this._fireAtHats();
      this._processInputs();
      for (let i = 0; i < this.threads.length; i++) {
        if (this.budgetStop) break;
        const th = this.threads[i];
        if (th && !th.done) th.runFrame();
      }
      this.currentObject = null;
    }
    this._renderStates();
    this._cleanupThreads();
  }

  /* 固定步长积分：位置/速度只取决于帧序号，seek 重放一致。 */
  _stepPhysics() {
    const dt = 1 / this.fps;
    for (const obj of this.objects.values()) {
      const ph = obj.physics;
      if (!ph || obj.deleted) continue;
      if (!ph.vx && !ph.vy && !ph.gravity) continue;
      ph.vy += ph.gravity * dt;
      if (ph.friction > 0) {
        const damp = Math.exp(-ph.friction * dt);
        ph.vx *= damp;
        ph.vy *= damp;
      }
      let x = num(obj.p.x, 0) + ph.vx * dt;
      let y = num(obj.p.y, 0) + ph.vy * dt;
      const hw = Math.max(0, num(obj.p.w, 0)) / 2;
      const hh = Math.max(0, num(obj.p.h, 0)) / 2;
      if (x - hw < 0) { x = hw; if (ph.vx < 0) ph.vx = -ph.vx * ph.bounce; }
      else if (x + hw > this.stage.width) { x = this.stage.width - hw; if (ph.vx > 0) ph.vx = -ph.vx * ph.bounce; }
      if (y - hh < 0) { y = hh; if (ph.vy < 0) ph.vy = -ph.vy * ph.bounce; }
      else if (y + hh > this.stage.height) { y = this.stage.height - hh; if (ph.vy > 0) ph.vy = -ph.vy * ph.bounce; }
      obj.p.x = x;
      obj.p.y = y;
    }
  }

  _cleanupThreads() {
    if (this.threads.length > 120) this.threads = this.threads.filter(t => !t.done);
  }

  tickStep() {
    if (this.steps >= this.stepBudget) {
      this.failBudget('本帧积木步数超出预算');
      return false;
    }
    this.steps++;
    this.totalSteps++;
    return true;
  }

  failBudget(msg) {
    if (!this.budgetExceeded) this.log('warn', `${msg}（上限 ${this.stepBudget} 步）`);
    this.budgetExceeded = true;
    this.budgetStop = true;
  }

  hasBudget() { return this.steps < this.stepBudget || (this.failBudget('本帧积木步数超出预算'), false); }

  log(level, msg) {
    const item = { level, msg, frame: Math.max(0, this.frame), time: this.time };
    this.logs.push(item);
    if (this.logs.length > 200) this.logs.shift();
    if (this.hooks.onLog) this.hooks.onLog(level, msg);
    return item;
  }

  /* ---------- 线程 / 事件 ---------- */
  spawnThread(owner, kind, opts = {}) {
    const live = this.threads.filter(t => !t.done).length;
    if (live >= MAX_THREADS) {
      this.log('warn', `线程数超过上限 ${MAX_THREADS}，已忽略新线程`);
      return null;
    }
    const th = new Thread(this, owner, kind, opts);
    this.threads.push(th);
    return th;
  }

  _spawnHat(hat, opts = {}) {
    if (!hat || !hat.owner || hat.owner.deleted) return null;
    return this.spawnThread(hat.owner, hat.type, {
      body: hat.body, cursor: opts.cursor == null ? this.time : opts.cursor,
    });
  }

  _fireStartHats() {
    if (this.frame !== 0) return;
    for (const hat of this.hats) {
      if (hat.type !== 'whenStart' || hat.fired) continue;
      hat.fired = true;
      this._spawnHat(hat, { cursor: 0 });
    }
  }

  _fireAtHats() {
    for (const hat of this.hats) {
      if (hat.type !== 'whenAt' || hat.fired || !hat.owner || hat.owner.deleted) continue;
      const b = hat.block;
      const S = (i) => (b.slots && b.slots[i] ? b.slots[i].value : undefined);
      this.currentObject = hat.owner;
      const raw = num(evalExpr(S(0), this), 0);
      const mode = String(evalExpr(S(1), this) ?? 'time');
      this.currentObject = null;
      const target = mode === 'progress' ? raw * (this.stage.duration || 0) : raw;
      const prev = hat.lastTime === -Infinity ? -EPS : hat.lastTime;
      if (this.time + EPS >= target && (target > prev + EPS || (target <= 0 && !hat.fired))) {
        hat.fired = true;
        this._spawnHat(hat, { cursor: this.time });
      }
      hat.lastTime = this.time;
    }
  }

  _dispatchBroadcasts() {
    if (!this.pendingBroadcasts.length) return;
    const due = [];
    const rest = [];
    for (const m of this.pendingBroadcasts) {
      if (m.at <= this.frame) due.push(m); else rest.push(m);
    }
    this.pendingBroadcasts = rest;
    for (const m of due) this.spawnReceivers(m.msg, m.sender);
  }

  spawnReceivers(msg, sender) {
    const out = [];
    for (const hat of this.hats.slice()) {
      if (hat.type !== 'whenReceive' || !hat.owner || hat.owner.deleted) continue;
      const S = (i) => (hat.block.slots && hat.block.slots[i] ? hat.block.slots[i].value : undefined);
      this.currentObject = hat.owner;
      const want = String(evalExpr(S(0), this) ?? '');
      this.currentObject = null;
      if (want !== msg) continue;
      const th = this._spawnHat(hat, { cursor: this.time });
      if (th) out.push(th);
    }
    void sender;
    return out;
  }

  _processInputs() {
    if (!this.inputQueue.length) return;
    const q = this.inputQueue;
    this.inputQueue = [];
    for (const evt of q) {
      for (const hat of this.hats.slice()) {
        if (!hat.owner || hat.owner.deleted) continue;
        const b = hat.block;
        const S = (i) => (b.slots && b.slots[i] ? b.slots[i].value : undefined);
        if (hat.type === 'whenKey' && evt.kind === 'key') {
          this.currentObject = hat.owner;
          const want = String(evalExpr(S(0), this) ?? '').toLowerCase();
          this.currentObject = null;
          // 菜单里写的是 space，而 KeyboardEvent.key 给的是 " "
          const raw = String(evt.key || '').toLowerCase();
          const key = raw === ' ' || raw === 'spacebar' ? 'space' : raw;
          if (want && want !== 'any' && want !== key) continue;
          this._spawnHat(hat, { cursor: this.time });
        } else if (hat.type === 'whenClicked' && evt.kind === 'click') {
          if (evt.objId && evt.objId !== hat.owner.id) continue;
          if (!evt.objId && evt.x != null) {
            const hit = this.hitTest(evt.x, evt.y);
            if (hit !== hat.owner) continue;
          }
          this._spawnHat(hat, { cursor: this.time });
        }
      }
    }
  }

  pushInput(evt) {
    if (!evt || !evt.kind) return;
    this.inputQueue.push(evt);
  }

  hitTest(x, y) {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const obj = this.objects.get(this.order[i]);
      if (!obj || obj.deleted || !obj.visible) continue;
      const p = obj.p;
      const st = obj.lastState;
      const s = st ? st.p : p;
      if (obj.type === 'text') {
        const size = num(s.fontSize, 96);
        const w = Math.max(120, String(s.text || '').length * size * 0.6);
        const h = size * 1.6;
        if (Math.abs(x - num(s.x, 0)) <= w / 2 && Math.abs(y - num(s.y, 0)) <= h / 2) return obj;
      } else {
        const w = num(s.w, 100), h = num(s.h, 100);
        if (Math.abs(x - num(s.x, 0)) <= w / 2 && Math.abs(y - num(s.y, 0)) <= h / 2) return obj;
      }
    }
    return null;
  }

  stopAll() {
    this.stopped = true;
    for (const th of this.threads) if (!th.done) th.halt();
  }

  stopOthers(keep) {
    for (const th of this.threads) if (th !== keep && !th.done) th.halt();
  }

  /* ---------- 声音 ---------- */
  playSound(name, volume = 100) {
    const cue = { name: String(name || ''), at: this.time, frame: Math.max(0, this.frame), volume };
    this.soundCues.push(cue);
    if (this.soundCues.length > 500) this.soundCues.shift();
    if (this.sound && this.sound.play) {
      try { this.sound.play(cue.name, (volume / 100) * (this.soundVolume / 100)); } catch { /* 播放器异常不应中断求值 */ }
    }
    return cue;
  }

  soundDuration(name) {
    if (this.sound && this.sound.duration) {
      const d = Number(this.sound.duration(name));
      if (isFinite(d) && d > 0) return d;
    }
    return BUILTIN_SOUND_DURATIONS[name] || 0.2;
  }

  _fireSoundSchedules() {
    if (!this.soundSchedules.length) return;
    const due = [];
    const rest = [];
    for (const s of this.soundSchedules) {
      if (s.at <= this.time + EPS) due.push(s); else rest.push(s);
    }
    this.soundSchedules = rest;
    for (const s of due) this.playSound(s.name, s.volume);
  }

  /* ---------- 对象 ---------- */
  findObject(sel) {
    if (sel === undefined || sel === null || sel === '') return null;
    const s = String(sel);
    if (s === '@current') return this.currentObject || null;
    for (const obj of this.objects.values()) {
      if (!obj.deleted && obj.name === s) return obj;
    }
    const byId = this.objects.get(s);
    return byId && !byId.deleted ? byId : null;
  }

  _defaultObjectProps(type, x, y) {
    const base = {
      text: { x, y, text: '新文字', fontSize: 96, fontWeight: 700, fill: '#ffffff', align: 'center', letterSpacing: 0, lineHeight: 1.25, shadow: 0, opacity: 1, rotation: 0 },
      image: { x, y, src: '', w: 400, h: 400, radius: 0, opacity: 1, rotation: 0 },
      circle: { x, y, w: 200, h: 200, fill: '#4c97ff', stroke: '', strokeWidth: 0, opacity: 1, rotation: 0 },
      rect: { x, y, w: 300, h: 200, radius: 0, fill: '#4a8cff', stroke: '', strokeWidth: 0, opacity: 1, rotation: 0 },
    };
    return Object.assign({}, base[type] || base.rect);
  }

  createObject(spec = {}) {
    const type = String(spec.type || 'rect');
    const x = spec.x == null ? this.stage.width / 2 : spec.x;
    const y = spec.y == null ? this.stage.height / 2 : spec.y;
    const id = `R${this.frame}_${++this._objectSeq}`;
    const layer = {
      id,
      name: String(spec.name || `对象${this._objectSeq}`),
      type,
      visible: true,
      props: Object.assign(this._defaultObjectProps(type, x, y), spec.props || {}),
      blocks: [],
      parent: spec.parent || null,
    };
    const obj = new RuntimeObject(this, layer, this.order.length);
    obj.isRuntime = true;
    this.objects.set(id, obj);
    this.order.push(id);
    return obj;
  }

  cloneObject(source) {
    if (!source || source.deleted) return null;
    if (this._cloneCount >= MAX_CLONES) {
      this.log('warn', `克隆数超过上限 ${MAX_CLONES}，已忽略`);
      return null;
    }
    this._cloneCount++;
    const id = `C${this.frame}_${this._objectSeq++}`;
    const obj = new RuntimeObject(this, {
      id,
      name: source.name,
      type: source.type,
      visible: source.visible,
      props: Object.assign({}, source.base),
      blocks: source.blocks,
      parent: source.parentName,
    }, this.order.length);
    obj.base = Object.assign({}, source.base);
    obj.p = Object.assign({}, source.p);
    obj.baseVisible = true;
    obj.visibleOverride = true;
    obj.localVars = new Map(source.localVars);
    obj.isClone = true;
    obj.cloneOf = source.id;
    this.objects.set(id, obj);
    this.order.push(id);
    this._compile(obj, source.blocks, true);
    return obj;
  }

  deleteObject(obj) {
    if (!obj || obj.deleted) return;
    obj.deleted = true;
    this.order = this.order.filter(id => id !== obj.id);
    for (const o of this.objects.values()) {
      if (o.parentName === obj.name) o.parentName = null;
    }
    this.hats = this.hats.filter(h => h.owner !== obj);
    for (const th of this.threads) if (th.owner === obj) th.halt();
  }

  reorder(obj, mode) {
    if (!obj || obj.deleted) return;
    let i = this.order.indexOf(obj.id);
    if (i < 0) return;
    this.order.splice(i, 1);
    if (mode === 'front') this.order.push(obj.id);
    else if (mode === 'back') this.order.unshift(obj.id);
    else if (mode === 'forward') this.order.splice(Math.min(this.order.length, i + 1), 0, obj.id);
    else this.order.splice(Math.max(0, i - 1), 0, obj.id);
  }

  /* ---------- 变量 / 列表 ---------- */
  getVar(k) {
    const key = normVarKey(k);
    const local = this.currentObject && this.currentObject.localVars;
    if (local && local.has(key)) return local.get(key);
    return this.vars.get(key);
  }

  setVar(k, v, scope, owner) {
    const key = normVarKey(k);
    if (scope === 'private' && owner) owner.localVars.set(key, v);
    else this.vars.set(key, v);
    if (this.hooks.onVar) this.hooks.onVar(key, v);
  }

  getList(name) {
    const key = listName(name);
    if (!this.lists.has(key)) this.lists.set(key, []);
    return this.lists.get(key);
  }

  /* ---------- 补间 / 关键帧 ---------- */
  addTween(obj, prop, from, to, dur, ez = 'linear', color = false) {
    if (!obj) return;
    if (!(dur > 0)) { obj.p[prop] = to; return; }
    obj.anims.push({
      prop, from, to, dur, ease: ez, color: color || COLOR_PROPS.has(prop),
      start: this.time,
    });
  }

  setKeyframe(obj, prop, time, value) {
    if (!obj) return;
    const key = `${obj.id}:${prop}`;
    let arr = this.tracks.get(key);
    if (!arr) { arr = []; this.tracks.set(key, arr); }
    const t = Math.max(0, num(time, 0));
    const at = arr.findIndex(k => Math.abs(k.time - t) < 1e-9);
    const kf = { time: t, value, color: COLOR_PROPS.has(prop) };
    if (at >= 0) arr[at] = kf; else { arr.push(kf); arr.sort((a, b) => a.time - b.time); }
  }

  /* ---------- 每帧状态 ---------- */
  _renderStates() {
    const states = new Map();
    for (const id of this.order) {
      const obj = this.objects.get(id);
      if (!obj || obj.deleted) continue;
      states.set(id, this._stateFor(obj));
    }
    // 父子世界变换
    for (const id of this.order) {
      const obj = this.objects.get(id);
      const st = states.get(id);
      if (obj && st) this._applyParent(states, obj, st, 0);
    }
    // 文本变量插值（全部线程执行完之后）
    for (const id of this.order) {
      const obj = this.objects.get(id);
      const st = states.get(id);
      if (!obj || !st) continue;
      this.currentObject = obj;
      const before = String(st.p.text ?? '');
      const after = interpolate(before, this);
      if (after !== before) {
        st.p.text = after;
        if (!st.text || st.text.length <= 1) st.text = buildUnits(after, st.splitUnit || 'whole');
        else if (st.splitUnit === 'whole' || !st.splitUnit) st.text = buildUnits(after, 'whole');
      }
    }
    this.currentObject = null;
    this._states = states;
  }

  _stateFor(obj) {
    const p = Object.assign({}, obj.p);
    const st = {
      id: obj.id,
      type: obj.type,
      name: obj.name,
      visible: obj.visible,
      base: obj.base,
      p,
      fx: {},
      text: null,
      splitUnit: 'whole',
      delay: 0,
      data: null,
      effects: Object.assign({}, obj.effects),
      blend: obj.blend,
      clip: obj.clip ? Object.assign({}, obj.clip) : null,
      mask: obj.maskId,
      costume: obj.costume,
      parent: obj.parentName,
      isClone: obj.isClone,
    };
    this._applyTracks(obj, st);
    this._applyAnims(obj, st);
    if (obj.sequence) {
      const arr = this.getList(obj.sequence.list);
      if (arr.length) {
        const i = Math.floor(Math.max(0, this.time - obj.sequence.start) * obj.sequence.fps) % arr.length;
        st.costume = arr[i];
        st.p.src = arr[i];
      }
    }
    st.text = buildUnits(String(st.p.text ?? ''), 'whole');
    applyFxDefs(this, obj.fxDefs, st, this.time);
    this._applyPaths(obj, st);
    this._applyFormulas(obj, st);
    obj.lastState = st;
    return st;
  }

  _applyTracks(obj, st) {
    for (const [key, arr] of this.tracks) {
      if (!key.startsWith(obj.id + ':')) continue;
      const prop = key.slice(obj.id.length + 1);
      if (!arr || !arr.length) continue;
      const t = this.time;
      if (t <= arr[0].time) { st.p[prop] = arr[0].value; continue; }
      if (t >= arr[arr.length - 1].time) { st.p[prop] = arr[arr.length - 1].value; continue; }
      let i = 0;
      while (i < arr.length - 1 && arr[i + 1].time <= t) i++;
      const a = arr[i], b = arr[i + 1];
      const span = Math.max(1e-9, b.time - a.time);
      const k = ease('inOutQuad', clamp01((t - a.time) / span));
      st.p[prop] = a.color ? mixHex(String(a.value), String(b.value), k) : lerp(num(a.value, 0), num(b.value, 0), k);
    }
  }

  _applyAnims(obj, st) {
    if (!obj.anims.length) return;
    const keep = [];
    for (const a of obj.anims) {
      if (this.time + EPS < a.start) { keep.push(a); continue; }
      const k = clamp01((this.time - a.start) / a.dur);
      const e = ease(a.ease, k);
      st.p[a.prop] = a.color ? mixHex(String(a.from), String(a.to), e) : lerp(num(a.from, 0), num(a.to, 0), e);
      if (k >= 1) obj.p[a.prop] = a.to;
      else keep.push(a);
    }
    obj.anims = keep;
  }

  _applyPaths(obj, st) {
    if (!obj.paths.length) return;
    for (const path of obj.paths) {
      const k = clamp01((this.time - path.start) / Math.max(1e-6, path.dur));
      const pts = path.points;
      if (pts.length < 2) continue;
      const x = pathPoint(pts, k, 0);
      const y = pathPoint(pts, k, 1);
      st.p.x = num(obj.p.x, 0) + x;
      st.p.y = num(obj.p.y, 0) + y;
    }
  }

  _applyFormulas(obj, st) {
    if (!obj.formulas.length) return;
    for (const f of obj.formulas) {
      const k = (this.time - f.start) / f.period;
      if (k < 0) continue;
      const a = Math.PI * 2 * k;
      const dx = f.mode === 'ellipse' ? f.ax * Math.cos(a) : f.ax * Math.sin(a);
      const dy = f.mode === 'ellipse' ? f.ay * Math.sin(a) : f.ay * Math.sin(a * 2);
      st.p.x = num(st.p.x, 0) + dx;
      st.p.y = num(st.p.y, 0) + dy;
    }
  }

  _applyParent(states, obj, st, depth) {
    if (!obj.parentName || depth > 16) return;
    const parent = this.findObject(obj.parentName);
    if (!parent || parent.deleted) { obj.parentName = null; return; }
    if (parent === obj) { obj.parentName = null; return; }
    const pst = states.get(parent.id) || this._stateFor(parent);
    if (!pst) return;
    this._applyParent(states, parent, pst, depth + 1);
    const pp = pst.p;
    const rot = (num(pp.rotation, 0) + 0) * Math.PI / 180;
    const sx = num(pp.scaleX, 1), sy = num(pp.scaleY, 1);
    const lx = num(st.p.x, 0), ly = num(st.p.y, 0);
    st.p.x = num(pp.x, 0) + Math.cos(rot) * sx * lx - Math.sin(rot) * sy * ly;
    st.p.y = num(pp.y, 0) + Math.sin(rot) * sx * lx + Math.cos(rot) * sy * ly;
    st.p.rotation = num(st.p.rotation, 0) + num(pp.rotation, 0);
    st.p.scaleX = num(st.p.scaleX, 1) * sx;
    st.p.scaleY = num(st.p.scaleY, 1) * sy;
    st.p.opacity = clamp01(num(st.p.opacity, 1) * num(pp.opacity, 1));
    if (!pst.visible) st.visible = false;
    if (st.data && st.data.base) {
      st.data = Object.assign({}, st.data, { base: Object.assign({}, st.data.base, { x: st.p.x, y: st.p.y }) });
    }
  }

  /* ---------- 对外场景 ---------- */
  compose() {
    const layers = {};
    const order = [];
    for (const id of this.order) {
      const st = this._states && this._states.get(id);
      if (!st) continue;
      layers[id] = st;
      order.push(id);
    }
    return {
      layers,
      order,
      extras: {},
      logs: this.logs.slice(),
      soundCues: this.soundCues.slice(),
      t: this.time,
      ir: this.ir,
      stage: Object.assign({}, this.stage),
    };
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }

function atTime(base, v) {
  return Math.max(base, num(v, 0));
}

/* 自定义贝塞尔缓动把四个控制点编码进 easing 字符串，ease() 直接解析。 */
function easingName(raw, b, start, E, num) {
  const name = String(raw ?? 'inOutQuad');
  if (name !== 'customBezier') return name;
  if (!b.slots || !b.slots[start]) return 'inOutQuad';
  const x1 = num(E(start), 0.42);
  const y1 = num(E(start + 1), 0);
  const x2 = num(E(start + 2), 0.58);
  const y2 = num(E(start + 3), 1);
  return `bezier:${x1},${y1},${x2},${y2}`;
}

function parsePathPoints(str) {
  const pts = [];
  for (const part of String(str || '').split(/[;\n]+/)) {
    const pair = part.trim().split(/[,\s]+/).filter(Boolean);
    if (pair.length < 2) continue;
    const x = Number(pair[0]), y = Number(pair[1]);
    if (isFinite(x) && isFinite(y)) pts.push([x, y]);
  }
  return pts;
}

function pathPoint(pts, k, axis) {
  const n = pts.length;
  const seg = Math.min(n - 2, Math.floor(k * (n - 1)));
  const local = clamp01(k * (n - 1) - seg);
  return lerp(pts[seg][axis], pts[seg + 1][axis], local);
}

const VAR_TOKEN = /\$([A-Za-z_]\w*)/g;
function interpolate(str, ctx) {
  const s = String(str == null ? '' : str);
  if (s.indexOf('$') < 0) return s;
  return s.replace(VAR_TOKEN, (all, name, offset) => {
    if (s[offset + all.length] === '.') return all;
    if (ctx.getVar(name) === undefined) return all;
    const v = evalExpr({ k: 'var', name }, ctx);
    if (v === undefined || v === null) return all;
    return String(v);
  });
}

/* ============================================================
   对外入口：按 IR 身份 + rev 复用运行时
   ------------------------------------------------------------
   t 后退或 IR 变化 → reset 后重放；t 前进 → 只推进缺少的帧。
   预览、导出、单帧 PNG 都走这里，因此三条路径天然一致。
   ============================================================ */
let _cache = null;

export function resetEvaluationCache() { _cache = null; }

export function evaluateFrame(ir, t, audio, hooks = {}) {
  const rev = hooks.rev == null ? 0 : hooks.rev;
  const custom = hooks.customLibrary || null;
  let rt = null;
  if (_cache && _cache.ir === ir && _cache.audio === audio && _cache.rev === rev && _cache.custom === custom) {
    rt = _cache.rt;
  } else {
    rt = new Runtime(ir, audio, { hooks });
    _cache = { ir, audio, rev, custom, rt };
  }
  rt.hooks = hooks;
  if (hooks.sound !== undefined) rt.sound = hooks.sound;
  rt.stepBudget = Number.isFinite(hooks.maxSteps) && hooks.maxSteps > 0 ? hooks.maxSteps : RUNTIME_MAX_STEPS;
  const target = (Number(t) || 0) * rt.fps;
  if (target < rt.frame) rt.reset();
  rt.advanceTo(t);
  return { state: rt.compose(), ctx: rt };
}

export function createRuntime(ir, audio, opts = {}) {
  return new Runtime(ir, audio, opts);
}

export { DEFAULT_MAX_STEPS };
