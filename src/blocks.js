/* ============================================================
   blocks.js · 积木库定义
   ------------------------------------------------------------
   每个积木定义:
   {
     op, cat(分类), label, color, desc,
     isLeaf: true  → 表达式积木（返回数值），slots = [a,b]
     isLeaf: false → 语句积木（C 形），slots = [子积木 / 参数]
   }
   slots 里的 default 用 'C:' 前缀标记子积木列表。
   ============================================================ */

/* 配色沿用 Scratch 3 的分类色板 */
export const CATS = {
  time:    { label: '时间轴', color: '#ffab19', desc: '控制什么时候发生、持续多久 —— 程序化时间轴的全部' },
  text:    { label: '文字',   color: '#9966ff', desc: '文字引擎：结构拆分、入场动效、文本表达式' },
  shape:   { label: '图形',   color: '#0fbd8c', desc: '图元、路径、参数化图形、重复器' },
  fx:      { label: '动效',   color: '#4c97ff', desc: '入场 / 退场 / 循环 / 弹性预设' },
  math:    { label: '数学',   color: '#59c059', desc: '四则运算、缓动、取模、插值、随机' },
  color:   { label: '颜色',   color: '#ff6680', desc: '混合、插值、调色' },
  logic:   { label: '逻辑',   color: '#5cb1d6', desc: '比较、条件、开关' },
  arr:     { label: '数组',   color: '#ff8c1a', desc: '随机取值、重复、索引' },
  audio:   { label: '音频驱动', color: '#cf63cf', desc: '把声音变成可编程的数据源（差异化能力）' },
  marker:  { label: '标记点', color: '#ffbf00', desc: '锚点：把画面绑定到配音与节拍' },
};

/* helper：构造 slot 描述 */
const P = (type, label, def, extra = {}) => Object.assign({ type, label, default: def }, extra);
const C = (label, def = []) => ({ type: 'blocks', label, default: def });

export const BLOCK_DEFS = [
  /* ---------------- 时间轴（语句） ---------------- */
  {
    op: 'wait', cat: 'time', color: CATS.time.color, label: '等待', desc: '空转等待指定时长',
    isLeaf: false,
    slots: [P('time', '时长', 1)],
  },
  {
    op: 'setAt', cat: 'time', color: CATS.time.color, label: '在时间点', desc: '把后续积木挂到绝对时间点（兜底手关键帧）',
    isLeaf: false,
    slots: [P('time', '时刻', 0), C('做什么')],
  },
  {
    op: 'atMarker', cat: 'marker', color: CATS.marker.color, label: '在标记点', desc: '把后续积木绑定到锚点，改配音自动跟随',
    isLeaf: false,
    slots: [P('sel', '标记名', '', { menu: 'markers' }), C('做什么')],
  },
  {
    op: 'after', cat: 'time', color: CATS.time.color, label: '之后', desc: '上一个元素结束后延迟 N 秒开始',
    isLeaf: false,
    slots: [P('time', '延迟', 0.2), C('做什么')],
  },
  {
    op: 'loop', cat: 'time', color: CATS.time.color, label: '重复 N 次', desc: '顺序重复执行子积木',
    isLeaf: false,
    slots: [P('num', '次数', 3), C('每次')],
  },
  {
    op: 'parallel', cat: 'time', color: CATS.time.color, label: '同时执行', desc: '并列执行，所有子积木同一时刻开始',
    isLeaf: false,
    slots: [C('并行 1'), C('并行 2')],
  },
  {
    op: 'waitUntilMarker', cat: 'marker', color: CATS.marker.color, label: '等到标记点', desc: '暂停到指定锚点再继续',
    isLeaf: false,
    slots: [P('sel', '标记名', '', { menu: 'markers' })],
  },
  /* 变量：全库原本没有任何「写变量」的 op，于是 evaluator 的 setVar 零调用，
     工程里声明的变量永远只能是初值。这里只新增这一个 op，不动任何已有 op。 */
  {
    op: 'setVar', cat: 'math', color: CATS.math.color, label: '设置变量', desc: '把值写进变量，后续表达式与文字里的 $变量 都能读到',
    isLeaf: false,
    slots: [P('str', '变量名', 'score', { placeholder: '不带 $，例如 score' }), P('num', '值', 0)],
  },

  /* ---------------- 文字（语句） ---------------- */
  {
    op: 'showText', cat: 'text', color: CATS.text.color, label: '显示文字', desc: '让图层文字显示出来（默认隐藏）',
    isLeaf: false,
    slots: [P('sel', '图层', '标题文字', { menu: 'layersText' }), P('str', '内容', '', { placeholder: '留空=图层原值' })],
  },
  {
    op: 'setText', cat: 'text', color: CATS.text.color, label: '设置文字', desc: '直接改写图层文本内容',
    isLeaf: false,
    slots: [P('sel', '图层', '标题文字', { menu: 'layersText' }), P('str', '内容', '新内容')],
  },
  {
    op: 'splitBy', cat: 'text', color: CATS.text.color, label: '按单位拆分', desc: '结构拆分：整块/逐行/逐词/逐字，逐单元可独立驱动',
    isLeaf: false,
    slots: [P('sel', '图层', '标题文字', { menu: 'layersText' }), P('sel', '单位', 'char', { menu: ['whole', 'line', 'word', 'char'] })],
  },
  {
    op: 'stagger', cat: 'text', color: CATS.text.color, label: '错峰延迟', desc: '每个拆分单元依次延迟入场',
    isLeaf: false,
    slots: [P('sel', '图层', '标题文字', { menu: 'layersText' }), P('time', '单元间隔', 0.05), P('time', '起始延迟', 0)],
  },
  {
    op: 'typewriter', cat: 'text', color: CATS.text.color, label: '打字机', desc: '按字符逐个显现，像打字一样',
    isLeaf: false,
    slots: [P('sel', '图层', '标题文字', { menu: 'layersText' }), P('num', '每秒字数', 12), P('time', '起始', 0)],
  },
  {
    op: 'charPopIn', cat: 'text', color: CATS.text.color, label: '逐字弹入', desc: '每个字符带回弹地弹出来',
    isLeaf: false,
    slots: [P('sel', '图层', '标题文字', { menu: 'layersText' }), P('time', '起始', 0), P('num', '间隔', 0.05), P('sel', '动画', 'backOut', { menu: ['backOut', 'elasticOut', 'bounceOut'] })],
  },
  {
    op: 'fadeIn', cat: 'fx', color: CATS.fx.color, label: '淡入', desc: '透明度 0 → 1',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('time', '时长', 0.5), P('time', '起始', 0)],
  },
  {
    op: 'fadeOut', cat: 'fx', color: CATS.fx.color, label: '淡出', desc: '透明度 1 → 0',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('time', '时长', 0.5), P('time', '起始', 0)],
  },
  {
    op: 'moveIn', cat: 'fx', color: CATS.fx.color, label: '位移入场', desc: '从偏移位置滑入',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('sel', '方向', 'left', { menu: ['left', 'right', 'up', 'down'] }), P('num', '距离', 120), P('time', '时长', 0.6), P('time', '起始', 0), P('sel', '缓动', 'outCubic', { menu: 'easings' })],
  },
  {
    op: 'scaleIn', cat: 'fx', color: CATS.fx.color, label: '缩放入场', desc: '从 0 放大到 1',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', '从', 0), P('num', '到', 1), P('time', '时长', 0.6), P('time', '起始', 0), P('sel', '缓动', 'backOut', { menu: 'easings' })],
  },
  {
    op: 'maskWipe', cat: 'text', color: CATS.text.color, label: '遮罩擦除', desc: '用矩形遮罩从左到右擦出文字（字幕入场最常用）',
    isLeaf: false,
    slots: [P('sel', '图层', '标题文字', { menu: 'layersText' }), P('time', '时长', 0.8), P('time', '起始', 0), P('sel', '方向', 'left', { menu: ['left', 'right', 'up', 'down'] })],
  },
  {
    op: 'pathSweep', cat: 'text', color: CATS.text.color, label: '路径扫过', desc: '文字沿一条正弦路径浮现',
    isLeaf: false,
    slots: [P('sel', '图层', '标题文字', { menu: 'layersText' }), P('time', '时长', 1.2), P('time', '起始', 0), P('num', '振幅', 60)],
  },
  {
    op: 'numberRoll', cat: 'text', color: CATS.text.color, label: '数字滚动', desc: '数值从 0 滚到目标（金额、序号）',
    isLeaf: false,
    slots: [P('sel', '图层', '标题文字', { menu: 'layersText' }), P('num', '目标值', 100), P('time', '时长', 1.5), P('time', '起始', 0), P('num', '小数位', 0)],
  },
  {
    op: 'highlightWord', cat: 'audio', color: CATS.audio.color, label: '逐词高亮', desc: '口播 karaoke 字幕：说到哪个词哪个词变色',
    isLeaf: false,
    slots: [P('sel', '图层', '标题文字', { menu: 'layersText' }), P('str', '台词', '', { placeholder: '逐词高亮的文本' }), P('time', '起始', 0), P('col', '高亮色', '#ffd166')],
  },

  /* ---------------- 图形（语句） ---------------- */
  {
    op: 'drawShape', cat: 'shape', color: CATS.shape.color, label: '绘制图元', desc: '创建并显示一个基础图元',
    isLeaf: false,
    slots: [P('sel', '图层', '装饰方块', { menu: 'layersShape' }), P('col', '填充', '#4a8cff'), P('num', '宽', 400), P('num', '高', 120), P('num', '圆角', 12)],
  },
  {
    op: 'setFill', cat: 'shape', color: CATS.shape.color, label: '设置填充', desc: '',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('col', '颜色', '#4a8cff'), P('time', '时长', 0), P('time', '起始', 0)],
  },
  {
    op: 'growBar', cat: 'shape', color: CATS.shape.color, label: '柱状图生长', desc: '数据驱动的柱状图逐根生长（财经科普刚需）',
    isLeaf: false,
    slots: [P('sel', '图层', '', { menu: 'layersShape' }), P('str', '数据', '30,55,80,45', { placeholder: '逗号分隔数值' }), P('time', '单根时长', 0.5), P('time', '间隔', 0.12), P('time', '起始', 0), P('col', '颜色', '#38c98b')],
  },
  {
    op: 'drawLine', cat: 'shape', color: CATS.shape.color, label: '折线图生长', desc: '折线按点依次绘出',
    isLeaf: false,
    slots: [P('sel', '图层', '', { menu: 'layersShape' }), P('str', '数据', '10,40,25,70,95', { placeholder: '逗号分隔' }), P('time', '整段时长', 1.5), P('time', '起始', 0), P('col', '颜色', '#ffb020')],
  },
  {
    op: 'repeater', cat: 'shape', color: CATS.shape.color, label: '重复器', desc: '一个元素按数组复制 N 份并错峰',
    isLeaf: false,
    slots: [P('num', '份数', 8), P('num', '水平间距', 90), P('time', '错峰间隔', 0.06), P('time', '起始', 0), P('num', '起始高度', 20)],
  },
  {
    op: 'audioBars', cat: 'audio', color: CATS.audio.color, label: '音频波形柱', desc: '内建合成音频驱动柱状波形（实时振幅）',
    isLeaf: false,
    slots: [P('sel', '图层', '', { menu: 'layersShape' }), P('num', '柱数', 48), P('time', '起始', 0), P('col', '颜色', '#7c5cff'), P('num', '增益', 1)],
  },
  {
    op: 'ringSpectrum', cat: 'audio', color: CATS.audio.color, label: '环形频谱', desc: '频段能量驱动的环形频谱',
    isLeaf: false,
    slots: [P('sel', '图层', '', { menu: 'layersShape' }), P('num', '环数', 64), P('time', '起始', 0), P('col', '颜色', '#38c98b'), P('num', '半径', 300)],
  },
  {
    op: 'particles', cat: 'shape', color: CATS.shape.color, label: '粒子系统', desc: '发射器 + 力场，节点控制生命周期',
    isLeaf: false,
    slots: [P('num', '粒子数', 90), P('time', '起始', 0), P('time', '时长', 3), P('col', '颜色', '#4a8cff'), P('num', '速度', 180)],
  },

  /* ---------------- 数学（表达式） ---------------- */
  { op: 'add', cat: 'math', color: CATS.math.color, label: '加', desc: 'a + b', isLeaf: true },
  { op: 'sub', cat: 'math', color: CATS.math.color, label: '减', desc: 'a − b', isLeaf: true },
  { op: 'mul', cat: 'math', color: CATS.math.color, label: '乘', desc: 'a × b', isLeaf: true },
  { op: 'div', cat: 'math', color: CATS.math.color, label: '除', desc: 'a ÷ b（除零返回 0）', isLeaf: true },
  { op: 'mod', cat: 'math', color: CATS.math.color, label: '取余', desc: 'a mod b', isLeaf: true },
  { op: 'clamp', cat: 'math', color: CATS.math.color, label: '限制范围', desc: '把数值限制在 min 与 max 之间', isLeaf: true },
  { op: 'lerp', cat: 'math', color: CATS.math.color, label: '插值', desc: '在 a 与 b 之间按 t 插值', isLeaf: true },
  { op: 'tween', cat: 'math', color: CATS.math.color, label: '帧内插值', desc: '从 from 到 to，按当前时间在时长内缓动', isLeaf: true,
    slots: [] },
  { op: 'noise', cat: 'math', color: CATS.math.color, label: '噪声', desc: '确定性伪随机（同一时间永远同值）', isLeaf: true },
  { op: 'sin', cat: 'math', color: CATS.math.color, label: '正弦', desc: 'sin(a) × b', isLeaf: true },
  { op: 'cos', cat: 'math', color: CATS.math.color, label: '余弦', desc: 'cos(a) × b', isLeaf: true },
  { op: 'abs', cat: 'math', color: CATS.math.color, label: '绝对值', desc: '|a|', isLeaf: true },
  { op: 'frame', cat: 'math', color: CATS.math.color, label: '当前帧', desc: '返回当前帧号', isLeaf: true },
  { op: 'time', cat: 'math', color: CATS.math.color, label: '当前时间', desc: '返回当前时间（秒）', isLeaf: true },
  { op: 'progress', cat: 'math', color: CATS.math.color, label: '总进度', desc: '0 → 1（工程进度）', isLeaf: true },

  /* ---------------- 颜色（表达式） ---------------- */
  { op: 'mixCol', cat: 'color', color: CATS.color.color, label: '颜色混合', desc: '两色按 t 混合（t 必须是 0→1 的数值积木）', isLeaf: true },
  { op: 'hsl', cat: 'color', color: CATS.color.color, label: 'HSL 取色', desc: '色相 0-360，饱和/亮度 0-100', isLeaf: true },

  /* ---------------- 逻辑（表达式） ---------------- */
  { op: 'gt', cat: 'logic', color: CATS.logic.color, label: '大于', desc: '', isLeaf: true },
  { op: 'lt', cat: 'logic', color: CATS.logic.color, label: '小于', desc: '', isLeaf: true },
  { op: 'eq', cat: 'logic', color: CATS.logic.color, label: '等于', desc: '', isLeaf: true },
  { op: 'and', cat: 'logic', color: CATS.logic.color, label: '且', desc: '', isLeaf: true },
  { op: 'or', cat: 'logic', color: CATS.logic.color, label: '或', desc: '', isLeaf: true },
  { op: 'not', cat: 'logic', color: CATS.logic.color, label: '非', desc: '', isLeaf: true },
  { op: 'if', cat: 'logic', color: CATS.logic.color, label: '如果…那么', desc: '条件成立执行 A，否则执行 B',
    isLeaf: false,
    slots: [P('bool', '条件', true), C('成立时'), C('否则')] },

  /* ---------------- 数组（表达式） ---------------- */
  { op: 'randRange', cat: 'arr', color: CATS.arr.color, label: '区间随机', desc: '在 a 与 b 之间取整数（按帧确定性）', isLeaf: true },
  { op: 'noise1D', cat: 'arr', color: CATS.arr.color, label: '一维噪声', desc: '平滑随机序列，用于有机运动', isLeaf: true },

  /* ---------------- 音频驱动（表达式） ---------------- */
  { op: 'amp', cat: 'audio', color: CATS.audio.color, label: '实时振幅', desc: '当前时刻音量 0→1', isLeaf: true },
  { op: 'bass', cat: 'audio', color: CATS.audio.color, label: '低频能量', desc: 'Bass 频段能量 0→1', isLeaf: true },
  { op: 'mid', cat: 'audio', color: CATS.audio.color, label: '中频能量', desc: 'Mid 频段能量 0→1', isLeaf: true },
  { op: 'treble', cat: 'audio', color: CATS.audio.color, label: '高频能量', desc: 'Treble 频段能量 0→1', isLeaf: true },
  { op: 'beat', cat: 'audio', color: CATS.audio.color, label: '节拍脉冲', desc: '每个节拍触发一次 1→0', isLeaf: true },
  { op: 'bpm', cat: 'audio', color: CATS.audio.color, label: 'BPM', desc: '当前音频每分钟节拍数', isLeaf: true },
];

export const BLOCK_BY_OP = new Map(BLOCK_DEFS.map(d => [d.op, d]));

export function defOf(op) { return BLOCK_BY_OP.get(op) || null; }

/* 表达式积木的参数槽（用于渲染与求值） */
export const LEAF_SLOTS = {
  add:       [['num', 'a', 0], ['num', 'b', 1]],
  sub:       [['num', 'a', 0], ['num', 'b', 1]],
  mul:       [['num', 'a', 1], ['num', 'b', 1]],
  div:       [['num', 'a', 1], ['num', 'b', 1]],
  mod:       [['num', 'a', 1], ['num', 'b', 1]],
  clamp:     [['num', '值', 0.5], ['num', '下限', 0], ['num', '上限', 1]],
  lerp:      [['num', 'a', 0], ['num', 'b', 1], ['num', 't', 0.5]],
  tween:     [['num', '从', 0], ['num', '到', 1], ['num', '时长', 1], ['num', '起始', 0], ['sel', '缓动', 'linear', { menu: 'easings' }]],
  noise:     [['num', '种子', 0], ['num', '缩放', 1]],
  sin:       [['num', '相位', 0], ['num', '幅度', 1]],
  cos:       [['num', '相位', 0], ['num', '幅度', 1]],
  abs:       [['num', 'a', 0]],
  frame:     [],
  time:      [],
  progress:  [],
  mixCol:    [['col', '颜色A', '#4a8cff'], ['col', '颜色B', '#ff5a5a'], ['num', '比例 t', 0.5]],
  hsl:       [['num', '色相', 210], ['num', '饱和', 80], ['num', '亮度', 60]],
  gt:        [['num', 'a', 0], ['num', 'b', 0]],
  lt:        [['num', 'a', 0], ['num', 'b', 0]],
  eq:        [['num', 'a', 0], ['num', 'b', 0]],
  and:       [['bool', 'a', true], ['bool', 'b', true]],
  or:        [['bool', 'a', true], ['bool', 'b', false]],
  not:       [['bool', 'a', false]],
  randRange: [['num', '下限', 0], ['num', '上限', 9]],
  noise1D:   [['num', '种子', 0], ['num', '缩放', 1]],
  amp:       [['num', '偏移', 0]],
  bass:      [['num', '偏移', 0]],
  mid:       [['num', '偏移', 0]],
  treble:    [['num', '偏移', 0]],
  beat:      [['num', '偏移', 0]],
  bpm:       [],
};

export const EASINGS = [
  ['linear', '线性'],
  ['inQuad', '渐入'],
  ['outQuad', '渐出'],
  ['inOutQuad', '渐入渐出'],
  ['inCubic', '强渐入'],
  ['outCubic', '强渐出'],
  ['inOutCubic', '强渐入渐出'],
  ['outExpo', '指数渐出'],
  ['outBack', '回弹'],
  ['backOut', '回弹(别名)'],
  ['outElastic', '弹性'],
  ['elasticOut', '弹性(别名)'],
  ['outBounce', '弹跳'],
  ['bounceOut', '弹跳(别名)'],
];

export const UNIT_LABELS = { whole: '整块', line: '逐行', word: '逐词', char: '逐字' };
export const DIR_LABELS = { left: '从左', right: '从右', up: '从上', down: '从下' };

export const PALETTE_GROUPS = ['time', 'text', 'shape', 'fx', 'math', 'color', 'logic', 'arr', 'audio', 'marker'];

export function categories() {
  return PALETTE_GROUPS.map(k => ({
    key: k,
    ...CATS[k],
    defs: BLOCK_DEFS.filter(d => d.cat === k),
  }));
}

/* 为 fromText 注册 op 元数据 */
export function metaFor(op) {
  const d = defOf(op);
  if (!d) return null;
  if (d.isLeaf) return { op, isLeaf: true, slots: [] };
  return {
    op,
    isLeaf: false,
    slots: (d.slots || []).map(s => ({
      type: s.type,
      label: s.label,
      placeholder: s.placeholder,
      menu: s.menu || null,
      isSub: s.default !== undefined && Array.isArray(s.default),
    })),
  };
}
