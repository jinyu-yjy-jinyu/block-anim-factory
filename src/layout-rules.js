/* ============================================================
   layout-rules.js · 中文排版规则
   ------------------------------------------------------------
   标点避头尾（禁则处理）。中文场景必做，
   否则一眼就能看出是外国人做的软件 —— 这是规划里点名的一条。

   NO_START：不能出现在行首的字符（行首禁则）
   NO_END  ：不能出现在行尾的字符（行尾禁则）
   ============================================================ */

/* 行首禁则：闭合类标点、后缀类符号 */
export const NO_START =
  '，。、；：？！）］｝〕〉》」』】〗〞”’·・ー々〻‐゠–〜' +
  '!%),.:;?]}¢°’”‰′″℃℉、。〉》」』】〙〗〟｠»' +
  '､｡｣ﾞﾟ!!??))｝｟' +
  ',.;:?!)]}>"\'' +
  '%‰℃℉°′″…—―～〜·・:;';

/* 行尾禁则：开启类标点、前缀类符号 */
export const NO_END =
  '（［｛〔〈《「『【〖〝‘“' +
  '([{<¥$£€₩#@' +
  '"\'“‘' +
  '＄（［｛£¥';

/* 可压缩的标点（排版微调） */
export const COMPRESSIBLE =
  '，。、；：！？';

/* 中日韩字符（用于断行判断：CJK 可任意位置断行） */
export const CJK = '\\u2e80-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef\\u3000-\\u303f';

/* 拉丁词（不可在词中断开） */
export const LATIN_WORD = /[A-Za-z0-9'’-]+/g;

/** 判断某字符之后是否允许断行 */
export function canBreakAfter(str, i) {
  const ch = str[i];
  if (i >= str.length - 1) return false;
  if (NO_START.includes(ch)) return false;
  // 拉丁词内部不断
  if (LATIN_WORD.test(ch)) {
    LATIN_WORD.lastIndex = 0;
    const next = str[i + 1];
    if (next && /[A-Za-z0-9'’-]/.test(next)) return false;
  }
  return true;
}

/** 判断某字符之前是否允许断行 */
export function canBreakBefore(str, i) {
  if (i <= 0) return false;
  return !NO_END.includes(str[i]);
}