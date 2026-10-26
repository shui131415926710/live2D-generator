/* ============================================================
   rig.js — M4 Rig 生成器：关键点 → 椭圆参数；无脸 → 形状先验
   依据：技术方案 §3.2 M4 换算表、§4.1 prior 常量
   设计要点：所有椭圆只以「双眼间距」为唯一尺度基准。
   ============================================================ */

/* MediaPipe FaceMesh 索引（与原项目 rig.js 共用语义锚点） */
const IDX = {
  eyeLOut: 33, eyeLIn: 133,
  eyeROut: 263, eyeRIn: 362,
  eyeLUp: 159, eyeLDown: 145,
  eyeRUp: 386, eyeRDown: 374,
  noseTip: 1,
  mouthL: 61, mouthR: 291,
  mouthUp: 13, mouthDown: 14,
  chin: 152,
  forehead: 10,
  faceL: 234, faceR: 454,
  browL: [70, 63, 105, 66, 107],
  browR: [336, 296, 334, 293, 300],
};

const R = (x, y, rx, ry) => ({ cx: x, cy: y, rx: Math.max(2, rx), ry: Math.max(2, ry) });

function clampEllipse(e, W, H) {
  const rx = Math.min(e.rx, W);
  const ry = Math.min(e.ry, H);
  return {
    cx: Math.min(W - 1, Math.max(1, e.cx)),
    cy: Math.min(H - 1, Math.max(1, e.cy)),
    rx, ry,
  };
}

/** 关键点 → rig（precise 模式） */
export function buildPreciseRig(face, imgW, imgH) {
  const P = face.landmarks;
  const nx = (i) => P[i].x;
  const ny = (i) => P[i].y;

  const eyeLx = (nx(IDX.eyeLOut) + nx(IDX.eyeLIn)) / 2;
  const eyeLy = (ny(IDX.eyeLUp) + ny(IDX.eyeLDown)) / 2;
  const eyeRx = (nx(IDX.eyeROut) + nx(IDX.eyeRIn)) / 2;
  const eyeRy = (ny(IDX.eyeRUp) + ny(IDX.eyeRDown)) / 2;

  const eyeDist = Math.max(6, Math.hypot(eyeRx - eyeLx, eyeRy - eyeLy));
  const eyeMidX = (eyeLx + eyeRx) / 2;
  const eyeMidY = (eyeLy + eyeRy) / 2;

  const chinY = ny(IDX.chin);
  const foreheadY = ny(IDX.forehead);

  // —— head ——（§3.2 换算表逐条）
  const headCx = eyeMidX;
  const headCy = eyeMidY - 0.55 * eyeDist;
  const headRx = 1.45 * eyeDist;
  const headRy = 0.78 * Math.max(eyeDist * 1.1, chinY - foreheadY);

  // 颈部支点：有肩信息就用，没有按下巴+0.9*ry 估
  const pivotY = chinY + 0.9 * headRy;

  // —— face ——
  const eyeLw = Math.hypot(nx(IDX.eyeLOut) - nx(IDX.eyeLIn), ny(IDX.eyeLOut) - ny(IDX.eyeLIn));
  const eyeRw = Math.hypot(nx(IDX.eyeROut) - nx(IDX.eyeRIn), ny(IDX.eyeROut) - ny(IDX.eyeRIn));
  const eyeLh = Math.abs(ny(IDX.eyeLDown) - ny(IDX.eyeLUp));
  const eyeRh = Math.abs(ny(IDX.eyeRDown) - ny(IDX.eyeRUp));

  const eyeA = R(eyeLx, eyeLy, 0.62 * (eyeLw || eyeDist * 0.34), 1.35 * Math.max(2, eyeLh));
  const eyeB = R(eyeRx, eyeRy, 0.62 * (eyeRw || eyeDist * 0.34), 1.35 * Math.max(2, eyeRh));

  const mouthW = Math.abs(nx(IDX.mouthR) - nx(IDX.mouthL));
  const mouthH = Math.abs(ny(IDX.mouthDown) - ny(IDX.mouthUp));
  const mouthCx = (nx(IDX.mouthL) + nx(IDX.mouthR)) / 2;
  const mouthCy = (ny(IDX.mouthL) + ny(IDX.mouthR)) / 2;
  const mouth = R(mouthCx, mouthCy, 0.68 * (mouthW || eyeDist * 0.9), 1.6 * Math.max(2.5, mouthH));

  const nose = R(nx(IDX.noseTip), ny(IDX.noseTip), 0.42 * eyeDist, 0.9 * eyeDist);

  // 眉
  const bl = IDX.browL.map((i) => P[i]);
  const br = IDX.browR.map((i) => P[i]);
  const browBox = bboxOf([...bl, ...br]);
  const browY = browBox.y + browBox.h / 2;
  const brow = {
    ...R(browBox.x + browBox.w / 2, browY, browBox.w * 0.62, Math.max(3, browBox.h * 1.1)),
    band: [browBox.y - browBox.h * 0.6, eyeMidY + 0.2 * eyeDist],
  };

  // 下巴过渡带
  const jaw = {
    ...R(eyeMidX, (mouthCy + chinY) / 2, 0.95 * headRx, 0.5 * Math.max(4, chinY - mouthCy)),
    band: [mouthCy, chinY + 0.1 * (chinY - mouthCy)],
  };

  const earL = R(headCx - headRx * 0.92, headCy + headRy * 0.1, headRx * 0.3, headRy * 0.35);
  const earR = R(headCx + headRx * 0.92, headCy + headRy * 0.1, headRx * 0.3, headRy * 0.35);

  // —— body ——
  const chest = R(headCx, headCy + 2.0 * headRy, 1.6 * headRx, 1.1 * headRy);
  const shoulders = [
    R(headCx - 0.92 * headRx, chest.cy - 0.28 * chest.ry, 0.9 * headRx, 0.55 * headRy),
    R(headCx + 0.92 * headRx, chest.cy - 0.28 * chest.ry, 0.9 * headRx, 0.55 * headRy),
  ];

  const rig = {
    version: 1,
    mode: 'precise',
    image: { width: imgW, height: imgH },
    head: {
      ...R(headCx, headCy, headRx, headRy),
      shiftX: imgW * 0.032,
      shiftY: imgH * 0.025,
      pivotX: headCx,
      pivotY,
      maxRoll: 0.15,
      weightBand: [chinY - 0.15 * headRy, chinY + 0.35 * headRy],
      turnBand: [eyeMidY - headRy * 0.4, chinY + 0.2 * headRy],
    },
    body: {
      chest,
      pivotX: headCx,
      pivotY: chest.cy + 1.15 * chest.ry,
      maxRoll: 0.035,
      breathBand: [headCy + 0.9 * headRy, headCy + 3.6 * headRy],
      shoulders,
      rollBand: [chest.cy - 0.6 * chest.ry, chest.cy + 0.9 * chest.ry],
    },
    face: {
      eyeA, eyeB, mouth, nose, brow, jaw, earL, earR,
      eyeDist,
      eyeMidY,
      chinY,
    },
    strands: [],
    mesh: meshPlan(headRx, headCy, headRy, chinY),
    quality: {
      faceDetected: true,
      eyeRegionConfident: true,
      faceBoxRatio: face.area / (imgW * imgH),
      notes: [],
    },
  };

  return finalize(rig, imgW, imgH);
}

/** 形状先验模式（§4.1）——只用比例常量，不含检测 */
export function buildPriorRig(img) {
  const { width: W, height: H, bbox } = img;
  const H0 = bbox.h || H;
  const W0 = bbox.w || W;
  const top = bbox.y || 0;
  const cx = (bbox.x || 0) + W0 / 2;

  const headH = 0.26 * H0;
  const headW = 0.62 * headH;

  const headCy = top + 0.52 * headH;
  const headRx = 0.55 * headW;
  const headRy = 0.62 * headH;

  const eyeDist = 0.42 * headW;
  const eyeMidY = headCy + 0.02 * headH;

  const eyeA = R(cx - eyeDist / 2, eyeMidY, eyeDist * 0.30, eyeDist * 0.17);
  const eyeB = R(cx + eyeDist / 2, eyeMidY, eyeDist * 0.30, eyeDist * 0.17);
  const mouth = R(cx, headCy + 0.30 * headH, eyeDist * 0.42, eyeDist * 0.21);
  const nose = R(cx, headCy + 0.14 * headH, 0.42 * eyeDist, 0.9 * eyeDist);

  const chinY = headCy + headRy * 0.95;

  const rig = {
    version: 1,
    mode: 'prior',
    image: { width: W, height: H },
    head: {
      ...R(cx, headCy, headRx, headRy),
      shiftX: W * 0.022,
      shiftY: H * 0.018,
      pivotX: cx,
      pivotY: chinY + 0.55 * headRy,
      maxRoll: 0.10,
      weightBand: [chinY - 0.1 * headRy, chinY + 0.3 * headRy],
      turnBand: [eyeMidY - headRy * 0.4, chinY],
    },
    body: {
      chest: R(cx, headCy + 1.35 * headH, 1.8 * headW * 0.5, 0.9 * headH),
      pivotX: cx,
      pivotY: top + H0 * 0.94,
      maxRoll: 0.03,
      breathBand: [headCy + 0.7 * headH, top + H0 * 0.95],
      shoulders: [
        R(cx - 0.55 * headW, headCy + 1.15 * headH, 0.45 * headW, 0.4 * headH),
        R(cx + 0.55 * headW, headCy + 1.15 * headH, 0.45 * headW, 0.4 * headH),
      ],
      rollBand: [headCy + 1.0 * headH, top + H0 * 0.9],
    },
    face: {
      eyeA, eyeB, mouth, nose,
      brow: { ...R(cx, eyeMidY - eyeDist * 0.55, eyeDist * 1.2, eyeDist * 0.22), band: [eyeMidY - eyeDist * 0.8, eyeMidY - eyeDist * 0.2] },
      jaw: { ...R(cx, (mouth.cy + chinY) / 2, headRx * 0.95, (chinY - mouth.cy) * 0.55), band: [mouth.cy, chinY] },
      earL: R(cx - headRx * 0.92, headCy, headRx * 0.28, headRy * 0.3),
      earR: R(cx + headRx * 0.92, headCy, headRx * 0.28, headRy * 0.3),
      eyeDist,
      eyeMidY,
      chinY,
    },
    strands: [],
    mesh: meshPlan(headRx, headCy, headRy, chinY),
    quality: {
      faceDetected: false,
      eyeRegionConfident: false,
      faceBoxRatio: 0,
      notes: ['未识别到人脸，按形状先验推定头位；眨眼与视线已关闭。'],
    },
  };

  return finalize(rig, W, H);
}

/** 纯呼吸模式：非人形图（§4.1 最简兜底） */
export function buildMinimalRig(img) {
  const { width: W, height: H, bbox } = img;
  const cx = (bbox.x || 0) + (bbox.w || W) / 2;
  const cy = (bbox.y || 0) + (bbox.h || H) / 2;
  const rig = {
    version: 1,
    mode: 'minimal',
    image: { width: W, height: H },
    head: {
      ...R(cx, cy, W * 0.5, H * 0.5),
      shiftX: 0, shiftY: 0, pivotX: cx, pivotY: (bbox.y || 0) + (bbox.h || H),
      maxRoll: 0, weightBand: [H, H], turnBand: [H, H],
    },
    body: {
      chest: R(cx, cy, W * 0.5, H * 0.5),
      pivotX: cx,
      pivotY: (bbox.y || 0) + (bbox.h || H) * 0.98,
      maxRoll: 0.006,
      breathBand: [(bbox.y || 0), H],
      shoulders: [],
      rollBand: [H, H],
    },
    face: {
      eyeA: R(0, 0, 1, 1), eyeB: R(0, 0, 1, 1),
      mouth: R(0, 0, 1, 1), nose: R(0, 0, 1, 1),
      brow: { ...R(0, 0, 1, 1), band: [H, H] },
      jaw: { ...R(0, 0, 1, 1), band: [H, H] },
      earL: R(0, 0, 1, 1), earR: R(0, 0, 1, 1),
      eyeDist: 1, eyeMidY: 0, chinY: H,
    },
    strands: [],
    mesh: meshPlan(W * 0.5, cy, H * 0.5, H),
    quality: {
      faceDetected: false,
      eyeRegionConfident: false,
      faceBoxRatio: 0,
      notes: ['未识别到角色结构，已提供基础整体动效（轻微呼吸与缩放）。'],
    },
  };
  return finalize(rig, W, H);
}

function bboxOf(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 网格规划：baseCell 14 / fine 7（技术方案 §6.1），并按尺寸自适应 */
function meshPlan(headRx, headCy, headRy, chinY) {
  const fineH = Math.max(40, headRy * 2.3);
  const fineW = Math.max(40, headRx * 2.3);
  return {
    baseCell: 14,
    fine: {
      x: headRx * -1.15 + 0, // cx 在 finalize 里补
      y: headCy - headRy * 1.15,
      w: fineW,
      h: fineH,
    },
    fineCell: 7,
    fineAnchor: { cx: 0, cy: headCy }, // cx 由 finalize 填
  };
}

/** 越界钳制 + 标记降级（F-05 要求） */
function finalize(rig, W, H) {
  const notes = rig.quality.notes;
  const clamp = (e, name) => {
    const c = clampEllipse(e, W, H);
    if (c.rx !== e.rx || c.ry !== e.ry) notes.push(`${name} 区域超出画面，已钳制到图内。`);
    return c;
  };

  rig.head = { ...rig.head, ...clamp(rig.head, '头部') };
  rig.body.chest = clamp(rig.body.chest, '胸部');
  rig.body.shoulders = (rig.body.shoulders || []).map((s) => clamp(s, '肩部'));
  const f = rig.face;
  rig.face = {
    ...f,
    eyeA: clamp(f.eyeA, '左眼'),
    eyeB: clamp(f.eyeB, '右眼'),
    mouth: clamp(f.mouth, '嘴部'),
    nose: clamp(f.nose, '鼻部'),
    brow: { ...clamp(f.brow, '眉部'), band: f.brow.band },
    jaw: { ...clamp(f.jaw, '下颌'), band: f.jaw.band },
    earL: clamp(f.earL, '左耳'),
    earR: clamp(f.earR, '右耳'),
  };

  // fine 矩形以头中心对齐
  const m = rig.mesh;
  m.fine.x = Math.max(0, rig.head.cx - m.fine.w / 2);
  m.fine.y = Math.max(0, rig.head.cy - m.fine.h / 2);
  m.fine.w = Math.min(m.fine.w, W - m.fine.x);
  m.fine.h = Math.min(m.fine.h, H - m.fine.y);

  rig.quality.notes = [...new Set(notes)];
  return rig;
}
