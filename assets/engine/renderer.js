/* ============================================================
   renderer.js — M7 CPU 变形 + WebGL2 渲染
   依据：技术方案 §2.3（WebGL2 原生、premultiplied alpha）、
        §3.3 ②（眼区压缩 + 片元眼睑遮罩）、§3.4（单层方案）
   ============================================================ */

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUV;
uniform vec2 uRes;
out vec2 vUV;
out vec2 vLocal;
void main() {
  vUV = aUV;
  vLocal = aPos;
  vec2 p = aPos / uRes;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec2 vLocal;
uniform sampler2D uTex;
uniform vec2 uImgSize;
uniform vec4 uEyeA;      // cx, cy, rx, ry (像素)
uniform vec4 uEyeB;
uniform float uEyeOpen;  // 1 = 全开
uniform float uHasEyes;
uniform vec2 uGaze;      // -1..1
uniform float uBlush;
uniform vec4 uBlushA;    // 位置/半径
uniform vec4 uBlushB;
// P0-3：睑线固定采样行（UV，0..1）与该区域的中位皮肤色兜底
uniform float uSkinRowA;
uniform float uSkinRowB;
uniform vec3  uSkinFallbackA;
uniform vec3  uSkinFallbackB;
uniform float uLidAlpha;   // 睑缘线强度（随闭合淡入）
out vec4 outColor;

// 睑线位置：全开时在眼睛上缘（不遮）；闭合时下移到 cy+0.25·ry，
// 即「上下眼睑合拢的位置」落在眼区偏下——而不是残留到最底边。
float lidLine(vec4 eye, float open) {
  return (eye.y - eye.w) + eye.w * 1.25 * (1.0 - open);
}

// 遮罩内的皮肤色：用 CPU 从「眼下脸颊带」估出的稳定肤色。
// 这里刻意不采纹理：眼区片元被纵向压缩过，vLocal 与 vUV 已不同步，
// 逐片元采样会把压缩后的行映射回原纹理，形成纵向涂抹条带或竖条纹。
// 闭眼后该区域本就是平整皮肤，纯色 + 边缘羽化 + 睑缘线的观感才对。
vec3 skinPatch(vec3 fb) {
  return fb;
}

vec3 eyelidMask(vec3 col, vec4 eye, float open, float rowV, vec3 fb) {
  vec2 d = (vLocal - eye.xy) / eye.zw;
  float r2 = d.x * d.x + d.y * d.y;
  // 羽化宽度：按图像像素折算到归一化半径，保证任何尺寸下都是 2~3px 的软边
  float feather = 2.6 / max(1.0, min(eye.z, eye.w));
  if (r2 > 1.0 + feather) return col;

  float closeAmt = 1.0 - open;   // 0 = 全开，1 = 闭合
  float lid = lidLine(eye, open);

  // ① 上眼睑下压：睑线以上的部分被皮肤盖住（2.6px 软边，去掉硬切线）
  float lidCover = 1.0 - smoothstep(lid - 2.6, lid + 2.6, vLocal.y);

  // ② 接近完全闭合时，整只眼椭圆都被眼睑覆盖（虹膜/眼白不残留），
  //    只留下沿睑线的一条深色睑缘线。椭圆边缘同样羽化，避免出现矩形直角。
  float ellipse = 1.0 - smoothstep(1.0 - feather, 1.0 + feather, r2);
  float fullCover = ellipse * smoothstep(0.62, 0.95, closeAmt);

  float covered = clamp(max(lidCover, fullCover), 0.0, 1.0);
  if (covered <= 0.002) return col;

  vec3 skin = skinPatch(fb);

  // ③ 睑缘线：沿睑线画一条 1~2 px 的深色线，上下眼睑由此合拢成一条连续线
  float line = 1.0 - smoothstep(0.8, 2.0, abs(vLocal.y - lid));
  float lineA = clamp(line * uLidAlpha, 0.0, 0.9);
  vec3 lash = mix(skin * 0.18, vec3(0.09, 0.07, 0.07), 0.6);
  skin = mix(skin, lash, lineA);

  return mix(col, skin, covered);
}

void main() {
  vec2 uv = vUV;
  vec4 t = texture(uTex, uv);
  // 纹理按直通 alpha 存储；几乎全透明的片元直接丢弃（保留轮廓边缘的原始 alpha）
  if (t.a < 0.02) discard;
  vec3 col = t.rgb;
  float alpha = t.a;

  // 视线：眼白/瞳孔采样点轻微偏移（§3.3 ⑥）
  if (uHasEyes > 0.5 && uEyeOpen > 0.02) {
    vec4 e = (d2(vLocal, uEyeA) < d2(vLocal, uEyeB)) ? uEyeA : uEyeB;
    vec2 d = (vLocal - e.xy) / e.zw;
    float r2 = d.x * d.x + d.y * d.y;
    if (r2 < 1.0) {
      float fall = sqrt(max(0.0, 4.0 * (1.0 - r2)));
      vec2 off = uGaze * vec2(e.z, e.w) * 0.16 * fall;
      vec2 gUV = clamp(uv + off / uImgSize, vec2(0.0), vec2(1.0));
      vec4 g = texture(uTex, gUV);
      if (g.a > 0.05) { col = g.rgb; alpha = max(alpha, g.a); }
    }
  }

  // 眼睑遮罩
  if (uHasEyes > 0.5 && uEyeOpen < 0.995) {
    col = eyelidMask(col, uEyeA, uEyeOpen, uSkinRowA, uSkinFallbackA);
    col = eyelidMask(col, uEyeB, uEyeOpen, uSkinRowB, uSkinFallbackB);
  }

  // 腮红：两个高斯红晕（§3.3 ⑦）
  if (uBlush > 0.001) {
    vec2 pa = (vLocal - uBlushA.xy) / uBlushA.zw;
    vec2 pb = (vLocal - uBlushB.xy) / uBlushB.zw;
    float ba = exp(-(pa.x*pa.x + pa.y*pa.y) * 1.6);
    float bb = exp(-(pb.x*pb.x + pb.y*pb.y) * 1.6);
    float amt = (ba + bb) * uBlush;
    col = mix(col, vec3(1.0, 0.62, 0.63), clamp(amt * 0.16, 0.0, 0.22));
  }

  // 预乘输出（上下文 premultipliedAlpha=true，混合函数 ONE / ONE_MINUS_SRC_ALPHA）
  outColor = vec4(col * alpha, alpha);
}`;

// 上面用到的辅助函数单独注入，避免 GLSL 里前置声明问题
const FS_PATCH = `
float d2(vec2 p, vec4 e) {
  vec2 d = (p - e.xy) / max(e.zw, vec2(0.001));
  return d.x * d.x + d.y * d.y;
}
`;

/** P0-3：闭眼时眼区最多压缩到原高度的 62%（0.55~0.7 区间内取值） */
const EYE_CLOSE_FLOOR = 0.62;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('E_NO_WEBGL');
    this.gl = gl;

    this.prog = this.buildProgram(VS, FS.replace('void main()', FS_PATCH + '\nvoid main()'));
    this.u = {
      res: gl.getUniformLocation(this.prog, 'uRes'),
      imgSize: gl.getUniformLocation(this.prog, 'uImgSize'),
      eyeA: gl.getUniformLocation(this.prog, 'uEyeA'),
      eyeB: gl.getUniformLocation(this.prog, 'uEyeB'),
      eyeOpen: gl.getUniformLocation(this.prog, 'uEyeOpen'),
      hasEyes: gl.getUniformLocation(this.prog, 'uHasEyes'),
      gaze: gl.getUniformLocation(this.prog, 'uGaze'),
      blush: gl.getUniformLocation(this.prog, 'uBlush'),
      blushA: gl.getUniformLocation(this.prog, 'uBlushA'),
      blushB: gl.getUniformLocation(this.prog, 'uBlushB'),
      skinRowA: gl.getUniformLocation(this.prog, 'uSkinRowA'),
      skinRowB: gl.getUniformLocation(this.prog, 'uSkinRowB'),
      skinFbA: gl.getUniformLocation(this.prog, 'uSkinFallbackA'),
      skinFbB: gl.getUniformLocation(this.prog, 'uSkinFallbackB'),
      lidAlpha: gl.getUniformLocation(this.prog, 'uLidAlpha'),
    };

    this.vao = gl.createVertexArray();
    this.posBuf = gl.createBuffer();
    this.uvBuf = gl.createBuffer();
    this.idxBuf = gl.createBuffer();
    this.tex = gl.createTexture();

    this.mesh = null;
    this.texW = 0; this.texH = 0;
    this.drawW = 0; this.drawH = 0;
    this.srcBitmap = null;
    this.skinCache = null;   // P0-3：睑线采样行 + 中位皮肤色（按 rig 缓存一次）
  }

  /**
   * P0-3：为一只眼算出「睑线固定采样行」和「区域中位皮肤色」。
   * 采样行取眼睛椭圆上缘再往上 15% ry 的位置（一定是皮肤带，不会落进虹膜），
   * 中位色取该行横向 9 个点的逐通道中位数，跳过透明像素。
   */
  skinSampleFor(eye) {
    // P0-3：闭眼后覆盖区的颜色必须与「眼睛周围的皮肤」一致，
    // 所以取样区域就是眼睛左右两侧、与眼同高的皮肤环带（排除眼椭圆本身）。
    // 之前取眉毛行 -> 偏白偏粉；取眼下高光带 -> 过亮（实测 203 vs 周围 134）。
    // 现在取侧环带 + 先按亮度剔除最暗 30%（镜框/睫毛）再取中位。
    const W = this.texW, H = this.texH;
    if (!W || !H) return { row: 0.5, fb: [0.86, 0.73, 0.66] };
    const rowV = Math.max(0, Math.min(1, (eye.cy + eye.ry * 1.9) / H));
    let fb = null;
    const bmp = this.srcBitmap;
    if (bmp) {
      try {
        const cols = [];
        // 左右各取一条竖带：0.95rx~1.55rx 之外，避开眼角和镜框内缘
        const y0 = Math.max(0, Math.round(eye.cy - eye.ry * 0.55));
        const y1 = Math.min(H - 1, Math.round(eye.cy + eye.ry * 1.55));
        const bh = Math.max(1, y1 - y0 + 1);
        for (const side of [-1, 1]) {
          const xa = eye.cx + side * eye.rx * 0.95;
          const xb = eye.cx + side * eye.rx * 1.55;
          const x0 = Math.max(0, Math.round(Math.min(xa, xb)));
          const x1 = Math.min(W - 1, Math.round(Math.max(xa, xb)));
          const bw = Math.max(1, x1 - x0 + 1);
          const cvs = document.createElement('canvas');
          cvs.width = bw; cvs.height = bh;
          const g = cvs.getContext('2d', { willReadFrequently: true });
          g.drawImage(bmp, x0, y0, bw, bh, 0, 0, bw, bh);
          cols.push(g.getImageData(0, 0, bw, bh).data);
        }
        const rs = [], gs = [], bs = [], lums = [];
        for (const data of cols) {
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 200) continue;
            const r = data[i], gg = data[i + 1], b = data[i + 2];
            lums.push(0.299 * r + 0.587 * gg + 0.114 * b);
            rs.push(r); gs.push(gg); bs.push(b);
          }
        }
        if (rs.length >= 12) {
          const sorted = lums.slice().sort((a, b) => a - b);
          const cut = sorted[Math.floor(sorted.length * 0.30)];
          const fr = [], fg = [], fbn = [];
          for (let i = 0; i < rs.length; i++) {
            if (lums[i] < cut) continue;
            fr.push(rs[i]); fg.push(gs[i]); fbn.push(bs[i]);
          }
          const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1] / 255; };
          const src = fr.length >= 8 ? [fr, fg, fbn] : [rs, gs, bs];
          fb = [med(src[0]), med(src[1]), med(src[2])];
        }
      } catch { /* tainted canvas 等情况：直接用默认肤色 */ }
    }
    if (!fb) fb = [0.86, 0.73, 0.66];
    return { row: rowV, fb };
  }

  ensureSkin(rig) {
    if (this.skinCache && this.skinCache.rig === rig && this.skinCache.w === this.texW) return this.skinCache;
    this.skinCache = {
      rig, w: this.texW,
      a: this.skinSampleFor(rig.face.eyeA),
      b: this.skinSampleFor(rig.face.eyeB),
    };
    return this.skinCache;
  }

  buildProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        throw new Error('E_SHADER: ' + log + '\n' + src);
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('E_LINK: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  setImage(bitmap, W, H) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    // 纹理按「直通 alpha」存储，预乘在片元着色器里做（避免 ImageBitmap 预乘状态歧义）
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texW = W; this.texH = H;
    this.srcBitmap = bitmap;
    this.skinCache = null;
    this.textureVersion = (this.textureVersion || 0) + 1;
    this.imageId = (this.imageId || 0) + 1;
  }

  setMesh(mesh) {
    const gl = this.gl;
    this.mesh = mesh;
    this.meshVersion = (this.meshVersion || 0) + 1;
    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.rest, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.tris, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  /**
   * 变形并绘制一帧。
   * @param {object} st MotionState
   */
  draw(st, rig) {
    const gl = this.gl;
    const mesh = this.mesh;
    if (!mesh) return;

    const b = mesh.bake;
    const rest = mesh.rest;
    const pos = mesh.pos;
    const n = mesh.n;

    const head = rig.head;
    const body = rig.body;
    const face = rig.face;

    // 预计算标量
    const ax = st.angleX / 30;          // 归一化到 -1..1
    const ay = st.angleY / 30;
    const az = st.angleZ / 30;
    const bz = st.bodyAngleZ / 10;
    const breath = st.breath;
    const eyeOpen = st.eyeOpen;

    const shiftX = head.shiftX;
    const shiftY = head.shiftY;
    const hpX = head.pivotX, hpY = head.pivotY;
    const maxRoll = head.maxRoll;
    const bpX = body.pivotX, bpY = body.pivotY;
    const bMaxRoll = body.maxRoll;
    const chestCx = body.chest.cx;

    const rollA = -az * maxRoll;
    const bodyRollA = -bz * bMaxRoll;

    // 眼区：睑线位置（像素）
    const lidA = face.eyeA.cy + face.eyeA.ry - (face.eyeA.cy + face.eyeA.ry - (face.eyeA.cy - face.eyeA.ry)) * eyeOpen;
    const lidB = face.eyeB.cy + face.eyeB.ry - (face.eyeB.cy + face.eyeB.ry - (face.eyeB.cy - face.eyeB.ry)) * eyeOpen;

    for (let k = 0; k < n; k++) {
      const i2 = k * 2;
      const x = rest[i2];
      const y = rest[i2 + 1];
      let px = x;
      let py = y;

      // ① 呼吸
      py -= breath * (5 * b.kBreath[k] + 4 * b.kShoulder[k]);
      px += (x - chestCx) * 0.012 * breath * b.kChest[k];

      // ② 转头（局部位移场）
      px += ax * shiftX * b.kTurn[k];
      py -= ay * shiftY * b.kTurn[k];

      // ③ 歪头：绕颈部支点的刚体旋转（权重控制）
      const wR = b.kRoll[k];
      if (wR > 0.001) {
        const dx = px - hpX;
        const dy = py - hpY;
        const a = rollA * wR;
        const ca = Math.cos(a), sa = Math.sin(a);
        px = hpX + dx * ca - dy * sa;
        py = hpY + dx * sa + dy * ca;
      }

      // ④ 身体摆动：绕下方支点小角度旋转
      const wB = b.kBodyRoll[k];
      if (wB > 0.001) {
        const dx = px - bpX;
        const dy = py - bpY;
        const a = bodyRollA * wB;
        const ca = Math.cos(a), sa = Math.sin(a);
        px = bpX + dx * ca - dy * sa;
        py = bpY + dx * sa + dy * ca;
      }

      // ⑤ 眼区纵向压缩（顶点层面）
      //    睑线：open=1 → 眼上缘；open=0 → 眼下缘
      //    P0-3 修复：压缩下限由 0.12 提到 0.62。原来闭合时整条眼区被压到 12% 高、
      //    纹理 UV 不变，等于把眼睛内容纵向拉伸约 8×，形成竖向涂抹条带。
      //    现在只做温和压缩（最紧 0.62），剩下的「不该看见的部分」交给片元遮罩盖住。
      if (b.kEyeA[k] > 0.5) {
        const top = face.eyeA.cy - face.eyeA.ry;
        const bot = face.eyeA.cy + face.eyeA.ry;
        const lid = bot - (bot - top) * eyeOpen;
        const k = EYE_CLOSE_FLOOR + (1 - EYE_CLOSE_FLOOR) * eyeOpen;
        if (py < lid) py = lid - (lid - py) * k;
        else py = lid + (py - lid) * k;
      }
      if (b.kEyeB[k] > 0.5) {
        const top = face.eyeB.cy - face.eyeB.ry;
        const bot = face.eyeB.cy + face.eyeB.ry;
        const lid = bot - (bot - top) * eyeOpen;
        const k = EYE_CLOSE_FLOOR + (1 - EYE_CLOSE_FLOOR) * eyeOpen;
        if (py < lid) py = lid - (lid - py) * k;
        else py = lid + (py - lid) * k;
      }

      // ⑥ 眉 / 鼻 / 嘴 / 下颌
      py -= st.browY * 3.0 * b.kBrow[k];
      py -= st.mouthOpen * 4.0 * b.kMouth[k];
      py += st.mouthOpen * 2.0 * b.kJaw[k];

      pos[i2] = px;
      pos[i2 + 1] = py;
    }

    // 上传
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);

    gl.viewport(0, 0, this.drawW, this.drawH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(gl.getUniformLocation(this.prog, 'uTex'), 0);

    // uRes 用「图像尺寸」做归一化，画布后备缓冲可以独立缩放（等比）
    gl.uniform2f(this.u.res, this.texW, this.texH);
    gl.uniform2f(this.u.imgSize, this.texW, this.texH);
    gl.uniform4f(this.u.eyeA, face.eyeA.cx, face.eyeA.cy, face.eyeA.rx, face.eyeA.ry);
    gl.uniform4f(this.u.eyeB, face.eyeB.cx, face.eyeB.cy, face.eyeB.rx, face.eyeB.ry);
    gl.uniform1f(this.u.eyeOpen, eyeOpen);
    const hasEyes = rig.mode === 'precise' ? 1 : 0;
    gl.uniform1f(this.u.hasEyes, hasEyes);
    gl.uniform2f(this.u.gaze, st.gazeX, st.gazeY);

    const cheekY = face.eyeA.cy + (face.eyeA.cy - rig.head.cy) * 0.55;
    const cheekR = Math.max(6, face.eyeA.rx * 1.5);
    gl.uniform4f(this.u.blushA, face.eyeA.cx, cheekY, cheekR, cheekR * 0.62);
    gl.uniform4f(this.u.blushB, face.eyeB.cx, cheekY, cheekR, cheekR * 0.62);
    gl.uniform1f(this.u.blush, hasEyes ? st.blush : 0);

    // P0-3：睑线采样行 / 中位皮肤色 / 睑缘线强度
    const sk = this.ensureSkin(rig);
    gl.uniform1f(this.u.skinRowA, sk.a.row);
    gl.uniform1f(this.u.skinRowB, sk.b.row);
    gl.uniform3f(this.u.skinFbA, sk.a.fb[0], sk.a.fb[1], sk.a.fb[2]);
    gl.uniform3f(this.u.skinFbB, sk.b.fb[0], sk.b.fb[1], sk.b.fb[2]);
    // 完全睁开时不画睑缘线；越闭合线越明显（0 → 1）
    const lidAlpha = hasEyes ? Math.min(1, Math.max(0, 1 - eyeOpen / 0.92)) : 0;
    gl.uniform1f(this.u.lidAlpha, lidAlpha);

    gl.drawElements(gl.TRIANGLES, this.mesh.tris.length, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  /** 设置画布像素尺寸（导出时用全分辨率） */
  resize(w, h) {
    this.drawW = w; this.drawH = h;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** P1-03：擦掉画布内容（切回空态时用，避免上一帧残留） */
  clear() {
    const gl = this.gl;
    gl.viewport(0, 0, Math.max(1, this.drawW), Math.max(1, this.drawH));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** P2-01：释放 GPU 资源，换图 / 销毁时不泄漏纹理与缓冲 */
  dispose() {
    const gl = this.gl;
    if (this.tex) { gl.deleteTexture(this.tex); this.tex = null; }
    if (this.posBuf) { gl.deleteBuffer(this.posBuf); this.posBuf = null; }
    if (this.idxBuf) { gl.deleteBuffer(this.idxBuf); this.idxBuf = null; }
    if (this.vao) { gl.deleteVertexArray(this.vao); this.vao = null; }
    if (this.prog) { gl.deleteProgram(this.prog); this.prog = null; }
    this.mesh = null;
    this.srcBitmap = null;
    this.skinCache = null;
  }
}
