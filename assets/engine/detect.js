/* ============================================================
   detect.js — 头部区域探索 + MediaPipe 关键点检测（懒加载）
   依据：技术方案 §2.1 / §3.2 M2、M3 / §4.1
   实测结论：整图直检 25%，头部裁剪 3 档候选 → 62.5%
   ============================================================ */

const MODEL_URL = './models/face_landmarker.task';
const WASM_BASE = './vendor/';

/** 生成 3 档头部候选框（均放大到长边约 512 后送检）。 */
export function headCandidates(img) {
  const { width: W, height: H, bbox } = img;
  const list = [];

  // 档 1：主体包围盒顶部 42%（全身/半身立绘最准）
  if (bbox && bbox.w > 0 && bbox.h > 0) {
    const cw = Math.min(W, bbox.w * 0.66);
    const ch = Math.min(H, bbox.h * 0.44);
    list.push({
      x: Math.max(0, bbox.x + (bbox.w - cw) / 2),
      y: Math.max(0, bbox.y - ch * 0.06),
      w: cw,
      h: ch,
      reason: 'body-bbox-top',
    });
  }

  // 档 2：整图顶部 40% 居中正方形（实验验证有效的档位）
  {
    const ch = Math.min(H, H * 0.40);
    const cw = Math.min(W, ch * 1.0);
    list.push({
      x: Math.max(0, (W - cw) / 2),
      y: 0,
      w: cw,
      h: ch,
      reason: 'fixed-ratio',
    });
  }

  // 档 3：居中偏上的宽框（应对半身近景，脸占比大的图）
  {
    const cw = Math.min(W, W * 0.86);
    const ch = Math.min(H, H * 0.56);
    list.push({
      x: Math.max(0, (W - cw) / 2),
      y: Math.max(0, H * 0.02),
      w: cw,
      h: ch,
      reason: 'centered-wide',
    });
  }

  // 档 4：整图（用于大特写）
  list.push({ x: 0, y: 0, w: W, h: H, reason: 'whole' });

  return list.filter((c) => c.w >= 64 && c.h >= 64);
}

/** 把某个候选框渲染成 ≤512 长边的位图，供检测器消费。 */
function cropBitmap(img, rect, targetLong = 512) {
  const s = Math.min(1, targetLong / Math.max(rect.w, rect.h));
  const w = Math.max(32, Math.round(rect.w * s));
  const h = Math.max(32, Math.round(rect.h * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  g.drawImage(img.bitmap, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
  return createImageBitmap(c);
}

/* ───────────── 懒加载器 ───────────── */

let landmarkerPromise = null;
let landmarkerState = 'idle'; // idle | loading | ready | failed

export function detectorState() { return landmarkerState; }

/**
 * 懒加载 MediaPipe FaceLandmarker。
 * @param {(pct:number, note?:string)=>void} onProgress 真实字节进度
 */
export function loadLandmarker(onProgress = () => {}) {
  if (landmarkerPromise) return landmarkerPromise;

  landmarkerState = 'loading';
  landmarkerPromise = (async () => {
    // 1) 先下载模型（自己 fetch，才能拿到真实字节进度）
    let modelBuf;
    const res = await fetch(MODEL_URL, { cache: 'force-cache' });
    if (!res.ok) throw new Error('E_MODEL_FETCH');
    const total = Number(res.headers.get('content-length')) || 3758596;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        onProgress(Math.min(0.97, got / total), `模型 ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
      }
      modelBuf = new Blob(chunks);
    } else {
      modelBuf = await res.blob();
      onProgress(0.97, '模型已就绪');
    }

    // 2) 初始化 tasks-vision（同源 WASM）
    const vision = await import('../../vendor/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks(
      new URL(WASM_BASE, document.baseURI).href.replace(/\/$/, '')
    );
    const lm = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetBuffer: new Uint8Array(await modelBuf.arrayBuffer()),
        delegate: 'CPU',
      },
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
      runningMode: 'IMAGE',
      numFaces: 4,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    onProgress(1, '模型已就绪');
    landmarkerState = 'ready';
    return lm;
  })().catch((e) => {
    landmarkerState = 'failed';
    landmarkerPromise = null;
    throw e;
  });

  return landmarkerPromise;
}

/**
 * 多候选检测。返回按面积排序的人脸列表（已换算回图像坐标）。
 * @returns {{faces: Array, tried:number, best: object|null}}
 */
export async function detectFaces(img, onProgress = () => {}) {
  const lm = await loadLandmarker((p, note) => onProgress(p * 0.55, note));
  const cands = headCandidates(img);
  const faces = [];
  const seen = [];

  for (let i = 0; i < cands.length; i++) {
    const rect = cands[i];
    onProgress(0.55 + (i / cands.length) * 0.4, `正在检查第 ${i + 1} / ${cands.length} 个候选区域`);
    let bmp;
    try {
      bmp = await cropBitmap(img, rect);
    } catch { continue; }

    let out;
    try {
      out = lm.detect(bmp);
    } catch {
      bmp.close?.();
      continue;
    }
    bmp.close?.();

    const lms = out.faceLandmarks || [];
    for (let k = 0; k < lms.length; k++) {
      const pts = lms[k];
      // 换算回归一化图像坐标
      const mapped = pts.map((p) => ({
        x: rect.x + p.x * rect.w,
        y: rect.y + p.y * rect.h,
        z: p.z || 0,
      }));
      // 去重：与已收集的人脸中心距离过近则跳过
      const cx = avg(mapped.map((p) => p.x));
      const cy = avg(mapped.slice(0, 468).map((p) => p.y));
      const dup = seen.some((s) => Math.hypot(s.cx - cx, s.cy - cy) < Math.min(rect.w, rect.h) * 0.18);
      if (dup) continue;
      seen.push({ cx, cy });

      let conf = 0.6;
      const sc = out.faceBlendshapes?.[k] ? 0.7 : 0.6;
      conf = sc;
      faces.push({
        landmarks: mapped,
        confidence: conf,
        cropRect: rect,
        mode: 'precise',
        area: faceArea(mapped),
        center: { x: cx, y: cy },
      });
    }
    // 一档命中且只有一张脸，就没必要继续试其它档（省时间）
    if (faces.length === 1) break;
  }

  onProgress(0.98, '检测完成');
  faces.sort((a, b) => b.area - a.area);
  return { faces, tried: cands.length };
}

function avg(a) { return a.reduce((s, v) => s + v, 0) / (a.length || 1); }

function faceArea(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < 468; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.max(1, (maxX - minX) * (maxY - minY));
}

export function faceBBox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < 468; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
