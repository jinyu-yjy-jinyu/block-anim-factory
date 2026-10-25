/* ============================================================
   ai.js · AI 辅助（J · V4）
   ------------------------------------------------------------
   规划 J 列的五条能力：
     1. 自然语言转积木序列：「让标题逐字弹入，延迟 0.05 秒」
     2. 文案自动分镜：输入一段稿子，拆成场景并建议动效
     3. 导入配音/字幕，自动按时间轴对齐文字动画节拍
     4. 已有动画反向解释成积木（教学价值极高）
     5. （补）从曲线反推动效参数

   设计取舍要说清楚：
   本模块是**规则驱动的本地 NLU 引擎**，默认不联网、不调大模型。
   原因：把「能离线跑、结果确定、积木一定合法」放在第一位。
   可选的在线模型适配放在 ai-online.js：它只负责把模型输出整理成
   同样的 Action[]，校验与编译仍走这里的 actionsToBlocks，所以
   在线失败时可以直接回退本地规则，积木合法性也由同一套规则兜底。
   ============================================================ */

import { uid, clone } from './ir.js';
import { defOf } from './blocks.js';
import { NUM, STR, COL, TIME, SEL, BOOL } from './ir.js';
import { evaluateFrame } from './evaluator.js';

/* ============================================================
   1. 自然语言 → 动作序列
   ------------------------------------------------------------
   Action = { op, slots:{...}, why }
   「为什么」字段很重要：让用户知道 AI 是怎么理解他的，
   也让积木生成后仍可人工修正，而不是黑箱。
   ============================================================ */

/* 动效词表：中英文 → 标准动作 */
const ACTION_LEXICON = [
  // —— 入场 ——
  { re: /(逐字|每个字|一个字一个字|一个字一?个?字)[^\n]{0,6}(弹入|弹出|蹦出|跳出)/, act: 'charPopIn' },
  { re: /(弹入|弹出|蹦出|跳出|jump\s*in)/, act: 'charPopIn' },
  { re: /(逐个|依次|错峰|一个一个|逐条)[^\n]{0,4}(出现|入场|显示|弹出|浮现)/, act: 'stagger' },
  { re: /(打字机|打字般|逐字显现|像打字)/, act: 'typewriter' },
  { re: /(淡入|渐显|慢慢出现|浮现|显现)/, act: 'fadeIn' },
  { re: /(淡出|渐隐|慢慢消失)/, act: 'fadeOut' },
  { re: /(滑入|从(?:左|右|上|下)[^\n]{0,3}滑入|飞入|移入|位移入场)/, act: 'moveIn' },
  { re: /(缩放(?:入场|进入)?|放大(?:出现|进场)|从(?:小|大)变)/, act: 'scaleIn' },
  { re: /(擦出|扫出|擦除|扫过|揭开)/, act: 'maskWipe' },
  { re: /(路径|沿[^\n]{0,3}曲线|波浪)/, act: 'pathSweep' },
  { re: /(数字滚动|滚动数字|数字跳|计数)/, act: 'numberRoll' },
  // —— 音频驱动 ——
  { re: /(逐词高亮|卡拉\s*ok|karaoke|说到[^\n]{0,3}变色|跟读高亮)/, act: 'highlightWord' },
  { re: /(波形柱|音频柱|音量柱|声波柱|随音乐跳动)/, act: 'audioBars' },
  { re: /(环形频谱|频谱环|圆环频谱|频谱)/, act: 'ringSpectrum' },
  // —— 事件 / 控制（P0）——
  { re: /(广播|发消息|发送消息|通知)(?:给)?[^\n]{0,10}/, act: 'broadcast' },
  { re: /(一直重复|无限循环|循环不停)/, act: 'forever' },
  // —— 变量 / 列表（P0）——
  { re: /(变量|得分|计数)[^\n]{0,10}(设为|设置为|改成|等于|赋值为)/, act: 'setVar' },
  { re: /(变量|得分|计数)[^\n]{0,10}(增加|加上|累加|自增)/, act: 'changeVar' },
  { re: /(创建|新建|定义)\s*(?:一个|个)?\s*(列表|队列)/, act: 'listCreate' },
  { re: /(列表|队列)[^\n]{0,8}(加入|添加|追加|新增)/, act: 'listAdd' },
  // —— 对象与运动（P0）——
  { re: /(创建|新建|添加)\s*(?:一个|个)?\s*(对象|矩形|圆形|文字|造型|图片)/, act: 'createObject' },
  { re: /隐藏\s*(?:一下)?\s*(?:对象|图层|它)/, act: 'hideObject' },
  { re: /显示\s*(?:一下)?\s*(?:对象|图层)/, act: 'showObject' },
  { re: /(移到|定位到|置于)\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)/, act: 'setPosition' },
  { re: /(滑行到|滑动到|移动到|飞到)\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)/, act: 'glideTo' },
  // —— 图形 ——
  // 放在 P0 之后：说「创建一个圆形对象」要认出 createObject，不能被这里的「圆形」抢成 drawShape。
  { re: /(柱状图|柱子|条形图|bar)/, act: 'growBar' },
  { re: /(折线图|折线|曲线图|趋势线)/, act: 'drawLine' },
  { re: /(粒子|散点|雪花|星点)/, act: 'particles' },
  { re: /(重复器|复制\s*\d+|阵列)/, act: 'repeater' },
  { re: /(图元|矩形|方块|圆形|色块)/, act: 'drawShape' },
  // —— 时间 ——
  { re: /(等待|停\s*\d|延时|等\s*\d|pause|停一下)/, act: 'wait' },
  { re: /(在\s*(\d+(?:\.\d+)?)\s*秒|(\d+(?:\.\d+)?)\s*秒处|setAt)/, act: 'setAt' },
  { re: /(重复\s*(\d+)\s*次|循环\s*(\d+)\s*次)/, act: 'loop' },
  { re: /(同时|并行|一起)/, act: 'parallel' },
  { re: /(在标记点|跟随配音|对齐语音|锚点)/, act: 'atMarker' },
];

/* 方向词 → 位移 */
const DIRECTIONS = {
  左: -1, right: -1, 右: 1, left: 1, 上: -1, down: 1, 下: 1, top: -1,
};

export class NLParser {
  constructor(opts = {}) {
    this.layerNames = opts.layers || [];       // 可选的图层名，解析「标题」用
    this.markers = opts.markers || [];
    this.strict = opts.strict !== false;      // 解析不出就报错而不是瞎猜
  }

  /**
   * 把一句中文（或几段）解析成动作序列
   * @returns {{actions:Array, warnings:string[]}}
   */
  parse(text) {
    const src = String(text || '').trim();
    const warnings = [];
    if (!src) return { actions: [], warnings: ['输入为空'] };

    // 按标点与连接词切成子句 —— 一句话可能包含多个动作。
    // 连接词要一起吃掉，否则会切出「最后」这种没有意义的碎片。
    // 「移动到 300,400」里的逗号是坐标分隔符，先换成占位符再切，切完换回来；
    // 否则坐标会被拆成两个子句，两个都听不懂。
    const masked = src.replace(/(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d)/g, '$1\u0001$2');
    let clauses = masked
      .split(/[，,。；;\n]+|然后|接着|最后|之后再|再然后/g)
      .map(s => s.replace(/\u0001/g, ',').trim())
      .filter(Boolean);

    // 「标题淡入，时长 1.5 秒」里的「时长 1.5 秒」不是独立动作，
    // 它是上一个动作的参数 —— 把这种纯参数子句并回前一个。
    clauses = clauses.reduce((acc, c) => {
      const isParamOnly = !actionOpOf(c) && /(时长|延迟|间隔|间距|速度|大小|幅度|次数|字号|数量|用时|寿命|重力|阻力|扩散|摩擦|反弹|用|共|为)\s*[\d.]/.test(c);
      if (isParamOnly && acc.length) acc[acc.length - 1] += '，' + c;
      else acc.push(c);
      return acc;
    }, []);

    const actions = [];
    let last = null;                            // 用于「之后」

    for (const clause of clauses) {
      const a = this.parseClause(clause, last);
      if (!a) {
        warnings.push(`没听懂：「${clause}」`);
        continue;
      }
      actions.push(a);
      last = a;
    }
    return { actions, warnings };
  }

  parseClause(clause, last) {
    const def = defOf(actionOpOf(clause));
    if (!def) return null;
    const op = actionOpOf(clause);
    const slots = {};
    const why = [];

    // —— 数值抽取 ——
    const nums = [...clause.matchAll(/(-?\d+(?:\.\d+)?)\s*(秒|s|毫秒|ms|分|次|个|px|像素|%)?/g)]
      .map(m => ({ v: parseFloat(m[1]), unit: m[2] || '' }));

    const numOf = (pred, dflt) => {
      const n = nums.find(pred);
      return n ? n.v : dflt;
    };

    // —— 按积木类型填槽 ——
    switch (op) {
      case 'charPopIn':
        slots.layer = this.layerOf(clause);
        slots.start = TIME(numOf(n => /秒|s|ms|毫秒/.test(n.unit), 0));
        // 注意：blocks.js 里「间隔」槽声明的是 num（不是 time），
        // 这里必须跟着走，否则参数会被塞进类型不符的槽里。
        slots.gap = NUM(numOf(n => /秒|s|ms|毫秒/.test(n.unit), 0.05));
        slots.anim = SEL(pickAnim(clause));
        why.push(`逐字弹入，间隔 ${slots.gap.v}s`);
        break;

      case 'stagger':
        slots.layer = this.layerOf(clause);
        slots.unit = SEL(pickUnit(clause));
        slots.gap = TIME(numOf(n => /秒|s|ms|毫秒/.test(n.unit), 0.05));
        slots.start = TIME(0);
        why.push(`错峰入场，单元间隔 ${slots.gap.v}s`);
        break;

      case 'typewriter':
        slots.layer = this.layerOf(clause);
        slots.speed = NUM(numOf(n => n.unit === '', 12));
        slots.start = TIME(numOf(n => n.unit === '秒' || n.unit === 's', 0));
        why.push('打字机效果');
        break;

      case 'fadeIn': case 'fadeOut':
        slots.layer = this.layerOf(clause);
        // 「淡入，用 0.8 秒」/「淡入时长 1.5 秒」都该认出来
        slots.dur = TIME(numOf(n => /秒|s|ms|毫秒/.test(n.unit), 0.6));
        slots.start = TIME(0);
        why.push(`${def.label} ${slots.dur.v}s`);
        break;

      case 'moveIn':
        slots.layer = this.layerOf(clause);
        slots.dir = SEL(pickDirection(clause));
        // 「距离」槽要的是正值 —— evaluator 按 dir 自己定正负（left → dx = -dist），
        // 传带符号的值会让「从左滑入」反向。
        slots.dist = NUM(directionDist(clause));
        slots.dur = TIME(numOf(n => n.unit === '秒' || n.unit === 's', 0.7));
        slots.start = TIME(numOf(n => n.unit === '秒' && n.v > 0, 0));
        why.push(`从${slots.dir.v}滑入`);
        break;

      case 'scaleIn':
        slots.layer = this.layerOf(clause);
        slots.from = NUM(numOf(n => n.v < 1 && n.unit === '', 0.8));
        // 「到」槽要有值，否则它会被后面的参数顶掉；blocks.js 该积木的默认值就是 1
        // （desc 也是「从 0 放大到 1」）。「放大到 1.2」这类目标倍率目前还认不出来。
        slots.to = NUM(1);
        slots.dur = TIME(numOf(n => n.unit === '秒' || n.unit === 's', 0.6));
        slots.start = TIME(numOf(n => n.unit === '秒' && n.v > 0, 0));
        slots.anim = SEL(pickAnim(clause));
        why.push('缩放入场');
        break;

      case 'maskWipe':
        slots.layer = this.layerOf(clause);
        slots.dur = TIME(numOf(n => n.unit === '秒' || n.unit === 's', 0.8));
        slots.start = TIME(0);
        slots.dir = SEL(pickDirection(clause));
        why.push('遮罩擦出');
        break;

      case 'pathSweep':
        slots.layer = this.layerOf(clause);
        slots.dur = TIME(numOf(n => n.unit === '秒' || n.unit === 's', 1.2));
        slots.amp = NUM(numOf(n => n.unit === 'px' || n.unit === '像素', 80));
        slots.cycles = NUM(numOf(n => n.unit === '', 2));
        why.push('路径扫过');
        break;

      case 'numberRoll':
        slots.layer = this.layerOf(clause);
        slots.to = NUM(numOf(n => n.unit === '', 100));
        slots.dur = TIME(numOf(n => n.unit === '秒' || n.unit === 's', 1.5));
        slots.start = TIME(0);
        why.push(`数字滚到 ${slots.to.v}`);
        break;

      case 'highlightWord':
        slots.layer = this.layerOf(clause);
        slots.highlight = COL(pickColor(clause) || '#38ffd1');
        slots.auto = BOOL(true);
        why.push('逐词高亮（卡拉OK）');
        break;

      case 'audioBars':
        slots.count = NUM(numOf(n => n.unit === '个' || n.unit === '', 56));
        slots.gain = NUM(numOf(n => n.unit === '', 1));
        slots.source = SEL('amp');
        why.push(`音频波形柱 ×${slots.count.v}`);
        break;

      case 'ringSpectrum':
        slots.bands = NUM(numOf(n => n.unit === '个' || n.unit === '', 64));
        slots.thickness = NUM(numOf(n => n.unit === 'px', 14));
        slots.smooth = NUM(0.7);
        why.push('环形频谱');
        break;

      case 'growBar':
        slots.layer = this.layerOf(clause);
        slots.data = STR(extractData(clause) || '30,55,80,45');
        slots.perBar = TIME(numOf(n => n.unit === '秒' || n.unit === 's', 0.08));
        slots.start = TIME(0);
        why.push('柱状图生长');
        break;

      case 'drawLine':
        slots.layer = this.layerOf(clause);
        slots.data = STR(extractData(clause) || '10,35,28,52,44,70');
        slots.perPoint = TIME(numOf(n => n.unit === '秒' || n.unit === 's', 0.12));
        slots.start = TIME(0);
        why.push('折线图');
        break;

      case 'particles': {
        const sp = clause.match(/(?:速度|初速)\s*(-?\d+(?:\.\d+)?)/);
        slots.count = NUM(numOf(n => n.unit === '个', 90));
        slots.start = TIME(0);
        slots.life = TIME(numOf(n => n.unit === '秒' || n.unit === 's', 3));
        slots.speed = NUM(sp ? parseFloat(sp[1]) : numOf(n => n.unit === 'px' || n.unit === '像素', 180));
        why.push(`粒子系统 ×${slots.count.v}`);
        break;
      }

      case 'repeater': {
        const sp = clause.match(/(?:间距|间隔)\s*(-?\d+(?:\.\d+)?)/);
        slots.count = NUM(numOf(n => n.unit === '个' || n.unit === '次', 14));
        slots.spacing = NUM(sp ? parseFloat(sp[1]) : numOf(n => n.unit === 'px' || n.unit === '像素', 90));
        slots.gap = TIME(numOf(n => n.unit === '秒' || n.unit === 's', 0.06));
        slots.start = TIME(0);
        why.push(`重复 ×${slots.count.v}`);
        break;
      }
        break;

      case 'drawShape': {
        // 积木定义是 [图层, 填充, 宽, 高, 圆角]，没有形状类型槽 ——
        // 宽高按子句里出现的像素数依次取，取不到就用定义默认值。
        const pxs = nums.filter(n => n.unit === 'px' || n.unit === '像素');
        slots.layer = this.layerOf(clause);
        slots.fill = COL(pickColor(clause) || '#4a8cff');
        slots.w = NUM(pxs[0] ? pxs[0].v : 400);
        slots.h = NUM(pxs[1] ? pxs[1].v : 120);
        why.push('绘制图元');
        break;
      }
      case 'wait':
        slots.dur = TIME(numOf(n => n.unit === '秒' || n.unit === 's' || n.unit === '', 1));
        why.push(`等待 ${slots.dur.v}s`);
        break;

      case 'setAt': {
        const t = nums.find(n => n.unit === '秒' || n.unit === 's');
        slots.at = TIME(t ? t.v : 0);
        why.push(`在 ${slots.at.v}s 执行`);
        break;
      }

      case 'loop': {
        const n = nums.find(x => x.unit === '次') || nums[0];
        slots.count = NUM(n ? Math.max(1, Math.round(n.v)) : 3);
        why.push(`重复 ${slots.count.v} 次`);
        break;
      }

      case 'broadcast': {
        const m = clause.match(/[「"']([^「」"']{1,12})[」"']/);
        slots.message = SEL(m ? m[1] : '开始');
        why.push(`广播「${slots.message.v}」`);
        break;
      }

      case 'forever':
        why.push('一直重复（每轮让出一帧）');
        break;

      case 'setVar': {
        const name = varNameOf(clause);
        slots.name = STR(name);
        slots.value = NUM(numOf(n => !/次|％|%/.test(n.unit), 1));
        why.push(`把变量 ${name} 设为 ${slots.value.v}`);
        break;
      }

      case 'changeVar': {
        const name = varNameOf(clause);
        slots.name = STR(name);
        slots.delta = NUM(numOf(n => !/次|％|%/.test(n.unit), 1));
        why.push(`让变量 ${name} 增加 ${slots.delta.v}`);
        break;
      }

      case 'listCreate': {
        const m = clause.match(/[「"']([^「」"']{1,12})[」"']/);
        slots.name = STR(m ? m[1] : '列表1');
        why.push(`创建列表「${slots.name.v}」`);
        break;
      }

      case 'listAdd': {
        const m = clause.match(/[「"']([^「」"']{1,12})[」"']/);
        slots.name = STR(m ? m[1] : '列表1');
        const d = extractData(clause);
        slots.value = STR(d || String(numOf(() => true, 1)));
        why.push(`往列表「${slots.name.v}」加入 ${slots.value.v}`);
        break;
      }

      case 'createObject': {
        const m = clause.match(/[「"']([^「」"']{1,12})[」"']/);
        slots.name = STR(m ? m[1] : '新对象');
        slots.type = SEL(pickObjectType(clause));
        const coords = [...clause.matchAll(/(-?\d+(?:\.\d+)?)/g)].map(x => parseFloat(x[1]));
        slots.x = NUM(coords.length >= 2 ? coords[0] : 960);
        slots.y = NUM(coords.length >= 2 ? coords[1] : 540);
        why.push(`创建对象「${slots.name.v}」（${slots.type.v}）`);
        break;
      }

      case 'hideObject': case 'showObject':
        slots.layer = this.layerOf(clause);
        why.push(op === 'hideObject' ? '隐藏对象' : '显示对象');
        break;

      case 'setPosition': case 'glideTo': {
        const m = clause.match(/(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)/);
        slots.layer = this.layerOf(clause);
        slots.x = NUM(m ? parseFloat(m[1]) : 960);
        slots.y = NUM(m ? parseFloat(m[2]) : 540);
        if (op === 'glideTo') {
          slots.dur = TIME(numOf(n => n.unit === '秒' || n.unit === 's', 1));
          slots.anim = SEL(pickMoveAnim(clause));
        }
        why.push(op === 'glideTo'
          ? `滑行到 (${slots.x.v}, ${slots.y.v})，用时 ${slots.dur.v}s`
          : `移到 (${slots.x.v}, ${slots.y.v})`);
        break;
      }

      case 'parallel':
        why.push('同时执行');
        break;

      case 'atMarker': {
        // 先找子句里出现的标记点名（优先），否则退到第一个
        const known = this.markers;
        let m = null;
        for (const cand of known) {
          if (clause.includes(cand)) { m = cand; break; }
        }
        if (!m) {
          const mm = clause.match(/标记点?[「"']?([^「」"'\s]{1,10})[」"']?/);
          m = (mm && known.includes(mm[1])) ? mm[1] : (known[0] || '');
        }
        slots.marker = SEL(m);
        why.push(`跟随标记点「${m}」`);
        break;
      }

      default:
        why.push(def.label);
        break;
    }

    void last;
    return { op, slots, why: why.join('，') || def.label };
  }

  /** 从子句里认出图层名 */
  layerOf(clause) {
    for (const name of this.layerNames) {
      if (clause.includes(name)) return SEL(name);
    }
    // 常见泛称
    if (/副标题|小字/.test(clause)) return SEL('副标题');
    if (/标题|主标题|大字/.test(clause)) return SEL('标题文字');
    return SEL('标题文字');
  }
}

function actionOpOf(clause) {
  for (const { re, act } of ACTION_LEXICON) {
    if (re.test(clause)) return act;
  }
  return null;
}

function pickAnim(clause) {
  if (/回弹|弹|overshoot|bounce/.test(clause)) return 'backOut';
  if (/弹跳|弹簧|elastic/i.test(clause)) return 'elasticOut';
  if (/弹跳|bounce/i.test(clause)) return 'bounceOut';
  return 'backOut';
}
function pickUnit(clause) {
  if (/逐字|按字/.test(clause)) return 'char';
  if (/逐词|按词/.test(clause)) return 'word';
  if (/逐行|按行/.test(clause)) return 'line';
  return 'char';
}
function pickDirection(clause) {
  if (/左/.test(clause)) return 'left';
  if (/右/.test(clause)) return 'right';
  if (/上|顶/.test(clause)) return 'up';
  if (/下|底/.test(clause)) return 'down';
  return 'left';
}
function directionX(clause) {
  const d = pickDirection(clause);
  return d === 'left' ? -120 : d === 'right' ? 120 : 0;
}
function directionY(clause) {
  const d = pickDirection(clause);
  return d === 'up' ? -80 : d === 'down' ? 80 : 0;
}
/**
 * moveIn「距离」槽要的正值（= 位移的模）。
 * 直接从 directionX/directionY 取绝对值，保证两者不会各改各的而漂开。
 * 横向 120 / 纵向 80 是沿用既有的默认幅度。
 */
function directionDist(clause) {
  const d = pickDirection(clause);
  if (d === 'left' || d === 'right') return Math.abs(directionX(clause));
  return Math.abs(directionY(clause));
}
function pickColor(clause) {
  const m = clause.match(/#[0-9a-fA-F]{6}|红|绿|蓝|黄|紫|粉|橙|青|白|黑/);
  if (!m) return null;
  const named = { 红: '#ff4a4a', 绿: '#38c98b', 蓝: '#4a8cff', 黄: '#ffd166', 紫: '#7c5cff', 粉: '#ff6bcb', 橙: '#ff9f45', 青: '#38ffd1', 白: '#ffffff', 黑: '#0d1017' };
  return named[m[0]] || m[0];
}
/** 「创建对象」的类型槽只有这几种，按子句里的形状词挑一个 */
function pickObjectType(clause) {
  if (/圆形|圆圈/.test(clause)) return 'circle';
  if (/文字|文本/.test(clause)) return 'text';
  if (/图片/.test(clause)) return 'image';
  if (/造型|角色|精灵/.test(clause)) return 'sprite';
  return 'rect';
}
/** 位移类积木的缓动：滑行默认平滑，明确要「弹」才用回弹 */
function pickMoveAnim(clause) {
  if (/匀速|线性/.test(clause)) return 'linear';
  if (/回弹|过冲|弹一下/.test(clause)) return 'backOut';
  return 'inOutQuad';
}
/** 变量名：优先引号里的名字，其次「变量 xxx」，最后退回常见的「得分」 */
function varNameOf(clause) {
  const quoted = clause.match(/[「"']([^「」"'\s]{1,20})[」"']/);
  if (quoted) return quoted[1];
  const named = clause.match(/变量\s*([A-Za-z_$\u4e00-\u9fa5][\w$\u4e00-\u9fa5]*)/);
  if (named) return named[1];
  if (/得分|分数/.test(clause)) return '得分';
  return 'score';
}
function extractData(clause) {
  const m = clause.match(/(\d+(?:\s*[,，、]\s*\d+)+)/);
  if (!m) return null;
  return m[1].replace(/[,，、]/g, ',').replace(/\s/g, '');
}

/* ============================================================
   动作序列 → 真正的积木（校验合法性）
   ============================================================ */

/**
 * 槽位名 → 积木槽位下标的映射。
 *
 * 判据是 evaluator 实际怎么读：语句块一律按位置取 E(0)…E(n)，而 E(i) 就是
 * blocks.js 的 def.slots[i]。所以「哪个名字排在第几位」不是风格问题 ——
 * 错开一位，参数就会落进类型不符的槽里（时间槽拿到颜色、数字槽拿到布尔），
 * 积木在界面上看着正常，跑起来全错。
 *
 * 数组里的 null = 这个槽没有对应的解析结果，交给 actionsToBlocks 用
 * blocks.js 的默认值填。不要为了「填满」把别的参数硬塞进去。
 */
export const SLOT_ORDER = {
  charPopIn: ['layer', 'start', 'gap', 'anim'],
  // stagger 的 def.slots 是 [图层, 单元间隔, 起始延迟]，没有「单位」槽；
  // parser 产出的 unit 在这里被有意丢弃（evaluator 里 ensureUnits 固定按 char 走）。
  stagger: ['layer', 'gap', 'start'],
  typewriter: ['layer', 'speed', 'start'],
  fadeIn: ['layer', 'dur', 'start'],
  fadeOut: ['layer', 'dur', 'start'],
  // 「距离」是单值槽：evaluator 自己按 dir 算正负（dir=left → dx=-dist）。
  // 这里必须给正的距离（parser 的 dist），传带符号的 dx 会让「从左滑入」反向。
  moveIn: ['layer', 'dir', 'dist', 'dur', 'start', 'anim'],
  scaleIn: ['layer', 'from', 'to', 'dur', 'start', 'anim'],
  maskWipe: ['layer', 'dur', 'start', 'dir'],
  // def.slots = [图层, 时长, 起始, 振幅]；parser 的 cycles 在这个积木里没有槽。
  pathSweep: ['layer', 'dur', 'start', 'amp'],
  // def.slots 有 5 个，parser 只给 4 个 → 第 5 槽（小数位）走默认值。
  numberRoll: ['layer', 'to', 'dur', 'start'],
  // def.slots = [图层, 台词, 起始, 高亮色]。台词留空是有意的：evaluator 只在
  // words 非空时才改写文本，留空 = 对图层现有文字逐词高亮。
  // parser 的 highlight 是颜色 → 属于第 4 槽；auto 在这个积木里没有槽。
  highlightWord: ['layer', null, null, 'highlight'],
  // def.slots = [图层, 柱数, 起始, 颜色, 增益]，parser 的 source 没有槽。
  audioBars: [null, 'count', null, null, 'gain'],
  // def.slots = [图层, 环数, 起始, 颜色, 半径]；thickness/smooth 没有对应槽。
  ringSpectrum: [null, 'bands', null, null, null],
  // def.slots = [图层, 数据, 单根时长, 间隔, 起始, 颜色]
  growBar: ['layer', 'data', 'perBar', null, 'start', null],
  drawLine: ['layer', 'data', 'perPoint', 'start'],
  // particles / repeater 的积木定义里没有图层槽（运行时按「首槽是不是图层名」
  // 自动判断），所以位置映射从第 0 槽开始，不能再塞 layer。
  particles: ['count', 'start', 'life', 'color', 'speed', 'lifeScale', 'spread', 'gravity', 'drag', 'sizeScale'],
  repeater: ['count', 'spacing', 'gap', 'start', 'h0'],
  // def.slots = [图层, 填充, 宽, 高, 圆角]
  drawShape: ['layer', 'fill', 'w', 'h', 'radius'],
  wait: ['dur'],
  setAt: ['at'],
  loop: ['count'],
  parallel: [],
  atMarker: ['marker'],
  // 以下 op 目前没有本地句式产出，映射先按槽位语义补齐：
  // 契约测试要求每个语句积木都有位置映射，避免将来加句式时错位。
  after: ['delay'],
  waitUntilMarker: ['marker'],
  showText: ['layer', 'text'],
  setText: ['layer', 'text'],
  splitBy: ['layer', 'unit'],
  setFill: ['layer', 'color', 'duration', 'start'],
  if: ['condition'],
  // setVar 的槽 = [变量名(str), 值(num), 作用域(sel)]，与 changeVar 对称。
  setVar: ['name', 'value', 'scope'],

  /* ---------------- 事件帽子（无本地句式，占位映射） ---------------- */
  whenStart: [],
  whenKey: ['key'],
  whenReceive: ['message'],
  whenClicked: [],
  whenAt: ['at', 'mode'],
  whenClone: [],

  /* ---------------- 控制 ---------------- */
  waitUntilTime: ['at'],
  waitUntil: ['condition'],
  forever: [],
  repeatUntil: ['condition'],
  stop: ['mode'],
  broadcast: ['message'],
  broadcastWait: ['message'],

  /* ---------------- 时间 / 关键帧 ---------------- */
  setDuration: ['duration'],
  setKeyframe: ['layer', 'prop', 'at', 'value'],
  setKeyframeColor: ['layer', 'color', 'at'],
  tweenProp: ['layer', 'prop', 'from', 'to', 'dur', 'anim'],
  tweenColor: ['layer', 'from', 'to', 'dur', 'anim'],

  /* ---------------- 运动 ---------------- */
  setPosition: ['layer', 'x', 'y'],
  changeX: ['layer', 'dx'],
  changeY: ['layer', 'dy'],
  setSize: ['layer', 'size'],
  setDirection: ['layer', 'direction'],
  rotateBy: ['layer', 'angle'],
  setOpacity: ['layer', 'opacity'],
  glideTo: ['layer', 'x', 'y', 'dur', 'anim'],
  moveSteps: ['layer', 'steps'],
  pointTowards: ['layer', 'target'],
  bounceOffEdge: ['layer'],
  moveAlongPath: ['layer', 'path', 'dur'],
  formulaMove: ['layer', 'mode', 'ax', 'ay', 'period', 'start'],
  physicsMove: ['layer', 'vx', 'vy', 'gravity', 'bounce', 'friction'],

  /* ---------------- 对象 / 舞台 ---------------- */
  switchBackdrop: ['color'],
  setStageSize: ['width', 'height'],
  setStageFps: ['fps'],
  createObject: ['name', 'type', 'x', 'y'],
  deleteObject: ['layer'],
  showObject: ['layer'],
  hideObject: ['layer'],
  cloneObject: ['layer'],
  bringToFront: ['layer'],
  sendToBack: ['layer'],
  goForward: ['layer'],
  goBackward: ['layer'],
  setParent: ['layer', 'parent'],

  /* ---------------- 外观 ---------------- */
  setTextStyle: ['layer', 'size', 'color', 'weight'],
  setColorEffect: ['layer', 'effect', 'value'],
  changeColorEffect: ['layer', 'effect', 'delta'],
  setBrightness: ['layer', 'value'],
  setSaturation: ['layer', 'value'],
  setContrast: ['layer', 'value'],
  setBlur: ['layer', 'radius'],
  addGlow: ['layer', 'radius', 'color'],
  addShadow: ['layer', 'radius', 'color'],
  clearEffects: ['layer'],
  setBlendMode: ['layer', 'mode'],
  setClipRect: ['layer', 'x', 'y', 'w', 'h'],
  maskWith: ['layer', 'mask'],

  /* ---------------- 声音 ---------------- */
  playSound: ['sound', 'volume'],
  playSoundWait: ['sound', 'volume'],
  stopAllSounds: [],
  setVolume: ['volume'],
  triggerSoundAt: ['sound', 'at', 'volume'],
  switchCostume: ['layer', 'costume'],
  playSequence: ['layer', 'list', 'fps'],

  /* ---------------- 列表 ---------------- */
  listCreate: ['name'],
  listAdd: ['name', 'value'],
  listDelete: ['name', 'index'],
  listInsert: ['name', 'index', 'value'],
  listSet: ['name', 'index', 'value'],
  listClear: ['name'],

  /* ---------------- 变量 ---------------- */
  changeVar: ['name', 'delta', 'scope'],
};

/**
 * 把 Action[] 编译成 IR 积木列表。
 * 凡是编译不了的 action 都会进 skipped，不会塞坏积木树。
 */
export function actionsToBlocks(actions) {
  const blocks = [];
  const skipped = [];

  for (const a of actions || []) {
    const def = defOf(a.op);
    if (!def) { skipped.push({ op: a.op, reason: '未知积木' }); continue; }

    if (def.isLeaf) {
      // 表达式积木：只能作为某个槽位，当前不直接放顶层
      skipped.push({ op: a.op, reason: '表达式积木不能放在顶层' });
      continue;
    }

    const keys = SLOT_ORDER[a.op];
    if (!keys) { skipped.push({ op: a.op, reason: '没有槽位映射' }); continue; }

    const slots = def.slots.map((spec, i) => {
      const key = keys[i];
      const provided = key ? a.slots[key] : undefined;
      if (Array.isArray(spec.default)) {
        return { type: 'blocks', label: spec.label, value: [] };
      }
      if (provided !== undefined) {
        return { type: spec.type, label: spec.label, menu: spec.menu || null, value: provided };
      }
      // 缺省：用积木定义里的默认值，别瞎猜
      const d = spec.default;
      if (d && typeof d === 'object' && d.k) return { type: spec.type, label: spec.label, menu: spec.menu || null, value: d };
      return {
        type: spec.type, label: spec.label, menu: spec.menu || null,
        value: { k: 'lit', t: spec.type === 'num' ? 'num' : spec.type === 'time' ? 'time' : spec.type === 'bool' ? 'bool' : spec.type === 'col' ? 'col' : spec.type === 'sel' ? 'sel' : 'str', v: d },
      };
    });

    blocks.push({ id: uid('B'), k: 'C', op: a.op, slots });
  }

  return { blocks, skipped };
}

/* ============================================================
   2. 文案自动分镜
   ============================================================ */

/** 依据句子特征推荐动效 */
export function suggestEffect(sentence, opts = {}) {
  const s = String(sentence || '');
  const len = [...s].length;

  // 数字 / 百分比 → 强调型
  if (/\d+(\.\d+)?\s*(%|万|亿|元|倍|人|次)/.test(s)) {
    return { op: 'numberRoll', reason: '句中有数字，用滚动强调更有说服力', confidence: 0.8 };
  }
  // 问句 → 悬念型
  if (/[？?]$/.test(s.trim()) || /^(为什么|怎么|如何|是不是|有没有)/.test(s)) {
    return { op: 'scaleIn', reason: '问句适合用缩放制造悬念', confidence: 0.6 };
  }
  // 短句 → 逐字弹入（冲击力）
  if (len <= 8) {
    return { op: 'charPopIn', reason: '短句适合逐字弹入，冲击力强', confidence: 0.75 };
  }
  // 长句 → 打字机（阅读引导）
  if (len >= 18) {
    return { op: 'typewriter', reason: '长句用打字机引导阅读', confidence: 0.7 };
  }
  // 列举（顿号/逗号多）→ 错峰
  if ((s.match(/[、，,]/g) || []).length >= 3) {
    return { op: 'stagger', reason: '含多个并列项，错峰依次出现更清晰', confidence: 0.65 };
  }
  // 默认淡入
  return { op: opts.defaultOp || 'fadeIn', reason: '常规陈述句，淡入最稳妥', confidence: 0.5 };
}

/**
 * 把一段文案拆成场景
 * @returns {{scenes:Array, totalDuration:number}}
 */
export function scriptToStoryboard(text, opts = {}) {
  const src = String(text || '').trim();
  const cps = opts.cps || 5.5;                 // 每秒字数
  const minDur = opts.minDur || 1.2;
  const maxDur = opts.maxDur || 8;
  const gap = opts.gap == null ? 0.35 : opts.gap;

  // 按句末标点切句；没有标点就按换行
  let parts = src.split(/(?<=[。！？!?；;])|\n+/).map(s => s.trim()).filter(Boolean);
  const noTerminator = parts.every(p => !/[。！？!?；;]/.test(p));
  if (parts.length <= 1 || noTerminator) {
    const finer = src.split(/[，,、]/).map(s => s.trim()).filter(Boolean);
    if (finer.length > parts.length) parts = finer;
  }
  // 连逗号都没有的超长段落 → 按字数硬切（总不至于给用户一个 45 字的场景）
  if (parts.length <= 1 && parts[0] && [...parts[0]].length > 28) {
    parts = hardSplit(parts[0], 20);
  }

  const scenes = [];
  let cursor = opts.startAt || 0;

  for (const p of parts) {
    const text2 = p.replace(/[。！？!?；;，,、]$/, '');
    const dur = clampDuration([...text2].length / cps, minDur, maxDur);
    const sug = suggestEffect(text2);
    scenes.push({
      id: uid('SC'),
      index: scenes.length,
      text: text2,
      start: round2(cursor),
      end: round2(cursor + dur),
      duration: round2(dur),
      suggested: sug,
      subtitleText: splitForSubtitle(text2),
      markers: [
        { name: `SC${scenes.length + 1}`, time: round2(cursor), label: text2.slice(0, 10) },
      ],
    });
    cursor += dur + gap;
  }

  return {
    scenes,
    totalDuration: round2(Math.max(0, cursor - gap)),
    wordCount: [...src.replace(/\s/g, '')].length,
  };
}

/** 把一段没有标点的长文按字数硬切成若干段（尽量在语义停顿处断开） */
function hardSplit(text, maxChars) {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return [text];
  const out = [];
  let buf = '';
  for (let i = 0; i < chars.length; i++) {
    buf += chars[i];
    if ([...buf].length < maxChars) continue;
    // 到上限了：优先看下一个字是不是虚词/标点 —— 在那里断开更自然
    const next = chars[i + 1];
    if (!next) { out.push(buf); buf = ''; break; }
    if (/[，。！？、；：的了和与]/.test(next)) { out.push(buf); buf = ''; continue; }
    // 否则在上限附近回退到最近的可断点（虚词之前）；找不到就按上限硬切
    const cut = findSoftCut(buf);
    if (cut > 0 && cut < buf.length) {
      out.push(buf.slice(0, cut));
      buf = buf.slice(cut) + chars[i + 1];
      i++;                       // 跳过分给下一段的那个字
    } else {
      out.push(buf);
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length ? out : [text];
}

/** 在一段文字里找一个还算自然的下刀点（虚词/助词之前） */
function findSoftCut(s) {
  const chars = Array.from(s);
  for (let i = chars.length - 1; i >= Math.floor(chars.length / 2); i--) {
    if (/[的了和与是也就都在要把被这那]/.test(chars[i])) return i;
  }
  return -1;
}

/** 把一句话切成适合做字幕的片段（按标点与长度） */
export function splitForSubtitle(sentence, maxChars = 16) {
  const s = String(sentence || '');
  if ([...s].length <= maxChars) return [s];
  const parts = [];
  let buf = '';
  for (const ch of s) {
    buf += ch;
    if ('，。！？；、,.!?; '.includes(ch) && [...buf].length >= 5) {
      parts.push(buf.trim()); buf = '';
    } else if ([...buf].length >= maxChars) {
      parts.push(buf.trim()); buf = '';
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.filter(Boolean);
}

/* ============================================================
   3. 字幕/配音 → 自动对齐文字动画
   ------------------------------------------------------------
   规划：「导入配音或字幕文件，自动按时间轴对齐文字动画节拍」
   这里把字幕条转成可直接用的积木序列 + 标记点。
   ============================================================ */
export function subtitlesToBlocks(track, opts = {}) {
  const layer = opts.layer || '标题文字';
  const actions = [];
  const markers = [];
  const skipped = [];

  for (const cue of track.cues || []) {
    markers.push({ id: uid('M'), name: cue.text.slice(0, 8) || 'C', time: cue.start, label: cue.text.slice(0, 12) });

    // 有词级时间码 → 逐词高亮（最贴合配音）
    if (cue.words && cue.words.length) {
      actions.push({
        op: 'highlightWord',
        slots: { layer: SEL(layer), highlight: COL(opts.highlight || '#38ffd1'), auto: BOOL(true) },
        why: `按词级时间码高亮「${cue.text.slice(0, 8)}」`,
      });
      continue;
    }
    // 否则按字数比例推一个错峰间隔，让入场跟着句子长度走
    const chars = [...cue.text].length || 1;
    const span = Math.max(0.2, cue.end - cue.start);
    const gap = clampDuration(span / chars * 0.8, 0.02, 0.2);
    const sug = suggestEffect(cue.text);
    const slots = { layer: SEL(layer) };
    if (sug.op === 'charPopIn') {
      slots.start = TIME(round2(cue.start));
      slots.gap = TIME(round2(gap));
      slots.anim = SEL('backOut');
    } else if (sug.op === 'typewriter') {
      slots.start = TIME(round2(cue.start));
      slots.speed = NUM(Math.round(chars / span));
    } else {
      slots.start = TIME(round2(cue.start));
      if ('dur' in (sug.op === 'fadeIn' ? { dur: 1 } : {})) slots.dur = TIME(round2(Math.min(span * 0.6, 1.2)));
    }
    actions.push({ op: sug.op, slots, why: `字幕「${cue.text.slice(0, 8)}」→ ${sug.op}（${sug.reason}）` });
  }

  const compiled = actionsToBlocks(actions);
  skipped.push(...compiled.skipped);
  return { blocks: compiled.blocks, markers, actions, skipped };
}

/* ============================================================
   4. 反向解释：动画 → 积木 → 人话
   ------------------------------------------------------------
   规划：「已有动画反向解释成积木（教学价值极高）」
   这里做两件事：
     a) 积木 → 结构化解释（每个积木一句人话 + 时间轴）
     b) 帧采样 → 反推动效参数（从画面变化猜「大概是淡入还是位移」）
   ============================================================ */

/** 积木 → 人话 */
export function explainBlock(b, ctx = {}) {
  const def = defOf(b.op);
  if (!def) return `未知积木 ${b.op}`;
  const v = (i) => slotValue(b, i);
  const t = (i) => fmtTime(v(i));

  switch (b.op) {
    case 'charPopIn':
      return `让「${v(0).v}」逐字弹入，从 ${t(1)} 开始，每个字间隔 ${v(2).v} 秒，用 ${v(3).v} 缓动`;
    case 'stagger':
      return `把「${v(0).v}」依次错峰入场，单元间隔 ${v(1).v} 秒，从 ${t(2)} 开始`;
    case 'typewriter':
      return `「${v(0).v}」以每秒 ${v(1).v} 字的速度打字机式显现，从 ${t(2)} 开始`;
    case 'fadeIn':
      return `「${v(0).v}」在 ${t(2)} 用 ${v(1).v} 秒淡入`;
    case 'fadeOut':
      return `「${v(0).v}」在 ${t(2)} 用 ${v(1).v} 秒淡出`;
    case 'moveIn':
      return `「${v(0).v}」从${dirName(v(1).v)}方向偏移 ${v(2).v} 滑入，用 ${v(3).v} 秒`;
    case 'scaleIn':
      return `「${v(0).v}」从 ${v(1).v} 倍缩放到 ${v(2).v} 倍，用 ${v(3).v} 秒`;
    case 'maskWipe':
      return `「${v(0).v}」用遮罩从${dirName(v(3).v)}擦出，用 ${v(1).v} 秒`;
    case 'pathSweep':
      return `「${v(0).v}」沿波浪路径扫过，用 ${v(1).v} 秒，振幅 ${v(3).v}`;
    case 'numberRoll':
      return `「${v(0).v}」的数字从 0 滚到 ${v(1).v}，用 ${v(2).v} 秒`;
    case 'highlightWord':
      return `「${v(0).v}」做卡拉OK逐词高亮，高亮色 ${v(3).v}`;
    case 'audioBars':
      return `画 ${v(1).v} 根音频波形柱，跟着音量跳动`;
    case 'ringSpectrum':
      return `画环形频谱，${v(1).v} 个频段，半径 ${v(4).v}`;
    case 'growBar':
      return `柱状图按数据「${v(1).v}」逐根生长，每根 ${v(2).v} 秒`;
    case 'drawLine':
      return `折线图按数据「${v(1).v}」依次绘出，整段 ${v(2).v} 秒`;
    case 'particles':
      return `${v(0).v} 个粒子的粒子系统，速度 ${v(4).v}，寿命 ${v(2).v} 秒`;
    case 'repeater':
      return `复制 ${v(0).v} 份，水平间距 ${v(1).v}，错峰间隔 ${v(2).v} 秒`;
    case 'drawShape':
      return `在「${v(0).v}」上绘制图元，填充 ${v(1).v}`;
    case 'wait':
      return `等待 ${v(0).v} 秒`;
    case 'setAt':
      return `在第 ${v(0).v} 秒执行后面的内容`;
    case 'atMarker':
      return `把后续内容绑定到标记点「${v(0).v}」，改配音会自动跟随`;
    case 'loop':
      return `把下面这段重复 ${v(0).v} 次`;
    case 'parallel':
      return '两段内容同时开始';
    case 'waitUntilMarker':
      return `暂停直到标记点「${v(0).v}」`;
    case 'showText':
      return `显示「${v(0).v}」${v(1).v ? `，内容为「${v(1).v}」` : ''}`;
    case 'setText':
      return `把「${v(0).v}」的文本改成「${v(1).v}」`;
    case 'splitBy':
      return `把「${v(0).v}」按${unitName(v(1).v)}拆分`;
    case 'setFill':
      return `设置「${v(0).v}」填充色为 ${v(1).v}`;
    default:
      return def.label + (def.desc ? `（${def.desc}）` : '');
  }
  void ctx;
}

/** 整个图层的积木 → 时间轴脚本 */
export function explainLayer(layer, ctx = {}) {
  const lines = [];
  for (const b of layer.blocks || []) {
    lines.push(explainBlock(b, ctx));
  }
  return lines;
}

/** 整份工程的自然语言说明 */
export function explainProject(ir, opts = {}) {
  const out = [];
  const p = ir.project;
  out.push(`这是一个 ${p.width}×${p.height}、${p.duration} 秒、${p.fps} 帧/秒的动画工程，共 ${ir.layers.length} 个图层。`);

  for (const l of ir.layers) {
    const desc = explainLayer(l, opts);
    if (!desc.length) {
      out.push(`图层「${l.name}」没有积木，属性是静态的${l.props.text ? `，显示「${l.props.text}」` : ''}。`);
      continue;
    }
    out.push(`图层「${l.name}」的逻辑是：` + desc.join('；') + '。');
  }
  return out;
}

/* ============================================================
   5. 从画面反推动效（教学向）
   ------------------------------------------------------------
   采样若干帧，比较图层的关键属性变化，反推是哪类动效。
   ============================================================ */
export function inferEffectFromFrames(ir, layerId, audio, opts = {}) {
  const layer = ir.layers.find(l => l.id === layerId);
  if (!layer) throw new Error('找不到图层');
  const fps = opts.fps || ir.project.fps;
  const samples = opts.samples || 24;

  const series = [];
  for (let i = 0; i < samples; i++) {
    const t = (i / (samples - 1)) * Math.min(ir.project.duration, opts.window || 3);
    const { state } = evaluateFrame(ir, t, audio);
    const ls = state.layers[layer.id];
    if (!ls) continue;
    const p = ls.p || {};
    series.push({
      t,
      opacity: ls.opacity == null ? 1 : ls.opacity,
      x: p.x == null ? 0 : p.x,
      y: p.y == null ? 0 : p.y,
      scale: p.scale == null ? 1 : p.scale,
    });
  }
  if (series.length < 3) throw new Error('采样点太少，无法反推');

  const range = (key) => {
    const vs = series.map(s => s[key]);
    return { min: Math.min(...vs), max: Math.max(...vs), delta: Math.max(...vs) - Math.min(...vs) };
  };

  const o = range('opacity'), x = range('x'), y = range('y'), s = range('scale');
  // 找「真正发生变化」的那段（跳过静止的头尾）
  let firstMoving = series.findIndex(s2 => s2.opacity < 0.999 || Math.abs(s2.scale - 1) > 0.01);
  if (firstMoving < 0) firstMoving = 0;

  const guesses = [];
  if (o.delta > 0.3) guesses.push({ effect: 'fadeIn', confidence: Math.min(1, o.delta), evidence: `透明度变化了 ${o.delta.toFixed(2)}` });
  if (x.delta > 20 || y.delta > 20) {
    const dir = Math.abs(x.delta) >= Math.abs(y.delta)
      ? (x.max > x.min ? 'left' : 'right') : (y.max > y.min ? 'up' : 'down');
    guesses.push({ effect: 'moveIn', dir, confidence: Math.min(1, (Math.abs(x.delta) + Math.abs(y.delta)) / 200), evidence: `位移了 ${x.delta.toFixed(0)}×${y.delta.toFixed(0)} 像素` });
  }
  if (s.delta > 0.05) guesses.push({ effect: 'scaleIn', confidence: Math.min(1, s.delta * 2), evidence: `缩放变化了 ${s.delta.toFixed(2)}` });

  guesses.sort((a, b) => b.confidence - a.confidence);

  return {
    layerId,
    startTime: round2(series[firstMoving].t),
    duration: round2(series[series.length - 1].t - series[firstMoving].t),
    guesses,
    best: guesses[0] || { effect: 'none', confidence: 0, evidence: '画面基本静止' },
    series,
  };
}

/* ============================================================
   6. 建议引擎（非破坏，只给建议）
   ------------------------------------------------------------
   扫一遍工程，指出常见问题：
     · 没有任何动画 → 建议先加入场
     · 图层数很多但没编组 → 建议编组
     · 字幕超长 → 建议拆句
     · 没有音频但用了音频驱动积木 → 提醒
     · 时长与帧率不匹配 → 提醒
   ============================================================ */
export function lintProject(ir, audio, opts = {}) {
  const issues = [];
  const add = (level, kind, msg, fix) => issues.push({ level, kind, msg, fix });

  const animated = ir.layers.filter(l => (l.blocks || []).length);
  if (!animated.length) {
    add('warn', 'noBlocks', '没有任何图层搭了动画逻辑，画面全程静止', '给图层加一个「淡入」试试');
  }

  for (const l of ir.layers) {
    for (const b of l.blocks || []) {
      scanBlock(b, l, ir);
    }
  }

  // 音频驱动积木但没音频
  const usesAudio = ir.layers.some(l => containsAudioOp(l.blocks));
  const hasAudio = audio && audio.isReal && audio.isReal();
  if (usesAudio && !hasAudio) {
    add('info', 'audioFallback', '用了音频驱动积木，但当前是合成音频（画面会按合成节拍走）', '导入真实音频后效果会自动切换');
  }

  // 帧率与时长
  const dur = Number(ir.project.duration) || 0;
  const fps = Number(ir.project.fps) || 0;
  const frames = dur * fps;
  // 浮点比较要给容差：5.5*24=132 其实是整数，浮点算出来可能是 131.99999…
  if (fps > 0 && Math.abs(frames - Math.round(frames)) > 1e-6) {
    add('info', 'fpsMismatch', `时长 ${dur}s × ${fps}fps = ${frames.toFixed(2)} 帧，不是整数`, '把时长调整成 fps 的整数倍，导出更整齐');
  }
  if (dur < 1) add('warn', 'tooShort', '时长不足 1 秒', '短视频通常至少 3 秒');
  if (dur > 120) add('warn', 'tooLong', '时长超过 2 分钟，渲染会比较慢', '可以拆成多条');

  void opts;
  return issues;

  function scanBlock(b, layer) {
    if (b.op === 'wait' && slotNum(b, 0) === 0) {
      add('warn', 'zeroWait', `图层「${layer.name}」有一个时长为 0 的「等待」`, '删掉它，或给它一个时长');
    }
    if (b.op === 'charPopIn' && slotNum(b, 2) <= 0) {
      add('warn', 'zeroGap', `图层「${layer.name}」逐字弹入的间隔是 0`, '间隔为 0 等于没拆分，改成 0.05 左右');
    }
    if (b.op === 'repeater' && slotNum(b, 1) > 200) {
      add('warn', 'tooManyRepeats', `图层「${layer.name}」重复器复制了 ${slotNum(b, 1)} 份`, '超过 200 份渲染会明显变慢');
    }
    if (b.slots) {
      for (const s of b.slots) {
        if (Array.isArray(s.value)) s.value.forEach(x => scanBlock(x, layer));
      }
    }
  }
}

function containsAudioOp(blocks) {
  for (const b of blocks || []) {
    if (['audioBars', 'ringSpectrum', 'highlightWord'].includes(b.op)) return true;
    if (b.slots) for (const s of b.slots) if (Array.isArray(s.value) && containsAudioOp(s.value)) return true;
  }
  return false;
}

/* ============================================================
   小工具
   ============================================================ */
function slotValue(b, i) {
  const s = b.slots && b.slots[i];
  if (!s) return { k: 'lit', t: 'num', v: 0 };
  return s.value && typeof s.value === 'object' && s.value.k ? s.value : { k: 'lit', t: 'str', v: s.value };
}
function slotNum(b, i) { const v = slotValue(b, i); return typeof v.v === 'number' ? v.v : parseFloat(v.v) || 0; }
function fmtTime(v) { return (v && v.v != null ? v.v : 0) + ' 秒'; }
function round2(n) { return Math.round(n * 100) / 100; }
function clampDuration(d, min, max) { return Math.max(min, Math.min(max, d)); }
function unitName(u) { return { char: '字', word: '词', line: '行', whole: '整块' }[u] || u; }
function dirName(d) { return { left: '左', right: '右', up: '上', down: '下' }[d] || d; }
function axisName(a) { return { x: '水平', y: '垂直', both: '两轴' }[a] || a; }
function shapeName(s) { return { rect: '矩形', circle: '圆形', triangle: '三角形', star: '星形', line: '线条' }[s] || s; }

export { clone };
/** 供在线模型适配器复用：op → 槽位键顺序（与 actionsToBlocks 同一张表） */
export { SLOT_ORDER as ACTION_SLOT_ORDER };