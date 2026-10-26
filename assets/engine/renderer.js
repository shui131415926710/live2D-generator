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
out vec4 outColor;

// 眼睑遮罩：把「应被眼睑遮住」的区域替换为上方的皮肤色
// 睑线：open=1 → 眼睛上缘（不遮）；open=0 → 眼睛下缘（整只眼被遮住）
vec3 eyelidMask(vec3 col, vec4 eye, float open) {
  vec2 d = (vLocal - eye.xy) / eye.zw;
  // 椭圆外快速返回
  if (d.x * d.x + d.y * d.y > 1.0) return col;
  float lidTop = mix(eye.y + eye.w, eye.y - eye.w, open);
  // 被遮住的是睑线以上的部分（从上往下压）
  float covered = 1.0 - smoothstep(lidTop - 1.5, lidTop + 1.5, vLocal.y);
  if (covered <= 0.002) return col;
  // 从眼睑上方采样皮肤色
  vec2 skinUV = vUV - vec2(0.0, (3.0 / uImgSize.y) * 1.6);
  vec4 sk = texture(uTex, clamp(skinUV, vec2(0.0), vec2(1.0)));
  if (sk.a < 0.5) return col;   // 采到的是头发/饰品等非皮肤区域，保持原样
  return mix(col, sk.rgb, covered);
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
    col = eyelidMask(col, uEyeA, uEyeOpen);
    col = eyelidMask(col, uEyeB, uEyeOpen);
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
    };

    this.vao = gl.createVertexArray();
    this.posBuf = gl.createBuffer();
    this.uvBuf = gl.createBuffer();
    this.idxBuf = gl.createBuffer();
    this.tex = gl.createTexture();

    this.mesh = null;
    this.texW = 0; this.texH = 0;
    this.drawW = 0; this.drawH = 0;
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
  }

  setMesh(mesh) {
    const gl = this.gl;
    this.mesh = mesh;
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
      //    压缩系数随 open 从 0.12（闭合）到 1.0（全开，不变形）
      if (b.kEyeA[k] > 0.5) {
        const top = face.eyeA.cy - face.eyeA.ry;
        const bot = face.eyeA.cy + face.eyeA.ry;
        const lid = bot - (bot - top) * eyeOpen;
        const k = 0.12 + 0.88 * eyeOpen;
        if (py < lid) py = lid - (lid - py) * k;
        else py = lid + (py - lid) * k;
      }
      if (b.kEyeB[k] > 0.5) {
        const top = face.eyeB.cy - face.eyeB.ry;
        const bot = face.eyeB.cy + face.eyeB.ry;
        const lid = bot - (bot - top) * eyeOpen;
        const k = 0.12 + 0.88 * eyeOpen;
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
}
