/* ============================================================
   ai-online.js · 可选在线模型接入
   ------------------------------------------------------------
   支持两类真正联网的模型，二者都走 OpenAI 兼容协议：
     - Ollama：本机 127.0.0.1:11434，免费、无需 API Key
     - 自定义：任意兼容 /chat/completions 的服务（OpenAI、DeepSeek、
       OpenRouter、vLLM、LM Studio …），Base URL + 模型 + Key 自己填

   本模块只做「调用 + 把模型输出收敛成合法 Action[]」。
   模型不受信任：op 必须在白名单里，槽位值按 blocks.js 的类型重新
   包装成 IR 字面量，非法参数直接丢弃并给出告警；最终仍由
   ai.js 的 actionsToBlocks 编译，所以在线失败可以无缝回退本地规则。
   ============================================================ */

import { defOf, EASINGS } from './blocks.js';
import { ACTION_SLOT_ORDER, splitForSubtitle, suggestEffect } from './ai.js';
import { uid, NUM, STR, COL, TIME, SEL, BOOL } from './ir.js';

export const AI_CONFIG_KEY = 'baf.aiConfig.v1';

const OLLAMA_DEFAULTS = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5:7b',
  apiKey: '',
};

export const AI_PROVIDERS = {
  local: { label: '内置规则引擎（免费 · 离线）', online: false },
  ollama: { label: 'Ollama 本地模型（免费 · 离线）', online: true },
  custom: { label: '自定义 OpenAI 兼容接口', online: true },
};

/** 在线模型可生成的积木：只开放能独立产生画面的语句积木 */
const ONLINE_OPS = [
  'charPopIn', 'stagger', 'typewriter', 'fadeIn', 'fadeOut', 'moveIn', 'scaleIn',
  'maskWipe', 'pathSweep', 'numberRoll', 'highlightWord', 'audioBars', 'ringSpectrum',
  'growBar', 'drawLine', 'wait',
];
const ONLINE_OP_SET = new Set(ONLINE_OPS);

/** 分镜建议允许的动效 */
const STORY_OPS = [
  'charPopIn', 'stagger', 'typewriter', 'fadeIn', 'fadeOut', 'moveIn',
  'scaleIn', 'maskWipe', 'numberRoll',
];
const STORY_OP_SET = new Set(STORY_OPS);

const SLOT_WRAP = { num: NUM, time: TIME, sel: SEL, col: COL, str: STR, bool: BOOL };

/* ============================================================
   配置
   ============================================================ */

export function defaultConfig() {
  return {
    provider: 'local',
    ollama: { ...OLLAMA_DEFAULTS },
    custom: { baseUrl: '', model: '', apiKey: '' },
  };
}

export function normalizeBaseUrl(url) {
  let s = String(url ?? '').trim();
  if (!s) return '';
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/chat\/completions$/i, '');
  return s.replace(/\/+$/, '');
}

export function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const provider = AI_PROVIDERS[r.provider] ? r.provider : 'local';
  const out = {
    provider,
    ollama: { ...OLLAMA_DEFAULTS },
    custom: { baseUrl: '', model: '', apiKey: '' },
  };

  for (const p of ['ollama', 'custom']) {
    // 兼容旧版扁平结构 {provider, baseUrl, model, apiKey}
    const src = (r.profiles && r.profiles[p]) || r[p] || (r.provider === p ? r : null);
    if (!src || typeof src !== 'object') continue;
    out[p] = {
      baseUrl: normalizeBaseUrl(src.baseUrl ?? out[p].baseUrl),
      model: String(src.model ?? out[p].model ?? '').trim(),
      apiKey: String(src.apiKey ?? out[p].apiKey ?? '').trim(),
    };
  }
  return out;
}

/** 当前 provider 对应的扁平配置，调用方不用关心 profiles 结构 */
export function activeProfile(config) {
  const cfg = normalizeConfig(config);
  if (cfg.provider === 'local') return { provider: 'local', baseUrl: '', model: '', apiKey: '' };
  return { provider: cfg.provider, ...cfg[cfg.provider] };
}

export function setProfile(config, provider, patch = {}) {
  const next = normalizeConfig(config);
  if (provider === 'local' || !AI_PROVIDERS[provider]) {
    next.provider = 'local';
    return next;
  }
  next.provider = provider;
  next[provider] = {
    baseUrl: normalizeBaseUrl(patch.baseUrl ?? next[provider].baseUrl),
    model: String(patch.model ?? next[provider].model ?? '').trim(),
    apiKey: String(patch.apiKey ?? next[provider].apiKey ?? '').trim(),
  };
  return next;
}

export function loadConfig(storage = globalThis.localStorage) {
  try {
    const raw = storage && storage.getItem(AI_CONFIG_KEY);
    if (!raw) return defaultConfig();
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(config, storage = globalThis.localStorage) {
  const cfg = normalizeConfig(config);
  try { storage && storage.setItem(AI_CONFIG_KEY, JSON.stringify(cfg)); } catch { }
  return cfg;
}

export function providerLabel(provider) {
  return (AI_PROVIDERS[provider] || AI_PROVIDERS.local).label;
}

export function validateConfig(config, { requireModel = true } = {}) {
  const cfg = normalizeConfig(config);
  if (cfg.provider === 'local') {
    return { provider: 'local', baseUrl: '', model: '', apiKey: '' };
  }

  const p = cfg[cfg.provider];
  if (!p.baseUrl) throw new Error('请先填写 Base URL');
  let u;
  try { u = new URL(p.baseUrl); } catch { throw new Error('Base URL 格式不正确，示例：http://127.0.0.1:11434/v1'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Base URL 只支持 http/https');
  if (requireModel && !p.model) throw new Error('请填写模型名，例如 qwen2.5:7b');
  return { provider: cfg.provider, ...p };
}

export function apiUrl(baseUrl, path) {
  const root = normalizeBaseUrl(baseUrl);
  return root + (path.startsWith('/') ? path : '/' + path);
}

/* ============================================================
   提示词与动作白名单
   ============================================================ */

let catalogCache = null;

export function actionCatalog() {
  if (catalogCache) return catalogCache;
  catalogCache = ONLINE_OPS.map(op => {
    const def = defOf(op);
    if (!def) return null;
    const order = ACTION_SLOT_ORDER[op] || [];
    const slots = [];
    order.forEach((key, i) => {
      if (!key) return;
      const spec = def.slots[i];
      if (!spec || spec.type === 'blocks') return;
      slots.push({ key, type: spec.type, label: spec.label, menu: spec.menu || null });
    });
    return { op, label: def.label, desc: def.desc || '', slots };
  }).filter(Boolean);
  return catalogCache;
}

const TYPE_HINT = {
  num: '数字', time: '秒（数字）', str: '字符串',
  sel: '选项字符串', col: '颜色 #RRGGBB', bool: 'true/false',
};

function menuOptions(menu) {
  if (Array.isArray(menu)) return menu;
  if (menu === 'easings') return EASINGS.map(e => e[0]);
  return null;
}

function formatSlot(slot) {
  const opts = menuOptions(slot.menu);
  let hint = TYPE_HINT[slot.type] || slot.type;
  if (opts) hint = `可选 ${opts.join('/')}`;
  else if (['layersText', 'layersShape', 'targets', 'markers'].includes(slot.menu)) hint = '图层名，只能从上下文图层里选';
  return `${slot.key}（${slot.label}，${hint}）`;
}

export function formatActionCatalog() {
  return actionCatalog().map(a => {
    const slots = a.slots.length ? `｜${a.slots.map(formatSlot).join('；')}` : '';
    return `- ${a.op}「${a.label}」：${a.desc}${slots}`;
  }).join('\n');
}

export function buildActionMessages({ text, layers = [], markers = [], duration = 6, fps = 24 } = {}) {
  const system = [
    '你是「积木动画工厂」的动画编排助手，只负责把用户的一句话翻译成动画积木动作。',
    '输出必须是单个 JSON 对象，格式：',
    '{"actions":[{"op":"fadeIn","slots":{"layer":"标题文字","dur":1.2,"start":0},"why":"标题淡入"}]}',
    '',
    '硬性规则：',
    '1. 不要输出 Markdown 代码块、解释、注释或 JSON 以外的任何文字。',
    '2. op 只能从下面列表里选；slots 的键只能用该 op 列出的参数，不要自造参数。',
    '3. 参数直接写原始值（数字 / 字符串 / 布尔），不要写表达式、函数或代码；时间单位是秒。',
    '4. 用户没提到的参数直接省略，系统会填默认值；动作按执行顺序排列，最多 12 个。',
    '5. layer 必须从用户给出的图层名里选；没有合适图层时省略该参数。',
    '6. why 用一句中文说明这样安排的原因。',
    '',
    '可用积木：',
    formatActionCatalog(),
  ].join('\n');

  const user = [
    `图层列表：${layers.length ? layers.join('、') : '（无，可省略 layer 参数）'}`,
    `标记点：${markers.length ? markers.join('、') : '（无）'}`,
    `工程时长：${duration} 秒，${fps} fps`,
    `用户要求：${text}`,
  ].join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

export function buildStoryboardMessages({ text, duration = 6, fps = 24 } = {}) {
  const system = [
    '你是短视频分镜助手，把一段口播文案按语义拆成 1–8 个分镜。',
    '只输出单个 JSON 对象：',
    '{"scenes":[{"text":"分镜文字","duration":2.5,"op":"fadeIn","reason":"常规陈述，淡入最稳妥"}]}',
    '',
    '规则：',
    '1. 不增删、不改写原文，按原文顺序拆分；text 去掉句末标点。',
    '2. duration 是数字秒，范围 0.8–8；没有把握就按每秒 5.5 字估算。',
    `3. op 只能是：${STORY_OPS.join('、')}。`,
    '4. reason 用一句中文说明为什么选这个动效。',
    '5. 不要 Markdown、解释或 JSON 以外的任何文字。',
  ].join('\n');

  const user = [
    `工程时长：${duration} 秒，${fps} fps`,
    '文案：',
    String(text || ''),
  ].join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/* ============================================================
   模型输出 → 合法 Action[]
   ============================================================ */

export function extractJSON(text) {
  let s = String(text ?? '').trim();
  if (!s) throw new Error('模型返回为空');
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  const start = s.search(/[\[{]/);
  if (start < 0) throw new Error('模型返回的不是 JSON');
  const sliced = s.slice(start);
  try { return JSON.parse(sliced); } catch { /* 后面可能还跟了解释文字 */ }

  const end = Math.max(sliced.lastIndexOf('}'), sliced.lastIndexOf(']'));
  if (end > 0) {
    try { return JSON.parse(sliced.slice(0, end + 1)); } catch { }
  }
  throw new Error('模型返回的 JSON 无法解析');
}

function coerceSlotValue(value, spec, { layers, op, key }) {
  const type = spec.type;
  if (type === 'num' || type === 'time') {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, reason: `不是有效数字：${JSON.stringify(value)}` };
    if (type === 'time' && n < 0) return { ok: false, reason: '时间不能为负数' };
    return { ok: true, value: n };
  }
  if (type === 'bool') {
    return { ok: true, value: value === true || value === 'true' || value === 1 || value === '1' };
  }

  const s = String(value).trim();
  if (!s) return { ok: false, reason: '值为空' };
  if (type === 'col') {
    if (!/^#[0-9a-f]{3,8}$/i.test(s) && !/^[a-z]{3,20}$/i.test(s)) {
      return { ok: false, reason: `不是有效颜色：${s}` };
    }
    return { ok: true, value: s };
  }
  if (type === 'sel') {
    const opts = menuOptions(spec.menu);
    if (opts && !opts.includes(s)) return { ok: false, reason: `不在可选值 ${opts.join('/')} 里：${s}` };
    if (['layersText', 'layersShape', 'targets', 'markers'].includes(spec.menu)) {
      if (layers.length && !layers.includes(s)) return { ok: false, reason: `图层「${s}」不存在` };
    }
    return { ok: true, value: s };
  }
  if (type === 'str') {
    if (s.length > 300) return { ok: false, reason: '文本过长' };
    return { ok: true, value: s };
  }
  void op; void key;
  return { ok: true, value: s };
}

export function coerceActions(rawActions, { layers = [] } = {}) {
  const actions = [];
  const warnings = [];

  for (const raw of Array.isArray(rawActions) ? rawActions : []) {
    if (!raw || typeof raw !== 'object') { warnings.push('忽略了一个不是对象的动作'); continue; }
    const op = String(raw.op || '');
    if (!ONLINE_OP_SET.has(op)) { warnings.push(`忽略未知积木 ${op || '(空)'}`); continue; }

    const def = defOf(op);
    const order = ACTION_SLOT_ORDER[op] || [];
    const src = raw.slots && typeof raw.slots === 'object' ? raw.slots : {};
    const slots = {};

    order.forEach((key, i) => {
      if (!key) return;
      const spec = def.slots[i];
      if (!spec || spec.type === 'blocks') return;
      let value = src[key];
      if (value === undefined || value === null) return;
      if (typeof value === 'object') value = value.v ?? value.value;
      if (value === undefined || value === null) return;

      const r = coerceSlotValue(value, spec, { layers, op, key });
      if (r.ok) slots[key] = SLOT_WRAP[spec.type](r.value);
      else warnings.push(`${op}.${key}：${r.reason}`);
    });

    actions.push({ op, slots, why: String(raw.why || def.label).slice(0, 120) });
    if (actions.length >= 12) {
      warnings.push('动作超过 12 个，只保留前 12 个');
      break;
    }
  }

  return { actions, warnings };
}

export function parseActionsFromContent(content, { layers = [] } = {}) {
  const data = extractJSON(content);
  const raw = Array.isArray(data) ? data : data && data.actions;
  if (!Array.isArray(raw) || !raw.length) throw new Error('模型没有返回动作');
  const out = coerceActions(raw, { layers });
  if (!out.actions.length) throw new Error('模型返回的动作都无法识别');
  return out;
}

/* ============================================================
   网络调用
   ============================================================ */

function httpError(status, data, raw) {
  const detail = data?.error?.message || data?.message
    || String(raw || '').replace(/\s+/g, ' ').slice(0, 160);
  return new Error(`接口返回 ${status}${detail ? `：${detail}` : ''}`);
}

function timeoutError(e, aborted) {
  if (aborted) return new Error('请求超时');
  const msg = e && e.message ? e.message : String(e);
  return new Error(`网络请求失败（检查 Base URL 与跨域设置）：${msg}`);
}

export async function chatCompletion(config, messages, opts = {}) {
  const cfg = normalizeConfig(config);
  const profile = validateConfig(cfg);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持网络请求');

  const headers = { 'Content-Type': 'application/json' };
  if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
  const body = {
    model: profile.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    stream: false,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60000);
  let res;
  try {
    res = await fetchImpl(apiUrl(profile.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw timeoutError(e, ctrl.signal.aborted);
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { }
  if (!res.ok) throw httpError(res.status, data, raw);

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('接口没有返回内容');
  return content;
}

export async function testConnection(config, opts = {}) {
  const cfg = normalizeConfig(config);
  const profile = validateConfig(cfg, { requireModel: false });
  if (profile.provider === 'local') return { ok: true, models: [], note: '本地规则引擎无需连接' };

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持网络请求');

  const headers = {};
  if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000);
  let res;
  try {
    res = await fetchImpl(apiUrl(profile.baseUrl, '/models'), { method: 'GET', headers, signal: ctrl.signal });
  } catch (e) {
    throw timeoutError(e, ctrl.signal.aborted);
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { }

  if (!res.ok) {
    // 有些兼容服务不实现 /models；用一次最小请求验证接口是否真的可用
    if ((res.status === 404 || res.status === 405) && profile.model) {
      await chatCompletion(cfg, [{ role: 'user', content: 'ping' }], {
        fetchImpl, timeoutMs: opts.timeoutMs ?? 15000, maxTokens: 1,
      });
      return { ok: true, models: [], note: '接口可访问（该服务未提供模型列表）' };
    }
    throw httpError(res.status, data, raw);
  }

  const list = Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.models) ? data.models : [];
  const models = list
    .map(m => (typeof m === 'string' ? m : m?.id || m?.name || ''))
    .filter(Boolean);
  return { ok: true, models, note: models.length ? '' : '接口可访问' };
}

export async function parseActions(text, opts = {}) {
  const cfg = normalizeConfig(opts.config);
  const profile = validateConfig(cfg);
  if (profile.provider === 'local') throw new Error('当前是本地规则引擎');

  const content = await chatCompletion(
    cfg,
    buildActionMessages({
      text,
      layers: opts.layers || [],
      markers: opts.markers || [],
      duration: opts.duration ?? 6,
      fps: opts.fps ?? 24,
    }),
    { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs },
  );

  const parsed = parseActionsFromContent(content, { layers: opts.layers || [] });
  return { ...parsed, engine: 'online', provider: profile.provider, model: profile.model };
}

/* ============================================================
   文案分镜（在线）
   ============================================================ */

const round2 = (n) => Math.round(n * 100) / 100;

export function coerceStoryboard(data, { sourceText = '' } = {}) {
  const raw = Array.isArray(data) ? data : data && data.scenes;
  if (!Array.isArray(raw) || !raw.length) throw new Error('模型没有返回分镜');

  const scenes = [];
  const gap = 0.35;
  let cursor = 0;

  for (const item of raw.slice(0, 12)) {
    if (!item || typeof item !== 'object') continue;
    const text = String(item.text || '').trim().replace(/[。！？!?；;，,、]$/, '');
    if (!text) continue;

    let duration = Number(item.duration);
    if (!Number.isFinite(duration) || duration <= 0) duration = [...text].length / 5.5;
    duration = round2(Math.min(8, Math.max(0.8, duration)));

    const guessed = suggestEffect(text);
    const op = STORY_OP_SET.has(item.op) ? item.op : guessed.op;
    const reason = String(item.reason || '').trim() || (op === guessed.op ? guessed.reason : '在线模型推荐');

    const scene = {
      id: uid('SC'),
      index: scenes.length,
      text,
      start: round2(cursor),
      end: round2(cursor + duration),
      duration,
      suggested: { op, reason: reason.slice(0, 120), confidence: 0.75 },
      subtitleText: splitForSubtitle(text),
      markers: [
        { name: `SC${scenes.length + 1}`, time: round2(cursor), label: text.slice(0, 10) },
      ],
    };
    scenes.push(scene);
    cursor += duration + gap;
  }

  if (!scenes.length) throw new Error('模型返回的分镜都无法使用');
  return {
    scenes,
    totalDuration: round2(Math.max(0, cursor - gap)),
    wordCount: [...String(sourceText).replace(/\s/g, '')].length,
  };
}

export function parseStoryboardFromContent(content, { sourceText = '' } = {}) {
  return coerceStoryboard(extractJSON(content), { sourceText });
}

export async function generateStoryboard(text, opts = {}) {
  const cfg = normalizeConfig(opts.config);
  const profile = validateConfig(cfg);
  if (profile.provider === 'local') throw new Error('当前是本地规则引擎');

  const content = await chatCompletion(
    cfg,
    buildStoryboardMessages({ text, duration: opts.duration ?? 6, fps: opts.fps ?? 24 }),
    { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, maxTokens: 1200 },
  );
  const sb = parseStoryboardFromContent(content, { sourceText: text });
  return { ...sb, engine: 'online', provider: profile.provider, model: profile.model };
}
