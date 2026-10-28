/* ============================================================
   motion.js — M6 动画驱动：轨道 + 弹簧平滑 + 眨眼状态机
   依据：技术方案 §3.3 全部小节
   ============================================================ */

/** 确定性噪声（避免每帧 random 抖动撕裂画面） */
function hash(n) {
  let x = Math.sin(n) * 43758.5453;
  return x - Math.floor(x);
}

/** 一维值噪声，用于低频漂移 */
function vnoise(t, seed = 0) {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash(i + seed * 57.31);
  const b = hash(i + 1 + seed * 57.31);
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

/** 弹簧平滑器 */
class Spring {
  constructor(stiffness = 120, damping = 0.95) {
    this.k = stiffness;
    this.d = damping;
    this.v = 0;
    this.cur = 0;
    this.target = 0;
    this.init = false;
  }
  step(dt) {
    if (!this.init) { this.cur = this.target; this.init = true; return this.cur; }
    const k = this.k;
    const a = (this.target - this.cur) * k - this.v * (1 - this.d) * Math.sqrt(k) * 2;
    this.v += a * dt;
    this.cur += this.v * dt;
    return this.cur;
  }
}

export class Motion {
  constructor(rig, caps) {
    this.rig = rig;
    this.caps = caps;      // { blink, breath, head, body, strands, gaze }
    this.t = 0;
    this.paused = false;
    this.reduced = false;  // P0-9：系统「减少动态效果」偏好
    this.pointer = { x: 0, y: 0 };   // 指针归一化位置（-1..1）
    this.state = {
      angleX: 0, angleY: 0, angleZ: 0,
      bodyAngleZ: 0,
      breath: 0,
      eyeOpen: 1,
      gazeX: 0, gazeY: 0,
      browY: 0, mouthOpen: 0, blush: 0.18,
    };
    this.spr = {
      angleX: new Spring(55, 0.72),
      angleY: new Spring(55, 0.72),
      angleZ: new Spring(45, 0.75),
      bodyAngleZ: new Spring(14, 0.9),
      gazeX: new Spring(260, 0.9),
      gazeY: new Spring(260, 0.9),
      browY: new Spring(120, 0.95),
      mouthOpen: new Spring(120, 0.95),
    };
    // 眨眼状态机
    this.blinkNext = 1.6 + Math.random() * 2.4;
    this.blinkT = -1;
    this.blinkDur = 0.136;
    this.blinkDouble = false;
    this.blinkCount = 0;
    // P1-02：眨眼计时用真实时钟，不受 dt 夹取影响
    this.lastWall = null;
  }

  /** 幅度缩放（paused 时也照常推进，但不动） */
  setAmplitude(a) { this.amp = a; }

  /** P0-9：跟随系统偏好。减少动态时保留眨眼，关掉呼吸 / 转头 / 身体摆动。 */
  setReducedMotion(on) {
    const v = !!on;
    if (this.reduced === v) return;
    this.reduced = v;
    // 立刻把已经动起来的目标归零，避免残留位移慢慢飘回去
    if (v) {
      this.spr.angleX.target = 0;
      this.spr.angleY.target = 0;
      this.spr.angleZ.target = 0;
      this.spr.bodyAngleZ.target = 0;
      this.spr.gazeX.target = 0;
      this.spr.gazeY.target = 0;
    }
  }

  /** 当前实际启用的效果（供 UI 能力标签使用） */
  effectiveCaps() {
    if (!this.reduced) return { ...this.caps };
    return {
      ...this.caps,
      breath: false,
      head: false,
      body: false,
      strands: false,
      gaze: false,
    };
  }

  update(dt) {
    if (this.paused) {
      // 暂停时也要推进墙钟基准，恢复播放时不会一次性补算
      this.lastWall = null;
      return this.state;
    }
    dt = Math.min(dt, 0.05);
    this.t += dt;
    const t = this.t;
    const reduced = this.reduced;

    // P1-02：眨眼倒计时按真实时间走。
    // 主循环的 dt 被夹到 50ms，掉帧时（例如 15fps）眨眼间隔会被拉长 25% 以上，
    // 实测会出现超过 6s 才眨一次。这里改用 performance.now() 的差值。
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const wallDt = this.lastWall === null ? dt : Math.min(1.0, Math.max(0, (now - this.lastWall) / 1000));
    this.lastWall = now;

    // —— 慢速漂移：转头 ±4°（§3.3 ③ 硬夹取）——
    const nx = vnoise(t * 0.26, 1) - 0.5;
    const ny = vnoise(t * 0.21, 2) - 0.5;
    const rot = vnoise(t * 0.17, 3) - 0.5;

    const headOn = this.caps.head && !reduced;
    this.spr.angleX.target = headOn ? nx * 8.0 : 0;
    this.spr.angleY.target = headOn ? ny * 6.0 : 0;
    this.spr.angleZ.target = headOn ? rot * 7.0 : 0;

    // 身体摆动（原来无条件写入，caps.body 形同虚设；P0-9 一并修掉）——
    const bodyOn = this.caps.body && !reduced;
    this.spr.bodyAngleZ.target = bodyOn ? (vnoise(t * 0.13, 4) - 0.5) * 5.0 : 0;

    // —— 视线：随机微动 + 指针跟随（P1-02 的指针部分，本期一并实现）——
    const px = this.pointer ? this.pointer.x : 0;
    const py = this.pointer ? this.pointer.y : 0;
    const gazeOn = this.caps.gaze && !reduced;
    this.spr.gazeX.target = gazeOn ? (vnoise(t * 0.33, 7) - 0.5) * 0.34 + px * 0.5 : 0;
    this.spr.gazeY.target = gazeOn ? (vnoise(t * 0.29, 8) - 0.5) * 0.26 + py * 0.4 : 0;

    // —— 眨眼（减少动态时保留，只是不眨眼之外的位移都关掉）——
    let eyeOpen = 1;
    if (this.caps.blink) {
      if (this.blinkT < 0) {
        this.blinkNext -= wallDt;
        if (this.blinkNext <= 0) {
          this.blinkT = 0;
          this.blinkDouble = Math.random() < 0.1;
        }
      } else {
        this.blinkT += wallDt;
        const p = this.blinkT / this.blinkDur;
        if (p >= 1) {
          if (this.blinkDouble && this.blinkT < this.blinkDur * 1.9) {
            // 连眨：第二个半程直接复用同一条曲线
            const p2 = (this.blinkT - this.blinkDur) / this.blinkDur;
            eyeOpen = 1 - closeCurve(p2);
          } else {
            this.blinkT = -1;
            this.blinkDouble = false;
            this.blinkCount++;
            // 3–6s 随机间隔（F-07 / P0-09）
            this.blinkNext = 3.0 + Math.random() * 3.0;
          }
        } else {
          eyeOpen = 1 - closeCurve(p);
        }
      }
    }
    this.state.eyeOpen = eyeOpen;

    this.state.angleX = this.spr.angleX.step(dt);
    this.state.angleY = this.spr.angleY.step(dt);
    this.state.angleZ = this.spr.angleZ.step(dt);
    this.state.bodyAngleZ = this.spr.bodyAngleZ.step(dt);
    this.state.gazeX = this.spr.gazeX.step(dt);
    this.state.gazeY = this.spr.gazeY.step(dt);

    // 呼吸：caps.breath 关闭或减少动态时保持一个恒定中值（画面不抖）
    if (this.caps.breath && !reduced) {
      this.state.breath = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 4.2) + 0.06 * (vnoise(t * 0.6, 5) - 0.5);
      this.state.blush = 0.18 + 0.08 * (vnoise(t * 0.3, 6) - 0.5);
    } else {
      this.state.breath = 0.5;
      this.state.blush = 0.18;
    }

    return this.state;
  }

  reset() {
    this.t = 0;
    this.paused = false;
    this.blinkT = -1;
    this.blinkNext = 1.6 + Math.random() * 2.4;
    this.lastWall = null;
    for (const k of Object.keys(this.spr)) {
      this.spr[k].v = 0;
      this.spr[k].cur = 0;
      this.spr[k].target = 0;
      this.spr[k].init = false;
    }
    this.state.eyeOpen = 1;
  }
}

/** 闭眼曲线：下行 45ms 快、上行 ease-out 慢（§3.3 ②） */
function closeCurve(p) {
  if (p <= 0) return 0;
  if (p >= 1) return 0;
  const DOWN = 0.34; // 闭眼段占 34%（≈45ms / 136ms）
  if (p < DOWN) {
    const u = p / DOWN;
    return u * u; // 加速闭合
  }
  const u = (p - DOWN) / (1 - DOWN);
  return 1 - u * u * (3 - 2 * u); // 平滑睁开
}
