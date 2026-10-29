/* ============================================================
   mesh.js — M5 网格生成 + 权重烘焙
   依据：技术方案 §2.2（规则网格 + fine 矩形 + 透明格剔除）、
        §3.2 M5（权重烘焙一次、运行期只乘加）、§6.1 网格规模
   ============================================================ */

const sstep = (a, b, x) => {
  if (a === b) return x < a ? 0 : 1;
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

const gauss = (x, y, e) => {
  const dx = (x - e.cx) / e.rx;
  const dy = (y - e.cy) / e.ry;
  const d = dx * dx + dy * dy;
  return d >= 6.25 ? 0 : Math.exp(-1.6 * d);
};

/**
 * P0-3（v3）—— 上下分带，取代「把整只眼等比压扁」。
 *
 * 真实闭眼 = 上睑皮肤向下覆盖眼球。眼球本身不会被压扁，只是被盖住。
 * 上一版把整个眼裂带等比压向睑线，等于把眼裂纹理纵向压 8 倍：
 * 高频内容被折叠成规则竖条、并摊成一块平坦色块 —— 复测看到的「平涂圆片」。
 *
 * 本版把眼区分成两个带，各自只做一种运动：
 *   ① 睑裂带（|dy| ≤ AP）— 向睑线收拢，收成一条细线（闭眼后的睫毛线）。
 *   ② 上带（睑裂以上）— **整体向下平移**，不缩放，纹理不被撕裂；
 *      平移量在睑裂上缘与 ① 完全相等，因此两带在睑线处严格缝合、无跳变。
 *      平移量沿垂直方向平滑衰减到 0（跨度 LID_SLIDE_SPAN），
 *      衰减跨度必须足够长，否则上带被压成一团平面（历史「平涂圆片」）。
 *   ③ 下带（睑裂以下）— 静止。睑裂下缘在闭眼时本就落在睑线上，位移为零。
 */
const AP = 1 / 1.35;          // 睑裂半高 = 0.7407 ry（rig.js: eye.ry = 1.35 × 睑裂半高）
const AP_EDGE = 0.86;         // 睑裂带权重在 0.86AP~1.0AP 之间平滑到 0
const LID_SLIDE_SPAN = 0.95;  // 上带平移衰减跨度：必须在眉毛之前归零（brow 距 eye 约 1.0ry）
const EYE_H_OUT = 1.06;       // 水平方向：眼宽 1.0 附近衰减到 0
const EYE_H_FADE = 0.62;      // 水平羽化起点：0.62 → 1.06 平滑过渡，避免眼角垂直硬边

/** ① 睑裂带权重（1 = 完全收拢到睑线） */
function eyeWeight(x, y, e) {
  const dx = (x - e.cx) / e.rx;
  const dy = (y - e.cy) / e.ry;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (adx >= EYE_H_OUT || ady >= AP) return 0;
  const wx = 1 - sstep(EYE_H_FADE, EYE_H_OUT, adx);
  const wy = ady <= AP_EDGE ? 1 : 1 - sstep(AP_EDGE, AP, ady);
  return wx * wy;
}

/** ② 上带平移权重（1 = 满额下移，0 = 不动） */
function lidSlideWeight(x, y, e) {
  const dx = (x - e.cx) / e.rx;
  const dy = (y - e.cy) / e.ry;
  const adx = Math.abs(dx);
  if (adx >= EYE_H_OUT) return 0;
  const wxl = 1 - sstep(EYE_H_FADE, EYE_H_OUT + 0.10, adx);
  const up = -dy - AP;           // 0 在睑裂上缘，向上递增
  if (up <= 0 || up >= LID_SLIDE_SPAN) return 0;
  return wxl * (1 - sstep(0, LID_SLIDE_SPAN, up));
}

/** 从 ImageBitmap 取降采样的 alpha 掩码，用于剔除全透明格 */
function alphaMask(bitmap, maxSide = 360) {
  const s = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(2, Math.round(bitmap.width * s));
  const h = Math.max(2, Math.round(bitmap.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, w, h);
  let data;
  try { data = g.getImageData(0, 0, w, h).data; } catch { return null; }
  return { w, h, data };
}

/** 一维坐标线：baseCell 步进，fine 区间内改 fineCell */
function axisLines(len, fineStart, fineEnd, baseCell, fineCell, eyeBands) {
  const out = [];
  const push = (v, step) => { for (let x = v; x < len; x += step) out.push(x); };
  // 逐段推进：眼带用超细步长，fine 区用 fineCell，其余用 baseCell
  let cursor = 0;
  const bands = (eyeBands || []).slice().sort((a, b) => a[0] - b[0]);
  const segs = [];
  for (const b of bands) {
    if (b[1] > cursor && b[0] < len) segs.push([Math.max(cursor, b[0]), Math.min(len, b[1]), b[2]]);
    cursor = Math.max(cursor, b[1]);
  }
  // 逐像素级推进：从 0 开始，按当前所在区间选步长
  let v = 0;
  let guard = 0;
  while (v < len && guard++ < 20000) {
    let step = baseCell;
    if (v >= fineStart && v < fineEnd) step = fineCell;
    for (const sgm of segs) if (v >= sgm[0] && v < sgm[1]) step = Math.min(step, sgm[2]);
    const nx2 = v + step;
    out.push(v);
    // 跨区边界：把边界点补上，避免步长跨越区间导致漏点
    if (nx2 > fineStart && v < fineStart) out.push(fineStart);
    for (const sgm of segs) {
      if (v < sgm[0] && nx2 > sgm[0]) out.push(sgm[0]);
      if (v < sgm[1] && nx2 > sgm[1]) out.push(sgm[1]);
    }
    if (nx2 > fineEnd && v < fineEnd) out.push(fineEnd);
    v = nx2;
  }
  out.push(len);
  return [...new Set(out.map((x) => Math.round(x)))].sort((a, b) => a - b);
}

/**
 * 构建单层网格。
 * @returns {{rest:Float32Array, uv:Float32Array, pos:Float32Array, tris:Uint32Array,
 *            n:number, stats:object, bake:object}}
 */
export function buildMesh(img, rig, opts = {}) {
  const W = img.width, H = img.height;
  const budget = opts.vertexBudget || 32000; // 性能上限
  let baseCell = rig.mesh.baseCell;
  let fineCell = rig.mesh.fineCell;
  const fine = rig.mesh.fine;

  let ex, ey, verts;
  // 逐级放大格子直到顶点数落到预算内（F-10 的「降网格密度优先保流畅」）
  // 眼带：闭眼时睑裂带会被纵向压到 ~1/8，7px 的网格在那里只剩不到 1px，
  // 必然混叠成竖条纹 / 平块。给眼带单独 2.2px 的网格，让压缩后的纹理有顶点承载。
  const mkBand = (e) => {
    const padX = 1.14, padT = 1.02, padB = 1.02;
    return [[e.cx - e.rx * padX, e.cx + e.rx * padX, 2.2],
            [e.cy - e.ry * padT, e.cy + e.ry * padB, 2.2]];
  };
  let eyeBandsX = [], eyeBandsY = [];
  for (const e of [rig.face.eyeA, rig.face.eyeB]) {
    eyeBandsX.push([e.cx - e.rx * 1.14, e.cx + e.rx * 1.14, 2.2]);
    eyeBandsY.push([e.cy - e.ry * 1.02, e.cy + e.ry * 1.02, 2.2]);
  }

  for (let i = 0; i < 8; i++) {
    ex = axisLines(W, Math.max(0, fine.x), Math.min(W, fine.x + fine.w), baseCell, fineCell, eyeBandsX);
    ey = axisLines(H, Math.max(0, fine.y), Math.min(H, fine.y + fine.h), baseCell, fineCell, eyeBandsY);
    verts = ex.length * ey.length;
    if (verts <= budget) break;
    baseCell = Math.ceil(baseCell * 1.18);
    fineCell = Math.ceil(fineCell * 1.18);
  }

  const nx = ex.length, ny = ey.length;
  const n = nx * ny;

  const mask = alphaMask(img.bitmap);
  const alphaAt = (x, y) => {
    if (!mask) return 255;
    const mx = Math.min(mask.w - 1, Math.max(0, Math.round((x / W) * (mask.w - 1))));
    const my = Math.min(mask.h - 1, Math.max(0, Math.round((y / H) * (mask.h - 1))));
    return mask.data[(my * mask.w + mx) * 4 + 3];
  };

  // 保留判定：格内 3×3 采样点里只要有一个 alpha > 2 就保留
  // （保守判定，避免把发丝这类细结构整格丢掉；真正的轮廓由片元 alpha 决定）
  const keepCell = new Uint8Array((nx - 1) * (ny - 1));
  const fr = [0.18, 0.5, 0.82];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      let keep = 0;
      for (let a = 0; a < 3 && !keep; a++) {
        for (let b = 0; b < 3 && !keep; b++) {
          const sx = ex[i] + (ex[i + 1] - ex[i]) * fr[a];
          const sy = ey[j] + (ey[j + 1] - ey[j]) * fr[b];
          if (alphaAt(sx, sy) > 2) keep = 1;
        }
      }
      keepCell[j * (nx - 1) + i] = keep;
    }
  }

  // 顶点索引表
  const idx = new Int32Array(n).fill(-1);
  let m = 0;
  const restArr = [];
  const uvArr = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = j * nx + i;
      let used = false;
      if (i < nx - 1 && j < ny - 1 && keepCell[j * (nx - 1) + i]) used = true;
      if (!used && i > 0 && j > 0 && keepCell[(j - 1) * (nx - 1) + (i - 1)]) used = true;
      if (!used && i > 0 && j < ny - 1 && keepCell[j * (nx - 1) + (i - 1)]) used = true;
      if (!used && i < nx - 1 && j > 0 && keepCell[(j - 1) * (nx - 1) + i]) used = true;
      if (!used) continue;
      idx[v] = m++;
      restArr.push(ex[i], ey[j]);
      uvArr.push(ex[i] / W, ey[j] / H);
    }
  }

  const rest = new Float32Array(restArr);
  const uv = new Float32Array(uvArr);
  const pos = new Float32Array(rest);

  // 三角形
  const triArr = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (!keepCell[j * (nx - 1) + i]) continue;
      const a = idx[j * nx + i];
      const b = idx[j * nx + i + 1];
      const c = idx[(j + 1) * nx + i];
      const d = idx[(j + 1) * nx + i + 1];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      triArr.push(a, b, c, b, d, c);
    }
  }
  const tris = new Uint32Array(triArr);

  // ── 权重烘焙（只在 rest 空间算一次；运行期不做 exp）──
  const head = rig.head;
  const body = rig.body;
  const face = rig.face;

  const kHead = new Float32Array(m);
  const kTurn = new Float32Array(m);
  const kRoll = new Float32Array(m);
  const kBodyRoll = new Float32Array(m);
  const kBreath = new Float32Array(m);
  const kChest = new Float32Array(m);
  const kShoulder = new Float32Array(m);
  const kBrow = new Float32Array(m);
  const kNose = new Float32Array(m);
  const kMouth = new Float32Array(m);
  const kJaw = new Float32Array(m);
  const kEyeA = new Float32Array(m);
  const kLidA = new Float32Array(m);
  const kEyeB = new Float32Array(m);
  const kLidB = new Float32Array(m);
  const eyeNyA = new Float32Array(m);
  const eyeNyB = new Float32Array(m);
  const kStrand = new Float32Array(m);
  const strandT = new Float32Array(m);

  const wb = head.weightBand;
  const rb = body.rollBand;
  const bb = body.breathBand;

  for (let k = 0; k < m; k++) {
    const x = rest[k * 2];
    const y = rest[k * 2 + 1];

    kHead[k] = gauss(x, y, head);
    // 头部影响带：下巴以下迅速衰减（避免脖子被剪切）
    const hBand = 1 - sstep(wb[0], wb[1], y);
    kHead[k] *= hBand;
    kRoll[k] = kHead[k];

    // 转头：t = 1 - nx² - ny²；dd = sstep(0, 0.84, t)
    const nxh = (x - head.cx) / head.rx;
    const nyh = (y - head.cy) / head.ry;
    const t = 1 - nxh * nxh - nyh * nyh;
    kTurn[k] = t <= 0 ? 0 : sstep(0, 0.84, t) * hBand;

    kBodyRoll[k] = gauss(x, y, body.chest) * (1 - sstep(rb[0], rb[1], y));
    // 呼吸：胸以上权重 1，向下衰减到 0（底边不动）
    kBreath[k] = 1 - sstep(bb[0], bb[1], y);
    kChest[k] = gauss(x, y, body.chest);
    let sh = 0;
    for (const s of body.shoulders) sh = Math.max(sh, gauss(x, y, s));
    kShoulder[k] = sh;

    kBrow[k] = gauss(x, y, face.brow) * (1 - sstep(face.brow.band[0], face.brow.band[1], y) * 0.0);
    kNose[k] = gauss(x, y, face.nose) * 0.5;
    kMouth[k] = gauss(x, y, face.mouth);
    kJaw[k] = gauss(x, y, face.jaw) * sstep(face.jaw.band[0], face.jaw.band[1], y);

    // 眼区：平滑权重（不再是 0/1 二值）
    // 二值权重会让位移场在椭圆边界上从「满额压缩」一步跳到「完全不压缩」，
    // 渲染出来就是一条硬币边缘似的硬边 —— 上一轮质检判定的「边界锋利的肤色圆顶」。
    kEyeA[k] = eyeWeight(x, y, face.eyeA);
    kLidA[k] = lidSlideWeight(x, y, face.eyeA);
    eyeNyA[k] = (y - face.eyeA.cy) / face.eyeA.ry;
    kEyeB[k] = eyeWeight(x, y, face.eyeB);
    kLidB[k] = lidSlideWeight(x, y, face.eyeB);
    eyeNyB[k] = (y - face.eyeB.cy) / face.eyeB.ry;
  }

  const stats = {
    vertices: m,
    triangles: tris.length / 3,
    gridW: nx,
    gridH: ny,
    baseCell,
    fineCell,
    flopsPerFrame: m * 40,
  };

  return {
    rest, uv, pos, tris, n: m,
    bake: {
      kHead, kTurn, kRoll, kBodyRoll, kBreath, kChest, kShoulder,
      kBrow, kNose, kMouth, kJaw, kEyeA, kEyeB, kLidA, kLidB, eyeNyA, eyeNyB,
      kStrand, strandT,
    },
    stats,
  };
}
