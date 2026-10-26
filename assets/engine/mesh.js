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
function axisLines(len, fineStart, fineEnd, baseCell, fineCell) {
  const out = [];
  for (let v = 0; v < fineStart; v += baseCell) out.push(v);
  if (fineStart > 0 && out[out.length - 1] !== fineStart) out.push(fineStart);
  for (let v = fineStart; v < fineEnd; v += fineCell) out.push(v);
  if (out[out.length - 1] !== fineEnd) out.push(fineEnd);
  for (let v = fineEnd + baseCell; v < len; v += baseCell) out.push(v);
  if (out[out.length - 1] < len) out.push(len);
  // 去重 + 升序
  return [...new Set(out.map((v) => Math.round(v)))].sort((a, b) => a - b);
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
  for (let i = 0; i < 8; i++) {
    ex = axisLines(W, Math.max(0, fine.x), Math.min(W, fine.x + fine.w), baseCell, fineCell);
    ey = axisLines(H, Math.max(0, fine.y), Math.min(H, fine.y + fine.h), baseCell, fineCell);
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
  const kEyeB = new Float32Array(m);
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

    // 眼区：仅椭圆内参与纵向压缩
    const ax = (x - face.eyeA.cx) / face.eyeA.rx;
    const ay = (y - face.eyeA.cy) / face.eyeA.ry;
    const inA = ax * ax + ay * ay <= 1;
    kEyeA[k] = inA ? 1 : 0;
    eyeNyA[k] = ay;
    const bx = (x - face.eyeB.cx) / face.eyeB.rx;
    const by = (y - face.eyeB.cy) / face.eyeB.ry;
    const inB = bx * bx + by * by <= 1;
    kEyeB[k] = inB ? 1 : 0;
    eyeNyB[k] = by;
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
      kBrow, kNose, kMouth, kJaw, kEyeA, kEyeB, eyeNyA, eyeNyB,
      kStrand, strandT,
    },
    stats,
  };
}
