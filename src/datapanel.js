/* ============================================================
   datapanel.js · 数据驱动 + 批量渲染 UI（P2）
   ------------------------------------------------------------
   表格预览 → 绑定到图层 → 逐行渲染 → 断点续渲 → 打包下载
   ============================================================ */

import {
  DataSource, parseDelimited, parseJSON, fetchTable, fetchAPI,
  findBindable, bindRow, BatchQueue, interpolate, FORMATTERS,
} from './batch.js';

export class DataPanel {
  constructor(opts = {}) {
    this.previewEl = opts.previewEl;
    this.countEl = opts.countEl;
    this.bindEl = opts.bindEl;
    this.progressEl = opts.progressEl;
    this.nameEl = opts.nameEl;
    this.onToast = opts.onToast || (() => {});
    this.onBind = opts.onBind || (() => {});     // (ir, row) => void

    this.ds = null;
    this.bindings = new Map();   // bindableKey -> columnKey
    this.queue = null;
    this.renderFn = opts.renderFn || null;
  }

  /* ============================================================
     数据装载
     ============================================================ */
  loadText(text, opts = {}) {
    try {
      this.ds = opts.json ? parseJSON(text, opts) : parseDelimited(text, opts);
      this.afterLoad();
    } catch (e) {
      this.onToast(e.message);
    }
  }

  async loadFile(file) {
    try {
      const text = await file.text();
      this.loadText(text, {
        json: /\.json$/i.test(file.name),
        name: file.name.replace(/\.[^.]+$/, ''),
      });
    } catch (e) {
      this.onToast('读取失败：' + e.message);
    }
  }

  async loadUrl(url) {
    try {
      const isJson = /\.json(\?|$)/i.test(url);
      this.ds = isJson ? await fetchAPI(url) : await fetchTable(url);
      this.afterLoad();
      this.onToast(`已拉取 ${this.ds.length} 行`);
    } catch (e) {
      this.onToast('拉取失败：' + e.message);
    }
  }

  afterLoad() {
    this.renderPreview();
    this.renderCount();
    this.onToast(`已载入 ${this.ds ? this.ds.length : 0} 行 × ${this.ds ? this.ds.columns.length : 0} 列`);
  }

  clear() {
    this.ds = null;
    this.bindings.clear();
    if (this.previewEl) this.previewEl.innerHTML = '';
    this.renderCount();
    if (this.bindEl) this.bindEl.innerHTML = '';
    if (this.progressEl) this.progressEl.innerHTML = '';
  }

  /* ============================================================
     表格预览
     ============================================================ */
  renderCount() {
    if (!this.countEl) return;
    this.countEl.textContent = this.ds ? `${this.ds.length} 行 × ${this.ds.columns.length} 列` : '0 行';
  }

  renderPreview() {
    const el = this.previewEl;
    if (!el || !this.ds) return;
    el.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'data-table';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    for (const c of this.ds.columns) {
      const th = document.createElement('th');
      th.textContent = `${c.label}`;
      th.title = `类型：${c.type === 'num' ? '数值' : '文本'}`;
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const LIMIT = 60;
    for (let i = 0; i < Math.min(LIMIT, this.ds.length); i++) {
      const tr = document.createElement('tr');
      tr.addEventListener('click', () => this.previewRow(i));
      for (const c of this.ds.columns) {
        const td = document.createElement('td');
        const v = this.ds.rows[i][c.key];
        td.textContent = v == null ? '' : String(v);
        if (c.type === 'num') td.className = 'num';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    el.appendChild(table);

    if (this.ds.length > LIMIT) {
      const m = document.createElement('div');
      m.style.cssText = 'padding:4px 8px;font-size:10px;color:var(--muted)';
      m.textContent = `仅预览前 ${LIMIT} 行，批量渲染会处理全部 ${this.ds.length} 行`;
      el.appendChild(m);
    }
  }

  previewRow(i) {
    if (!this.ds) return;
    const row = this.ds.rows[i];
    const lines = this.ds.columns.map(c => `${c.label}: ${row[c.key]}`);
    this.onToast(lines.slice(0, 6).join('  |  ') + (lines.length > 6 ? ' …' : ''));
  }

  /* ============================================================
     绑定
     ============================================================ */
  /** 扫描当前 IR 的可绑定位置 */
  scanBindable(ir) {
    this.ir = ir;
    this.bindables = findBindable(ir);
    this.renderBindings();
    return this.bindables;
  }

  renderBindings() {
    const el = this.bindEl;
    if (!el) return;
    el.innerHTML = '';
    if (!this.ds) {
      const d = document.createElement('div');
      d.className = 'lbl';
      d.textContent = '先载入数据，再选择要绑定的字段';
      el.appendChild(d);
      return;
    }
    if (!this.bindables || !this.bindables.length) {
      const d = document.createElement('div');
      d.className = 'lbl';
      d.textContent = '这个工程没有可绑定的字段';
      el.appendChild(d);
      return;
    }

    // 只展示「文本型」的绑定点，数量太多会淹没界面
    const items = this.bindables.filter(b => b.type === 'str' || b.type === 'num').slice(0, 24);
    for (const b of items) {
      const row = document.createElement('div');
      row.className = 'bind-row';

      const label = document.createElement('span');
      label.textContent = b.label;
      label.title = b.label;
      row.appendChild(label);

      const sel = document.createElement('select');
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '（不绑定）';
      sel.appendChild(none);
      for (const c of this.ds.columns) {
        const o = document.createElement('option');
        o.value = c.key;
        o.textContent = c.label;
        sel.appendChild(o);
      }
      sel.value = this.bindings.get(keyOf(b)) || '';
      sel.addEventListener('change', () => {
        if (sel.value) this.bindings.set(keyOf(b), sel.value);
        else this.bindings.delete(keyOf(b));
        this.onBind(this.ir, this.bindings);
      });
      row.appendChild(sel);

      // 格式
      const fmtSel = document.createElement('select');
      const fNone = document.createElement('option');
      fNone.value = '';
      fNone.textContent = '原样';
      fmtSel.appendChild(fNone);
      for (const [k, v] of Object.entries(FORMATTERS)) {
        const o = document.createElement('option');
        o.value = k;
        o.textContent = v.label || k;
        fmtSel.appendChild(o);
      }
      fmtSel.addEventListener('change', () => {
        if (sel.value) this.bindings.set(keyOf(b), sel.value + '|' + fmtSel.value);
      });
      row.appendChild(fmtSel);

      el.appendChild(row);
    }
  }

  /* ============================================================
     批量渲染
     ============================================================ */
  buildQueue(baseIR) {
    if (!this.ds) { this.onToast('请先载入数据'); return null; }
    const self = this;

    const renderOne = async (row) => {
      // 1) 变量插值：把 {{列}} 换成实际值。
      //    必须走 bindRow —— 它内部 clone(ir) 后返回新对象。
      //    原实现写的是 `let ir = baseIR` 再原地改 layer.props，
      //    而 baseIR 就是用户当前工程的活对象（run(App.ir)），
      //    结果占位符被第一行永久顶掉：N 行数据出 N 张一模一样的图，
      //    并且点一下批量渲染就把用户工程改坏了。
      //    formats 必须显式传：bindRow 里 `fns = fmtFns || FORMATTERS`，
      //    传 {} 是 truthy，内置格式会整体失效。
      let ir = bindRow(baseIR, row, self.ds.columns, { formats: FORMATTERS });
      // 2) 字段级绑定（面板里选的），按当前行写进副本
      if (self.bindings.size) ir = applyFieldBindings(ir, self.bindings, self.ds, row);
      // 3) 调用真正的渲染器
      if (!self.renderFn) throw new Error('未接入渲染器');
      return self.renderFn(ir, row);
    };

    this.queue = BatchQueue.fromDataSource(this.ds, renderOne, {
      nameTemplate: this.nameEl ? this.nameEl.value.trim() : '',
      concurrency: 1,
      maxRetries: 2,
    });
    this.renderProgress(this.queue.stats, null);
    return this.queue;
  }

  async run(baseIR) {
    const q = this.queue || this.buildQueue(baseIR);
    if (!q) return;
    q.resumeFrom = q.serializeProgress();
    await q.run((stats, task) => this.renderProgress(stats, task));
    const s = q.stats;
    this.onToast(`批量完成：成功 ${s.done}，失败 ${s.failed}`);
  }

  pause() { if (this.queue) this.queue.pause(); }

  renderProgress(stats, task) {
    const el = this.progressEl;
    if (!el) return;
    el.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'bp-bar';
    const fill = document.createElement('div');
    fill.className = 'bp-fill';
    fill.style.width = (stats.percent * 100).toFixed(1) + '%';
    bar.appendChild(fill);
    el.appendChild(bar);

    const text = document.createElement('div');
    text.className = 'bp-text';
    text.innerHTML =
      `<span>${stats.done} / ${stats.total}${task ? ' · ' + task.name : ''}</span>` +
      `<span>${stats.failed ? `<span class="fail">失败 ${stats.failed}</span>` : ''}${stats.running ? ' 处理中…' : ''}</span>`;
    el.appendChild(text);
  }

  /** 打包全部产物 */
  async zipAll() {
    if (!this.queue) { this.onToast('还没有渲染结果'); return null; }
    const c = this.queue.collect();
    if (!c.count) { this.onToast('没有成功的产物'); return null; }
    const { createZip } = await import('./zip.js');
    const entries = [];
    for (const item of c.items) {
      const ext = (item.blob.type || '').split('/')[1] || 'bin';
      entries.push({
        name: `${item.name}.${ext === 'jpeg' ? 'jpg' : ext}`,
        data: new Uint8Array(await item.blob.arrayBuffer()),
      });
    }
    entries.unshift({
      name: 'manifest.json',
      data: new TextEncoder().encode(JSON.stringify(c.manifest, null, 2)),
    });
    return createZip(entries);
  }

  /* ============================================================
     断点续渲
     ============================================================ */
  saveProgress() {
    if (!this.queue) return null;
    return this.queue.serializeProgress();
  }

  loadProgress(saved, baseIR) {
    const q = this.queue || this.buildQueue(baseIR);
    if (!q) return 0;
    const n = q.restoreProgress(saved);
    this.renderProgress(q.stats, null);
    if (n) this.onToast(`已跳过 ${n} 条已完成任务（断点续渲）`);
    return n;
  }

  toJSON() {
    return { ds: this.ds ? this.ds.toJSON() : null, bindings: [...this.bindings.entries()] };
  }
  fromJSON(j) {
    if (!j) return;
    if (j.ds) { this.ds = DataSource.fromJSON(j.ds); this.afterLoad(); }
    if (j.bindings) this.bindings = new Map(j.bindings);
  }
}

function keyOf(b) {
  return b.kind === 'prop'
    ? `prop:${b.layerId}:${b.path.join('.')}`
    : `slot:${b.layerId}:${b.blockId}:${b.slotIndex}`;
}

/** 把面板里选的绑定写进 IR 副本（副本由调用方传入，本函数不碰外部对象） */
function applyFieldBindings(ir, bindings, ds, row) {
  const byKey = new Map(ds.columns.map(c => [c.key, c]));
  const findTarget = (b) => {
    if (b.kind === 'prop') {
      const layer = ir.layers.find(l => l.id === b.layerId);
      if (!layer) return null;
      return { obj: layer.props, key: b.path[0] };
    }
    const layer = ir.layers.find(l => l.id === b.layerId);
    if (!layer) return null;
    let found = null;
    const scan = (blocks) => {
      for (const blk of blocks || []) {
        if (blk.id === b.blockId && blk.slots && blk.slots[b.slotIndex]) {
          found = blk.slots[b.slotIndex];
          return;
        }
        if (blk.slots) for (const s of blk.slots) if (Array.isArray(s.value)) scan(s.value);
      }
    };
    scan(layer.blocks);
    return found ? { obj: found, key: 'value' } : null;
  };

  // 绑定目标是「当前 IR」里的位置。IR 已经是 bindRow 产出的新副本，
  // 结构与 baseIR 一致，因此不用再拿 baseIR 去找。
  const bindables = findBindable(ir);
  for (const [key, spec] of bindings) {
    const [colKey, fmtName] = String(spec).split('|');
    const col = byKey.get(colKey);
    if (!col) continue;
    const b = bindables.find(x => keyOf(x) === key);
    if (!b) continue;
    const target = findTarget(b);
    if (!target) continue;

    // 取值 + 套用面板选的格式
    let v = row ? row[col.key] : undefined;
    if (v === undefined || v === null) v = '';
    const fn = fmtName && FORMATTERS[fmtName];
    if (fn) v = fn(v);

    // 写回副本。原来这里只有一句 `void fmtName`，赋值从来没发生，
    // 所以面板里选的字段绑定全部不生效且不报错。
    if (target.key === 'value') {
      // 槽位值：按目标类型包成对应的字面量，保留类型
      const t = col.type === 'num' ? 'num' : 'str';
      target.obj.value = t === 'num'
        ? { k: 'lit', t: 'num', v: Number(v) || 0 }
        : { k: 'lit', t: 'str', v: String(v) };
    } else {
      // 图层属性：数值列写数字，其余写字符串
      target.obj[target.key] = col.type === 'num' && isFinite(Number(v)) ? Number(v) : String(v);
    }
  }
  return ir;
}