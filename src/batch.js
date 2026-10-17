/* ============================================================
   batch.js · 数据驱动与批量渲染（P2-B/C）
   ------------------------------------------------------------
   规划 G：这是「商业化杀手锏」——
   动画即程序，程序即模板。搭一次逻辑，换一批数据批量出片。

   三个能力：
     · 数据源解析：粘贴表格 / CSV / JSON / 在线表格 / API
     · 变量绑定：把图层文本、颜色、数值绑定到数据列
     · 批量渲染队列：数据每行出一条，自动命名、失败重试、断点续渲
   ============================================================ */

import { clone, uid } from './ir.js';

/* ============================================================
   数据源
   ============================================================ */
export class DataSource {
  constructor(opts = {}) {
    this.id = opts.id || uid('DS');
    this.name = opts.name || '数据集';
    this.columns = opts.columns || [];      // [{key,label,type}]
    this.rows = opts.rows || [];            // [{colKey: value}]
    this.source = opts.source || 'paste';
  }

  get length() { return this.rows.length; }
  row(i) { return this.rows[i] || null; }

  /** 取列的数值数组（用于图表） */
  column(key) {
    return this.rows.map(r => Number(r[key]) || 0);
  }

  stats(key) {
    const v = this.column(key);
    if (!v.length) return { min: 0, max: 0, sum: 0, avg: 0 };
    // 用循环求最值：Math.min(...v) 会把数组展开成实参，
    // 行数上十万时会超出调用栈上限抛 RangeError。
    let min = Infinity, max = -Infinity, sum = 0;
    for (let i = 0; i < v.length; i++) {
      const n = v[i];
      if (n < min) min = n;
      if (n > max) max = n;
      sum += n;
    }
    return { min, max, sum, avg: sum / v.length };
  }

  /** 按条件过滤（规划：条件渲染） */
  filter(fn) {
    return new DataSource({ name: this.name + '（筛选）', columns: this.columns, rows: this.rows.filter(fn), source: this.source });
  }

  /** 按列排序 */
  sort(key, dir = 1) {
    const rows = this.rows.slice().sort((a, b) => (Number(a[key]) - Number(b[key])) * dir);
    return new DataSource({ name: this.name, columns: this.columns, rows, source: this.source });
  }

  toJSON() { return { id: this.id, name: this.name, columns: this.columns, rows: this.rows, source: this.source }; }
  static fromJSON(j) { return new DataSource(j); }
}

/* ---------- 解析器 ---------- */

/** CSV / TSV 解析（支持引号包裹、换行、BOM） */
export function parseDelimited(text, opts = {}) {
  const src = String(text).replace(/^\uFEFF/, '');
  const delim = opts.delimiter || guessDelimiter(src);
  const rows = [];
  let row = [], cell = '', inQuote = false, afterQuote = false;

  const endField = () => { row.push(cell); cell = ''; afterQuote = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuote) {
      if (ch === '"') {
        // 连续两个引号 = 转义的一个引号
        if (src[i + 1] === '"') { cell += '"'; i++; continue; }
        inQuote = false;
        afterQuote = true;         // 闭合引号，之后只允许分隔符/换行
        continue;
      }
      cell += ch;
      continue;
    }

    if (afterQuote) {
      // 闭合引号后遇到非分隔内容 → 视为该字符属于字段（宽松处理）
      if (ch === delim) { endField(); continue; }
      if (ch === '\r') continue;
      if (ch === '\n') { endRow(); continue; }
      cell += ch;
      afterQuote = false;
      continue;
    }

    if (ch === '"' && cell === '') { inQuote = true; continue; }
    if (ch === delim) { endField(); continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { endRow(); continue; }
    cell += ch;
  }
  if (cell !== '' || row.length || afterQuote || inQuote) endRow();

  // 去掉尾部空行
  while (rows.length && rows[rows.length - 1].every(c => c.trim() === '')) rows.pop();
  if (!rows.length) return new DataSource({ name: opts.name || '空数据' });

  const hasHeader = opts.header !== false && rows[0].some(c => c.trim() !== '' && !isNumeric(c));
  const headerRow = hasHeader ? rows[0] : null;
  const body = hasHeader ? rows.slice(1) : rows;

  const columns = (headerRow || body[0] || []).map((h, i) => ({
    key: 'c' + i,
    label: headerRow ? String(h).trim() || '列' + (i + 1) : '列' + (i + 1),
    type: headerRow ? guessType(body.map(r => r[i])) : guessType(body.map(r => r[i])),
  }));

  const out = body.map(r => {
    const o = {};
    columns.forEach((c, i) => { o[c.key] = coerce(r[i], c.type); });
    return o;
  });
  return new DataSource({ name: opts.name || '粘贴数据', columns, rows: out, source: 'paste' });
}

function guessDelimiter(s) {
  const line = s.split('\n')[0] || '';
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && counts[ch] != null) counts[ch]++;
  }
  return Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a), ',');
}

function isNumeric(s) {
  if (s == null) return false;
  const t = String(s).trim();
  if (!t) return false;
  // 允许货币符号、千分位、百分号、括号负数
  const cleaned = t.replace(/[,，¥$€£₩\s]/g, '');
  if (/%$/.test(cleaned)) {
    return isFinite(parseFloat(cleaned.slice(0, -1)));
  }
  if (/^\(.*\)$/.test(cleaned)) {
    return isFinite(parseFloat(cleaned.slice(1, -1)));
  }
  // 必须整串都是数字（允许开头 -+ 和小数点、百分号结尾）
  if (!/^[-+]?[0-9]*\.?[0-9]+%?$/.test(cleaned)) return false;
  return isFinite(parseFloat(cleaned));
}

function guessType(col) {
  let num = 0, nonEmpty = 0;
  for (const v of col) {
    const s = String(v == null ? '' : v).trim();
    if (!s) continue;
    nonEmpty++;
    if (isNumeric(s)) num++;
  }
  if (nonEmpty && num / nonEmpty > 0.8) return 'num';
  return 'str';
}

function coerce(v, type) {
  if (type === 'num') {
    const s = String(v == null ? '' : v).trim();
    if (!s) return 0;
    const neg = /^\(.*\)$/.test(s);
    const cleaned = s.replace(/[()]/g, '').replace(/[,，¥$€£₩%\s]/g, '');
    const n = parseFloat(cleaned);
    if (!isFinite(n)) return 0;
    return neg ? -n : n;
  }
  return String(v == null ? '' : v).trim();
}

/** JSON 解析：数组或 {columns, rows} 或 {key: [..]} 形式 */
export function parseJSON(text, opts = {}) {
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('JSON 解析失败：' + e.message); }
  if (Array.isArray(j)) {
    if (!j.length) return new DataSource({ name: opts.name || 'JSON 数据' });
    if (typeof j[0] === 'object' && !Array.isArray(j[0])) {
      const keys = Object.keys(j[0]);
      const columns = keys.map(k => ({ key: k, label: k, type: guessType(j.map(r => r[k])) }));
      const rows = j.map(r => { const o = {}; columns.forEach(c => { o[c.key] = coerce(r[c.key], c.type); }); return o; });
      return new DataSource({ name: opts.name || 'JSON 数据', columns, rows, source: 'json' });
    }
    const columns = [{ key: 'value', label: 'value', type: guessType(j) }];
    return new DataSource({ name: opts.name || 'JSON 数据', columns, rows: j.map(v => ({ value: coerce(v, 'num') })), source: 'json' });
  }
  if (j && typeof j === 'object') {
    const keys = Object.keys(j);
    if (keys.length && Array.isArray(j[keys[0]])) {
      const columns = keys.map(k => ({ key: k, label: k, type: guessType(j[k]) }));
      const n = Math.max(...keys.map(k => j[k].length));
      const rows = [];
      for (let i = 0; i < n; i++) {
        const o = {};
        columns.forEach(c => { o[c.key] = coerce(j[c.key][i], c.type); });
        rows.push(o);
      }
      return new DataSource({ name: opts.name || 'JSON 数据', columns, rows, source: 'json' });
    }
  }
  throw new Error('无法识别的 JSON 结构');
}

/** 从在线表格 URL 拉取（公开 CSV 导出链接） */
export async function fetchTable(url, opts = {}) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`拉取失败：HTTP ${res.status}`);
  const text = await res.text();
  return parseDelimited(text, { name: opts.name || '在线表格' });
}

/** API 返回 JSON 数组 */
export async function fetchAPI(url, opts = {}) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`拉取失败：HTTP ${res.status}`);
  const text = await res.text();
  return parseJSON(text, opts);
}

/* ============================================================
   变量绑定：把 IR 里的具体值替换成「数据列引用」
   ============================================================ */

/**
 * 在 IR 中查找所有可被绑定的位置。
 * 绑定目标 = 槽位值 / 图层属性，用 $data.c0 这样的引用表示。
 */
export function findBindable(ir) {
  const out = [];
  for (const layer of ir.layers || []) {
    for (const key of Object.keys(layer.props || {})) {
      const v = layer.props[key];
      if (typeof v === 'string' || typeof v === 'number') {
        out.push({ layerId: layer.id, kind: 'prop', path: [key], label: `${layer.name}.${key}`, type: typeof v });
      }
    }
    const scan = (blocks) => {
      for (const b of blocks || []) {
        if (b.slots) {
          b.slots.forEach((s, i) => {
            if (Array.isArray(s.value)) return scan(s.value);
            const v = s.value;
            if (v && typeof v === 'object' && v.k === 'lit' && (v.t === 'str' || v.t === 'num' || v.t === 'col')) {
              out.push({ layerId: layer.id, kind: 'slot', blockId: b.id, op: b.op, slotIndex: i, label: `${b.op}.${s.label || i}`, type: v.t });
            }
          });
        }
      }
    };
    scan(layer.blocks);
  }
  return out;
}

/** 生成绑定后的 IR 副本 */
export function bindRow(ir, row, columns, opts = {}) {
  const out = clone(ir);
  const cols = columns || [];
  const fmtFns = opts.formats || {};

  // 字符串：整句插值（支持一句里绑多列）
  const bindStr = (s) => {
    if (typeof s !== 'string' || s.indexOf('{{') < 0) return s;
    return interpolate(s, row, cols, fmtFns);
  };

  for (const layer of out.layers || []) {
    for (const key of Object.keys(layer.props || {})) {
      const v = layer.props[key];
      if (typeof v === 'string') layer.props[key] = bindStr(v);
      else if (typeof v === 'number' && opts.boundProps && opts.boundProps.includes(key)) {
        const col = cols.find(c => c.label === key || c.key === key);
        if (col) layer.props[key] = Number(row[col.key]) || 0;
      }
    }
    const scan = (blocks) => {
      for (const b2 of blocks || []) {
        if (!b2.slots) continue;
        b2.slots.forEach((s) => {
          if (Array.isArray(s.value)) return scan(s.value);
          const v = s.value;
          if (!v || typeof v !== 'object') return;
          if (v.k === 'lit' && v.t === 'str') {
            if (typeof v.v === 'string') s.value = { k: 'lit', t: 'str', v: bindStr(v.v) };
          } else if (v.k === 'lit' && v.t === 'num') {
            const col = cols.find(c => c.label === v.v || c.key === v.v);
            if (col) s.value = { k: 'lit', t: 'num', v: Number(row[col.key]) || 0 };
          } else if (v.k === 'lit' && v.t === 'col') {
            const col = cols.find(c => c.label === v.v || c.key === v.v);
            if (col) s.value = { k: 'lit', t: 'col', v: String(row[col.key]) };
          }
        });
      }
    };
    scan(layer.blocks);
  }
  return out;
}

/* ---------- 插值格式化函数（规划里的「金额格式化/序号」等） ---------- */
export const FORMATTERS = {
  comma: (v) => (isFinite(Number(v)) ? Number(v).toLocaleString('zh-CN') : v),
  int: (v) => (isFinite(Number(v)) ? String(Math.round(Number(v))) : v),
  percent: (v) => (isFinite(Number(v)) ? (Number(v) * 100).toFixed(0) + '%' : v),
  percent1: (v) => (isFinite(Number(v)) ? (Number(v) * 100).toFixed(1) + '%' : v),
  yuan: (v) => '¥' + (isFinite(Number(v)) ? Number(v).toFixed(2) : v),
  dollar: (v) => '$' + (isFinite(Number(v)) ? Number(v).toFixed(2) : v),
  wan: (v) => (isFinite(Number(v)) ? (Number(v) / 1e4).toFixed(1).replace(/\.0$/, '') + '万' : v),
  yi: (v) => (isFinite(Number(v)) ? (Number(v) / 1e8).toFixed(1).replace(/\.0$/, '') + '亿' : v),
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  pad: (v) => String(v).padStart(3, '0'),
  trim: (v) => String(v).trim(),
};

/** 生成所有「Nf 保留小数」格式（0f / 1f / 2f …） */
for (let d = 0; d <= 6; d++) {
  FORMATTERS[`${d}f`] = (v) => (isFinite(Number(v)) ? Number(v).toFixed(d) : v);
}

/** 生成带常用格式的 interpolate 版本 */
export function makeInterpolator(columns, extraFns = {}) {
  const fns = Object.assign({}, FORMATTERS, extraFns);
  return (str, row) => interpolate(str, row, columns, fns);
}

/* 绑定语法：{{列标签|格式}} 或 $data.列键
   注意：正则不能复用带 g 标志的实例，否则 lastIndex 会串味 */
const BIND_ONE = /\{\{([^}|]+?)(?:\|([^}]*?))?\}\}|\$data\.([A-Za-z0-9_]+)/;
const BIND_ALL = /\{\{([^}|]+?)(?:\|([^}]*?))?\}\}/g;

export function findBinding(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(BIND_ONE);
  if (!m) return null;
  const name = m[3] || m[1];
  return { key: name.trim(), fmt: (m[2] || '').trim(), raw: s, groups: m };
}

/** 多列插值：把整句里的绑定都替换掉。未传 fmtFns 时使用内置格式表。 */
export function interpolate(str, row, columns, fmtFns) {
  if (typeof str !== 'string' || str.indexOf('{{') < 0) return str;
  const fns = fmtFns || FORMATTERS;
  return str.replace(BIND_ALL, (all, name, fmt) => {
    const key = String(name).trim();
    const col = (columns || []).find(c => c.label === key || c.key === key);
    let v = col ? row[col.key] : row[key];
    const fmtName = String(fmt == null ? '' : fmt).trim();
    if (fmtName && fns[fmtName]) v = fns[fmtName](v);
    else if (col && col.type === 'num') v = Number(v) || 0;
    return v == null ? '' : String(v);
  });
}

/** 条件渲染：{{#if 列}} ... {{/if}} */
export function evalCondition(expr, row, columns) {
  const m = String(expr).match(/^\s*([^\s]+)\s*(==|!=|>|<|>=|<=)\s*(.+?)\s*$/);
  if (!m) return true;
  const key = m[1].trim();
  const col = (columns || []).find(c => c.label === key || c.key === key);
  const a = col ? Number(row[col.key]) : row[key];
  const bRaw = m[3].trim().replace(/^["']|["']$/g, '');
  const b = Number(bRaw);
  const an = Number(a), bn = isFinite(b) ? b : null;
  switch (m[2]) {
    case '==': return String(a) === bRaw || (bn != null && an === bn);
    case '!=': return !(String(a) === bRaw || (bn != null && an === bn));
    case '>': return bn != null && an > bn;
    case '<': return bn != null && an < bn;
    case '>=': return bn != null && an >= bn;
    case '<=': return bn != null && an <= bn;
    default: return true;
  }
}

function applyFormat(v, fmt, bind) {
  if (!fmt) return v;
  // 简单支持：逗号、百分比、货币、保留小数
  const num = Number(v);
  switch (fmt) {
    case 'comma': return isFinite(num) ? num.toLocaleString('zh-CN') : v;
    case 'percent': return isFinite(num) ? (num * 100).toFixed(0) + '%' : v;
    case 'yuan': return '¥' + (isFinite(num) ? num.toFixed(2) : v);
    case 'int': return isFinite(num) ? String(Math.round(num)) : v;
    default: {
      const m = fmt.match(/^(\d+)f$/);
      if (m) return isFinite(num) ? num.toFixed(+m[1]) : v;
      return v;
    }
  }
  void bind;
}

/* ============================================================
   批量渲染队列
   ------------------------------------------------------------
   要求：数据每行出一条视频，自动命名、自动打包、失败重试。
   支持断点续渲（记录已完成的任务）。
   ============================================================ */
export class BatchQueue {
  constructor(opts = {}) {
    this.tasks = [];                    // {id, rowIndex, row, name, status, attempts, error, blob}
    this.concurrency = opts.concurrency || 1;
    this.maxRetries = opts.maxRetries ?? 2;   // 0 是「不重试」，不能用 || 当成缺省值
    this.results = [];
    this.state = 'idle';                // idle | running | paused | done
    this._aborted = false;
  }

  /** 用数据集与渲染函数建队列 */
  static fromDataSource(ds, renderFn, opts = {}) {
    const q = new BatchQueue(opts);
    q.ds = ds;
    q.renderFn = renderFn;
    ds.rows.forEach((row, i) => {
      q.tasks.push({
        // 用行号做稳定 id。原实现用 uid('T') 随机生成，
        // 队列重建后 id 全变，restoreProgress 按 id 匹配永远命中 0，
        // 「断点续渲」原理上就不可能工作。行号在数据源不变时是稳定唯一的，
        // 这正是断点续渲的语义前提（数据源变了由指纹拦下）。
        id: 'T' + i,
        rowIndex: i,
        row,
        name: q.nameFor(row, i, opts),
        status: 'pending',
        attempts: 0,
        error: null,
        blob: null,
      });
    });
    return q;
  }

  /** 命名模板：{0} 按列序号，{列名} 按列标签/键 */
  nameFor(row, i, opts = {}) {
    const ds = this.ds;
    const columns = (ds && ds.columns) || [];
    const pad = String(ds ? ds.rows.length : 0).length + 1;
    const tmpl = opts.nameTemplate;
    if (tmpl) {
      return tmpl.replace(/\{(\d+)\}|\{([^}]+)\}/g, (m, num, key) => {
        if (num != null) {
          const col = columns[+num];
          return col ? String(row[col.key]) : '';
        }
        const col = columns.find(c => c.label === key || c.key === key);
        return col ? String(row[col.key]) : '';
      }).replace(/[\\/:*?"<>|]/g, '_');
    }
    const first = columns[0];
    const v = first ? row[first.key] : null;
    const seq = String(i + 1).padStart(Math.max(4, pad), '0');
    const tail = v != null && String(v).trim() !== '' ? '_' + String(v).slice(0, 20) : '';
    return (seq + tail).replace(/[\\/:*?"<>|]/g, '_');
  }

  get stats() {
    const total = this.tasks.length;
    const done = this.tasks.filter(t => t.status === 'done').length;
    const failed = this.tasks.filter(t => t.status === 'failed').length;
    const running = this.tasks.filter(t => t.status === 'running').length;
    return { total, done, failed, running, pending: total - done - failed - running, percent: total ? done / total : 0 };
  }

  /** 当前队列的数据源指纹：行数 + 列签名（键/名/类型）。用于校验进度是否还能对得上。 */
  _dsFingerprint() {
    const ds = this.ds;
    if (!ds) return '';
    // parseDelimited 生成的列 key 恒为 c0/c1/…，光看 key 区分不出改表头，
    // 所以把 label 与 type 一并纳入签名。
    const cols = (ds.columns || []).map(c => `${c.key}:${c.label}:${c.type}`).join('|');
    return `${ds.rows.length}#${cols}`;
  }

  /**
   * 断点续渲：只跑未完成的任务。
   * 返回恢复条数；数据源与保存进度时不一致（增删行/改列）则返回 0 不恢复，
   * 避免按行号恢复出错误的行 —— 不静默错位。
   */
  restoreProgress(saved) {
    // 入参是数组（旧格式，无指纹则不校验）或带 done 的对象
    const list = Array.isArray(saved) ? saved : (saved && saved.done) || [];
    const fp = saved && saved.fingerprint;
    if (fp != null && fp !== this._dsFingerprint()) return 0;
    const map = new Map(list.map(s => [s.id, s]));
    let restored = 0;
    for (const t of this.tasks) {
      const s = map.get(t.id);
      // serializeProgress 已 filter 过 status === 'done'，这里每条必然已完成，
      // 不能再判断 s.status（该字段不存在，原实现因此永远恢复不出东西）。
      if (s) { t.status = 'done'; t.attempts = s.attempts || 1; restored++; }
    }
    return restored;
  }

  /**
   * 存进度：只存已完成项，并带上数据源指纹供 restoreProgress 校验。
   * 返回数组（契约不变），指纹挂在数组的 fingerprint 属性上，
   * 这样 .length / 遍历 / JSON 序列化（指纹丢失则降级为不校验）都不受影响。
   */
  serializeProgress() {
    const done = this.tasks.filter(t => t.status === 'done')
      .map(t => ({ id: t.id, name: t.name, attempts: t.attempts }));
    done.fingerprint = this._dsFingerprint();
    return done;
  }

  abort() { this._aborted = true; this.state = 'idle'; }
  pause() { this.state = 'paused'; }

  async run(onProgress) {
    this.state = 'running';
    this._aborted = false;
    const pending = this.tasks.filter(t => t.status !== 'done');
    const workers = [];

    const take = () => {
      // 每次从头重扫。原实现用只前进的 cursor，失败项被置回 pending 后
      // 落在 cursor 之前就永远扫不到，会一直卡在 pending。
      // 终止性由 attempts / maxRetries 保证：重试超限后状态变 failed，不再为 pending。
      for (let i = 0; i < pending.length; i++) {
        if (pending[i].status === 'pending') return pending[i];
      }
      return null;
    };

    const worker = async () => {
      while (true) {
        if (this._aborted || this.state === 'paused') return;
        const task = take();
        if (!task) return;
        task.status = 'running';
        task.attempts++;
        try {
          task.blob = await this.renderFn(task.row, task.rowIndex);
          task.status = 'done';
          task.error = null;
        } catch (e) {
          task.error = e.message;
          if (task.attempts <= this.maxRetries) {
            task.status = 'pending';       // 退避后重试
            await new Promise(r => setTimeout(r, 120 * task.attempts));
          } else {
            task.status = 'failed';
          }
        }
        if (onProgress) onProgress(this.stats, task);
      }
    };

    for (let i = 0; i < Math.max(1, this.concurrency); i++) workers.push(worker());
    await Promise.all(workers);

    this.state = this._aborted ? 'idle' : 'done';
    this.results = this.tasks.filter(t => t.status === 'done').map(t => ({ name: t.name, blob: t.blob }));
    return this.stats;
  }

  /** 把全部产物打成一个包（manifest + blob 列表） */
  collect() {
    const ok = this.tasks.filter(t => t.status === 'done');
    return {
      count: ok.length,
      failed: this.tasks.filter(t => t.status === 'failed').length,
      items: ok.map(t => ({ name: t.name, blob: t.blob })),
      manifest: {
        total: this.tasks.length,
        generated: ok.length,
        failed: this.tasks.filter(t => t.status === 'failed').map(t => ({ name: t.name, error: t.error })),
        at: new Date().toISOString(),
      },
    };
  }
}

/* ============================================================
   参数暴露（P2-A）—— 模板生态的基础
   ------------------------------------------------------------
   作者把某些变量标记为「可调参数」，使用者只能改这几个值。
   ============================================================ */
export class ParamSpec {
  constructor(opts = {}) {
    this.id = opts.id || uid('P');
    this.key = opts.key || 'param';
    this.label = opts.label || '参数';
    this.type = opts.type || 'num';       // num | text | color | bool | select
    this.value = opts.value;
    this.min = opts.min; this.max = opts.max; this.step = opts.step;
    this.options = opts.options || null;   // select 用
    this.unit = opts.unit || '';
    this.group = opts.group || '基础';
    this.desc = opts.desc || '';
    this.expose = opts.expose !== false;   // false = 作者自用，不对外暴露
  }
}

export class ParamSet {
  constructor(opts = {}) {
    this.params = opts.params || [];
    this.locked = opts.locked || [];
  }
  add(p) { this.params.push(p instanceof ParamSpec ? p : new ParamSpec(p)); return p; }
  get(key) { return this.params.find(p => p.key === key); }
  remove(key) { this.params = this.params.filter(p => p.key !== key); }
  set(key, value) {
    const p = this.get(key);
    if (!p) throw new Error('没有这个参数：' + key);
    if (this.locked.includes(key)) throw new Error('参数已锁定：' + key);
    p.value = coerceParam(p, value);
    return p;
  }
  values() {
    const o = {};
    for (const p of this.params) o[p.key] = p.value;
    return o;
  }
  /** 对外暴露的（使用者可见可改的） */
  exposed() { return this.params.filter(p => p.expose); }
  groups() {
    const m = new Map();
    for (const p of this.exposed()) {
      if (!m.has(p.group)) m.set(p.group, []);
      m.get(p.group).push(p);
    }
    return [...m.entries()].map(([name, list]) => ({ name, params: list }));
  }
  validate() {
    const issues = [];
    for (const p of this.params) {
      if (p.type === 'num') {
        if (p.min != null && p.value < p.min) issues.push({ key: p.key, msg: `小于下限 ${p.min}` });
        if (p.max != null && p.value > p.max) issues.push({ key: p.key, msg: `大于上限 ${p.max}` });
      }
      if (p.type === 'select' && p.options && !p.options.some(o => (o[0] ?? o) === p.value)) {
        issues.push({ key: p.key, msg: '不在候选项内' });
      }
      if (p.type === 'color' && !/^#[0-9a-fA-F]{6}$/.test(String(p.value))) {
        issues.push({ key: p.key, msg: '颜色格式应为 #RRGGBB' });
      }
    }
    return issues;
  }
  toJSON() { return { params: this.params, locked: this.locked }; }
  static fromJSON(j) { return new ParamSet(j); }
}

export function coerceParam(spec, v) {
  switch (spec.type) {
    case 'num': {
      let n = Number(v);
      if (!isFinite(n)) n = spec.value;
      if (spec.min != null) n = Math.max(spec.min, n);
      if (spec.max != null) n = Math.min(spec.max, n);
      return n;
    }
    case 'bool': return v === true || v === 'true' || v === 1 || v === '1';
    case 'select': return v;
    default: return String(v);
  }
}

/** 把参数值写进 IR（模板参数化） */
export function applyParams(ir, values) {
  const out = clone(ir);
  for (const layer of out.layers || []) {
    for (const key of Object.keys(layer.props || {})) {
      if (Object.prototype.hasOwnProperty.call(values, key)) layer.props[key] = values[key];
    }
  }
  return out;
}

/* ============================================================
   插件 API（P2-D）
   ------------------------------------------------------------
   第三方作者能注册新的积木 / 图层类型 / 导出格式。
   这里给出最小但完整的插件契约。
   ============================================================ */
export class PluginHost {
  constructor() {
    this.plugins = new Map();
    this.blockDefs = [];
    this.layerTypes = [];
    this.exporters = [];
    this.hooks = new Map();
  }

  register(plugin) {
    if (!plugin || !plugin.id) throw new Error('插件必须有 id');
    if (this.plugins.has(plugin.id)) throw new Error('插件已注册：' + plugin.id);
    const manifest = {
      id: plugin.id,
      name: plugin.name || plugin.id,
      version: plugin.version || '0.0.0',
      api: plugin.api || '1.0',
      author: plugin.author || '',
      description: plugin.description || '',
      permissions: plugin.permissions || [],
    };
    if (String(manifest.api).split('.')[0] !== '1') {
      throw new Error(`插件 API 主版本不兼容：${manifest.api}（本宿主支持 1.x）`);
    }
    this.plugins.set(manifest.id, manifest);

    if (Array.isArray(plugin.blocks)) {
      for (const b of plugin.blocks) {
        // 命名空间隔离：强制前缀，避免冲突
        const prefixed = Object.assign({}, b, {
          op: b.op.startsWith(plugin.id + '.') ? b.op : `${plugin.id}.${b.op}`,
          label: (b.label || b.op) + ` [${manifest.id}]`,
          pluginId: manifest.id,
        });
        this.blockDefs.push(prefixed);
      }
    }
    if (Array.isArray(plugin.layerTypes)) for (const t of plugin.layerTypes) this.layerTypes.push(Object.assign({ pluginId: manifest.id }, t));
    if (Array.isArray(plugin.exporters)) for (const e of plugin.exporters) this.exporters.push(Object.assign({ pluginId: manifest.id }, e));
    return manifest;
  }

  unregister(id) {
    const p = this.plugins.get(id);
    if (!p) return false;
    this.plugins.delete(id);
    this.blockDefs = this.blockDefs.filter(b => b.pluginId !== id);
    this.layerTypes = this.layerTypes.filter(t => t.pluginId !== id);
    this.exporters = this.exporters.filter(e => e.pluginId !== id);
    return true;
  }

  list() { return [...this.plugins.values()]; }
  has(id) { return this.plugins.has(id); }

  on(event, fn) {
    if (!this.hooks.has(event)) this.hooks.set(event, []);
    this.hooks.get(event).push(fn);
  }
  emit(event, payload) {
    const fns = this.hooks.get(event) || [];
    return fns.map(fn => { try { return fn(payload); } catch { return null; } });
  }

  /** 沙箱校验：插件声明了它用了什么能力 */
  audit(id) {
    const p = this.plugins.get(id);
    if (!p) return null;
    const known = ['fs:read', 'fs:write', 'net', 'process', 'clipboard'];
    const unknown = (p.permissions || []).filter(x => !known.includes(x));
    return { id, permissions: p.permissions || [], unknown, risky: (p.permissions || []).some(x => ['net', 'process', 'fs:write'].includes(x)) };
  }
}

export const pluginHost = new PluginHost();