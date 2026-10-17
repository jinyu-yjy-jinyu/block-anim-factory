/* ============================================================
   zip.js · 极简 ZIP（store + deflate-raw），无依赖
   用于「导出 PNG 序列帧（带 Alpha）」通道。
   ============================================================ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function deflateRaw(u8) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    // 关键：不要写成 `new Blob([u8]).stream()`。
    // Blob 构造会把 u8 **整份复制**进 blob 的存储，然后 .stream() 再从
    // 那份副本读出来 —— 等于为了压缩一帧 PNG，内存里先多出一整份。
    // 序列帧导出时这是每帧一次、峰值随帧数线性涨的主因。
    // 直接把 u8 写进 CompressionStream 的 writable，零额外拷贝。
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    // 必须先挂上读端再写，否则背压会把写端卡住
    const readPromise = new Response(cs.readable).arrayBuffer();
    writer.write(u8);
    writer.close();
    const buf = await readPromise;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

export async function createZip(entries, onProgress) {
  // entries: [{name, data: Uint8Array}] 或 [{name, data: () => Promise<Uint8Array>}]
  // 传函数形式时**逐条取数据、压缩完就丢弃原始引用**，峰值内存不再随
  // 帧数线性增长（序列帧导出 1080p 120 帧时，全攒着要 ~200MB 常驻）。
  const chunks = [];
  const central = [];
  let offset = 0;

  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((now.getSeconds() / 2) & 31);
  const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const nameBytes = enc.encode(e.name);
    // 延迟取数：data 可能是 Uint8Array，也可能是返回它的函数
    const raw = typeof e.data === 'function' ? await e.data() : e.data;
    const crc = crc32(raw);

    let method = 0;
    let body = raw;
    const packed = await deflateRaw(raw);
    if (packed && packed.length < raw.length) { method = 8; body = packed; }

    // 文件名一律按 UTF-8 写入；含非 ASCII 时必须置 general purpose bit 11 (0x0800)，
    // 否则解压方会退回本地代码页解码，中文名乱码。
    const flags = /[^\x00-\x7F]/.test(e.name) ? 0x0800 : 0;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, body);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + body.length;
    if (onProgress) onProgress((i + 1) / entries.length, e.name);
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}
