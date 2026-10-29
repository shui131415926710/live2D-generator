/* ============================================================
   app.js — 控制器
   把引擎（validate → decode → detect → rig → mesh → motion → renderer）
   接到界面状态机：idle → reading → processing → success | degraded | error
   依据：需求文档 F-01~F-14 / P0-01~P0-16；技术方案 §3.2 M1~M8、§7
   ============================================================ */

import { LIMITS, checkFile, describeBytes } from './engine/validate.js';
import { normalize } from './engine/decode.js';
import { detectFaces, loadLandmarker, detectorState, blockMediaPipeTelemetry } from './engine/detect.js';
import { buildPreciseRig, buildPriorRig, buildMinimalRig } from './engine/rig.js';
import { buildMesh } from './engine/mesh.js';
import { Motion } from './engine/motion.js';
import { Renderer, lidY, EYE_CLOSE_FLOOR } from './engine/renderer.js';
import { buildEyePatch } from './engine/patch.js';

// P1-04：在任何检测逻辑之前装好拦截，确保统计上报请求发不出去。
blockMediaPipeTelemetry();

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
  freezeEyeOpen: null,   // 测试接缝：非空时主循环重绘该 eyeOpen 而不推进动画（仅 ?debug=1 可用）
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
  reduced: false,
};

const SLOW_HINT_MS = 15000;   // P0-15：15 秒未完成给出解释
const HARD_TIMEOUT_MS = 60000; // P0-15：60 秒兜底超时

/* ── P0-9：系统「减少动态效果」偏好 ──────────────────────────
   必须在主循环里真实读取 matchMedia，并监听其变化；
   开启时保留眨眼（PRD 明确要求），关掉呼吸 / 转头 / 身体摆动 / 视线漂移，
   同时把能力标签改成实际启用的那一组，不能让界面继续声称有这些效果。
   ──────────────────────────────────────────────────────── */
const RM_QUERY = '(prefers-reduced-motion: reduce)';
const MQ = (typeof window !== 'undefined' && window.matchMedia)
  ? window.matchMedia(RM_QUERY)
  : null;

function prefersReduced() { return !!(MQ && MQ.matches); }

function applyReducedMotion(on) {
  S.reduced = !!on;
  if (S.motion) S.motion.setReducedMotion(S.reduced);
  // 能力标签同步：减少动态时只剩眨眼
  if (S.caps && (S.mode === 'success' || S.mode === 'degraded')) {
    renderChips(S.reduced ? reducedCaps(S.caps) : S.caps);
  }
  if (S.renderer && S.rig) S.renderer.draw(S.motion ? S.motion.state : S.rig, S.rig);
  window.__mas = Object.assign(window.__mas || {}, {
    reducedMotion: S.reduced,
    reducedQuery: RM_QUERY,
  });
}

/** 减少动态时实际启用的能力：只留眨眼 */
function reducedCaps(caps) {
  return {
    blink: !!caps.blink,
    breath: false,
    head: false,
    body: false,
    strands: false,
    gaze: false,
  };
}

if (MQ) {
  if (typeof MQ.addEventListener === 'function') {
    MQ.addEventListener('change', (e) => applyReducedMotion(e.matches));
  } else if (typeof MQ.addListener === 'function') {
    MQ.addListener((e) => applyReducedMotion(e.matches));
  }
}

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
    clearStage();
  }
}

/**
 * P1-03：把舞台复位到空态。
 * 出错 / 取消 / 重置时必须调用，避免上一张图的画面和标签残留在新状态下。
 */
function clearStage() {
  S.rig = null;
  S.mesh = null;
  S.motion = null;
  S.playing = true;
  S.lastT = 0;
  S.minEye = 1;
  el.canvasWrap.dataset.empty = 'true';
  el.gl.classList.remove('is-live');
  el.stageHint.textContent = '拖入图片开始';
  el.stageMeta.textContent = '';
  if (el.labels) el.labels.innerHTML = '';
  // 画布本身也擦掉，否则 is-live 移除后仍会透出最后一帧
  if (S.renderer && typeof S.renderer.clear === 'function') S.renderer.clear();
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
  // P1-07：按错误类型给针对性建议，不再所有非体积错误都落同一段通用文案
  if (kind === 'size') {
    return [
      '把图片导出时长边压到 2000px 以内，通常就能压到 20 MB 以下。',
      '换成 JPG 或 WebP 格式重新导出，体积会小很多。',
      '如果图本来就不大，可能是文件系统里存的是原图，先用图片工具压缩一次。',
    ];
  }
  if (kind === 'filesize') {
    return [
      '这张图的尺寸（像素）本身没问题，是文件体积太大：先用图片工具另存为 JPG（质量 85 左右）。',
      '或者把长边压到 3000px 以内再拖进来。',
      '带大量图层的 PNG 体积会很大，导出成「扁平化 PNG」也能显著减小。',
    ];
  }
  if (kind === 'small') {
    return [
      '换一张短边至少 256px 的图；太小的话五官定位会失稳。',
      '如果手上只有小图，先用图片工具放大 2 倍再试一次（放大后仍可能不准）。',
      '截图保存时选「原始尺寸」，不要选缩略图。',
    ];
  }
  if (kind === 'faces') {
    return [
      '把角色头部放到画面里更大一些，最好占画面四分之一以上。',
      '换一张正脸、无遮挡的图：侧脸、背影、被手或道具挡住都会让五官定位失准。',
      '多人合影请先裁剪出要用的那一个人，再单独上传。',
    ];
  }
  if (kind === 'count') {
    return [
      '同一张图里有多个面孔时，请只保留主角、裁掉其他人物后再上传。',
      '或者在上传后用选脸面板指定一个主角。',
      '人物占比过小时，先裁剪到以头部为主体。',
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
    // P1-01 / N-2：GIF 只取首帧必须如实说明。
    // 这里用**拼接**而不是覆盖：GIF 几乎必然无 alpha，上一版先写 GIF 提示、
    // 6 行后再被 noTransparency 分支整体覆盖，导致「已取第 1 帧」100% 不可达。
    const gifNote = (img.gifFrameCount && img.gifFrameCount > 1)
      ? `已取第 1 帧（这份 GIF 共 ${img.gifFrameCount} 帧）——本工具只处理静态单帧。`
      : '';
    const alphaNote = img.noTransparency
      ? '这张图没有透明背景，处理后会保留背景；想要透明效果请用带透明通道的 PNG。'
      : '';

    if (img.noTransparency) {
      el.fileStatus.className = 'file-status is-warn';
      el.fileStatus.textContent = '这张图没有透明背景，处理后会保留背景。';
    }
    // 优先级：GIF 帧数（用户最需要知道的「它不会动」）> 无透明 > 降采样说明
    const subs = [gifNote, alphaNote].filter(Boolean);
    if (subs.length) {
      el.progressSub.textContent = subs.join(' ');
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

  /* P0-3：预生成闭眼贴片（每张图一次，纯本地、来自原图自身皮肤）。
     v5 收口：贴片构建阶段先判「眼周可行性」。判不过（头发/深色眼影遮挡、
     供体面积不足、环带无合格肤色）就**整图不启用眨眼**——宁可少一个动画，
     也不要闭眼时露出一块瑕疵椭圆。呼吸/转头/摆动完全不受影响。 */
  let patch = null, guard = null;
  try {
    patch = buildEyePatch(img.bitmap, rig, img.width, img.height);
    guard = patch && patch.guard ? patch.guard : null;
  } catch (e) {
    patch = null; guard = null;
  }
  if (patch && patch.canvas) {
    S.patch = patch;
    S.renderer.setPatch(patch.canvas, patch.rect);
    S.patchInfo = { rect: patch.rect, donor: patch.donor, guard };
  } else {
    S.patch = null;
    S.renderer.setPatch(null, null);
    S.patchInfo = { rect: patch ? patch.rect : null, donor: patch ? patch.donor : null, guard };
  }

  // 闸门结论落到能力表：任一眼不可用 → 整图 blink=false（双眼同步，不出现 wink）
  const eyeGuardOk = !!(guard && guard.feasible);
  if (!eyeGuardOk && caps.blink) {
    caps.blink = false;
    caps.blinkOffReason = (guard && guard.eyes)
      ? guard.eyes.filter((e) => !e.feasible)
        .map((e) => `眼${e.eye}：${e.reasons.join('、')}`).join('；')
      : '眼周遮挡检测未通过';
  }
  S.caps = caps;
  S.eyeGuard = guard;

  S.motion = new Motion(rig, caps);
  // P0-9：从第一帧就应用系统偏好，不要等用户切换一次才生效
  S.motion.setReducedMotion(prefersReduced());
  S.reduced = prefersReduced();
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
    }${caps.blinkOffReason ? ' · 眼周遮挡，未启用眨眼' : ''}`;

  // 眼周遮挡的轻提示（成本低就加）：只在「本来能眨眼、但因为遮挡被关掉」时出现
  el.stageHint.textContent = caps.blinkOffReason ? '眼周有遮挡，已自动不启用眨眼' : '';

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

/* ── 能力标签：只列实际启用的（showResult 与减少动态切换共用） ── */
function renderChips(caps) {
  el.labels.innerHTML = '';
  const order = ['blink', 'breath', 'head', 'body', 'gaze'];
  for (const k of order) {
    if (!caps[k]) continue;
    const b = document.createElement('span');
    b.className = 'label-chip';
    b.textContent = CHIP_TEXT[k];
    el.labels.appendChild(b);
  }
  // 减少动态时明确告知用户少了什么，避免「标签变少了但不知道为什么」
  if (S.reduced) {
    const note = document.createElement('span');
    note.className = 'label-chip label-chip-note';
    note.textContent = '已按系统偏好减少动态';
    el.labels.appendChild(note);
  }
}

/* ── 结果页 ── */
function showResult(rig, caps, img, degraded) {
  setState(degraded ? 'degraded' : 'success');

  el.statusPill.textContent = degraded ? '已降级生成' : '已生成';
  el.statusPill.classList.toggle('is-degraded', !!degraded);

  // 能力标签：只列实际启用的（减少动态时用缩减后的那一组）
  renderChips(S.reduced ? reducedCaps(caps) : caps);

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
  // N-1（P1）：与 PDF 等通用错误路径**完全一致**地复位。
  // 上一版这里直接 setState('error')，没有 clearStage()、也没有焦点转移：
  // 先成功生成一张图、再拖入风景图时，右侧画布仍在播上一张图的动画、
  // 能力标签仍为 5 项、stage-meta 仍是上一张图、data-empty 仍为 false、
  // 焦点停在 BODY（读屏不播报）。这同时是 P0-8「部分关闭」的原因。
  clearStage();
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
  // N-1 / P0-8：焦点落到错误标题（tabindex=-1，role=alert 容器内），读屏立即播报
  requestAnimationFrame(() => {
    const h = el.panelError && el.panelError.querySelector('#h-error');
    if (h && typeof h.focus === 'function') h.focus();
  });
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
  // P1-03：出错时清掉上一张图残留的舞台内容与能力标签。
  // 否则错误面板已经出现，右侧画布还在播上一张图，用户会以为这张图生成成功了。
  clearStage();
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
  // P0-8：错误面板是 role="alert"，把焦点也移过去，读屏软件才能立即播报内容。
  // 焦点落在标题（tabindex=-1）上，紧接着的正文与建议列表会一起被读出来。
  requestAnimationFrame(() => {
    const h = el.panelError && el.panelError.querySelector('#h-error');
    if (h && typeof h.focus === 'function') h.focus();
  });
}

function handlePipelineError(err) {
  if (err && err.code === 'E_ABORT') return;   // 用户主动取消，界面已复位
  stopTimer();
  const isTimeout = err && err.code === 'E_TIMEOUT';
  const isSmall = err && err.code === 'E_SMALL';
  const msg = err && err.message ? err.message : '发生了未知错误。';
  showError(msg, isTimeout
    ? [
        '换一台性能更好的设备再试一次。',
        '把图片缩小一些（长边 1000px 左右通常就够用了）。',
        '关掉其他占资源的标签页，然后重新上传。',
      ]
    : isSmall
      ? adviceFor('small')
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

/* ── 导出 PNG（P0-14 / P0-1 修复） ── */
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
      exportRenderer = new Renderer(document.createElement('canvas'));
    }
    // P0-1：纹理与网格每次导出都要重绑。
    // 原来这两行写在 if (!exportRenderer) 里，只在该 Renderer 第一次创建时绑定，
    // 换图后导出拿到的仍是上一张图的纹理与网格。
    exportRenderer.setImage(S.img.bitmap, S.img.width, S.img.height);
    exportRenderer.setMesh(S.mesh);
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
  // 测试接缝：定格到指定 eyeOpen 后只重绘、不推进动画（仅 ?debug=1 时可用）
  if (S.freezeEyeOpen !== null && S.freezeEyeOpen !== undefined) {
    S.motion.paused = true;
    S.motion.state.eyeOpen = S.freezeEyeOpen;
    S.renderer.draw(S.motion.state, S.rig);
    window.__mas = Object.assign(window.__mas || {}, {
      eyeOpen: S.freezeEyeOpen, state: S.mode, mode: S.rig.mode, frozen: true,
    });
    return;
  }
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
      reducedMotion: S.reduced,
      breath: S.motion.state.breath,
      bodyAngleZ: S.motion.state.bodyAngleZ,
      angleX: S.motion.state.angleX,
      angleY: S.motion.state.angleY,
      // 测量用几何：眼区椭圆与眉的位置（供外部脚本裁 ROI、核对睑线 y，不改变渲染）
      geo: S.rig ? {
        img: [S.img.width, S.img.height],
        canvas: [S.renderer.drawW, S.renderer.drawH],
        eyeA: [S.rig.face.eyeA.cx, S.rig.face.eyeA.cy, S.rig.face.eyeA.rx, S.rig.face.eyeA.ry],
        eyeB: [S.rig.face.eyeB.cx, S.rig.face.eyeB.cy, S.rig.face.eyeB.rx, S.rig.face.eyeB.ry],
        brow: [S.rig.face.brow.cx, S.rig.face.brow.cy, S.rig.face.brow.rx, S.rig.face.brow.ry],
        eyeDist: S.rig.face.eyeDist,
      } : null,
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

/* 测试接缝：仅在 ?debug=1 时挂载，用于把动画定格到指定 eyeOpen 后取帧。
   生产环境不暴露任何改写入口。 */
if (typeof location !== 'undefined' && /[?&]debug=1\b/.test(location.search)) {
  /* 全分辨率抓帧探针：**不暂停、不改状态**，只把「此刻正在播放的这一帧」
     按原图分辨率重绘到离屏画布并返回 PNG。
     用于以真实动画帧（而不是定格帧）做闭眼质量量化。 */
  let probeRenderer = null;
  let fullRenderer = null;

  /* 低成本抓帧：直接从屏幕上正在显示的那块画布取像素（不重绘、不暂停、不改状态）。
     用于以接近原生帧率连续采样真实动画帧。 */
  window.__masProbe = {
    shot() {
      if (!S.renderer || !S.motion) return null;
      const src = S.renderer.canvas;
      const c = document.createElement('canvas');
      c.width = src.width; c.height = src.height;
      const g = c.getContext('2d');
      g.drawImage(src, 0, 0);
      return {
        eyeOpen: +(+S.motion.state.eyeOpen).toFixed(4),
        w: c.width, h: c.height,
        png: c.toDataURL('image/png'),
        fps: +(+S.fps).toFixed(1),
        blinks: S.motion.blinkCount,
        playing: S.playing,
        frozen: S.freezeEyeOpen,
      };
    },
    /* 全分辨率抓帧（原图分辨率）。贵（SwiftShader 填充率限制），只在需要定格取证时调用。 */
    /* 睁眼零回归对照：同图 / 同帧 / 同尺寸，唯一差别是「有没有贴片」。
       返回两张整幅 PNG，diff 由外部脚本逐像素比对。 */
    fullCompare(open) {
      if (!S.renderer || !S.rig || !S.img || !S.motion) return null;
      const W = S.img.width, H = S.img.height;
      const mk = (withPatch) => {
        const c = document.createElement('canvas');
        const r = new Renderer(c);
        r.setImage(S.img.bitmap, W, H);
        r.setMesh(S.mesh);
        // 贴片真正参与渲染的最大开启度必须覆盖被测值：直接按 eyeOpen 算 mix
        // 这里用同一个 setPatch / 不 setPatch 区分，逻辑完全一致
        if (withPatch && S.patch) r.setPatch(S.patch.canvas, S.patch.rect);
        r.resize(W, H);
        return { c, r };
      };
      const st = Object.assign({}, S.motion.state, { eyeOpen: Number(open) });
      const A = mk(true), B = mk(false);
      A.r.draw(st, S.rig);
      B.r.draw(st, S.rig);
      return {
        eyeOpen: +Number(open).toFixed(4),
        a: A.c.toDataURL('image/png'),
        b: B.c.toDataURL('image/png'),
        img: [W, H],
      };
    },
    full(opt) {
      if (!S.renderer || !S.rig || !S.img || !S.motion) return null;
      const o = opt || {};
      if (!fullRenderer) fullRenderer = new Renderer(document.createElement('canvas'));
      if (fullRenderer.imageId !== S.renderer.imageId) {
        fullRenderer.setImage(S.img.bitmap, S.img.width, S.img.height);
      }
      if (fullRenderer.meshVersion !== S.renderer.meshVersion) {
        fullRenderer.setMesh(S.mesh);
      }
      if (S.patch && fullRenderer.patchVersion !== S.renderer.patchVersion) {
        fullRenderer.setPatch(S.patch.canvas, S.patch.rect);
      }
      fullRenderer.resize(S.img.width, S.img.height);
      fullRenderer.draw(S.motion.state, S.rig);

      const full = fullRenderer.canvas;
      // ROI 必须覆盖**双眼并集**。旧实现只按 eyeA 计算（padX=1.7*rxA），
      // 眼 B 在 cx=748.9 时右半边被 ROI 硬切 → 量到的是"半椭圆"，
      // 这是测量口子的缺陷，不是渲染缺陷（历史误判来源之一）。
      const eA = S.rig.face.eyeA, eB = S.rig.face.eyeB;
      const padX = (o.padX !== undefined ? o.padX : 3.4);
      const padY = (o.padY !== undefined ? o.padY : 1.5);
      const x0 = Math.max(0, Math.round(Math.min(eA.cx - padX * eA.rx, eB.cx - padX * eB.rx)));
      const y0 = Math.max(0, Math.round(Math.min(eA.cy - padY * eA.ry, eB.cy - padY * eB.ry)));
      const x1 = Math.min(S.img.width, Math.round(Math.max(eA.cx + padX * eA.rx, eB.cx + padX * eB.rx)));
      const y1 = Math.min(S.img.height, Math.round(Math.max(eA.cy + padY * eA.ry, eB.cy + padY * eB.ry)));
      const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.drawImage(full, x0, y0, w, h, 0, 0, w, h);
      return {
        eyeOpen: +(+S.motion.state.eyeOpen).toFixed(4),
        roi: [x0, y0, w, h],
        png: c.toDataURL('image/png'),
        geo: {
          img: [S.img.width, S.img.height],
          eyeA: [S.rig.face.eyeA.cx, S.rig.face.eyeA.cy, S.rig.face.eyeA.rx, S.rig.face.eyeA.ry],
          eyeB: [S.rig.face.eyeB.cx, S.rig.face.eyeB.cy, S.rig.face.eyeB.rx, S.rig.face.eyeB.ry],
          brow: [S.rig.face.brow.cx, S.rig.face.brow.cy, S.rig.face.brow.rx, S.rig.face.brow.ry],
          chinY: S.rig.face.chinY,
        },
      };
    },
    /* 顶点级探针：把 eyeA/eyeB 权重 >0.001 的顶点在「压缩前 / 压缩后」的 y 范围读出来，
       直接证明几何压缩到底压了多少，不依赖任何像素推断。 */
    eyeVertices(open) {
      if (!S.rig || !S.mesh || !S.renderer) return null;
      const R = S.renderer;
      const mesh = S.mesh;
      // 用冻结值重画一帧（只影响本次读数，不改真实播放）
      const prev = S.freezeEyeOpen;
      window.__masDebug.freezeEye(open);
      const b = mesh.bake, rest = mesh.rest, pos = mesh.pos;
      const out = { eyeOpen: open, eyes: {} };
      for (const key of ['A', 'B']) {
        const kk = key === 'A' ? b.kEyeA : b.kEyeB;
        const eye = key === 'A' ? S.rig.face.eyeA : S.rig.face.eyeB;
        // 分权重档统计：w≥0.9（睑裂核心，虹膜就在这一档）、w≥0.5、w>0.001（含边界）
        const bands = { core: { w: 0.9 }, mid: { w: 0.5 }, any: { w: 0.001 } };
        for (const kk2 of Object.keys(bands)) {
          bands[kk2].rMin = 1e9; bands[kk2].rMax = -1e9;
          bands[kk2].pMin = 1e9; bands[kk2].pMax = -1e9; bands[kk2].n = 0;
        }
        let cnt = 0, wMax = 0;
        for (let k = 0; k < mesh.n; k++) {
          const w = kk[k];
          if (!(w > 0.001)) continue;
          cnt++;
          if (w > wMax) wMax = w;
          const y0 = rest[k * 2 + 1];
          const y1 = pos[k * 2 + 1];
          for (const kk2 of Object.keys(bands)) {
            if (w < bands[kk2].w) continue;
            const B2 = bands[kk2];
            B2.n++;
            if (y0 < B2.rMin) B2.rMin = y0;
            if (y0 > B2.rMax) B2.rMax = y0;
            if (y1 < B2.pMin) B2.pMin = y1;
            if (y1 > B2.pMax) B2.pMax = y1;
          }
        }
        const summarize = (B2) => (B2.n === 0 ? null : {
          n: B2.n,
          restSpan: +(B2.rMax - B2.rMin).toFixed(1),
          defSpan: +(B2.pMax - B2.pMin).toFixed(1),
          ratio: +(defSpanOf(B2)).toFixed(3),
        });
        function defSpanOf(B2) {
          const rs = B2.rMax - B2.rMin;
          return rs > 0 ? (B2.pMax - B2.pMin) / rs : 0;
        }
        const rMin = bands.any.rMin, rMax = bands.any.rMax;
        const pMin = bands.any.pMin, pMax = bands.any.pMax;
        out.eyes[key] = {
          n: cnt, wMax: +wMax.toFixed(4),
          restY: [+rMin.toFixed(1), +rMax.toFixed(1)],
          defY: [+pMin.toFixed(1), +pMax.toFixed(1)],
          core: summarize(bands.core),
          mid: summarize(bands.mid),
          lidY: +lidY(eye, open).toFixed(1),
        };
      }
      out.floor = EYE_CLOSE_FLOOR;
      if (prev === null || prev === undefined) window.__masDebug.resumeEye();
      else window.__masDebug.freezeEye(prev);
      return out;
    },
    patch() {
      if (!S.patchInfo) return null;
      const base = {
        rect: S.patchInfo.rect,
        donor: S.patchInfo.donor,
        guard: S.patchInfo.guard || null,
        hasCanvas: !!(S.patch && S.patch.canvas),
      };
      if (!S.patch || !S.patch.canvas) return { ...base, url: null, w: 0, h: 0 };
      return {
        ...base,
        url: S.patch.canvas.toDataURL('image/png'),
        w: S.patch.canvas.width, h: S.patch.canvas.height,
      };
    },
    geom() {
      if (!S.rig) return null;
      return {
        img: [S.img.width, S.img.height],
        canvas: [S.renderer.drawW, S.renderer.drawH],
        eyeA: [S.rig.face.eyeA.cx, S.rig.face.eyeA.cy, S.rig.face.eyeA.rx, S.rig.face.eyeA.ry],
        eyeB: [S.rig.face.eyeB.cx, S.rig.face.eyeB.cy, S.rig.face.eyeB.rx, S.rig.face.eyeB.ry],
        brow: [S.rig.face.brow.cx, S.rig.face.brow.cy, S.rig.face.brow.rx, S.rig.face.brow.ry],
      };
    },
  };
  window.__masDebug = {
    freezeEye(open) {
      if (!S.motion || !S.renderer || !S.rig) return null;
      S.freezeEyeOpen = Number(open);
      S.motion.paused = true;
      S.motion.state.eyeOpen = S.freezeEyeOpen;
      S.renderer.draw(S.motion.state, S.rig);
      return { eyeOpen: S.freezeEyeOpen, mode: S.rig.mode };
    },
    resumeEye() {
      S.freezeEyeOpen = null;
      if (!S.motion) return null;
      S.motion.paused = false;
      return { frozen: null };
    },
    /* 测试接缝：把除 eyeOpen 之外的全部动效量钉成常量。
       没有它时，sweep 取帧间头部角度/呼吸/注视仍在变，
       同一份代码多次取帧的接缝数在 0/1/3 与 10/15/23 之间跳，无法作基线。 */
    /* 取证：读回 renderer 本次实际写入 shader 的睑线 uniform（uLidA/uLidB/uClose/uLidW）。
       判据③ 要求记录 lidY 在 eyeOpen=1/0.6/0.3/0.1/0 的取值，这里取的就是实际生效值，
       不是旁边再算一遍公式。 */
    lidUniform() {
      if (!S.renderer || !S.renderer.lastLid) return null;
      const p = S.renderer.lastLid;
      return {
        eyeOpen: p.eyeOpen, lidA: Number(p.lidA.toFixed(3)), lidB: Number(p.lidB.toFixed(3)),
        close: Number(p.close.toFixed(3)), lidW: p.lidW,
        cyA: S.rig.face.eyeA.cy, cyB: S.rig.face.eyeB.cy,
        ryA: S.rig.face.eyeA.ry, ryB: S.rig.face.eyeB.ry,
        theoreticalA: Number((S.rig.face.eyeA.cy + S.rig.face.eyeA.ry * (1/1.35) * (1 - 2 * p.eyeOpen)).toFixed(3)),
        theoreticalB: Number((S.rig.face.eyeB.cy + S.rig.face.eyeB.ry * (1/1.35) * (1 - 2 * p.eyeOpen)).toFixed(3)),
      };
    },
    freezeMotion(vals) {
      if (!S.motion || !S.renderer || !S.rig) return null;
      const v = vals || {};
      const st = S.motion.state;
      for (const k of ['angleX', 'angleY', 'angleZ', 'bodyAngleZ',
                       'breath', 'gazeX', 'gazeY', 'browY', 'mouthOpen']) {
        if (v[k] !== undefined) st[k] = Number(v[k]);
      }
      S.motion.paused = true;
      S.renderer.draw(st, S.rig);
      return { state: Object.assign({}, st) };
    },
  };
}
