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
  event:   { label: '事件',   color: '#ffbf00', desc: '程序入口：开始、按键、点击、广播、到达时间点、克隆时触发' },
  control: { label: '控制',   color: '#ffab19', desc: '等待、循环、条件、停止与广播 —— 程序结构的骨架' },
  time:    { label: '时间轴', color: '#f4a72c', desc: '控制什么时候发生、持续多久 —— 程序化时间轴的全部' },
  marker:  { label: '标记点', color: '#ffd166', desc: '锚点：把画面绑定到配音与节拍' },
  text:    { label: '文字',   color: '#9966ff', desc: '文字引擎：结构拆分、入场动效、文本表达式' },
  fx:      { label: '动效',   color: '#4c97ff', desc: '入场 / 退场 / 循环 / 弹性预设' },
  shape:   { label: '图形',   color: '#0fbd8c', desc: '图元、路径、参数化图形、重复器' },
  motion:  { label: '运动',   color: '#4c97ff', desc: '位置、朝向、缩放、滑行、边缘反弹与路径运动' },
  object:  { label: '对象',   color: '#0fbd8c', desc: '舞台、背景、对象生命周期、层级与父子关系' },
  looks:   { label: '外观',   color: '#9966ff', desc: '文字样式、滤镜、混合模式、裁剪与遮罩' },
  sound:   { label: '声音',   color: '#cf63cf', desc: '播放音效、音量与定时触发；成片暂不混流' },
  math:    { label: '数学',   color: '#59c059', desc: '四则运算、缓动、取模、插值、随机' },
  color:   { label: '颜色',   color: '#ff6680', desc: '混合、插值、调色' },
  logic:   { label: '逻辑',   color: '#5cb1d6', desc: '比较、条件、开关' },
  arr:     { label: '数组',   color: '#ff8c1a', desc: '随机取值、重复、索引' },
  list:    { label: '列表',   color: '#ff8c1a', desc: '列表的创建、增删改查与表达式读取' },
  audio:   { label: '音频驱动', color: '#cf63cf', desc: '把声音变成可编程的数据源（差异化能力）' },
};

/* 图层逻辑头的分类色，Node 对比度测试与积木渲染共用一份 */
export const LAYER_HEAD_COLORS = { text: '#9966ff', rect: '#0fbd8c', circle: '#4c97ff', image: '#ff8c1a', sprite: '#cf63cf' };

/* 帽子积木：只能放在顶层，用来声明一段可被事件触发的脚本 */
export const HAT_OPS = new Set(['whenStart', 'whenKey', 'whenReceive', 'whenClicked', 'whenAt', 'whenClone']);

/* helper：构造 slot 描述 */
const P = (type, label, def, extra = {}) => Object.assign({ type, label, default: def }, extra);
const C = (label, def = []) => ({ type: 'blocks', label, default: def });

export const BLOCK_DEFS = [
  /* ---------------- 事件（帽子） ---------------- */
  {
    op: 'whenStart', cat: 'event', color: CATS.event.color, label: '当作品开始', desc: '播放开始时触发一次；导出成片同样生效',
    isLeaf: false, hat: true,
    slots: [C('做什么')],
  },
  {
    op: 'whenKey', cat: 'event', color: CATS.event.color, label: '当按下按键', desc: '仅在预览播放中响应键盘；视频无法交互，导出不触发',
    isLeaf: false, hat: true,
    slots: [P('sel', '按键', 'space', { menu: 'keys' }), C('做什么')],
  },
  {
    op: 'whenReceive', cat: 'event', color: CATS.event.color, label: '当收到消息', desc: '收到同名广播时触发',
    isLeaf: false, hat: true,
    slots: [P('sel', '消息', '开始', { menu: 'messages' }), C('做什么')],
  },
  {
    op: 'whenClicked', cat: 'event', color: CATS.event.color, label: '当被点击', desc: '仅在预览播放中响应舞台点击；导出不触发',
    isLeaf: false, hat: true,
    slots: [C('做什么')],
  },
  {
    op: 'whenAt', cat: 'event', color: CATS.event.color, label: '当到达时间点', desc: '时间或总进度跨过阈值时触发一次；预览与导出一致',
    isLeaf: false, hat: true,
    slots: [P('time', '时刻/进度', 1), P('sel', '模式', 'time', { menu: 'eventModes' }), C('做什么')],
  },
  {
    op: 'whenClone', cat: 'event', color: CATS.event.color, label: '当作为克隆体启动', desc: '克隆对象创建时，在克隆体上触发',
    isLeaf: false, hat: true,
    slots: [C('做什么')],
  },

  /* ---------------- 控制（语句） ---------------- */
  {
    op: 'waitUntilTime', cat: 'control', color: CATS.control.color, label: '等待到时刻', desc: '挂起线程，直到工程时间到达指定秒数',
    isLeaf: false,
    slots: [P('time', '时刻', 1)],
  },
  {
    op: 'waitUntil', cat: 'control', color: CATS.control.color, label: '等待直到', desc: '条件成立前每帧检查一次，不阻塞其它线程',
    isLeaf: false,
    slots: [P('bool', '条件', true)],
  },
  {
    op: 'forever', cat: 'control', color: CATS.control.color, label: '一直重复', desc: '循环执行；每轮至少让出一帧，避免冻结界面',
    isLeaf: false,
    slots: [C('做什么')],
  },
  {
    op: 'repeatUntil', cat: 'control', color: CATS.control.color, label: '重复直到', desc: '条件成立前反复执行，每轮让出一帧',
    isLeaf: false,
    slots: [P('bool', '条件', false), C('每次')],
  },
  {
    op: 'stop', cat: 'control', color: CATS.control.color, label: '停止', desc: '结束当前脚本，或停止全部脚本（本轮播放内）',
    isLeaf: false,
    slots: [P('sel', '范围', 'this', { menu: 'stopModes' })],
  },
  {
    op: 'broadcast', cat: 'control', color: CATS.control.color, label: '广播消息', desc: '在下一帧开始触发同名「当收到消息」脚本',
    isLeaf: false,
    slots: [P('sel', '消息', '开始', { menu: 'messages' })],
  },
  {
    op: 'broadcastWait', cat: 'control', color: CATS.control.color, label: '广播并等待', desc: '触发接收脚本，等它们全部结束后再继续',
    isLeaf: false,
    slots: [P('sel', '消息', '开始', { menu: 'messages' })],
  },

  /* ---------------- 时间轴（语句） ---------------- */
  {
    op: 'wait', cat: 'control', color: CATS.control.color, label: '等待', desc: '挂起当前脚本指定时长，其它脚本继续运行',
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
    op: 'loop', cat: 'control', color: CATS.control.color, label: '重复 N 次', desc: '在同一帧内顺序重复执行子积木',
    isLeaf: false,
    slots: [P('num', '次数', 3), C('每次')],
  },
  {
    op: 'parallel', cat: 'control', color: CATS.control.color, label: '同时执行', desc: '并列执行，所有子积木同一时刻开始',
    isLeaf: false,
    slots: [C('并行 1'), C('并行 2')],
  },
  {
    op: 'waitUntilMarker', cat: 'marker', color: CATS.marker.color, label: '等到标记点', desc: '暂停到指定锚点再继续',
    isLeaf: false,
    slots: [P('sel', '标记名', '', { menu: 'markers' })],
  },
  {
    op: 'setDuration', cat: 'time', color: CATS.time.color, label: '设置时长', desc: '运行时改写舞台时长（循环边界与 $progress 跟随）',
    isLeaf: false,
    slots: [P('time', '时长', 6)],
  },
  {
    op: 'setKeyframe', cat: 'time', color: CATS.time.color, label: '设置关键帧', desc: '给属性写入关键帧；相邻关键帧之间自动插值',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('sel', '属性', 'opacity', { menu: 'properties' }), P('time', '时间', 0), P('num', '值', 1)],
  },
  {
    op: 'setKeyframeColor', cat: 'time', color: CATS.time.color, label: '设置颜色关键帧', desc: '给填充色写入关键帧，按时间渐变',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('col', '颜色', '#4a8cff'), P('time', '时间', 0)],
  },
  {
    op: 'tweenProp', cat: 'time', color: CATS.time.color, label: '补间属性', desc: '把数值属性从 A 过渡到 B，可指定时长与缓动',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('sel', '属性', 'x', { menu: 'properties' }), P('num', '从', 0), P('num', '到', 100), P('time', '时长', 1), P('sel', '缓动', 'inOutQuad', { menu: 'easings' }), P('num', '贝塞尔 x1', 0.42), P('num', 'y1', 0), P('num', 'x2', 0.58), P('num', 'y2', 1)],
  },
  {
    op: 'tweenColor', cat: 'time', color: CATS.time.color, label: '补间颜色', desc: '填充色从 A 渐变到 B',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('col', '从', '#4a8cff'), P('col', '到', '#ff5a5a'), P('time', '时长', 1), P('sel', '缓动', 'inOutQuad', { menu: 'easings' }), P('num', '贝塞尔 x1', 0.42), P('num', 'y1', 0), P('num', 'x2', 0.58), P('num', 'y2', 1)],
  },
  /* 变量：全库原本没有任何「写变量」的 op，于是 evaluator 的 setVar 零调用，
     工程里声明的变量永远只能是初值。这里只新增这一个 op，不动任何已有 op。 */
  {
    op: 'setVar', cat: 'math', color: CATS.math.color, label: '设置变量', desc: '把值写进变量，后续表达式与文字里的 $变量 都能读到',
    isLeaf: false,
    slots: [P('str', '变量名', 'score', { placeholder: '不带 $，例如 score' }), P('num', '值', 0), P('sel', '作用域', 'global', { menu: 'scopes' })],
  },
  {
    op: 'changeVar', cat: 'math', color: CATS.math.color, label: '改变变量', desc: '在当前值上加一个数；与等待积木配合可实现逐帧递增',
    isLeaf: false,
    slots: [P('str', '变量名', 'score', { placeholder: '不带 $，例如 score' }), P('num', '增量', 1), P('sel', '作用域', 'global', { menu: 'scopes' })],
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
    op: 'particles', cat: 'shape', color: CATS.shape.color, label: '粒子系统', desc: '发射器 + 力场；重力/阻力/扩散按固定步长积分',
    isLeaf: false,
    slots: [
      P('num', '粒子数', 90), P('time', '起始', 0), P('time', '时长', 3),
      P('col', '颜色', '#4a8cff'), P('num', '速度', 180),
      P('num', '寿命倍数', 1), P('num', '扩散角度', 360), P('num', '重力', 240),
      P('num', '阻力', 0), P('num', '大小倍数', 1),
    ],
  },

  /* ---------------- 运动（语句） ---------------- */
  {
    op: 'setPosition', cat: 'motion', color: CATS.motion.color, label: '移到坐标', desc: '设置对象中心点的舞台坐标',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', 'x', 960), P('num', 'y', 540)],
  },
  {
    op: 'changeX', cat: 'motion', color: CATS.motion.color, label: '改变 x', desc: '在当前横坐标上增减',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', '增量', 10)],
  },
  {
    op: 'changeY', cat: 'motion', color: CATS.motion.color, label: '改变 y', desc: '在当前纵坐标上增减',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', '增量', 10)],
  },
  {
    op: 'setSize', cat: 'motion', color: CATS.motion.color, label: '设置大小', desc: '按百分比缩放，100 = 原始大小',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', '大小 %', 100)],
  },
  {
    op: 'setDirection', cat: 'motion', color: CATS.motion.color, label: '面向方向', desc: '0=上，90=右，180=下，270=左',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', '方向', 90)],
  },
  {
    op: 'rotateBy', cat: 'motion', color: CATS.motion.color, label: '旋转', desc: '在当前角度上增加度数',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', '角度', 15)],
  },
  {
    op: 'setOpacity', cat: 'motion', color: CATS.motion.color, label: '设置透明度', desc: '0 = 透明，100 = 不透明',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', '不透明度 %', 100)],
  },
  {
    op: 'glideTo', cat: 'motion', color: CATS.motion.color, label: '滑行到', desc: '在指定时长内平滑移动到目标坐标',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', 'x', 960), P('num', 'y', 540), P('time', '时长', 1), P('sel', '缓动', 'inOutQuad', { menu: 'easings' })],
  },
  {
    op: 'moveSteps', cat: 'motion', color: CATS.motion.color, label: '移动步数', desc: '沿当前朝向移动指定距离',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', '步数', 10)],
  },
  {
    op: 'pointTowards', cat: 'motion', color: CATS.motion.color, label: '面向对象', desc: '把朝向转向另一个对象',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('sel', '对象', '', { menu: 'targets' })],
  },
  {
    op: 'bounceOffEdge', cat: 'motion', color: CATS.motion.color, label: '碰到边缘反弹', desc: '按对象尺寸限制在舞台内，并翻转朝向',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' })],
  },
  {
    op: 'moveAlongPath', cat: 'motion', color: CATS.motion.color, label: '沿路径移动', desc: '路径点写成 x,y;x,y;…，在时长内依次经过',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('str', '路径', '0,0;160,80;320,0', { placeholder: 'x,y;x,y;…' }), P('time', '时长', 2)],
  },
  {
    op: 'formulaMove', cat: 'motion', color: CATS.motion.color, label: '公式运动', desc: '按正弦或椭圆公式连续运动（确定性）',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('sel', '轨迹', 'sine', { menu: ['sine', 'ellipse'] }), P('num', '幅度 x', 200), P('num', '幅度 y', 100), P('num', '周期', 2), P('time', '起始', 0)],
  },
  {
    op: 'physicsMove', cat: 'motion', color: CATS.motion.color, label: '物理运动', desc: '给对象一个速度，按固定步长模拟重力、边缘反弹与摩擦',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', 'x 速度', 200), P('num', 'y 速度', -300), P('num', '重力', 600), P('num', '反弹', 0.8), P('num', '摩擦', 0)],
  },

  /* ---------------- 对象（语句） ---------------- */
  {
    op: 'switchBackdrop', cat: 'object', color: CATS.object.color, label: '切换背景', desc: '设置舞台背景色（运行时，不写回工程）',
    isLeaf: false,
    slots: [P('col', '背景色', '#101828')],
  },
  {
    op: 'setStageSize', cat: 'object', color: CATS.object.color, label: '设置舞台尺寸', desc: '运行时改写舞台宽高，影响边缘反弹与坐标参考',
    isLeaf: false,
    slots: [P('num', '宽', 1920), P('num', '高', 1080)],
  },
  {
    op: 'setStageFps', cat: 'object', color: CATS.object.color, label: '设置帧率', desc: '运行时记录目标帧率（固定步长按工程帧率执行）',
    isLeaf: false,
    slots: [P('num', '帧率', 24)],
  },
  {
    op: 'createObject', cat: 'object', color: CATS.object.color, label: '创建对象', desc: '在运行时创建新对象；不写入工程，重置后消失',
    isLeaf: false,
    slots: [P('str', '名称', '新对象'), P('sel', '类型', 'rect', { menu: 'objectTypes' }), P('num', 'x', 960), P('num', 'y', 540)],
  },
  {
    op: 'deleteObject', cat: 'object', color: CATS.object.color, label: '删除对象', desc: '删除运行时对象；工程图层在重置后恢复',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' })],
  },
  {
    op: 'showObject', cat: 'object', color: CATS.object.color, label: '显示对象', desc: '显示图层或运行时对象',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' })],
  },
  {
    op: 'hideObject', cat: 'object', color: CATS.object.color, label: '隐藏对象', desc: '隐藏图层或运行时对象',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' })],
  },
  {
    op: 'cloneObject', cat: 'object', color: CATS.object.color, label: '克隆对象', desc: '复制对象及其变量；克隆体可响应「当作为克隆体启动」',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' })],
  },
  {
    op: 'bringToFront', cat: 'object', color: CATS.object.color, label: '移到最前', desc: '调整运行时绘制顺序',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' })],
  },
  {
    op: 'sendToBack', cat: 'object', color: CATS.object.color, label: '移到最后', desc: '调整运行时绘制顺序',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' })],
  },
  {
    op: 'goForward', cat: 'object', color: CATS.object.color, label: '前移一层', desc: '调整运行时绘制顺序',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' })],
  },
  {
    op: 'goBackward', cat: 'object', color: CATS.object.color, label: '后移一层', desc: '调整运行时绘制顺序',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' })],
  },
  {
    op: 'setParent', cat: 'object', color: CATS.object.color, label: '设置父对象', desc: '子对象跟随父对象的位移/旋转/缩放/透明度',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('sel', '父对象', '', { menu: 'targets' })],
  },

  /* ---------------- 外观（语句） ---------------- */
  {
    op: 'setTextStyle', cat: 'looks', color: CATS.looks.color, label: '设置文字样式', desc: '字号、颜色、字重',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', '字号', 96), P('col', '颜色', '#ffffff'), P('num', '字重', 700)],
  },
  {
    op: 'setColorEffect', cat: 'looks', color: CATS.looks.color, label: '设置颜色特效', desc: '直接设置色相/亮度/饱和/对比数值',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('sel', '效果', 'color', { menu: ['color', 'brightness', 'saturation', 'contrast'] }), P('num', '数值', 0)],
  },
  {
    op: 'changeColorEffect', cat: 'looks', color: CATS.looks.color, label: '改变颜色特效', desc: '在当前特效数值上增减',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('sel', '效果', 'color', { menu: ['color', 'brightness', 'saturation', 'contrast'] }), P('num', '增量', 10)],
  },
  {
    op: 'setBrightness', cat: 'looks', color: CATS.looks.color, label: '设置亮度', desc: '100 = 原始亮度',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', '亮度 %', 100)],
  },
  {
    op: 'setSaturation', cat: 'looks', color: CATS.looks.color, label: '设置饱和度', desc: '100 = 原始饱和度',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', '饱和 %', 100)],
  },
  {
    op: 'setContrast', cat: 'looks', color: CATS.looks.color, label: '设置对比度', desc: '100 = 原始对比度',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', '对比 %', 100)],
  },
  {
    op: 'setBlur', cat: 'looks', color: CATS.looks.color, label: '设置模糊', desc: '像素模糊半径',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', '半径', 4)],
  },
  {
    op: 'addGlow', cat: 'looks', color: CATS.looks.color, label: '添加发光', desc: '按半径与颜色添加发光',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', '半径', 12), P('col', '颜色', '#4a8cff')],
  },
  {
    op: 'addShadow', cat: 'looks', color: CATS.looks.color, label: '添加阴影', desc: '按半径与颜色添加投影',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', '半径', 8), P('col', '颜色', '#00000080')],
  },
  {
    op: 'clearEffects', cat: 'looks', color: CATS.looks.color, label: '清除特效', desc: '移除该对象全部滤镜与颜色特效',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' })],
  },
  {
    op: 'setBlendMode', cat: 'looks', color: CATS.looks.color, label: '设置混合模式', desc: '正片叠底、滤色、叠加等 Canvas 混合模式',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('sel', '模式', 'source-over', { menu: 'blendModes' })],
  },
  {
    op: 'setClipRect', cat: 'looks', color: CATS.looks.color, label: '矩形裁剪', desc: '只显示对象位于矩形内的部分',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('num', 'x', 0), P('num', 'y', 0), P('num', '宽', 960), P('num', '高', 540)],
  },
  {
    op: 'maskWith', cat: 'looks', color: CATS.looks.color, label: '用对象遮罩', desc: '用另一个对象的形状作为遮罩（离屏合成）',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('sel', '遮罩对象', '', { menu: 'targets' })],
  },

  /* ---------------- 声音（语句） ---------------- */
  {
    op: 'playSound', cat: 'sound', color: CATS.sound.color, label: '播放声音', desc: '预览中真实播放；导出视频暂不混流（会记录 cue）',
    isLeaf: false,
    slots: [P('sel', '声音', 'beep', { menu: 'sounds' }), P('num', '音量 %', 100)],
  },
  {
    op: 'playSoundWait', cat: 'sound', color: CATS.sound.color, label: '播放声音并等待', desc: '播放到结束再继续；导出只记录 cue',
    isLeaf: false,
    slots: [P('sel', '声音', 'beep', { menu: 'sounds' }), P('num', '音量 %', 100)],
  },
  {
    op: 'stopAllSounds', cat: 'sound', color: CATS.sound.color, label: '停止所有声音', desc: '立即停止预览中的全部音频',
    isLeaf: false,
    slots: [],
  },
  {
    op: 'setVolume', cat: 'sound', color: CATS.sound.color, label: '设置音量', desc: '设置声音积木的主音量',
    isLeaf: false,
    slots: [P('num', '音量 %', 100)],
  },
  {
    op: 'triggerSoundAt', cat: 'sound', color: CATS.sound.color, label: '定时播放声音', desc: '在指定的工程时刻触发一次声音',
    isLeaf: false,
    slots: [P('sel', '声音', 'click', { menu: 'sounds' }), P('time', '时刻', 1), P('num', '音量 %', 100)],
  },
  {
    op: 'switchCostume', cat: 'sound', color: CATS.sound.color, label: '切换造型', desc: '给 sprite 图层切换造型（图片地址或内置形状）',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('str', '造型', '', { placeholder: '图片 URL 或颜色 #4a8cff' })],
  },
  {
    op: 'playSequence', cat: 'sound', color: CATS.sound.color, label: '列表驱动序列', desc: '把列表当作逐帧造型序列，按帧率循环切换',
    isLeaf: false,
    slots: [P('sel', '目标', '', { menu: 'targets' }), P('str', '列表', 'frames', { placeholder: '列表名' }), P('num', '帧率', 12)],
  },

  /* ---------------- 列表（语句） ---------------- */
  {
    op: 'listCreate', cat: 'list', color: CATS.list.color, label: '创建列表', desc: '创建或清空同名列表',
    isLeaf: false,
    slots: [P('str', '列表名', 'items', { placeholder: '不带 $' })],
  },
  {
    op: 'listAdd', cat: 'list', color: CATS.list.color, label: '列表加入', desc: '把值追加到末尾',
    isLeaf: false,
    slots: [P('str', '列表名', 'items'), P('str', '值', '')],
  },
  {
    op: 'listDelete', cat: 'list', color: CATS.list.color, label: '删除列表项', desc: '删除指定序号（从 1 开始）',
    isLeaf: false,
    slots: [P('str', '列表名', 'items'), P('num', '序号', 1)],
  },
  {
    op: 'listInsert', cat: 'list', color: CATS.list.color, label: '插入列表项', desc: '在指定序号前插入值',
    isLeaf: false,
    slots: [P('str', '列表名', 'items'), P('num', '序号', 1), P('str', '值', '')],
  },
  {
    op: 'listSet', cat: 'list', color: CATS.list.color, label: '替换列表项', desc: '替换指定序号的值；越界忽略',
    isLeaf: false,
    slots: [P('str', '列表名', 'items'), P('num', '序号', 1), P('str', '值', '')],
  },
  {
    op: 'listClear', cat: 'list', color: CATS.list.color, label: '清空列表', desc: '删除列表内全部项目',
    isLeaf: false,
    slots: [P('str', '列表名', 'items')],
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
  { op: 'round', cat: 'math', color: CATS.math.color, label: '四舍五入', desc: '取最接近的整数', isLeaf: true },
  { op: 'tan', cat: 'math', color: CATS.math.color, label: '正切', desc: 'tan(弧度)', isLeaf: true },
  { op: 'listLength', cat: 'list', color: CATS.list.color, label: '列表长度', desc: '返回列表项目数', isLeaf: true },
  { op: 'itemOf', cat: 'list', color: CATS.list.color, label: '列表第几项', desc: '序号从 1 开始；越界返回空', isLeaf: true },
  { op: 'listContains', cat: 'list', color: CATS.list.color, label: '列表包含', desc: '列表里是否有该值', isLeaf: true },

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
  { op: 'if', cat: 'control', color: CATS.control.color, label: '如果…那么', desc: '条件成立执行 A，否则执行 B',
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
  round:     [['num', '值', 0]],
  tan:       [['num', '弧度', 0]],
  listLength:   [['str', '列表名', 'items']],
  itemOf:       [['str', '列表名', 'items'], ['num', '序号', 1]],
  listContains: [['str', '列表名', 'items'], ['str', '值', '']],
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
  ['customBezier', '自定义贝塞尔'],
];

export const UNIT_LABELS = { whole: '整块', line: '逐行', word: '逐词', char: '逐字' };
export const DIR_LABELS = { left: '从左', right: '从右', up: '从上', down: '从下' };

/* 取值固定的下拉菜单：界面渲染（blockview）与在线 AI 校验（ai-online）共用同一份，
   否则模型给出的中文标签和积木里真正写的英文值会各说各话。
   图层 / 标记 / 消息这类要看工程内容的菜单不在此列。 */
export const MENU_ITEMS = {
  properties: [
    ['x', 'x 坐标'], ['y', 'y 坐标'], ['rotation', '旋转'],
    ['scaleX', '横向缩放'], ['scaleY', '纵向缩放'], ['opacity', '透明度'],
    ['w', '宽'], ['h', '高'], ['fontSize', '字号'], ['fill', '填充色'],
  ],
  keys: [
    ['any', '任意键'], ['space', '空格'], ['enter', '回车'], ['escape', 'Esc'],
    ['arrowleft', '←'], ['arrowright', '→'], ['arrowup', '↑'], ['arrowdown', '↓'],
    ['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D'], ['w', 'W'], ['s', 'S'],
  ],
  blendModes: [
    ['source-over', '正常'], ['multiply', '正片叠底'], ['screen', '滤色'],
    ['overlay', '叠加'], ['darken', '变暗'], ['lighten', '变亮'],
    ['color-dodge', '颜色减淡'], ['color-burn', '颜色加深'],
    ['hard-light', '强光'], ['soft-light', '柔光'], ['difference', '差值'],
    ['exclusion', '排除'], ['hue', '色相'], ['saturation', '饱和度'],
    ['color', '颜色'], ['luminosity', '明度'],
  ],
  scopes: [['global', '全局'], ['private', '当前对象私有']],
  stopModes: [['this', '当前脚本'], ['all', '全部脚本'], ['other', '其它脚本']],
  eventModes: [['time', '时间（秒）'], ['progress', '总进度（0-1）']],
  objectTypes: [['rect', '矩形'], ['circle', '圆形'], ['text', '文字'], ['image', '图片'], ['sprite', '造型']],
  sounds: [['beep', '哔声'], ['click', '点击'], ['pop', '弹出'], ['whoosh', '呼啸']],
};

export const PALETTE_GROUPS = [
  'event', 'control', 'time', 'marker', 'text', 'fx', 'shape',
  'motion', 'object', 'looks', 'sound', 'math', 'color', 'logic', 'arr', 'list', 'audio',
];

/* 供运行时与契约测试复用：按定义区分帽子 / 普通语句 / 表达式 */
export const STATEMENT_OPS = new Set(BLOCK_DEFS.filter(d => !d.isLeaf).map(d => d.op));
export const LEAF_OPS = new Set(BLOCK_DEFS.filter(d => d.isLeaf).map(d => d.op));

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
  if (d.isLeaf) {
    return {
      op,
      isLeaf: true,
      slots: (LEAF_SLOTS[op] || []).map(sd => ({
        type: sd[0],
        label: sd[1],
        default: sd[2],
        menu: (sd[3] && sd[3].menu) || null,
        isSub: false,
      })),
    };
  }
  return {
    op,
    isLeaf: false,
    slots: (d.slots || []).map(s => ({
      type: s.type,
      label: s.label,
      placeholder: s.placeholder,
      menu: s.menu || null,
      default: s.default,
      isSub: s.default !== undefined && Array.isArray(s.default),
    })),
  };
}
