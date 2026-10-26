/* ============================================================
   app.js — 控制器
   把引擎（validate → decode → detect → rig → mesh → motion → renderer）
   接到界面状态机：idle → reading → processing → success | degraded | error
   依据：需求文档 F-01~F-14 / P0-01~P0-16；技术方案 §3.2 M1~M8、§7
   ============================================================ */

import { LIMITS, checkFile, describeBytes } from './engine/validate.js';
import { normalize } from './engine/decode.js';
import { detectFaces, loadLandmarker, detectorState } from './engine/detect.js';
import { buildPreciseRig, buildPriorRig, buildMinimalRig } from './engine/rig.js';
import { buildMesh } from './engine/mesh.js';
import { Motion } from './engine/motion.js';
import { Renderer } from './engine/renderer.js';

const $ = (id) => document.getElementById(id);

const el = {
  app: $('app'),
  dropzone: $('dropzone'), fileInput: $('file-input'), dzTitle: $('dz-title'),
  panelFile: $('panel-file'), thumb: $('thumb'), fileName: $('file-name'),
  fileDim: $('file-dim'), fileStatus: $('file-status'), btnReplace: $('btn-replace'),
  panelProgress: $('panel-progress'), steps: $('steps'), bar: $('bar'), barFill: $('bar-fill'),
  progressLabel: $('progress-label'), progressTime: $('progress-time'), progressSub: $('progress-sub'),
  btnCancel: $('btn-cancel'),
  panelControls: $('panel-controls'), statusPill: $('status-pill'),
  noticeDegraded: $('notice-degraded'), degradedTitle: $('degraded-title'),
  degradedText: $('degraded-text'), degradedWhy: $('degraded-why'), labels: $('labels'),
  btnPlay: $('btn-play'), playLabel: $('play-label'), btnReset: $('btn-reset'),
  btnExport: $('btn-export'), exportNote: $('export-note'), exportResult: $('export-result'),
  panelError: $('panel-error'), errorText: $('error-text'), errorAdvice: $('error-advice'),
  btnRetry: $('btn-retry'), btnAnother: $('btn-another'),
  rowForce: $('row-force'), btnForce: $('btn-force'),
  canvasWrap: $('canvas-wrap'), emptyMesh: $('empty-mesh'), gl: $('gl'),
  stageMeta: $('stage-meta'), stageCaption: $('stage-caption'), stageHint: $('stage-hint'),
  facePicker: $('face-picker'), fpTitle: $('fp-title'), fpImg: $('fp-img'),
  fpHit: $('fp-hit'), fpList: $('fp-list'), btnFpCancel: $('btn-fp-cancel'),
  toast: $('toast'),
};

/* ── 运行状态 ── */
const S = {
  file: null,
  format: null,
  img: null,
  rig: null,
  mesh: null,
  renderer: null,
  motion: null,
  caps: null,
  mode: 'idle',
  playing: true,
  raf: 0,
  lastT: 0,
  abort: false,
  t0: 0,
  tick: 0,
  faces: [],
  thumbUrl: null,
  fps: 0,
  fpsAcc: 0,
  fpsN: 0,
  fpsT0: 0,
  drawAcc: 0,
  drawN: 0,
  minEye: 1,
};

const SLOW_HINT_MS = 15000;   // P0-15：15 秒未完成给出解释
const HARD_TIMEOUT_MS = 60000; // P0-15：60 秒兜底超时

/* ── 小工具 ── */
function fmtBytes(n) { return describeBytes(n); }

let toastTimer = 0;
function toast(msg, isError = false) {
  const t = el.toast;
  t.textContent = msg;
  t.classList.toggle('is-error', !!isError);
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('is-show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('is-show');
    setTimeout(() => { t.hidden = true; }, 260);
  }, isError ? 5200 : 3200);
}

function setState(name) {
  S.mode = name;
  el.app.dataset.state = name;
  el.panelFile.hidden = name === 'idle';
  el.panelProgress.hidden = !(name === 'reading' || name === 'processing');
  el.panelControls.hidden = !(name === 'success' || name === 'degraded');
  el.panelError.hidden = name !== 'error';
  el.facePicker.hidden = true;
  const busy = name === 'reading' || name === 'processing';
  document.body.classList.toggle('is-busy', busy);
  if (busy) {
    // 进度与「取消」按钮必须留在视口里，压缩后的首屏已把面板顶上来了
    requestAnimationFrame(() => {
      if (el.panelProgress.offsetParent) {
        el.panelProgress.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }
  if (name === 'idle') {
    el.canvasWrap.dataset.empty = 'true';
    el.gl.classList.remove('is-live');
    el.stageHint.textContent = '拖入图片开始';
    el.stageMeta.textContent = '';
  }
}

function setStep(n) {
  const items = el.steps.querySelectorAll('.step');
  items.forEach((li) => {
    const i = Number(li.dataset.step);
    li.classList.toggle('is-active', i === n);
    li.classList.toggle('is-done', i < n);
  });
}

function setProgress(pct, label, sub) {
  const p = Math.max(0, Math.min(100, pct));
  el.barFill.style.width = p.toFixed(1) + '%';
  el.bar.setAttribute('aria-valuenow', String(Math.round(p)));
  if (label) el.progressLabel.textContent = label;
  if (sub !== undefined) el.progressSub.textContent = sub || '';
}

function elapsed() { return (performance.now() - S.t0) / 1000; }

function startTimer() {
  S.t0 = performance.now();
  clearInterval(S.tick);
  S.tick = setInterval(() => {
    el.progressTime.textContent = elapsed().toFixed(1) + ' s';
    if (elapsed() * 1000 > SLOW_HINT_MS && el.progressSub.textContent === '') {
      el.progressSub.textContent =
        '首次使用需要下载约 3.6 MB 的本地识别模型，网络较慢时请稍候；这一步只在第一次发生。';
    }
  }, 100);
}

function stopTimer() { clearInterval(S.tick); S.tick = 0; }

function abortError(msg) { const e = new Error(msg); e.code = 'E_ABORT'; return e; }


/* ============================================================
   第二部分：上传入口 → 校验 → 处理流水线 → 结果页
   ============================================================ */

/* ── 上传入口：点击 / 拖拽 / 粘贴 ── */
function pickFile() { el.fileInput.click(); }

el.dropzone.addEventListener('click', (e) => {
  if (e.target.closest('input')) return;
  pickFile();
});
el.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFile(); }
});
el.fileInput.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) onFile(f);
  e.target.value = '';
});

['dragenter', 'dragover'].forEach((ev) =>
  el.dropzone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    el.dropzone.classList.add('is-drag');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  el.dropzone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    if (ev === 'dragleave' && el.dropzone.contains(e.relatedTarget)) return;
    el.dropzone.classList.remove('is-drag');
  })
);
el.dropzone.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  if (!dt) return;
  const f = dt.files && dt.files[0];
  if (f) onFile(f);
});

// 整页拖入
['dragover', 'drop'].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    if (e.target.closest && e.target.closest('#dropzone')) return;
    e.preventDefault();
  })
);

// 粘贴
window.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) { e.preventDefault(); onFile(f); return; }
    }
  }
});

/* ── 文件进入：先做 S1 校验 ── */
function onFile(file) {
  if (S.mode === 'reading' || S.mode === 'processing') {
    toast('还在处理上一张，请先取消或等待完成。', true);
    return;
  }
  // 清空 input，保证「换一张」后再次选择同一个文件也能触发 change
  try { el.fileInput.value = ''; } catch (e) { /* 部分浏览器不允许写 value，忽略 */ }
  const chk = checkFile(file);
  if (!chk.ok) {
    el.dropzone.classList.add('is-error');
    setTimeout(() => el.dropzone.classList.remove('is-error'), 1600);
    showError(chk.reason, adviceFor(chk.kind), { keepFile: true });
    return;
  }
  S.file = file;
  S.format = chk.format;
  startPipeline(file, chk.format);
}

function adviceFor(kind) {
  if (kind === 'size') {
    return [
      '把图片导出时长边压到 2000px 以内，通常就能压到 20 MB 以下。',
      '换成 JPG 或 WebP 格式重新导出，体积会小很多。',
      '如果图本来就不大，可能是文件系统里存的是原图，先用图片工具压缩一次。',
    ];
  }
  return [
    '支持 PNG、JPG、WebP、GIF；其它格式请先在图片工具里导出成 PNG 或 JPG。',
    '如果文件后缀和实际格式不一致（比如把 .psd 改名成 .png），重新导出一次即可。',
    '也可以直接截图保存成 PNG 再拖进来。',
  ];
}

/* ── 缩略图 ── */
function showThumb(file) {
  if (S.thumbUrl) URL.revokeObjectURL(S.thumbUrl);
  S.thumbUrl = URL.createObjectURL(file);
  el.thumb.src = S.thumbUrl;
}

/* ── 主流水线 ── */
async function startPipeline(file, format, opts = {}) {
  S.abort = false;
  S.faces = [];
  setState('reading');
  setStep(1);
  setProgress(2, '正在读取图片…', '');
  startTimer();
  showThumb(file);

  el.fileName.textContent = file.name || '未命名图片';
  el.fileDim.textContent = `${fmtBytes(file.size)} · ${format.toUpperCase()}`;
  el.fileStatus.className = 'file-status';
  el.fileStatus.textContent = '未上传 · 仅在本机浏览器内处理';
  el.dropzone.classList.add('is-reading');

  let img = null;
  try {
    /* 步骤 1：解码 + 归一化（降采样、alpha 分析） */
    img = await normalize(file, format, (pct) => {
      if (S.abort) throw abortError('已取消');
      setProgress(pct, '正在读取图片…', '解码与尺寸归一化');
    });
    if (S.abort) throw abortError('已取消');
    S.img = img;

    el.fileDim.textContent = `${img.srcWidth}×${img.srcHeight} → ${img.width}×${img.height}`;
    el.fileStatus.textContent = '未上传 · 仅在本机浏览器内处理';

    // PRD §4.7：无透明背景在 S1 就提示
    if (img.noTransparency) {
      el.fileStatus.className = 'file-status is-warn';
      el.fileStatus.textContent = '这张图没有透明背景，处理后会保留背景。';
      el.progressSub.textContent = '这张图没有透明背景，处理后会保留背景；想要透明效果请用带透明通道的 PNG。';
    } else if (img.downscaleNote) {
      el.progressSub.textContent = img.downscaleNote;
    }

    /* 步骤 2：人脸检测（懒加载模型） */
    setState('processing');
    setStep(1);
    setProgress(10, '正在识别人脸…', '首次使用会先下载本地识别模型');
    checkDeadline();

    let det = { faces: [] };
    try {
      det = await detectFaces(img, (pct, note) => {
        if (S.abort) throw abortError('已取消');
        checkDeadline();
        setProgress(10 + pct * 52, '正在识别人脸…', note || '');
      });
    } catch (err) {
      if (err && err.code === 'E_ABORT') throw err;
      // §4.6：模型加载失败 = 阻断型失败，不悄悄切无脸模式
      throw new Error(
        '检测模型没能加载完成。模型文件需要从本站静态资源下载，网络受限或 CDN 被拦截时会失败。' +
        (err && err.message ? `（${err.message}）` : '')
      );
    }
    if (S.abort) throw abortError('已取消');

    S.faces = det.faces || [];

    if (S.faces.length === 0 && !opts.forceFallback) {
      // PRD §4.2：停在说明页，不生成任何头像
      stopTimer();
      showNoFace();
      return;
    }

    if (S.faces.length >= 2 && !opts.face) {
      // PRD §4.3：多脸不自动挑，进入选择态
      stopTimer();
      showFacePicker(S.faces);
      return;
    }

    const face = opts.face || S.faces[0] || null;
    await buildAndPlay(img, face, opts);
  } catch (err) {
    handlePipelineError(err);
  }
}

function checkDeadline() {
  if (S.abort) throw abortError('已取消');
  if (elapsed() * 1000 > HARD_TIMEOUT_MS) {
    const e = new Error('这个设备处理这张图有点吃力，整段处理超过了 60 秒。');
    e.code = 'E_TIMEOUT';
    throw e;
  }
}

/* ── 构建 rig + 网格 + 首帧 ── */
async function buildAndPlay(img, face, opts = {}) {
  /* 步骤 3：定位五官与轮廓 */
  setStep(2);
  setProgress(64, '正在定位五官…', '把关键点换算成可驱动的区域');
  await frame();

  let rig;
  if (face) {
    rig = buildPreciseRig(face, img.width, img.height);
  } else {
    // 形状先验兜底（技术方案 §4.1）
    const looksHuman = isHumanoid(img);
    rig = looksHuman ? buildPriorRig(img) : buildMinimalRig(img);
  }
  S.rig = rig;

  /* 步骤 4：网格与权重 */
  setStep(3);
  setProgress(72, '正在生成动作网格…', '烘焙呼吸 / 转头 / 眨眼权重');
  await frame();

  const mesh = buildMesh(img, rig, { vertexBudget: 32000 });
  S.mesh = mesh;

  /* 步骤 5：准备第一帧 */
  setStep(4);
  setProgress(94, '正在准备第一帧…', '');
  await frame();

  const caps = capsFor(rig);
  S.caps = caps;

  if (!S.renderer) {
    try {
      S.renderer = new Renderer(el.gl);
    } catch (e) {
      throw new Error('这个浏览器没有开启 WebGL2，无法渲染动画。请更新浏览器或换用 Chrome / Edge / Safari 15+ 后重试。');
    }
  }
  S.renderer.setImage(img.bitmap, img.width, img.height);
  S.renderer.setMesh(mesh);

  S.motion = new Motion(rig, caps);
  S.playing = true;
  S.minEye = 1;
  updatePlayButton();

  // 画布尺寸（等比）
  layoutCanvas();
  el.canvasWrap.dataset.empty = 'false';
  el.gl.classList.add('is-live');
  el.stageHint.textContent = '';
  el.stageMeta.textContent =
    `${img.width}×${img.height} · ${mesh.stats.vertices.toLocaleString('en-US')} 顶点 · ${
      rig.mode === 'precise' ? '精确模式' : rig.mode === 'prior' ? '形状先验' : '整体动效'
    }`;

  // 画第一帧
  const st = S.motion.state;
  S.renderer.draw(st, rig);

  setProgress(100, '完成', '');
  stopTimer();
  setStep(5);

  const degraded = rig.mode !== 'precise' || (rig.quality.notes && rig.quality.notes.length > 0);
  showResult(rig, caps, img, degraded);
}

/** 让出主线程一帧，保证进度条能刷新 */
function frame() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

/** 3 条人形判定（技术方案 §4.1） */
function isHumanoid(img) {
  const { width: W, height: H, bbox } = img;
  const b = bbox && bbox.w > 0 ? bbox : { w: W, h: H };
  const ratio = b.h / Math.max(1, b.w);
  if (ratio < 0.95) return false;              // 太宽，不像立绘
  if (b.w / Math.max(1, W) > 0.92 && b.h / Math.max(1, H) > 0.92) return false; // 几乎铺满画面（风景）
  const alphaCov = img.alphaCoverage ?? 1;
  if (alphaCov < 0.12 && b.w / W > 0.8) return false; // 大面积不透明且无主体 → 风景图
  return true;
}

/** 按 rig 模式给出「实际启用」的能力（PRD 4.1 / P0-08 / P0-13） */
function capsFor(rig) {
  if (rig.mode === 'precise') {
    return { blink: true, breath: true, head: true, body: true, strands: false, gaze: true };
  }
  if (rig.mode === 'prior') {
    return { blink: false, breath: true, head: true, body: true, strands: false, gaze: false };
  }
  return { blink: false, breath: true, head: false, body: true, strands: false, gaze: false };
}

const CHIP_TEXT = {
  blink: '自动眨眼',
  breath: '呼吸起伏',
  head: '轻微转头',
  body: '身体摆动',
  gaze: '视线跟随',
};


/* ============================================================
   第三部分：结果页 / 说明页 / 多人脸选择态 / 播放 / 导出 / 接线
   ============================================================ */

/* ── 结果页 ── */
function showResult(rig, caps, img, degraded) {
  setState(degraded ? 'degraded' : 'success');

  el.statusPill.textContent = degraded ? '已降级生成' : '已生成';
  el.statusPill.classList.toggle('is-degraded', !!degraded);

  // 能力标签：只列实际启用的
  el.labels.innerHTML = '';
  const order = ['blink', 'breath', 'head', 'body', 'gaze'];
  let n = 0;
  for (const k of order) {
    if (!caps[k]) continue;
    n++;
    const b = document.createElement('span');
    b.className = 'label-chip';
    b.textContent = CHIP_TEXT[k];
    el.labels.appendChild(b);
  }

  // 降级说明
  if (degraded) {
    el.noticeDegraded.hidden = false;
    const notes = (rig.quality && rig.quality.notes) || [];
    if (rig.mode === 'prior') {
      el.degradedTitle.textContent = '已启用降级效果';
      el.degradedText.textContent =
        '这张图里没有找到清晰的人脸，所以没有定位到眼睛和嘴巴。你看到的动画是整体呼吸与轻微摆动，不是精确的五官驱动。';
      el.degradedWhy.textContent =
        '未检出人脸时，系统改用「形状先验」按比例推定头位（P0 兜底路径，与主路径同等实现），' +
        '但眼睛、嘴巴位置不可靠，因此自动眨眼与视线跟随已关闭，避免把错误位置画变形。' +
        '想要完整效果，请换一张正面、清晰、人脸较大的立绘。';
    } else if (rig.mode === 'minimal') {
      el.degradedTitle.textContent = '已启用降级效果';
      el.degradedText.textContent =
        '这张图里没有识别到可用的角色结构，只能提供整体呼吸与轻微摆动。';
      el.degradedWhy.textContent =
        '既没有检测到人脸，画面也不符合立绘比例判定，系统退到最简兜底：只做整体形变，不做五官驱动。';
    } else {
      el.degradedTitle.textContent = '部分效果已关闭';
      el.degradedText.textContent = notes.join('；') || '检测到的关键点不完整，部分效果不可用。';
      el.degradedWhy.textContent =
        '单个区域超出画面或关键点缺失时，系统会裁剪掉依赖它的效果，而不是整单失败。';
    }
  } else {
    el.noticeDegraded.hidden = true;
  }

  // 导出说明随图实际情况变化
  if (img.noTransparency) {
    el.exportNote.textContent = '导出为 PNG，保留原图背景（这张图本身没有透明通道）。文件名带时间戳。';
  } else {
    el.exportNote.textContent = '导出为透明 PNG，分辨率与处理图一致，文件名带时间戳。';
  }
  el.exportResult.hidden = true;

  el.stageCaption.textContent = img.noTransparency
    ? '原图没有透明背景，背景会随人物一起轻微位移——本期不做自动抠图。'
    : '透明背景以棋盘格显示。画面按原图比例缩放，不会拉伸。';
}

/* ── 说明页：没有找到人脸（PRD §4.2 / P0-12） ── */
function showNoFace() {
  setState('error');
  el.errorText.textContent =
    '没有找到清晰的人脸。这张图可能不是人物立绘，或者人物太小、太侧。';
  el.errorAdvice.innerHTML = '';
  for (const t of [
    '换一张正脸清晰的图：侧脸、背影、被手或道具挡住都会让五官定位失准。',
    '让人脸占画面更大一些：把角色头部放到画面的四分之一以上，网格才能精确落在五官上。',
    '用未压缩的原图：社交平台二次压缩过的图，五官边缘会糊，识别成功率明显下降。',
  ]) {
    const li = document.createElement('li');
    li.textContent = t;
    el.errorAdvice.appendChild(li);
  }
  el.rowForce.hidden = false;
  el.btnForce.textContent = '仍然尝试生成（按形状先验估算，效果可能不符合预期）';
  el.btnRetry.textContent = '重新检测';
  el.dzTitle.textContent = '把图片拖到这里';
}

/* ── 多人脸选择态（PRD §4.3 / P0-11） ── */
function showFacePicker(faces) {
  setState('processing');
  el.facePicker.hidden = false;
  el.fpTitle.textContent = `这张图里有 ${faces.length} 张脸，选一个作为头像主角`;
  el.fpImg.src = S.thumbUrl || '';
  el.fpHit.innerHTML = '';
  el.fpList.innerHTML = '';

  faces.forEach((f, i) => {
    // 缩略图列表
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'fp-item';
    item.innerHTML = `<span class="fp-thumb" style="width:28px;height:28px;border-radius:8px;display:inline-block;background:#222836"></span><span>面孔 ${i + 1}</span>`;
    item.addEventListener('click', () => resumeWithFace(f));
    el.fpList.appendChild(item);

    // 图上的编号框
    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'fp-box';
    box.innerHTML = `<span>${i + 1}</span>`;
    box.addEventListener('click', () => resumeWithFace(f));
    el.fpHit.appendChild(box);
  });

  // 位置需要在图片布局完成后计算
  requestAnimationFrame(() => {
    const imgRect = el.fpImg.getBoundingClientRect();
    const boxRect = el.fpImg.parentElement.getBoundingClientRect();
    const scale = imgRect.width / (S.img.width || 1);
    const boxes = el.fpHit.querySelectorAll('.fp-box');
    faces.forEach((f, i) => {
      const bb = faceBoxOf(f);
      const b = boxes[i];
      if (!b || !bb) return;
      b.style.left = (imgRect.left - boxRect.left + bb.x * scale) + 'px';
      b.style.top = (imgRect.top - boxRect.top + bb.y * scale) + 'px';
      b.style.width = Math.max(26, bb.w * scale) + 'px';
      b.style.height = Math.max(26, bb.h * scale) + 'px';
    });
  });
}

function faceBoxOf(f) {
  const pts = f.landmarks || [];
  if (!pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < Math.min(468, pts.length); i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

async function resumeWithFace(face) {
  el.facePicker.hidden = true;
  setState('processing');
  setStep(2);
  setProgress(66, '正在定位五官…', '已选定主角');
  startTimer();
  try {
    await buildAndPlay(S.img, face);
  } catch (err) {
    handlePipelineError(err);
  }
}

/* ── 失败页 ── */
function showError(text, advice, opts = {}) {
  setState('error');
  el.errorText.textContent = text;
  el.errorAdvice.innerHTML = '';
  for (const t of advice || []) {
    const li = document.createElement('li');
    li.textContent = t;
    el.errorAdvice.appendChild(li);
  }
  el.rowForce.hidden = !opts.force;
  el.btnForce.textContent = '仍然尝试生成（效果可能不符合预期）';
  el.btnRetry.textContent = opts.retryLabel || '重试';
  if (!opts.keepFile) {
    el.dzTitle.textContent = '把图片拖到这里';
  }
}

function handlePipelineError(err) {
  if (err && err.code === 'E_ABORT') return;   // 用户主动取消，界面已复位
  stopTimer();
  const isTimeout = err && err.code === 'E_TIMEOUT';
  const msg = err && err.message ? err.message : '发生了未知错误。';
  showError(msg, isTimeout
    ? [
        '换一台性能更好的设备再试一次。',
        '把图片缩小一些（长边 1000px 左右通常就够用了）。',
        '关掉其他占资源的标签页，然后重新上传。',
      ]
    : [
        '重新上传一次这张图，通常可以解决偶发失败。',
        '确认图片文件没有损坏，可以先用图片工具另存一份再拖进来。',
        '如果是第一次使用，请检查网络是否正常——识别模型需要从本站静态资源下载。',
      ], { retryLabel: '重试' });
}

/* ── 播放控制 ── */
function updatePlayButton() {
  el.btnPlay.setAttribute('aria-pressed', S.playing ? 'true' : 'false');
  el.playLabel.textContent = S.playing ? '暂停' : '播放';
}

el.btnPlay.addEventListener('click', () => {
  if (!S.motion) return;
  S.playing = !S.playing;
  updatePlayButton();
  if (S.playing) S.lastT = 0;
});

el.btnReset.addEventListener('click', () => {
  if (!S.motion) return;
  S.motion.reset();
  S.motion.paused = !S.playing;
  S.renderer.draw(S.motion.state, S.rig);
  toast('已重置到初始姿态。');
});

el.btnCancel.addEventListener('click', () => {
  S.abort = true;
  stopTimer();
  setState('idle');
  el.panelFile.hidden = false;
  el.fileStatus.className = 'file-status';
  el.fileStatus.textContent = '已取消 · 图片仍在，可直接重新处理';
  el.dzTitle.textContent = '已取消 · 重新处理这张图';
  toast('已取消处理，图片仍留在你的浏览器里。');
});

el.btnRetry.addEventListener('click', () => {
  if (!S.file) { setState('idle'); return; }
  startPipeline(S.file, S.format);
});

el.btnAnother.addEventListener('click', () => {
  S.file = null; S.format = null; S.img = null; S.faces = [];
  stopTimer();
  setState('idle');
  el.dzTitle.textContent = '把图片拖到这里';
  el.fileStatus.textContent = '—';
  el.fileDim.textContent = '—';
  el.fileName.textContent = '—';
  toast('已清空，换一张试试。');
});

el.btnForce.addEventListener('click', () => {
  if (!S.file) return;
  startPipeline(S.file, S.format, { forceFallback: true });
});

el.btnReplace.addEventListener('click', () => {
  setState('idle');
  el.dzTitle.textContent = '把图片拖到这里';
  pickFile();
});

el.btnFpCancel.addEventListener('click', () => {
  el.facePicker.hidden = true;
  setState('idle');
  el.panelFile.hidden = false;
  el.dzTitle.textContent = '把图片拖到这里';
});

/* ── 导出 PNG（P0-14） ── */
let exportRenderer = null;
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

el.btnExport.addEventListener('click', () => {
  if (!S.renderer || !S.rig || !S.img) return;
  try {
    if (!exportRenderer) {
      const c = document.createElement('canvas');
      exportRenderer = new Renderer(c);
      exportRenderer.setImage(S.img.bitmap, S.img.width, S.img.height);
      exportRenderer.setMesh(S.mesh);
    }
    exportRenderer.resize(S.img.width, S.img.height);
    exportRenderer.draw(S.motion.state, S.rig);
    const url = exportRenderer.canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `mesh-avatar-${stamp()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    el.exportResult.hidden = false;
    el.exportResult.classList.remove('is-error');
    el.exportResult.textContent =
      `已导出 ${S.img.width}×${S.img.height} PNG（${S.img.noTransparency ? '保留原背景' : '带透明通道'}），文件名 mesh-avatar-${stamp()}.png`;
  } catch (e) {
    el.exportResult.hidden = false;
    el.exportResult.classList.add('is-error');
    el.exportResult.textContent = '导出失败：' + (e && e.message ? e.message : '未知错误');
  }
});

/* ── 画布尺寸与渲染循环 ── */
function layoutCanvas() {
  if (!S.img || !S.renderer) return;
  const rect = el.canvasWrap.getBoundingClientRect();
  const pad = 28;
  const availW = Math.max(160, rect.width - pad * 2);
  const availH = Math.max(160, rect.height - pad * 2);
  const ar = S.img.width / S.img.height;
  let w = availW, h = availW / ar;
  if (h > availH) { h = availH; w = availH * ar; }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  S.renderer.resize(Math.round(w * dpr), Math.round(h * dpr));
}

let ro = null;
if (typeof ResizeObserver !== 'undefined') {
  ro = new ResizeObserver(() => {
    clearTimeout(ro._t);
    ro._t = setTimeout(() => { layoutCanvas(); }, 80);
  });
  ro.observe(el.canvasWrap);
}

function loop(now) {
  S.raf = requestAnimationFrame(loop);
  if (!S.motion || !S.renderer || !S.rig) return;
  const dt = S.lastT ? Math.min(0.05, (now - S.lastT) / 1000) : 0.016;
  S.lastT = now;
  S.motion.paused = !S.playing;
  const st = S.motion.update(dt);
  if (S.playing) {
    const tDraw = performance.now();
    S.renderer.draw(st, S.rig);
    S.drawAcc += performance.now() - tDraw; S.drawN++;
    if (st.eyeOpen < S.minEye) S.minEye = st.eyeOpen;
    S.fpsN++;
    const nowMs = performance.now();
    if (!S.fpsT0) S.fpsT0 = nowMs;
    if (nowMs - S.fpsT0 >= 500) {
      // 用真实墙钟算帧率，避免 dt 被钳制后失真
      S.fps = (S.fpsN * 1000) / (nowMs - S.fpsT0);
      S.fpsN = 0; S.fpsT0 = nowMs;
    }
    window.__mas = Object.assign(window.__mas || {}, {
      fps: S.fps, state: S.mode, vertices: S.mesh ? S.mesh.stats.vertices : 0,
      mode: S.rig ? S.rig.mode : null,
      eyeOpen: S.motion.state.eyeOpen,
      eyeMin: S.minEye,
      blinks: S.motion.blinkCount,
      drawMs: S.drawN ? +(S.drawAcc / S.drawN).toFixed(2) : 0,
      t: nowMs,
    });
  }
}
requestAnimationFrame(loop);

/* 指针 → 视线 */
el.canvasWrap.addEventListener('pointermove', (e) => {
  if (!S.motion) return;
  const r = el.canvasWrap.getBoundingClientRect();
  S.motion.pointer.x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
  S.motion.pointer.y = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
});
el.canvasWrap.addEventListener('pointerleave', () => {
  if (S.motion) { S.motion.pointer.x = 0; S.motion.pointer.y = 0; }
});

/* ── 空态网格动画：首屏 10 秒内看懂在做什么 ── */
function startEmptyMesh() {
  const c = el.emptyMesh;
  if (!c) return;
  const g = c.getContext('2d');
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const N = 16;
  let t = 0;
  let raf = 0;
  function draw() {
    const w = c.width, h = c.height;
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h * 0.46;
    const t0 = t;
    // 头部轮廓
    g.beginPath();
    g.ellipse(cx, cy, w * 0.135, h * 0.115, 0, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(139,114,255,.55)';
    g.lineWidth = 1.6;
    g.stroke();
    // 网格线（带呼吸起伏）
    for (let j = 0; j <= N; j++) {
      g.beginPath();
      for (let i = 0; i <= N; i++) {
        const x = (i / N) * w;
        const y = (j / N) * h;
        const dx = (x - cx) / (w * 0.3), dy = (y - cy) / (h * 0.3);
        const r = Math.sqrt(dx * dx + dy * dy);
        const wave = Math.sin(t0 * 1.1 + i * 0.55 + j * 0.33) * (4 + r * 6);
        const lift = Math.cos(t0 * 0.9 + i * 0.4) * 5 * Math.exp(-r * 1.4);
        if (i === 0) g.moveTo(x, y + wave - lift); else g.lineTo(x, y + wave - lift);
      }
      g.strokeStyle = 'rgba(61,214,208,.16)';
      g.lineWidth = 1;
      g.stroke();
    }
    for (let i = 0; i <= N; i++) {
      g.beginPath();
      for (let j = 0; j <= N; j++) {
        const x = (i / N) * w;
        const y = (j / N) * h;
        const dx = (x - cx) / (w * 0.3), dy = (y - cy) / (h * 0.3);
        const r = Math.sqrt(dx * dx + dy * dy);
        const wave = Math.cos(t0 * 0.85 + j * 0.5) * (3 + r * 5);
        const lift = Math.sin(t0 * 1.05 + j * 0.35) * 4.5 * Math.exp(-r * 1.5);
        if (j === 0) g.moveTo(x + wave, y - lift); else g.lineTo(x + wave, y - lift);
      }
      g.strokeStyle = 'rgba(139,114,255,.14)';
      g.lineWidth = 1;
      g.stroke();
    }
  }
  function tick() {
    t += 0.016;
    draw();
    raf = requestAnimationFrame(tick);
  }
  if (reduce) { draw(); } else { raf = requestAnimationFrame(tick); }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(raf); } else if (!reduce) { raf = requestAnimationFrame(tick); }
  });
}
startEmptyMesh();

/* ── 启动 ── */
setState('idle');
window.__mas = { fps: 0, state: 'idle', version: '1.0.0' };
