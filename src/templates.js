/* ============================================================
   templates.js · 官方模板库
   ------------------------------------------------------------
   每个模板 = 一份完整 IR。V0 的验收标准是：
   「用积木搭出『逐字弹入标题』并导出成功」—— 对应 tpl_popTitle。
   ============================================================ */

import { defaultProject, newLayer, uid, NUM, STR, COL, TIME, SEL, BOOL, defaultForType } from './ir.js';
import { defOf } from './blocks.js';
import { AudioSource } from './evaluator.js';

/* 槽位描述：直接取积木定义，保证 label / menu / placeholder 与积木库一致 */
function blk(op, values) {
  const def = defOf(op);
  if (!def) throw new Error('未知积木：' + op);
  if (def.isLeaf) throw new Error(`${op} 是表达式积木，请用 expr()`);
  const slots = [];
  (def.slots || []).forEach((sd, i) => {
    const isSub = Array.isArray(sd.default);
    slots.push({
      type: sd.type,
      label: sd.label,
      placeholder: sd.placeholder,
      menu: sd.menu || null,
      value: isSub ? [] : (values[i] !== undefined ? values[i] : defaultForType(sd.type, sd.default)),
    });
  });
  return { id: uid('B'), k: 'C', op, slots };
}

/* 表达式积木（{k:'blk'}），值按 a,b,c,p,p2 顺序 */
function expr(op, a, b, c, p, p2) {
  const o = { id: uid('B'), k: 'blk', op };
  const keys = ['a', 'b', 'c', 'p', 'p2'];
  [a, b, c, p, p2].forEach((v, i) => { if (v !== undefined) o[keys[i]] = v; });
  return o;
}

const T = TIME, S_ = STR, C = COL, N = NUM, L = SEL;

/* ============================================================
   T1 · 逐字弹入标题（V0 验收模板）
   ============================================================ */
export function tplPopTitle() {
  const ir = defaultProject('模板 · 逐字弹入标题');
  ir.project.duration = 6;
  ir.project.background = '#0b0e14';

  const title = ir.layers[1];
  title.props.text = '积木动画工厂';
  title.props.fontSize = 150;
  title.props.fontWeight = 900;
  title.props.x = 960; title.props.y = 460;
  title.props.shadow = 18;
  title.visible = false;
  title.blocks = [
    blk('splitBy', [L('标题文字'), L('char')]),
    blk('charPopIn', [L('标题文字'), T(0.2), N(0.07), L('backOut')]),
    blk('wait', [T(0.2)]),
    blk('moveIn', [L('装饰方块'), L('left'), N(420), T(0.8), T(1.2), L('outCubic')]),
  ];

  const bar = ir.layers[2];
  bar.props.w = 520; bar.props.h = 10; bar.props.radius = 5;
  bar.props.fill = '#4a8cff';
  bar.visible = false;
  bar.blocks = [
    blk('scaleIn', [L('装饰方块'), N(0), N(1), T(0.6), T(1.2), L('outBack')]),
    blk('wait', [T(0.9)]),
    blk('scaleIn', [L('装饰方块'), N(1), N(0.0), T(0.35), T(3.4), L('inOutCubic')]),
  ];

  ir.markers = [
    { id: uid('M'), time: 0.0, label: '开场', color: '#ffb020' },
    { id: uid('M'), time: 0.2, label: '逐字开始', color: '#4a8cff' },
    { id: uid('M'), time: 1.2, label: '副标题入场', color: '#38c98b' },
    { id: uid('M'), time: 3.4, label: '收场', color: '#ff5a5a' },
  ];
  return ir;
}

/* ============================================================
   T2 · 音频驱动波形柱（差异化能力演示）
   ============================================================ */
export function tplAudioBars() {
  const ir = defaultProject('模板 · 音频驱动波形柱');
  ir.project.duration = 8;
  ir.project.background = '#070a12';

  const title = ir.layers[1];
  title.props.text = '声音驱动画面';
  title.props.fontSize = 96; title.props.fontWeight = 800;
  title.props.y = 220; title.props.x = 960;
  title.visible = false;
  title.blocks = [
    blk('maskWipe', [L('标题文字'), T(1.1), T(0.3), L('left')]),
    blk('highlightWord', [L('标题文字'), S_('拖一个节点连上就完事'), T(2.4), C('#ffd166')]),
  ];

  const bars = ir.layers[2];
  bars.type = 'rect';
  bars.name = '波形柱';
  bars.props = { x: 960, y: 640, w: 1100, h: 320, radius: 6, fill: '#7c5cff', stroke: '', strokeWidth: 0, opacity: 1, rotation: 0 };
  bars.visible = false;
  bars.blocks = [
    blk('audioBars', [L('波形柱'), N(56), T(0.3), C('#7c5cff'), N(1.4)]),
  ];

  ir.markers = [
    { id: uid('M'), time: 0.3, label: '入场', color: '#ffb020' },
    { id: uid('M'), time: 2.4, label: '逐词高亮', color: '#ffd166' },
    { id: uid('M'), time: 4.0, label: '重音', color: '#38c98b' },
  ];
  return ir;
}

/* ============================================================
   T3 · 数据榜单（财经号刚需）
   ============================================================ */
export function tplBarChart() {
  const ir = defaultProject('模板 · 数据榜单柱状图');
  ir.project.duration = 7;
  ir.project.background = '#0d1017';

  const title = ir.layers[1];
  title.props.text = '2025 各季度营收';
  title.props.fontSize = 110; title.props.fontWeight = 800;
  title.props.x = 960; title.props.y = 190;
  title.visible = false;
  title.blocks = [blk('charPopIn', [L('标题文字'), T(0.2), N(0.08), L('backOut')])];

  const chart = ir.layers[2];
  chart.type = 'rect';
  chart.name = '柱状图';
  chart.props = { x: 960, y: 640, w: 1200, h: 460, radius: 0, fill: '#38c98b', stroke: '', strokeWidth: 0, opacity: 1, rotation: 0 };
  chart.visible = false;
  chart.blocks = [
    blk('growBar', [L('柱状图'), S_('42,68,91,57'), T(0.7), T(0.16), T(0.9), C('#38c98b')]),
  ];

  const line = newLayer('趋势线', 'rect', { x: 960, y: 420, w: 1200, h: 200, fill: '#ffb020', opacity: 1, rotation: 0 });
  ir.layers.push(line);
  line.blocks = [
    blk('drawLine', [L('趋势线'), S_('38,52,60,80,74,96'), T(2.2), T(2.2), C('#ffb020')]),
  ];

  ir.markers = [
    { id: uid('M'), time: 0.2, label: '标题', color: '#ffb020' },
    { id: uid('M'), time: 0.9, label: '数据生长', color: '#38c98b' },
    { id: uid('M'), time: 2.2, label: '趋势线', color: '#ffb020' },
  ];
  return ir;
}

/* ============================================================
   T4 · 口播逐词高亮字幕
   ============================================================ */
export function tplKaraoke() {
  const ir = defaultProject('模板 · 口播逐词高亮字幕');
  ir.project.duration = 9;
  ir.project.background = '#000000';
  ir.layers[0].visible = true;

  const title = ir.layers[1];
  title.props.text = '一句话记住这套流程';
  title.props.fontSize = 88; title.props.fontWeight = 800;
  title.props.y = 800; title.props.x = 960;
  title.props.fill = '#ffffff';
  title.visible = false;
  title.blocks = [
    blk('highlightWord', [L('标题文字'), S_('录一句配音 字幕自己出来 画面跟着声音走'), T(0.4), C('#38ffd1')]),
  ];

  const sub = ir.layers[2];
  sub.name = '进度条';
  sub.props = { x: 960, y: 900, w: 900, h: 8, radius: 4, fill: '#38ffd1', opacity: 1, rotation: 0 };
  sub.visible = false;
  sub.blocks = [
    blk('scaleIn', [L('进度条'), N(0.02), N(1), T(8), T(0.4), L('linear')]),
  ];

  ir.markers = [
    { id: uid('M'), time: 0.4, label: '开口', color: '#38ffd1' },
    { id: uid('M'), time: 3.0, label: '第二句', color: '#ffb020' },
    { id: uid('M'), time: 6.0, label: '第三句', color: '#ff5a5a' },
  ];
  return ir;
}

/* ============================================================
   T5 · 环形频谱（音频驱动）
   ============================================================ */
export function tplRingSpectrum() {
  const ir = defaultProject('模板 · 环形频谱');
  ir.project.duration = 8;
  ir.project.background = '#05070d';

  const title = ir.layers[1];
  title.props.text = 'BASS / MID / TREBLE';
  title.props.fontSize = 64; title.props.fontWeight = 700;
  title.props.y = 180; title.props.x = 960;
  title.props.fill = '#7c8aa5';
  title.visible = false;
  title.blocks = [blk('fadeIn', [L('标题文字'), T(0.8), T(0.2)])];

  const ring = ir.layers[2];
  ring.type = 'circle';
  ring.name = '频谱环';
  ring.props = { x: 960, y: 560, w: 40, h: 40, fill: '#ffffff', opacity: 1, rotation: 0 };
  ring.visible = false;
  ring.blocks = [
    blk('ringSpectrum', [L('频谱环'), N(72), T(0.2), C('#7c5cff'), N(280)]),
  ];
  return ir;
}

/* ============================================================
   T6 · 粒子 + 重复器（纯程序化）
   ============================================================ */
export function tplParticles() {
  const ir = defaultProject('模板 · 粒子与重复器');
  ir.project.duration = 6;
  ir.project.background = '#0a0d16';

  const title = ir.layers[1];
  title.props.text = '批量与复用';
  title.props.fontSize = 104; title.props.fontWeight = 800;
  title.props.y = 200; title.props.x = 960;
  title.visible = false;
  title.blocks = [blk('charPopIn', [L('标题文字'), T(0.2), N(0.09), L('backOut')])];

  const rep = ir.layers[2];
  rep.name = '重复条';
  rep.props = { x: 960, y: 520, w: 46, h: 200, radius: 10, fill: '#4a8cff', opacity: 1, rotation: 0 };
  rep.visible = false;
  rep.blocks = [
    // 注意：repeater 在 blocks.js 里**没有图层槽**（份数/间距/错峰/起始/起始高度）。
    // 原来这里多传了一个 L('重复条')，blk() 按 def.slots 的 5 个槽硬塞，
    // 参数整体右移一位：份数="重复条"、间距=14、错峰=92… 起始高度被截掉。
    // 图层由 curLayerId 决定（积木挂在哪个图层上就作用于哪个），不需要再写名字。
    blk('repeater', [N(14), N(92), T(0.05), T(1.0), N(16)]),
  ];

  const ps = newLayer('粒子', 'circle', { x: 960, y: 800, w: 8, h: 8, fill: '#7c5cff', opacity: 1, rotation: 0 });
  ir.layers.push(ps);
  // 同理：particles 也没有图层槽（粒子数/起始/时长/颜色/速度）。
  // 原来多传 L('粒子') 导致：粒子数="粒子"、起始=140、时长=1.4、颜色=3.5、速度="#7c5cff"，
  // 求值出来速度是 0 —— 粒子原地不动。
  ps.blocks = [blk('particles', [N(140), T(1.4), T(3.5), C('#7c5cff'), N(220)])];
  return ir;
}

export const TEMPLATES = [
  { key: 'popTitle',  name: '逐字弹入标题',   make: tplPopTitle,    desc: 'V0 验收模板：字符级 stagger + 回弹，配副标题入场与收场。' },
  { key: 'audioBars', name: '音频驱动波形柱', make: tplAudioBars,   desc: '实时振幅驱动 56 根柱 + 逐词高亮，演示「声音驱动画面」。' },
  { key: 'barChart',  name: '数据榜单柱状图', make: tplBarChart,    desc: 'CSV 风格数据串驱动柱状图生长 + 折线依次绘出。' },
  { key: 'karaoke',   name: '口播逐词高亮字幕', make: tplKaraoke,   desc: '说到哪个词哪个词变色，进度条按标点字数推进。' },
  { key: 'ring',      name: '环形频谱',       make: tplRingSpectrum, desc: 'Bass/Mid/Treble 频段能量驱动的环形频谱。' },
  { key: 'particles', name: '粒子与重复器',   make: tplParticles,   desc: '发射器 + 力场粒子，一元素按数组复制 14 份。' },
];

export function loadTemplate(key) {
  const t = TEMPLATES.find(x => x.key === key);
  return t ? t.make() : tplPopTitle();
}

export function defaultAudio(ir) {
  return new AudioSource({ bpm: 120, duration: ir.project.duration, seed: 7, intensity: 1, beatEnv: 'pulse' });
}
