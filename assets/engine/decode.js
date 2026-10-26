/* ============================================================
   decode.js — 解码、EXIF 校正、降采样、alpha 分析
   规则来源：需求 2.2 / 4.7，技术方案 §3.2 M1、§4.2、§4.3
   ============================================================ */

import { checkDimensions } from './validate.js';

/** 通读一个 ImageBitmap 的 alpha 覆盖率（抽样，快）。 */
function alphaStats(bitmap) {
  const maxSide = 320;
  const s = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * s));
  const h = Math.max(1, Math.round(bitmap.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, w, h);
  let data;
  try {
    data = g.getImageData(0, 0, w, h).data;
  } catch {
    return { hasAlpha: false, alphaCoverage: 1 };
  }
  let opaque = 0, transparent = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 8) opaque++; else transparent++;
  }
  const total = opaque + transparent;
  const coverage = total ? opaque / total : 1;
  return {
    hasAlpha: transparent > total * 0.002,
    alphaCoverage: coverage,
  };
}

/** 不透明像素的主体包围盒（技术方案 §3.2 M2 的输入）。 */
function alphaBBox(bitmap) {
  const maxSide = 420;
  const s = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * s));
  const h = Math.max(1, Math.round(bitmap.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h).data;

  let minX = w, minY = h, maxX = -1, maxY = -1;
  const thr = 12;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > thr) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const k = bitmap.width / w;
  return {
    x: (minX / w) * bitmap.width,
    y: (minY / h) * bitmap.height,
    w: ((maxX - minX + 1) / w) * bitmap.width,
    h: ((maxY - minY + 1) / h) * bitmap.height,
    scaleUp: k,
  };
}

/** GIF：优先 WebCodecs ImageDecoder 取首帧，失败回退 <img> 解码。 */
async function decodeGifFirstFrame(file) {
  if (typeof window !== 'undefined' && 'ImageDecoder' in window) {
    try {
      if (await window.ImageDecoder.isTypeSupported('image/gif')) {
        const buf = await file.arrayBuffer();
        const dec = new window.ImageDecoder({ data: buf, type: 'image/gif' });
        await dec.tracks.ready;
        const frameCount = dec.tracks.selectedTrack?.frameCount ?? 1;
        const frame = await dec.decode({ frameIndex: 0 });
        const bmp = await createImageBitmap(frame.image);
        frame.image.close();
        dec.close();
        return { bitmap: bmp, frameCount };
      }
    } catch {
      /* 落到 <img> 兜底 */
    }
  }
  // 回退：浏览器自解码，取当前帧（通常即首帧）
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImgEl(url);
    const bmp = await createImageBitmap(img);
    return { bitmap: bmp, frameCount: 0 }; // 0 = 未知
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImgEl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = url;
  });
}

/**
 * 解码 + 归一化。返回 NormalizedImage。
 * @param {File} file
 * @param {(pct:number, note?:string)=>void} onProgress
 */
export async function normalize(file, format, onProgress = () => {}) {
  let bitmap;
  let gifFrameCount = 0;

  if (format === 'gif') {
    const r = await decodeGifFirstFrame(file);
    bitmap = r.bitmap;
    gifFrameCount = r.frameCount;
  } else {
    // imageOrientation: 'from-image' 自动按 EXIF 方向校正（需求 2.2 最后一行）
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      bitmap = await createImageBitmap(file);
    }
  }

  onProgress(6);

  const dim = checkDimensions(bitmap.width, bitmap.height);
  if (!dim.ok) {
    bitmap.close?.();
    const err = new Error(dim.reason);
    err.code = 'E_SMALL';
    throw err;
  }

  // 第二道：长边超过 1600 一律降采样（技术方案 §4.3 的量化依据）
  const LONG_TARGET = 1600;
  let outBmp = bitmap;
  let didDownscale = !!dim.downscaled;
  let finalW = bitmap.width;
  let finalH = bitmap.height;
  let downscaleNote = dim.reason || null;
  const srcW = bitmap.width;
  const srcH = bitmap.height;

  const long = Math.max(bitmap.width, bitmap.height);
  if (long > LONG_TARGET) {
    const s = LONG_TARGET / long;
    finalW = Math.round(bitmap.width * s);
    finalH = Math.round(bitmap.height * s);
    try {
      outBmp = await createImageBitmap(bitmap, {
        resizeWidth: finalW,
        resizeHeight: finalH,
        resizeQuality: 'high',
      });
      bitmap.close?.();
      didDownscale = true;
      downscaleNote =
        `原图 ${srcW}×${srcH} 已优化至 ${finalW}×${finalH} 以提升流畅度。`;
    } catch {
      outBmp = bitmap;
      finalW = bitmap.width;
      finalH = bitmap.height;
    }
  } else if (didDownscale) {
    // 满足 4096/1678 万约束但未超 1600 —— 仍需按 checkDimensions 的缩放执行
    try {
      outBmp = await createImageBitmap(bitmap, {
        resizeWidth: finalW,
        resizeHeight: finalH,
        resizeQuality: 'high',
      });
      bitmap.close?.();
    } catch { /* 保持原样 */ }
  }

  onProgress(9);

  const alpha = alphaStats(outBmp);
  const bbox = alphaBBox(outBmp);

  return {
    bitmap: outBmp,
    width: finalW,
    height: finalH,
    srcWidth: srcW,
    srcHeight: srcH,
    hasAlpha: alpha.hasAlpha,
    alphaCoverage: alpha.alphaCoverage,
    bbox: bbox || { x: 0, y: 0, w: finalW, h: finalH },
    didDownscale,
    downscaleNote,
    sourceFormat: format,
    gifFrameCount,
    noTransparency: !alpha.hasAlpha,
  };
}
