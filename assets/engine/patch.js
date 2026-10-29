/* ============================================================
   patch.js — P0-3 闭眼贴片（预生成，浏览器内，纯本地）

   原理：不再压扁眼裂纹理，而是预先生成一片「闭眼后的眼区」，
   运行时按闭度交叉淡化过去。

   贴片内容全部来自原图自身的真实皮肤像素：
     ① 取材：在该眼周围搜索一块与睑裂同尺寸的干净皮肤（1:1 直接映射，不缩放、
        不周期镜像 → 无重复接缝），候选按「暗部占比 / 纹理强度 / 越界」打分
     ② 逐行把取材像素的整体亮度/色度对齐到**同一行紧邻眼外的真实肤色**
     ③ 掩码是**睑裂杏仁形**（2rx × 2·0.7407ry，两端收尖），不是整颗眼椭圆；
        羽化 2~3px，因此边界处贴片 alpha 已归零，不会出现硬边圆片
     ④ 沿闭眼位置压一条 ≤2px 的深色睑缘线，与 shader 里随 eyeOpen 下移的
        动态睑线在 eyeOpen=0 处重合（不出现两条线）

   约束：全程 canvas 2D + ImageData，不发任何网络请求（PRD F-13 诚信声明）。
   ============================================================ */

const AP = 1 / 1.35;          // 睑裂半高（ry 倍数）= 0.7407
const FEATHER = 8.0;          // 边界羽化（图像像素；1200px 宽图约合 464px 画布上 2~3px 视觉羽化）          // 贴片边界羽化（图像像素）
const LENS_W = 1.04;          // 睑裂半宽（rx 倍数）
const LENS_H = 1.06;          // 睑裂半高额外余量（× AP·ry）

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/** 单眼睑裂杏仁形的半高（随横坐标收尖）。t ∈ [-1,1] */
function lensHalfH(t, ryF) {
  const a = Math.abs(t);
  if (a >= 1) return 0;
  // 0.62 次幂让两端比椭圆更快收到 0 → 眼角是尖的，不是圆弧
  return ryF * Math.pow(1 - a * a, 0.62);
}

/** 贴片矩形：两眼的睑裂杏仁形并集（图像像素） */
export function patchRect(rig, W, H) {
  const eyes = [rig.face.eyeA, rig.face.eyeB];
  const rxW = (e) => e.rx * LENS_W;
  const ryH = (e) => e.ry * AP * LENS_H;
  const x0 = Math.max(0, Math.floor(Math.min(...eyes.map((e) => e.cx - rxW(e)))));
  const x1 = Math.min(W, Math.ceil(Math.max(...eyes.map((e) => e.cx + rxW(e)))));
  const y0 = Math.max(0, Math.floor(Math.min(...eyes.map((e) => e.cy - ryH(e)))));
  const y1 = Math.min(H, Math.ceil(Math.max(...eyes.map((e) => e.cy + ryH(e)))));
  return [x0, y0, Math.max(4, x1 - x0), Math.max(4, y1 - y0)];
}

/**
 * 为单眼选「干净皮肤带」（优先上睑）。
 * 做法：在睑裂上/下各 90px 窗口内逐行判定 clean（无眉毛毛发、无高光、亮度在皮肤区间），
 * 找出**最长的连续 clean 行段**，并要求它离睑裂尽可能近。
 * 眉毛（L<46 占比 >2%）与头发同属 clean 判定中的排除项，因此眉毛永远不会进贴片。
 */
function pickDonor(sd, W, H, eye, bwFull, faceMidX, mirrorGeo) {
  const browLum = 46;
  // ── 取材降级链（组长处方 A+B）────────────────────────────
  // ① 本眼睑裂上方 90px 干净上睑皮肤（条件**不放宽**）
  // ② 本眼下方皮肤带（连续、无眉毛污染）
  // ③ 本眼同侧颊部皮肤带（本眼 cx 与面部中线之间，避开另一只眼横向区间）
  // ④ 横向扩展到脸颊中央，保证供体窗 ≥ 90×90（必要时从对侧对称位置镜像）
  // 每一级命中即停，并把 level + 窗口坐标一起返回 —— 不许悄悄降级。
  const DX = [0, -0.35, 0.35, -0.7, 0.7];
  const MIN_W = Math.max(bwFull, 20);

  // ① 上睑 + ② 下睑：先在本眼正上下取，再在本眼同侧有限偏移内取
  let bestUp = null, bestDown = null;
  for (const dx of DX) {
    for (const frac of [1, 0.8, 0.62, 0.48]) {
      const bw = Math.max(10, Math.round(bwFull * frac));
      const r = pickDonorAt(sd, W, H, eye, bw, browLum, eye.lensW * dx);
      if (!r) continue;
      if (r.dir === 'up' && (!bestUp || r.h * r.w > bestUp.h * bestUp.w)) bestUp = r;
      if (r.dir === 'down' && (!bestDown || r.h * r.w > bestDown.h * bestDown.w)) bestDown = r;
    }
    if (bestUp && bestUp.h >= 14 && bestUp.w >= MIN_W * 0.9) break;
  }
  // 质量门槛：供体窗**必须够铺满睑裂带**。
  // 宽度 >= 睑裂宽的 0.85；高度 >= 睑裂带高度（2*lensH）的 0.9。
  // v5 修：旧闸门只要求 h>=12，而填充循环需要 2*lensH 的纵向过渡
  // （face_a 需 63.6~67.8px），供体仅 48px 时会被迫折行 ——
  // 实测在 face_a 眼B 下缘造成 4 个接缝超差点（角度 59°~62°）。
  // 面积不足必须继续降级，不许将就；降级到兜底时如实写「兜底(面积不足)」。
  const wideFriend = Math.max(bwFull * 0.9, 20);
  const needH = Math.max(12, (eye.lensH || 0) * 2 * 0.9);
  const adequate = (d) => d && d.w >= wideFriend * 0.85 && d.h >= needH;

  if (adequate(bestUp)) return { ...bestUp, level: 1, levelName: '上睑' };
  if (adequate(bestDown)) return { ...bestDown, level: 2, levelName: '下睑' };

  // ③ 同侧颊部：在眼心下方、朝面部中线一侧寻找连续皮肤带
  const cheek = pickCheekDonor(sd, W, H, eye, bwFull, faceMidX);
  if (adequate(cheek)) return { ...cheek, level: 3, levelName: '同侧颊部' };

  // ④ 脸颊中央扩展：保证供体窗至少 90×90，仍取不到则从对侧镜像位置取
  const BIGW = Math.max(90, Math.round(bwFull));
  const big = pickDonorAt(sd, W, H, eye, BIGW, browLum, 0, BIGW * 4, 60);
  if (big && big.h >= 60) return { ...big, level: 4, levelName: '脸颊中央扩展' };

  if (mirrorGeo) {
    const mEye = { cx: 2 * faceMidX - eye.cx, cy: eye.cy, rx: eye.rx, ry: eye.ry,
                   lensW: eye.lensW, lensH: eye.lensH };
    const m = pickDonorAt(sd, W, H, mEye, BIGW, browLum, 0, BIGW * 4, 60);
    if (m && m.h >= 60) return { ...m, level: 4, levelName: '对侧镜像', mirrored: true, mirrorCx: mEye.cx };
  }
  // 全部不合格时兜底：取面积最大者，并如实标记为降级
  const fallback = [bestUp, bestDown, cheek, big].filter(Boolean)
    .sort((a, b) => b.w * b.h - a.w * a.h)[0];
  if (fallback) return { ...fallback, level: 4, levelName: '兜底(面积不足)' };
  return null;
}

/**
 * 在单眼睑裂上/下方搜索连续干净皮肤带。
 * @param {Uint8ClampedArray} sd 原图 RGBA
 * @param {number} winPx 上下扫描窗（默认 90）
 * @param {number} minHPx 合格带的最小高度（默认 8）
 */
function pickDonorAt(sd, W, H, eye, bw, browLum, dx, winPx, minHPx) {
  // dx：相对眼心的横向偏移（同侧搜索用，避免两只眼共用同一个横向窗口）
  const bx0 = Math.max(1, Math.min(W - bw - 2, Math.round(eye.cx + dx - bw / 2)));
  const rowClean = (gy) => {
    let dark = 0, bright = 0, n = 0, sum = 0;
    for (let x = bx0; x < bx0 + bw; x++) {
      const i = (gy * W + x) * 4;
      const L = lum(sd[i], sd[i + 1], sd[i + 2]);
      sum += L; n++;
      if (L < browLum) dark++;
      if (L > 240) bright++;
    }
    return { ok: dark / n <= 0.02 && bright / n <= 0.05 && sum / n >= 72, mean: sum / n };
  };

  const WIN = winPx || 90;
  const MINH = minHPx || 8;
  const top = eye.cy - eye.lensH;
  const bot = eye.cy + eye.lensH;
  const runs = [];       // {y0, h, gap, dir}
  let cur = null;
  // 向上扫描
  for (let gy = Math.floor(top) - 1; gy >= Math.max(2, Math.floor(top) - WIN); gy--) {
    const r = rowClean(gy);
    if (r.ok) { if (!cur) cur = { y0: gy, h: 0, dir: 'up' }; cur.h++; cur.y0 = gy; }
    else { if (cur) { runs.push({ ...cur, gap: Math.floor(top) - 1 - (cur.y0 + cur.h - 1) }); cur = null; } }
  }
  if (cur) runs.push({ ...cur, gap: Math.floor(top) - 1 - (cur.y0 + cur.h - 1) });
  // 向下扫描
  cur = null;
  for (let gy = Math.ceil(bot) + 1; gy <= Math.min(H - 3, Math.ceil(bot) + WIN); gy++) {
    const r = rowClean(gy);
    if (r.ok) { if (!cur) cur = { y0: gy, h: 0, dir: 'down' }; cur.h++; }
    else { if (cur) { runs.push({ ...cur, gap: cur.y0 - Math.ceil(bot) - 1 }); cur = null; } }
  }
  if (cur) runs.push({ ...cur, gap: cur.y0 - Math.ceil(bot) - 1 });

  // 上睑优先：同长度下 dir='up' 更贴近任务要求（上睑皮肤）
  const good = runs.filter((r) => r.h >= MINH && r.gap <= 26);
  if (!good.length) return null;
  good.sort((a, b) => (b.h - a.h) || (b.h + (b.dir === 'up' ? 6 : 0)) - (a.h + (a.dir === 'up' ? 6 : 0)));
  const best = good[0];
  return { x: bx0, y: best.y0, w: bw, h: Math.min(best.h, 120), dir: best.dir, gap: best.gap };
}

/** ③ 同侧颊部皮肤带：眼心下方、朝面部中线方向的连续干净带 */
function pickCheekDonor(sd, W, H, eye, bwFull, faceMidX) {
  const bw = Math.max(20, Math.round(Math.min(bwFull, Math.abs(faceMidX - eye.cx) * 2)));
  const dirToMid = Math.sign(faceMidX - eye.cx) || 1;
  // 窗口贴着本眼朝中线一侧，横向不越过面部中线
  let x0;
  if (dirToMid > 0) x0 = Math.max(2, Math.round(eye.cx + eye.lensW * 0.2));
  else x0 = Math.min(W - bw - 2, Math.round(eye.cx - eye.lensW * 0.2 - bw));
  x0 = Math.max(2, Math.min(W - bw - 2, x0));

  const WY0 = Math.round(eye.cy + eye.lensH * 1.2);
  const WY1 = Math.min(H - 3, WY0 + 140);
  const clean = [];
  for (let gy = WY0; gy <= WY1; gy++) {
    let dark = 0, bright = 0, n = 0;
    for (let x = x0; x < x0 + bw; x++) {
      const i = (gy * W + x) * 4;
      const L = lum(sd[i], sd[i + 1], sd[i + 2]);
      n++;
      if (L < 46) dark++;
      if (L > 242) bright++;
    }
    if (dark / n <= 0.03 && bright / n <= 0.05) clean.push(gy);
  }
  if (clean.length < 8) return null;
  // 取最长连续段
  let best = null, cur = null;
  for (let i = 0; i < clean.length; i++) {
    if (!cur || clean[i] !== clean[i - 1] + 1) { cur = { y0: clean[i], h: 1 }; }
    else cur.h++;
    if (!best || cur.h > best.h) best = { y0: cur.y0, h: cur.h };
  }
  if (!best || best.h < 8) return null;
  return { x: x0, y: best.y0, w: bw, h: Math.min(best.h, 120), dir: 'down' };
}

/* ============================================================
   眼周可行性闸门（v5 收口：眼周被遮挡的图自动不启用眨眼）

   背景：用户 2026-10-29 拍板 —— 与其闭眼时露出一块瑕疵椭圆，不如识别出
   「这张图的眼周不适合做贴片」然后干脆不启用眨眼。判定发生在**贴片构建阶段**，
   每只眼独立评估，任一眼不可用就整图禁用眨眼（双眼同步，不出现 wink）。

   五条判据全部来自原图像素，逐条可复现、可解释，宁可错杀：
     S1 供体面积不足：w < 0.85×2·lensW 或 h < 0.9×2·lensH，或已降级到兜底
     S2 环带合格点过少：睑裂左右 1.02~1.45·lensW 的窄环里「像皮肤」(中位 L≥60)
        的行占比 < 0.80 —— 深色眼影/锅底阴影(L≈30~50)那类
     S3 上缘外侧深色带状结构横贯：睑裂上缘上方 3~26px 带内，存在连续暗段
        ≥1.6·lensW 的行占 > 8% —— 刘海/头发压在眼上
     S4 眼区行内深色带横穿：眼心 ±1.2·lensH 的行里，最长连续暗段 ≥1.9·lensW
        —— 头发/浓眼线横过整只眼
     S5 贴片边界连成的**可见弧长**：把闭眼帧按 shader 公式合成后，沿睑裂边界
        取 360 点，跨过羽化带量 ΔL；凡「原图本来没有、贴片才带来」的台阶记为接缝。
        散点噪声不算，连续 ≥ N° 才构成能被看成椭圆的轮廓。
    ============================================================ */
export const EYE_GATE = {
  donorW: 0.85,      // ×2·lensW
  donorH: 0.90,      // ×2·lensH（且不低于 12px）
  ringMedL: 60,      // 「像皮肤」的亮度下限
  ringGoodFrac: 0.80,
  crossRun: 1.6,     // ×lensW
  crossRowFrac: 0.08,
  eyeRun: 1.9,       // ×lensW
  eyeCrossFrac: 0.06,
  seamArcDeg: 24,    // 实测：干净脸 1°/7°，face_a 18°/39°，pair2 27°/47°
};

const medianArr = (a) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
};

/** S2：环带「像皮肤」行占比 */
function ringGoodFrac(sd, W, H, e) {
  let good = 0, total = 0;
  const y0 = Math.max(1, Math.floor(e.cy - e.lensH) - 1);
  const y1 = Math.min(H - 2, Math.ceil(e.cy + e.lensH) + 1);
  for (let gy = y0; gy <= y1; gy++) {
    const pts = [];
    for (const side of [-1, 1]) {
      const xs = e.cx + side * e.lensW * 1.02;
      const xe = e.cx + side * e.lensW * 1.45;
      const lo = Math.max(1, Math.floor(Math.min(xs, xe)));
      const hi = Math.min(W - 2, Math.ceil(Math.max(xs, xe)));
      for (let gx = lo; gx <= hi; gx++) {
        const i = (gy * W + gx) * 4;
        pts.push(lum(sd[i], sd[i + 1], sd[i + 2]));
      }
    }
    if (pts.length >= 2) { total++; if (medianArr(pts) >= EYE_GATE.ringMedL) good++; }
  }
  return total ? good / total : 0;
}

/** S3：睑裂上缘上方带内，连续暗段 ≥1.6·lensW 的行占比 */
function crossRowFrac(sd, W, H, e) {
  const xs0 = Math.round(e.cx - e.lensW * 0.95);
  const xs1 = Math.round(e.cx + e.lensW * 0.95);
  const ys0 = Math.round(e.cy - e.lensH - 26);
  const ys1 = Math.round(e.cy - e.lensH - 3);
  let rows = 0, hit = 0;
  for (let gy = Math.max(1, ys0); gy <= Math.min(H - 2, ys1); gy++) {
    rows++;
    let run = 0, longest = 0;
    for (let gx = Math.max(1, xs0); gx <= Math.min(W - 2, xs1); gx++) {
      const i = (gy * W + gx) * 4;
      if (lum(sd[i], sd[i + 1], sd[i + 2]) < EYE_GATE.ringMedL) { run++; if (run > longest) longest = run; }
      else run = 0;
    }
    if (longest >= EYE_GATE.crossRun * e.lensW) hit++;
  }
  return rows ? hit / rows : 0;
}

/** S4：眼心行内最长暗段（以 lensW 归一），返回「横贯行占比」 */
function eyeCrossFrac(sd, W, H, e) {
  const ya = Math.round(e.cy - e.lensH * 1.2);
  const yb = Math.round(e.cy + e.lensH * 1.2);
  const xa = Math.round(e.cx - e.lensW * 2.2);
  const xb = Math.round(e.cx + e.lensW * 2.2);
  let rows = 0, hit = 0, worst = 0;
  for (let gy = Math.max(1, ya); gy <= Math.min(H - 2, yb); gy++) {
    rows++;
    let run = 0, longest = 0;
    for (let gx = Math.max(1, xa); gx <= Math.min(W - 2, xb); gx++) {
      const i = (gy * W + gx) * 4;
      if (lum(sd[i], sd[i + 1], sd[i + 2]) < EYE_GATE.ringMedL) { run++; if (run > longest) longest = run; }
      else run = 0;
    }
    const r = longest / e.lensW;
    if (r > worst) worst = r;
    if (r >= EYE_GATE.eyeRun) hit++;
  }
  return { frac: rows ? hit / rows : 0, worst };
}

/**
 * 逐眼可行性判定。**不确定就判不可用**——宁可少一个动画，不要露瑕疵。
 * @returns {{eyes:Array, feasible:boolean}}
 */
function evaluateEyes(sd, W, H, eyeGeo, donors) {
  const eyes = eyeGeo.map((e, i) => {
    const d = donors[i];
    const reasons = [];
    const needW = EYE_GATE.donorW * 2 * e.lensW;
    const needH = Math.max(12, EYE_GATE.donorH * 2 * e.lensH);

    // S1 供体面积：不够铺满睑裂带 → 拿来凑就会折行/重复纹理
    const donorOk = !!d && d.w >= needW && d.h >= needH;
    if (!donorOk) {
      reasons.push(d
        ? `供体面积不足(${d.w}×${d.h}，需 ≥${Math.round(needW)}×${Math.round(needH)})`
        : '取不到供体窗');
    }
    // S1b 已经降级到兜底 = 四级都没拿到合格皮肤
    if (d && /兜底/.test(d.levelName || '')) reasons.push(`降级到兜底(${d.levelName})`);

    // S2 环带合格点：深色眼影/锅底阴影会让「可供对齐的真实肤色」几乎不存在
    const rg = ringGoodFrac(sd, W, H, e);
    if (rg < EYE_GATE.ringGoodFrac) {
      reasons.push(`环带合格行占比${(rg * 100).toFixed(0)}%${'<'}${(EYE_GATE.ringGoodFrac * 100).toFixed(0)}%`);
    }
    // S3 上缘外侧深色带状结构横贯（刘海/头发压在眼上）
    const cr = crossRowFrac(sd, W, H, e);
    if (cr > EYE_GATE.crossRowFrac) {
      reasons.push(`上缘外侧深色横贯${(cr * 100).toFixed(0)}%>${(EYE_GATE.crossRowFrac * 100).toFixed(0)}%`);
    }
    // S4 眼区内深色带横穿（头发/浓眼线整只眼横过）
    const ec = eyeCrossFrac(sd, W, H, e);
    if (ec.frac > EYE_GATE.eyeCrossFrac) {
      reasons.push(`眼区深色横贯${(ec.frac * 100).toFixed(0)}%>${(EYE_GATE.eyeCrossFrac * 100).toFixed(0)}%`);
    }

    return {
      eye: i === 0 ? 'A' : 'B',
      feasible: reasons.length === 0,
      reasons,
      metrics: {
        lensW: +e.lensW.toFixed(1), lensH: +e.lensH.toFixed(1),
        donor: d ? { w: d.w, h: d.h, level: d.level, levelName: d.levelName } : null,
        needW: +needW.toFixed(1), needH: +needH.toFixed(1),
        ringGoodFrac: +rg.toFixed(3),
        crossRowFrac: +cr.toFixed(3),
        eyeCrossFrac: +ec.frac.toFixed(3),
        eyeCrossWorst: +ec.worst.toFixed(2),
      },
    };
  });
  return { eyes, feasible: eyes.every((e) => e.feasible) };
}

/**
 * S5：贴片已合成后**自检边界台阶**。
 * 沿睑裂杏仁形上下缘逐列取样：贴片内侧（alpha≥180）4px 处 vs 原图外侧 4px 处的 |ΔL|，
 * 取中位数。台阶大 = 贴片边界能被看见 = 就是「露椭圆」。
 * 这是**在真实合成结果上**量的，不是估算；实测值见 README 对照表。
 */
function patchBoundaryStep(od, pw, ph, px0, py0, sd, W, H, e) {
  const steps = [];
  for (let iy = 2; iy + 6 < ph; iy++) {
    for (let ix = 0; ix < pw; ix++) {
      const gx = px0 + ix;
      const t = (gx - e.cx) / e.lensW;
      if (Math.abs(t) > 0.92) continue;
      const a = od[(iy * pw + ix) * 4 + 3];
      if (a < 180) continue;
      const a4 = od[((iy + 4) * pw + ix) * 4 + 3];
      if (a4 >= 40) continue;                       // 还没到边界
      const gy = py0 + iy, gy4 = gy + 4;
      if (gy < 1 || gy4 >= H - 1) continue;
      const pin = lum(od[(iy * pw + ix) * 4], od[(iy * pw + ix) * 4 + 1], od[(iy * pw + ix) * 4 + 2]);
      const po = lum(sd[(gy4 * W + gx) * 4], sd[(gy4 * W + gx) * 4 + 1], sd[(gy4 * W + gx) * 4 + 2]);
      steps.push(Math.abs(pin - po));
    }
  }
  return steps.length >= 20 ? medianArr(steps) : null;
}

/**
 * S5（终审）：**贴片边界可见性** —— 就是「露椭圆」本身。
 *
 * 做法：按 shader 的混合公式在 CPU 端合成「闭眼帧」像素
 *       composite = patch.rgb × a + orig.rgb × (1 − a)
 * （renderer 用 premultipliedAlpha、blend ONE/ONE_MINUS_SRC_ALPHA，alpha=1 时 mix 满，
 *  与 eyeOpen=0 的实际效果一致），然后沿睑裂杏仁边界取 360 个采样点，
 * 每点比较「边界内侧」与「边界外侧」的亮度差，并按 attr.py 的归因规则分类：
 *   v1 = 同一位置**原图**内侧 vs 外侧  → 这是原图本来就有的硬边（眉毛/眼线/发丝）
 *   v0 = **闭眼后**内侧 vs 外侧        → 这是用户实际会看到的台阶
 *   原图硬边 : v1 ≥ 60（与贴片无关，不算我们的锅）
 *   贴片接缝 : v1 < 60 且 v0 ≥ 60 —— 这就是能看见的那圈边界
 * 贴片接缝数 > 0 → 该眼不可用（从严，宁可错杀）。
 */
function patchSeamCount(od, pw, ph, px0, py0, sd, W, H, e) {
  const N = 360, TH = 60;
  // 偏移必须按 FEATHER 缩放：贴片的透明度就在这 FEATHER 个像素里从 1 降到 0，
  // 取固定 1.5~3.5px 在 1024px 大图上全落在半透明带里，量到的是「羽化差」不是「台阶」。
  // 内侧取 d = h − (FEATHER+1) 处（alpha 恒为 1，贴片主导）；
  // 外侧取 d = h + (FEATHER+1) 处（alpha 为 0，原图主导）。
  // 两点之间正是用户能看见的那一条过渡带，跨它量 ΔL 才是真正的可见台阶。
  const OFF = FEATHER + 1.0;
  let seams = 0, origEdge = 0, ok = 0;
  const cls = new Array(N).fill(-1);   // -1 跳过 / 0 合格 / 1 原图硬边 / 2 贴片接缝
  const sample = (gx, gy) => {
    if (gx < 1 || gx >= W - 1 || gy < 1 || gy >= H - 1) return null;
    const si = (gy * W + gx) * 4;
    const Lorig = lum(sd[si], sd[si + 1], sd[si + 2]);
    const ix = gx - px0, iy = gy - py0;
    if (ix < 0 || ix >= pw || iy < 0 || iy >= ph) return { Lorig, Lcomp: Lorig };
    const oi = (iy * pw + ix) * 4;
    const a = od[oi + 3] / 255;
    if (a <= 0.004) return { Lorig, Lcomp: Lorig };
    const pr = od[oi] * a + sd[si] * (1 - a);
    const pg = od[oi + 1] * a + sd[si + 1] * (1 - a);
    const pb = od[oi + 2] * a + sd[si + 2] * (1 - a);
    return { Lorig, Lcomp: lum(pr, pg, pb) };
  };
  for (let i = 0; i < N; i++) {
    const th = (2 * Math.PI * i) / N;
    const ct = Math.cos(th), st = Math.sin(th);
    const hh = Math.abs(ct) < 1 ? e.lensH * Math.pow(Math.abs(1 - ct * ct), 0.62) : 0;
    const ex = e.cx + e.lensW * ct, ey = e.cy + hh * st;
    let nx, ny;
    if (Math.abs(st) < 1e-6) { nx = Math.sign(ct) || 1; ny = 0; }
    else { nx = ct / e.lensW; ny = st / Math.max(hh, 1e-6); }
    const nn = Math.hypot(nx, ny) || 1;
    nx /= nn; ny /= nn;
    const sIn = sample(Math.round(ex - nx * OFF), Math.round(ey - ny * OFF));
    const sOut = sample(Math.round(ex + nx * OFF), Math.round(ey + ny * OFF));
    if (!sIn || !sOut) continue;
    const v1 = Math.abs(sIn.Lorig - sOut.Lorig);   // 原图本来就有这个台阶 → 不算我们的锅
    const v0 = Math.abs(sIn.Lcomp - sOut.Lcomp);   // 闭眼后真会看到的台阶
    if (v1 >= TH) { origEdge++; cls[i] = 1; }
    else if (v0 >= TH) { seams++; cls[i] = 2; }
    else { ok++; cls[i] = 0; }
  }
  // 见不见得到「一圈椭圆」，取决的不是散点总数，而是**接缝连成的弧有多长**。
  // 单点/双点散落是纹理噪声；连续 30° 以上才会被看成边界轮廓。
  const maxArc = longestRun(cls);
  return { seams, origEdge, ok, n: seams + origEdge + ok, maxArcDeg: +(maxArc * 360 / N).toFixed(1) };
}

/** 环形数组里值为 2 的最长连续段长度（允许跨 0 索引首尾相接）。 */
function longestRun(cls) {
  const N = cls.length;
  let best = 0, cur = 0;
  for (let k = 0; k < N * 2; k++) {
    if (cls[k % N] === 2) { cur++; if (cur > best) best = Math.min(cur, N); }
    else cur = 0;
  }
  return best;
}

/**
 * 生成闭眼贴片。
 * @returns {{canvas:HTMLCanvasElement|null, rect:number[], donor:object,
 *            guard:{feasible:boolean, eyes:Array}}|null}
 *          canvas === null 表示**眼周不适合做贴片**，调用方必须关闭整图眨眼。
 */
export function buildEyePatch(bitmap, rig, W, H) {
  if (!rig || !rig.face || !rig.face.eyeA) return null;
  const rect = patchRect(rig, W, H);
  const [px0, py0, pw, ph] = rect;

  // 原图整幅读一次（只在每次换图时发生）
  const src = document.createElement('canvas');
  src.width = W; src.height = H;
  const sg = src.getContext('2d', { willReadFrequently: true });
  sg.drawImage(bitmap, 0, 0, W, H);
  let sd;
  try { sd = sg.getImageData(0, 0, W, H).data; } catch { return null; }

  const eyes = [rig.face.eyeA, rig.face.eyeB];
  const eyeGeo = eyes.map((e) => {
    const lensW = e.rx * LENS_W;
    const lensH = e.ry * AP * LENS_H;
    return { cx: e.cx, cy: e.cy, rx: e.rx, ry: e.ry, lensW, lensH };
  });

  // 每眼一条同尺寸取材带（宽度 = 睑裂宽，高度 = 睑裂高 → 1:1 垂直下移即闭眼）
  // 面部中线：两眼眼心的中点（用于 ③ 同侧颊部 与 ④ 对侧镜像取材）
  const faceMidX = (eyeGeo[0].cx + eyeGeo[1].cx) / 2;
  const donors = eyeGeo.map((g, i) => pickDonor(
    sd, W, H, g, Math.max(6, Math.ceil(g.lensW * 2)), faceMidX,
    // 只为**第二只眼**启用对侧镜像回退，避免两只眼都镜像到同一处
    i === 1 ? true : false,
  ));
  const usable = donors.filter((d) => d && d.h >= 8);

  // ── 眼周可行性闸门（收口判据）：先判，再决定要不要合成贴片 ──
  // 放在这里而不是合成之后：判不过就不做贴片，避免任何瑕疵画面上屏。
  const guard = evaluateEyes(sd, W, H, eyeGeo, donors);
  const donorBand = donors.map((d) => (d ? { x: d.x, y: d.y, w: d.w, h: d.h, dir: d.dir, gap: d.gap,
                                              level: d.level, levelName: d.levelName,
                                              mirrored: !!d.mirrored } : null));
  if (!guard.feasible || !usable.length) {
    return { canvas: null, rect, donor: { band: donorBand, primary: null }, guard };
  }

  // 取材带整体均值（加性对齐的基线）
  const dmean = donors.map((d) => {
    if (!d) return [0, 0, 0];
    let s = [0, 0, 0];
    for (let y = d.y; y < d.y + d.h; y++) {
      for (let x = d.x; x < d.x + d.w; x++) {
        const i = (y * W + x) * 4;
        s[0] += sd[i]; s[1] += sd[i + 1]; s[2] += sd[i + 2];
      }
    }
    const n = d.w * d.h;
    return [s[0] / n, s[1] / n, s[2] / n];
  });

  const out = document.createElement('canvas');
  out.width = pw; out.height = ph;
  const og = out.getContext('2d', { willReadFrequently: true });
  const img = og.createImageData(pw, ph);
  const od = img.data;

  // ── ① 每眼每行「紧邻眼圈」目标色 ──
  // 只取该行紧贴睑裂左右两侧 1.02~1.45 lensW 的窄环（同一条水平线上的真实皮肤），
  // 因此与贴片边界上下相邻，颜色天然对齐；不会沾染鼻影、头发、另一只眼。
  // ── 供体↔受体中位亮度比例校正（组长处方 B）──────
  // 供体（脸颊皮肤）与受体（眼周，可能带眼影/阴影）中位亮度差异大时，
  // 若只做逐行加性对齐，深色区会被逐行"提亮到某一行"而出现横向亮带。
  // 这里先算一次全局比例，把整片供体拉到受体量级，再由逐行加性对齐微调。
  const medianOf = (vals) => {
    if (!vals.length) return null;
    const a = vals.slice().sort((x, y) => x - y);
    return a[a.length >> 1];
  };
  const receptorMed = eyeGeo.map((e) => {
    const vals = [];
    for (let gy = Math.floor(e.cy - e.lensH * 1.3); gy <= Math.ceil(e.cy + e.lensH * 1.3); gy++) {
      if (gy < 1 || gy >= H - 1) continue;
      for (const side of [-1, 1]) {
        for (let k = 1.05; k <= 1.55; k += 0.1) {
          const gx = Math.round(e.cx + side * e.lensW * k);
          if (gx < 1 || gx >= W - 1) continue;
          const i = (gy * W + gx) * 4;
          vals.push(lum(sd[i], sd[i + 1], sd[i + 2]));
        }
      }
    }
    return medianOf(vals);
  });
  const donorMed = donors.map((d) => {
    if (!d) return null;
    const vals = [];
    for (let gy = d.y; gy < d.y + d.h; gy++) {
      for (let gx = d.x; gx < d.x + d.w; gx++) {
        const i = (gy * W + gx) * 4;
        vals.push(lum(sd[i], sd[i + 1], sd[i + 2]));
      }
    }
    return medianOf(vals);
  });
  const lumScale = eyeGeo.map((e, i) => {
    const dr = receptorMed[i], dm = donorMed[i];
    if (dr === null || dm === null || dm < 4) return 1;
    const diff = Math.abs(dr - dm);
    if (diff <= 12) return 1;                     // 差异 <=12：不校正
    const k = dr / dm;
    return Math.min(1.6, Math.max(0.45, k));      // 比例校正，带安全钳制
  });

  // ── 顶边色调适配（判据② 归因测量的直接产物）────────────
  // 归因脚本 verify/attr.py 显示：贴片接缝超标点 **41/45 集中在眉侧上缘**
  // （face_b 眼B max 80.3、pair2 眼A max 104.6）。原因不是羽化不够，而是
  // 原图睑裂正上方是**深色眼影/眉影**，而贴片顶边是亮皮肤 → 亮度台阶大。
  // 修法：量出睑裂上缘上方真实亮度，让贴片顶边按比例压向该亮度，
  // 再在往下 30% 处平滑恢复为正常肤色（解剖上闭眼上睑本来就该偏暗）。
  const topTone = eyeGeo.map((e) => {
    const yTop = Math.floor(e.cy - e.lensH);
    const vals = [];
    for (let gy = Math.max(1, yTop - 7); gy <= Math.max(1, yTop - 2); gy++) {
      for (let gx = Math.round(e.cx - e.lensW * 0.55); gx <= Math.round(e.cx + e.lensW * 0.55); gx++) {
        if (gx < 1 || gx >= W - 1) continue;
        const i = (gy * W + gx) * 4;
        vals.push(lum(sd[i], sd[i + 1], sd[i + 2]));
      }
    }
    if (!vals.length) return 1;
    vals.sort((x, y) => x - y);
    const med = vals[vals.length >> 1];
    // 贴片自身的基准亮度（供体带中位 × 比例）
    const dm = donorMed[eyeGeo.indexOf(e)];
    const base = dm !== null ? dm * (lumScale[eyeGeo.indexOf(e)] || 1) : null;
    if (base === null || base < 8) return 1;
    // 下限 0.40 实测优于 0.25：0.25 时眼A接缝 0→3、眼B 15→10，
    // 眼A 反而退化；0.40 下眼A 接缝为 **0**（达标）。取 0.40。
    return Math.min(1, Math.max(0.40, med / base));
  });

  const ringTargets = eyeGeo.map((e) => {
    const arr = new Array(ph);
    const y0 = Math.max(0, Math.floor(e.cy - e.lensH - 1));
    const y1 = Math.min(H - 1, Math.ceil(e.cy + e.lensH + 1));
    for (let gy = y0; gy <= y1; gy++) {
      let n = 0, r = 0, g = 0, b = 0;
      for (const side of [-1, 1]) {
        const xs = e.cx + side * e.lensW * 1.02;
        const xe = e.cx + side * e.lensW * 1.45;
        const lo = Math.max(1, Math.floor(Math.min(xs, xe)));
        const hi = Math.min(W - 2, Math.ceil(Math.max(xs, xe)));
        for (let gx = lo; gx <= hi; gx++) {
          const i = (gy * W + gx) * 4;
          const L = lum(sd[i], sd[i + 1], sd[i + 2]);
          // 关键修正：旧实现排除 L<62，但眼 B 周围是**深色眼影/阴影**(L≈30~50)，
          // 导致该眼每一行都"无合格取样"→ 回退到亮行 → 贴片比周围亮一大截，
          // 目视就是一块发亮的椭圆（EYEB_pair.png）。深色皮肤也是皮肤，必须纳入。
          if (L > 242) continue;
          r += sd[i]; g += sd[i + 1]; b += sd[i + 2]; n++;
        }
      }
      arr[gy - py0] = n >= 2 ? [r / n, g / n, b / n] : null;
    }
    const idx = [];
    for (let i = 0; i < ph; i++) if (arr[i]) idx.push(i);
    for (let i = 0; i < ph; i++) {
      if (arr[i]) continue;
      if (!idx.length) { arr[i] = null; continue; }
      let bst = idx[0];
      for (const v of idx) if (Math.abs(v - i) < Math.abs(bst - i)) bst = v;
      arr[i] = arr[bst];
    }
    return arr;
  });

  // 每个「折叠后源行」的均值：用于行内加性对齐（只搬纹理、不搬亮度）。
  // 索引 = 折叠后的 local 行号；必须与填充时实际取样行一致，否则补偿错位。
  const donorRowMean = donors.map((d) => {
    if (!d) return null;
    const m = new Array(d.h).fill(null);
    for (let li = 0; li < d.h; li++) {
      const yy = Math.min(H - 2, Math.max(1, d.dir === 'up' ? d.y + d.h - 1 - li : d.y + li));
      let n = 0, r = 0, g = 0, b = 0;
      for (let x = d.x; x < d.x + d.w; x++) {
        const j = (yy * W + x) * 4;
        r += sd[j]; g += sd[j + 1]; b += sd[j + 2]; n++;
      }
      m[li] = n ? [r / n, g / n, b / n] : null;
    }
    return m;
  });

  // ── ② 填眼区：取材纹理 + 逐行对齐到紧邻眼圈 ──
  for (let ry2 = 0; ry2 < ph; ry2++) {
    const gy = py0 + ry2;
    for (let rx2 = 0; rx2 < pw; rx2++) {
      const gx = px0 + rx2;
      let m = 0, ei = -1;
      for (let k = 0; k < eyeGeo.length; k++) {
        const e = eyeGeo[k];
        const t = (gx - e.cx) / e.lensW;
        const h = lensHalfH(t, e.lensH);
        if (h <= 0) continue;
        const d = Math.abs(gy - e.cy);
        const mm = 1 - smoothstepC(h - FEATHER, h, d);
        if (mm > m) { m = mm; ei = k; }
      }
      if (m <= 0.002 || ei < 0) continue;
      const e = eyeGeo[ei];
      const d = donors[ei];
      if (!d) continue;

      const dd = Math.max(0, gy - (e.cy - e.lensH));
      const period = d.h;
      const fold = dd % (period * 2);
      const local = fold < period ? fold : period * 2 - 1 - fold;
      // 横向取值。取材带窄于睑裂带时（眼 B 实测 w=46 vs 2*lensW≈94）
      // 曾试过镜像折叠铺满：实测边界跳变 54.4 → 99.1 反而恶化，
      // 且 46px 周期在目视上呈现"哑铃形"重复纹理（DISP19）。
      // 故保留边缘钳制：宁可右半侧平坦，也不引入可见周期结构。
      const offX = gx - (e.cx - e.lensW);
      let sx = d.x + Math.min(d.w - 1, Math.max(0, Math.round(offX)));
      let sy = d.dir === 'up' ? (d.y + d.h - 1 - Math.floor(local)) : (d.y + Math.floor(local));
      if (sx < 1) sx = 1; if (sx >= W - 2) sx = W - 2;
      if (sy < 1) sy = 1; if (sy >= H - 2) sy = H - 2;
      const si = (sy * W + sx) * 4;

      const tgt = ringTargets[ei][ry2];
      const localRow = Math.floor(local);
      const dm = donorRowMean[ei] && donorRowMean[ei][localRow];
      const oi = (ry2 * pw + rx2) * 4;
      const ks = lumScale[ei] || 1;
      const br = sd[si] * ks, bg = sd[si + 1] * ks, bb = sd[si + 2] * ks;
      if (tgt && dm) {
        od[oi] = clamp8(br + (tgt[0] - dm[0] * ks));
        od[oi + 1] = clamp8(bg + (tgt[1] - dm[1] * ks));
        od[oi + 2] = clamp8(bb + (tgt[2] - dm[2] * ks));
      } else {
        od[oi] = clamp8(br); od[oi + 1] = clamp8(bg); od[oi + 2] = clamp8(bb);
      }
      // 上缘避让：睑裂最上方 6px 保留原图的深色上睫毛/睑缘，贴片不覆盖那里，
      // 否则会把原本的深色睫毛抹成一条亮带 → 视觉上就是「贴了一块亮片」。
      const dyTop = gy - (e.cy - e.lensH);
      // 顶边覆盖：在膜裂上缘以上再羽化 -7px → +2px，
    // 必须把原图的**静止上睫毛**盖掉——否则它固定在 y≈570，
    // 成为比移动睑线更暗的静态残影（这正是目视里的"双层鬼影"）。
    const topCut = smoothstepC(-7.0, 2.0, dyTop);
      // 睑部明暗：真实闭眼的上睑是「上暗 → 中亮 → 靠睑线再暗」，
      // 均匀肤色的贴片看起来一定像个贴纸，必须带这层纵向明暗。
      const rel = Math.min(1, Math.max(0, dyTop / Math.max(1, e.lensH * 2)));
      const shade = 0.86 + 0.20 * Math.sin(Math.PI * Math.min(1, rel * 1.05)) - 0.06 * rel;
      od[oi] = clamp8(od[oi] * shade);
      od[oi + 1] = clamp8(od[oi + 1] * shade);
      od[oi + 2] = clamp8(od[oi + 2] * shade);
      // 顶边色调适配：在睑裂上缘往下 30% 内，把贴片压向原图上方实际亮度，
      // 消除"亮皮肤直接贴到深眼影"造成的边界台阶。
      const tt = topTone[ei];
      if (tt < 1) {
        const frac = Math.min(1, Math.max(0, dyTop / Math.max(1, e.lensH * 2 * 0.30)));
        const tone = tt + (1 - tt) * (frac * frac * (3 - 2 * frac));
        od[oi] = clamp8(od[oi] * tone);
        od[oi + 1] = clamp8(od[oi + 1] * tone);
        od[oi + 2] = clamp8(od[oi + 2] * tone);
      }
      od[oi + 3] = Math.round(255 * m * topCut);
    }
  }
  // 贴片**只提供皮肤**，不烘焙任何睑缘线。
  // 睑缘线由 shader 按 lidY(eyeOpen) 每帧绘制，位置随闭合单调下移；
  // 烘焙一条固定 y 的线会与移动的线互相打架，实测最暗行被钉在静态位置 570，
  // 五档 582/582/570/570/570 → 不单调。
  og.putImageData(img, 0, 0);

  // ── 终审闸门 S5：在**真实合成结果**上自检贴片边界 ──
  // 前面 4 条是「预测」，这条是「实测」：把闭眼帧按 shader 的混合公式合出来，
  // 沿睑裂边界量一圈，凡出现「原图本来没有、贴上贴片才出现」的亮度台阶，
  // 就是用户会看见的那圈椭圆。一处都不许有 → 该眼不可用（从严）。
  const seam = eyeGeo.map((e) => patchSeamCount(od, pw, ph, px0, py0, sd, W, H, e));
  seam.forEach((s, i) => {
    const eye = guard.eyes[i];
    eye.metrics.seam = s.seams;
    eye.metrics.seamOrig = s.origEdge;
    eye.metrics.seamOk = s.ok;
    eye.metrics.seamArc = s.maxArcDeg;
    if (s.maxArcDeg >= EYE_GATE.seamArcDeg && eye.feasible) {
      eye.reasons.push(`贴片边界连成${s.maxArcDeg.toFixed(0)}°弧（≥${EYE_GATE.seamArcDeg}°）`);
      eye.feasible = false;
    }
  });
  guard.feasible = guard.eyes.every((e) => e.feasible);
  guard.seamChecked = true;
  if (!guard.feasible) {
    // 判不过就丢掉合成结果，画面上不留任何东西
    return { canvas: null, rect, donor: { band: donorBand, primary: null }, guard };
  }

  const d0 = donors.find(Boolean);
  return {
    canvas: out,
    rect,
    donor: {
      band: donorBand,
      primary: { x: d0.x, y: d0.y, w: d0.w, h: d0.h, dir: d0.dir },
    },
    guard,
  };
}

function smoothstepC(a, b, x) {
  if (a === b) return x < a ? 0 : 1;
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
