/* ============================================================
   validate.js — S1 输入校验（需求 2.2 / F-01 / F-02 / P0-03..06）
   纯函数，无 DOM 副作用，可单测。
   ============================================================ */

export const LIMITS = {
  maxBytes: 20 * 1024 * 1024,      // 20 MB
  maxEdge: 4096,                  // 单边上限
  maxPixels: 16777216,            // 总像素 ≤ 16,777,216（≈1678 万，2^24）
  minShortSide: 256,              // 短边下限
};

export const FORMAT_LABEL = 'PNG、JPG、WebP、GIF';

const TYPE_MAP = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** 按扩展名兜底识别（有些系统拖入文件不带 MIME）。 */
function extOf(name = '') {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

const EXT_MAP = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif' };

/**
 * 第一层：类型与体积（不需要解码，立即返回）。
 * @returns {{ok:boolean, kind:'format'|'size'|null, reason?:string, format?:string}}
 */
export function checkFile(file) {
  if (!file) return { ok: false, kind: 'format', reason: '没有拿到文件。' };

  const byMime = TYPE_MAP[(file.type || '').toLowerCase()];
  const byExt = EXT_MAP[extOf(file.name)];
  const format = byMime || byExt || null;

  if (!format) {
    return {
      ok: false,
      kind: 'format',
      reason: '这不是支持的图片格式。支持 ' + FORMAT_LABEL + '，其它格式（如 PDF、TXT、PSD）需要先导出成图片。',
    };
  }
  if (typeof file.size === 'number' && file.size > LIMITS.maxBytes) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      kind: 'size',
      reason: `这个文件 ${mb} MB，超过 20 MB 上限。请先压缩或缩小尺寸后重试（导出时把长边压到 2000px 以内通常就够了）。`,
    };
  }
  if (typeof file.size === 'number' && file.size === 0) {
    return { ok: false, kind: 'format', reason: '这个文件是空的（0 字节），可能没有上传完整。' };
  }
  return { ok: true, format };
}

/**
 * 第二层：解码后的像素尺寸（F-02 / P0-04 / P0-05）。
 * 短边过小 → 拒绝；超像素上限 → 等比缩小并明示（不拒绝）。
 */
export function checkDimensions(width, height) {
  const short = Math.min(width, height);
  const long = Math.max(width, height);

  if (short < LIMITS.minShortSide) {
    return {
      ok: false,
      kind: 'small',
      reason: `图片只有 ${width}×${height}，短边小于 ${LIMITS.minShortSide}px。太小的话五官定位会失稳，请换一张更大的图。`,
    };
  }

  const overEdge = long > LIMITS.maxEdge;
  const overPixels = width * height > LIMITS.maxPixels;
  if (!overEdge && !overPixels) {
    return { ok: true, scale: 1, width, height, downscaled: false };
  }

  // 等比缩到同时满足单边与总像素两条约束
  let scale = 1;
  if (overEdge) scale = Math.min(scale, LIMITS.maxEdge / long);
  if (overPixels) scale = Math.min(scale, Math.sqrt(LIMITS.maxPixels / (width * height)));

  // 用四舍五入而非向下取整：6000×4000 → 4096×2731（向下取整会得到 4096×2730）。
  // 再夹回上限，避免取整后单边 / 总像素越界。
  const clampW = (v) => Math.min(LIMITS.maxEdge, Math.max(LIMITS.minShortSide, Math.round(v)));
  const w = clampW(width * scale);
  const h = clampW(height * scale);
  return {
    ok: true,
    scale,
    width: w,
    height: h,
    downscaled: true,
    reason: `原图 ${width}×${height} 超过 ${LIMITS.maxEdge}×${LIMITS.maxEdge} 或 ${LIMITS.maxPixels} 像素上限，已为你缩小到 ${w}×${h}。`,
  };
}

/** 供 UI 用的一句话规格描述。 */
export function describeBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
