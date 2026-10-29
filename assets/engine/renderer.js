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
uniform sampler2D uEyePatch;   // P0-3：预生成的闭眼贴片（原图眼皮皮肤 + 睑缘线）
uniform vec4 uPatchRect;       // 贴片在原图中的矩形 px0, py0, pw, ph
uniform float uPatchMix;       // 0 = 贴片不可见，1 = 完全贴片
uniform vec2 uImgSize;
uniform vec4 uEyeA;      // cx, cy, rx, ry（图像像素）
uniform vec4 uEyeB;
uniform float uEyeOpen;  // 1 = 全开
uniform float uHasEyes;
uniform vec2 uGaze;      // -1..1
uniform float uBlush;
uniform vec4 uBlushA;    // 位置/半径（图像像素）
uniform vec4 uBlushB;
uniform float uLidA;     // 睑线 y（图像像素）—— 与 CPU 顶点压缩用同一条公式算出的同一个值
uniform float uLidB;
uniform float uClose;    // 闭合度 0..1
uniform float uLidW;     // 睑缘线半宽（图像像素）
out vec4 outColor;

// P0-3：睑缘线。只画线，不做任何肤色填充。
// 闭眼完全由 CPU 顶点压缩完成（上带向下、下带向上，两带以睑线为不动点向它压缩，
// 因此在睑线处天然缝合）；shader 只负责在合拢处补一条 1~2px 的深色睑缘。
// 水平方向随 |dx| → 1 淡出，避免线头在眼尾突然截断。
float lidLineMask(vec4 eye, float lid) {
  vec2 d = (vLocal - eye.xy) / max(eye.zw, vec2(0.001));
  // 水平：中段满强度，向眼角外侧平滑收窄（|dx|>0.88 淡出，避免线头戳到镜框）
  float hFade = 1.0 - smoothstep(0.58, 0.88, abs(d.x));
  // 垂直：重心在睑线略偏下（褶线在睑缘内侧），上侧拖得比下侧长，
  // 这样它是「眼睑折痕的阴影」而不是一条等宽的深色横杠
  float dy = vLocal.y - lid;
  float wUp = uLidW * 1.15;
  float wDn = uLidW * 0.70;
  float band = 1.0 - smoothstep(0.0, (dy < 0.0 ? wUp : wDn), abs(dy));
  return clamp(band * band * hFade, 0.0, 1.0);
}

/**
 * P0-3 闭眼覆盖：**纹理域**的真实皮肤下沉，不是纯色填充。
 *
 * 为什么不用几何压缩：睑裂纵向 65px 要收到 ~8px，压缩比 8:1。
 * 这种压缩比下，网格三角形必然被剪切成斜条（实测竖条纹），
 * 且在水平两端产生垂直硬边（实测矩形色块）。已用顶点探针验证压缩比
 * 确实达到 0.13~0.20，但视觉上依然是一块「贴上去的肉色片」。
 *
 * 因此改为：把睑裂上缘**以上**的真实皮肤纹理向下拉伸，覆盖整个睑裂。
 * - 采样点全部来自原图像素（含毛孔、明暗、血色），因此纹理连续、不是纯色；
 * - 在睑裂上缘处拉伸系数为 0，取样点就是原像素本身，接缝天然连续；
 * - 水平方向超出眼宽才淡出，避免眼角留下白色巩膜残条。
 */
float eyeCoverMask(vec4 eye) {
  vec2 d = (vLocal - eye.xy) / max(eye.zw, vec2(0.001));
  return 1.0 - smoothstep(0.98, 1.16, abs(d.x));
}

void main() {
  vec2 uv = vUV;
  // 采样用隐式 LOD：三角被纵向压扁时 uv 导数自然变大，GPU 会自动升 mip。
  // 上一版加了手动 LOD bias(4.2)，把整块眼区平均成一片平坦色 —— 那正是
  // 复测里「纹理平坦、唯一色比低于颊部」的色块本身。这里不做任何手动偏移。
  vec4 t = texture(uTex, uv);
  // 纹理按直通 alpha 存储；几乎全透明的片元直接丢弃
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

  /* P0-3 v3 — 闭眼贴片交叉淡化（**必须先于睑缘线绘制**）。
     贴片是**预生成**的一张 RGBA（原图眼皮皮肤 1:1 取材），
     运行时只做一次采样与 alpha 混合，不做任何逐帧计算。
     uPatchMix 由 uClose 驱动，eyeOpen>=0.42 时即为 0（睁眼零回归 + 无重影）。
     顺序很关键：贴片是"皮肤"，睑缘线是"褶痕"，褶痕必须压在皮肤之上，
     否则贴片会把睑缘线整条盖掉，闭眼退化成一块无结构的淡色椭圆。 */
  if (uPatchMix > 0.002) {
    vec4 pr = uPatchRect;
    if (vLocal.x >= pr.x && vLocal.x < pr.x + pr.z &&
        vLocal.y >= pr.y && vLocal.y < pr.y + pr.w) {
      vec2 pUV = vec2((vLocal.x - pr.x) / pr.z, (vLocal.y - pr.y) / pr.w);
      vec4 pat = texture(uEyePatch, pUV);
      float k = pat.a * uPatchMix;
      if (k > 0.002) {
        col = mix(col, pat.rgb, k);
        alpha = mix(alpha, max(alpha, pat.a), k * 0.5 + 0.5 * k);
      }
    }
  }

  // 睑缘线：闭合越深越明显；不填色、不遮罩。绘制在贴片之上。
  // 位置由 uLidA/uLidB 驱动（= lidY(eye, eyeOpen)），因此随闭合单调下移。
  if (uHasEyes > 0.5 && uClose > 0.10) {
    float a = max(lidLineMask(uEyeA, uLidA), lidLineMask(uEyeB, uLidB)) * uClose;
    float k = clamp(a * 0.62, 0.0, 0.60);
    col = mix(col, col * 0.42 + vec3(0.010, 0.009, 0.009), k);
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

/**
 * P0-3：闭眼时眼区压缩到的高度比例。0.12 = 剩原高度的 12%，
 * 虹膜被压成约 2~3px 的深色细线 —— 这才是真实的闭眼形态。
 * 上一次取 0.62 让眼睛还剩 62% 高度，虹膜必然整块可见。
 */
export const EYE_CLOSE_FLOOR = 0.12;

/**
 * 睑裂半高（ry 倍数）。rig.js 里 eye.ry = 1.35 × 睑裂半高，
 * 所以真实睑裂上/下缘在 cy ∓ (1/1.35)·ry = cy ∓ 0.7407·ry。
 * 上一版 lidY 用的是 cy-ry（比真实上缘还高 0.26ry），压缩锚点落在眼睛上方，
 * 于是眼裂内容被向上拽、而权重在 0.50ry 处已归零 —— 眼裂外 1/3 的虹膜根本没被压。
 * 这是「闭眼后虹膜仍整块可见」的几何根源。
 */
export const EYE_APERTURE = 1 / 1.35;   // 0.7407

/**
 * 睑线位置（图像像素 y）= **上睑缘**位置，即闭眼时形成的那条褶皱/睫毛线。
 *   open = 1（全睁）→ 睑裂上缘 cy − 0.7407·ry
 *   open = 0（闭合）→ 睑裂下缘 cy + 0.7407·ry
 * 随 eyeOpen 减小而**向下**单调移动：y = cy + AP·ry·(1 − 2·open)。
 *
 * ⚠️ 上版写成 (2*open-1)，方向是反的（open=1 落到下缘、open=0 落到上缘）：
 * 闭眼时整片眼区被向**上**拽进睑裂上方，压出一块肉色平片 —— 也就是复测里
 * 「眼睛上贴了块肉色圆片」的直接成因。顶点探针已实测：
 * 修正前 eyeOpen=1 → lidY=634.6(下缘)，eyeOpen=0 → lidY=569.1(上缘)。
 *
 * CPU 顶点压缩与 shader 睑缘线共用本函数，因此线随闭合一起下移。
 */
export function lidY(eye, open) {
  return eye.cy + eye.ry * EYE_APERTURE * (1 - 2 * open);
}

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
      lidA: gl.getUniformLocation(this.prog, 'uLidA'),
      lidB: gl.getUniformLocation(this.prog, 'uLidB'),
      close: gl.getUniformLocation(this.prog, 'uClose'),
      lidW: gl.getUniformLocation(this.prog, 'uLidW'),
      eyePatch: gl.getUniformLocation(this.prog, 'uEyePatch'),
      patchRect: gl.getUniformLocation(this.prog, 'uPatchRect'),
      patchMix: gl.getUniformLocation(this.prog, 'uPatchMix'),
    };

    this.vao = gl.createVertexArray();
    this.posBuf = gl.createBuffer();
    this.uvBuf = gl.createBuffer();
    this.idxBuf = gl.createBuffer();
    this.tex = gl.createTexture();
    this.patchTex = gl.createTexture();
    this.hasPatch = false;

    this.mesh = null;
    this.texW = 0; this.texH = 0;
    this.drawW = 0; this.drawH = 0;
    this.srcBitmap = null;
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
    // P0-3：必须带 mipmap。闭眼时眼区被纵向压到 12%，一个屏幕像素要覆盖
    // 原始纹理的 8 行；只有 LINEAR（无 mipmap）时每像素只取邻近 2 行，
    // 高频内容折叠成规则纵条纹 —— 这就是历史「条带」的真正来源。
    // 用 trilinear mipmap + 各向异性后，LOD 会随压缩自动升高，重压区被正确预滤波。
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) {
      const maxA = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, maxA));
    }
    this.texW = W; this.texH = H;
    this.srcBitmap = bitmap;
    this.textureVersion = (this.textureVersion || 0) + 1;
    this.imageId = (this.imageId || 0) + 1;
  }

  /**
   * P0-3：上传预生成的闭眼贴片（patch.js 在浏览器内生成，来自原图自身皮肤）。
   * @param {HTMLCanvasElement} canvas 贴片
   * @param {number[]} rect [px0, py0, pw, ph] 在原图中的位置
   */
  setPatch(canvas, rect) {
    const gl = this.gl;
    if (!canvas || !rect) { this.hasPatch = false; return; }
    gl.bindTexture(gl.TEXTURE_2D, this.patchTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.patchRect = rect.slice();
    this.hasPatch = true;
    this.patchVersion = (this.patchVersion || 0) + 1;
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

    // 眼区：睑线位置（图像像素）。CPU 与 shader 共用 lidY()，保证睑缘线随皮下移。
    const lidA = lidY(face.eyeA, eyeOpen);
    const lidB = lidY(face.eyeB, eyeOpen);
    const closeAmt = 1 - eyeOpen;
    // P0-3 v3：闭眼改由**预生成贴片**完成（见 patch.js），几何压缩量置 0。
    // 8:1 纵向压缩在任何采样方式下都会把纹理抹成一维（已两轮实测），
    // 因此顶点不再参与闭眼，只保留必要的权重结构。
    const inv = 0;
    // 上带整体下移量 = 睑裂上缘 → 睑线 的距离。
    // 睑裂上缘在 cy - AP*ry；lidY(open) 从同一点线性走到 cy + AP*ry，
    // 所以 slide = AP*ry - AP*ry*(2*open-1) = 2*AP*ry*(1-open)。
    const AP_R = EYE_APERTURE;
    const slideA = 2 * AP_R * face.eyeA.ry * closeAmt;
    const slideB = 2 * AP_R * face.eyeB.ry * closeAmt;

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

      // ⑤ 眼区上下分带（顶点层面，闭眼的唯一手段）
      //
      //  ① 睑裂带：向睑线收拢，收到 EYE_CLOSE_FLOOR 高度（= 闭眼后的睫毛线）。
      //  ② 上带平移已移除：它会把眉毛一起拽下、并在水平两端留下垂直硬边
      //    （实测在 464px 画布上是一块左右齐平的矩形色块）。
      //    闭眼完全由 ① 完成：以睑线为不动点，把睑裂带收拢到 FLOOR 高度。
      //    睑裂内的纹理（虹膜/睫毛）因此收成一条细线，而不是被摊平。
      //    lidY 与 shader 睑缘线共用同一个 lidY()，随闭合同步下移。
      if (b.kEyeA[k] > 0.001) {
        py = lidA + (py - lidA) * (1 - b.kEyeA[k] * inv);
      }
      if (b.kEyeB[k] > 0.001) {
        py = lidB + (py - lidB) * (1 - b.kEyeB[k] * inv);
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

    // P0-3：贴片纹理（单元 1）
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.patchTex);
    gl.uniform1i(this.u.eyePatch, 1);
    const hasEyes = rig.mode === 'precise' ? 1 : 0;
    if (this.hasPatch && this.patchRect) {
      gl.uniform4f(this.u.patchRect, this.patchRect[0], this.patchRect[1],
        this.patchRect[2], this.patchRect[3]);
      // eyeOpen>0.92 时贴片完全不可见 → 保证睁眼画面零回归
      // 交叉淡化窗：eyeOpen 0.42 → 0.10 渐入。
      // 旧窗口 (0.08→0.80) 在 eyeOpen=0.6 就有 44% 的贴片压在大睁的眼上，
      // 实测是一层椭圆"鬼影/重影"（DISP16 第 2 格）。现在 0.42 以上直接为 0。
      const t0 = Math.min(1, Math.max(0, (0.42 - eyeOpen) / 0.32));
      const mixAmt = hasEyes ? t0 * t0 * (3 - 2 * t0) : 0;
      gl.uniform1f(this.u.patchMix, mixAmt);
    } else {
      gl.uniform1f(this.u.patchMix, 0);
    }
    gl.activeTexture(gl.TEXTURE0);

    // uRes 用「图像尺寸」做归一化，画布后备缓冲可以独立缩放（等比）
    gl.uniform2f(this.u.res, this.texW, this.texH);
    gl.uniform2f(this.u.imgSize, this.texW, this.texH);
    gl.uniform4f(this.u.eyeA, face.eyeA.cx, face.eyeA.cy, face.eyeA.rx, face.eyeA.ry);
    gl.uniform4f(this.u.eyeB, face.eyeB.cx, face.eyeB.cy, face.eyeB.rx, face.eyeB.ry);
    gl.uniform1f(this.u.eyeOpen, eyeOpen);
    gl.uniform1f(this.u.hasEyes, hasEyes);
    gl.uniform2f(this.u.gaze, st.gazeX, st.gazeY);

    const cheekY = face.eyeA.cy + (face.eyeA.cy - rig.head.cy) * 0.55;
    const cheekR = Math.max(6, face.eyeA.rx * 1.5);
    gl.uniform4f(this.u.blushA, face.eyeA.cx, cheekY, cheekR, cheekR * 0.62);
    gl.uniform4f(this.u.blushB, face.eyeB.cx, cheekY, cheekR, cheekR * 0.62);
    gl.uniform1f(this.u.blush, hasEyes ? st.blush : 0);

    // P0-3：睑线位置与闭合度（与 CPU 压缩同一组值）
    gl.uniform1f(this.u.lidA, lidA);
    gl.uniform1f(this.u.lidB, lidB);
    // 取证：记录本次实际写入的睑线位置，供 verify/lidy4.mjs 读取（不参与渲染）
    this.lastLid = { lidA, lidB, close: hasEyes ? Math.min(1, Math.max(0, (closeAmt - 0.06) / 0.72)) : 0,
                     lidW: 1.6, eyeOpen };
    gl.uniform1f(this.u.close, hasEyes ? Math.min(1, Math.max(0, (closeAmt - 0.06) / 0.72)) : 0);
    // 睑缘线半宽：2.2 图像像素 → 全开时视觉上 1~2px，符合「细线」尺度
    gl.uniform1f(this.u.lidW, 1.6);

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
    if (this.patchTex) { gl.deleteTexture(this.patchTex); this.patchTex = null; }
    if (this.posBuf) { gl.deleteBuffer(this.posBuf); this.posBuf = null; }
    if (this.idxBuf) { gl.deleteBuffer(this.idxBuf); this.idxBuf = null; }
    if (this.vao) { gl.deleteVertexArray(this.vao); this.vao = null; }
    if (this.prog) { gl.deleteProgram(this.prog); this.prog = null; }
    this.mesh = null;
    this.srcBitmap = null;
  }
}
