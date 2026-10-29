# Gao Leng Shuishui · 网站版源码包

上传一张图，在浏览器里自动生成一个会眨眼、会呼吸、会轻微转头的 2D 动画形象，并导出透明 PNG。
**纯前端静态站点**：没有后端、没有数据库、没有构建步骤，图片不离开本机浏览器。

在线版本：https://miaoda.feishu.cn/app/app_17gtathns92

---

## 一、技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 页面 | 原生 HTML + CSS（设计令牌 CSS 变量） | 无框架、无打包器，`index.html` 直接可跑 |
| 逻辑 | 原生 ES modules（`<script type="module">`） | 浏览器直接加载 `assets/app.js` 及其 `assets/engine/*.js` |
| 动效 | 自研 CPU 顶点变形 + **WebGL2** 渲染 | 顶点变形在 CPU 上按烘焙权重做乘加，再上传纹理给 WebGL2 绘制 |
| 人脸检测 | `@mediapipe/tasks-vision` v1.1.1（Apache-2.0） | Face Landmarker，478 个关键点，随包内置、同源加载 |
| 模型 | `face_landmarker.task`（float16，MediaPipe 官方模型） | 首次选图后才懒加载 |
| 导出 | Canvas `toDataURL('image/png')` | 保留 alpha 通道 |

无 npm 运行时依赖：`package.json` 里没有 `dependencies`，`serve` 只是用来起一个静态服务器的开发者工具。

---

## 二、目录结构

```
mesh-avatar-studio/
├── index.html                  页面结构（六个状态面板 + 预览舞台）
├── assets/
│   ├── app.css                 设计令牌、六态面板、响应式与动效
│   ├── app.js                  应用编排：状态机、上传、进度、播放、导出
│   └── engine/
│       ├── validate.js         输入校验（格式、体积、尺寸），纯函数
│       ├── decode.js           解码 / EXIF 校正 / 长边降采样 / GIF 取首帧 / alpha 分析
│       ├── detect.js           MediaPipe 懒加载 + 4 路头部候选裁剪检测
│       ├── rig.js              关键点 → 椭圆骨架参数；无人脸时用形状先验兜底
│       ├── mesh.js             规则网格生成 + 单层权重场烘焙
│       ├── motion.js           待机动画轨道：眨眼状态机、呼吸、转头、滚转、视线
│       └── renderer.js         CPU 变形 + WebGL2 渲染 + 眼睑遮罩
├── models/
│   └── face_landmarker.task    人脸关键点模型，3,758,596 字节
├── vendor/
│   ├── vision_bundle.mjs       MediaPipe tasks-vision 的 ES module 入口
│   ├── vision_wasm_internal.js         SIMD 版 WASM 胶水代码
│   ├── vision_wasm_internal.wasm       SIMD 版 WASM 本体，13,519,922 字节
│   ├── vision_wasm_nosimd_internal.js  非 SIMD 版胶水代码（较老浏览器回落用）
│   └── vision_wasm_nosimd_internal.wasm 非 SIMD 版 WASM 本体，12,627,509 字节
├── serve.py                    零依赖本地静态服务器（显式声明 .wasm MIME）
├── package.json                只声明 scripts，无运行时依赖
├── NOTICE.md                   第三方组件与许可
└── README.md                   本文件
```

资源总量约 30 MB，其中模型与 WASM 占绝大部分——这是本站能离线在浏览器内做人脸检测的代价。

---

## 三、本地运行

### 前置要求

- **Node.js ≥ 18**（仅方式一/二可选，用于 `npx serve`）；或 **Python 3.9+**（方式三，系统一般自带）
- 一个支持 **WebGL2** 的现代浏览器：Chrome 56+ / Edge 79+ / Firefox 51+ / Safari 15+
- 无需联网（模型与 WASM 都在包里）。但**第一次处理图片时浏览器要读取约 17 MB 本地资源**，请留意下面「常见问题」第 1 条。

> **为什么不能直接双击 `index.html` 用 `file://` 打开？**
> 三个硬性原因，缺一不可：
> 1. **ES module 受同源策略限制**。`file://` 下的模块脚本会被浏览器按不透明源处理，`import` 直接报 CORS 错误，页面一片空白。
> 2. **MediaPipe 的 WASM 通过 `instantiateStreaming` 加载**，这要求资源经 HTTP(S) 返回且 `Content-Type: application/wasm`；`file://` 没有 MIME 头，编译会失败。
> 3. **MediaPipe 内部会创建 worker 并取相对路径资源**，`file://` 下的相对 URL 解析与 fetch 同样被拦。
>
> 结论：必须起一个 http 静态服务器指向本目录。下面给三种方式，任选其一。

### 方式一（推荐）：免构建，任意静态服务器

包内自带 `serve.py`，它只用 Python 标准库，并**显式把 `.wasm` 声明为 `application/wasm`**，避免某些环境把 WASM 当 `application/octet-stream` 导致加载失败：

```bash
cd mesh-avatar-studio
python3 serve.py            # 默认 http://127.0.0.1:5173
# 或指定端口： python3 serve.py 8080
```

打开 <http://127.0.0.1:5173/> 即可。

用 `npx serve` 也行（`serve` 自带正确的 `.wasm` MIME 映射）：

```bash
cd mesh-avatar-studio
npx --yes serve@14 . --listen 5173
```

或任何你熟悉的静态服务器，例如：

```bash
python3 -m http.server 5173        # 注意：老版本 Python 可能把 .wasm 当 octet-stream
php -S 127.0.0.1:5173
rclone serve http . --addr 127.0.0.1:5173
```

**用 `python3 -m http.server` 时请确认 `.wasm` 的 MIME**：Python 3.9+ 的 `mimetypes` 默认已包含 `application/wasm`（可用 `python3 -c "import mimetypes;print(mimetypes.guess_type('a.wasm'))"` 自查）。若输出不是 `application/wasm`，请改用包内的 `serve.py`。

### 方式二：npm 一键脚本（需要 Node.js ≥ 18）

```bash
cd mesh-avatar-studio
npm install     # 本包无 dependencies，这一步只准备 npm 环境，可以跳过
npm run dev     # 等价于 npx serve@14 . --listen 5173
```

`package.json` 里还有 `npm run serve:py`（转调 `serve.py`）。
本项目**没有构建产物**，源码即产物，不存在 `dist/`。

### 方式三：部署到你自己的静态托管

把整个目录原样上传到任意静态托管（Nginx / 对象存储 / GitHub Pages / Vercel / 内网文件服务）即可。唯一硬性要求：**`.wasm` 必须返回 `Content-Type: application/wasm`**。

Nginx 示例：

```nginx
types { application/wasm wasm; }
location / {
  root /path/to/mesh-avatar-studio;
  index index.html;
}
```

**子路径部署也可以**：包内所有资源引用都是相对路径（`./assets/...`、`./models/...`、`./vendor/...`），挂在 `/studio/` 之类的子目录下同样能跑，不需要改任何代码。

---

## 四、跑起来后应看到什么（自检清单）

按顺序核对，前 4 条不用上传图片就能确认：

1. **打开首页**：深色页面，顶部左侧是「Gao Leng Shuishui / 2D 动画形象生成器」品牌区（左侧图标为 `assets/brand-icon.jpg`，也用作 favicon），右上角有「本地处理 · 不上传」徽标。
2. **左栏标题**为「上传一张图 / 让它自己动起来」，下方是一个虚线框拖放区，写着「把图片拖到这里」和「或 点击选择文件 · 也支持 Ctrl/⌘ + V 粘贴」。
3. **右栏「预览舞台」**里有一个正在缓慢起伏的线框网格动画（不是静态图），下方有一行「等待一张立绘」。
4. **浏览器控制台无红色报错**。如果控制台出现 `Failed to load module script` 或 `WebAssembly` 相关错误，基本都是 MIME / `file://` 问题，回看上一节。

5. **上传一张人像**（点击拖放区选文件，或直接把图拖进去）：
   - 左侧立刻出现缩略图、文件名、尺寸，状态提示「处理中」；
   - 出现四段进度：识别人脸 → 定位五官 → 生成网格 → 准备首帧，进度条推进时**模型下载会显示 MB 数字**；
   - 十几秒内进入「播放控制」状态，右侧舞台出现会动的形象。
6. **看动画**：观察 10 秒，应该能看到**眨眼**（每 3–6 秒一次，间隔不固定）、**呼吸起伏**、**头部轻微转动**；鼠标在画布上移动时，眼睛会朝指针方向轻微偏转。
7. **点「暂停」**：画面定格；再点「播放」继续，不从头开始。「重置姿态」让形象回到中位。
8. **点「导出当前帧 PNG」**：浏览器下载一张 `mesh-avatar-<时间戳>.png`，用图片工具打开确认尺寸与处理图一致、透明区域仍是透明。
9. **兜底路径**：上传一张纯风景图（没有人脸），应停在说明页，文案是「没有找到清晰的人脸」并给出换图建议；点「仍然尝试生成」仍能产出一个整体呼吸的动画——这是预期的降级行为，不是故障。

只要 1–8 通，本地部署即与在线站点功能一致。

---

## 五、常见问题

**1. 第一次上传为什么等了这么久？**
人脸检测引擎是懒加载的：页面首次选图时才去取模型与 WASM。包内实际体积 —— 模型 `face_landmarker.task` **3,758,596 字节（3.76 MB / 3.58 MiB）**，SIMD 版 WASM `vision_wasm_internal.wasm` **13,519,922 字节（13.52 MB / 12.89 MiB）**，合计约 **17.3 MB**。本地服务器上这是磁盘读取，通常 1–3 秒；如果从远程托管加载，慢网下可能要十几秒。界面在模型下载阶段会显示真实 MB 进度，不会假装静默等待。第二次开始走浏览器缓存，明显更快。

**2. 提示「这个浏览器没有开启 WebGL2」**
渲染依赖 WebGL2。请更新浏览器，或在 Chrome/Edge 的 `chrome://gpu` 里确认硬件加速没有被关闭。部分虚拟机、远程桌面、老旧集显环境会禁用 WebGL2。

**3. 页面白屏 / 控制台报 MIME 类型错误**
`.wasm` 没被声明为 `application/wasm`，或你用了 `file://` 打开。改用 `python3 serve.py`（包内自带，已处理 MIME）或 `npx serve`。

**4. 上传后一直停在「识别画面中的人脸」**
多半是模型文件没取到。检查 `models/face_landmarker.task` 与 `vendor/*.wasm` 是否都在包里、路径是否被中途改动。资源路径是相对 `index.html` 的：`./models/`、`./vendor/`。**如果你把 `assets/`、`models/`、`vendor/` 拆散到不同层级，`assets/engine/detect.js` 里写的 `../../vendor/vision_bundle.mjs` 会失效**，请保持原始目录层级不变。

**5. 支持哪些图片？**
PNG / JPG / WebP / GIF（GIF 只取第一帧）。单文件 ≤ 20 MB，单边 ≤ 4096 px 且总像素 ≤ 1678 万，短边 ≥ 256 px。长边超过 1600 px 会自动等采样到 1600 并明确告知；超过像素上限会自动缩小而不是拒绝；手机照片按 EXIF 方向自动纠正。带背景的图会保留背景，**不做自动抠图**。

**6. 为什么有的图不眨眼？**
MediaPipe 在二次元立绘上的整图检出率不高，本站用 4 路头部候选裁剪提升命中率，但仍有一部分图定位不到完整的眼部关键点。此时会**自动关掉眨眼、只保留呼吸与轻微摆动**，并在界面上标明「已启用降级效果」和原因——宁可不给，也不给错的。你可以上传另一张更正面、脸占比更大的图重试。

**7. 多个人的图怎么办？**
检测到多张脸时不会自动挑，会进入选择态，让你点选一个作为主角，其余区域按背景处理。

**8. 可以商用吗？**
本站代码 MIT。但内置的 MediaPipe 组件与模型按 Apache-2.0 分发，使用时请遵守其许可（见 `NOTICE.md`）。包内**不含任何示例角色素材**，你上传什么就处理什么。

---

## 六、隐私说明

**图片只在你本机的浏览器内存里处理，不会上传到任何服务器。**

- 整个处理链路（解码、降采样、人脸检测、网格生成、渲染、导出）全部发生在浏览器内，没有后端接口，源码里也没有任何指向外部服务的图片上传地址。
- 图片不写入 localStorage / IndexedDB / Cache Storage，刷新页面即从内存清除。
- 模型与 WASM 是随包分发的静态资源，加载它们不携带任何图片数据。
- 「本地处理 · 不上传」这句徽标是硬约束，不是营销文案；如果实现与这句不一致，那是缺陷。

你可以自己验证：打开 DevTools → Network 面板，勾选保留日志，上传一张图，检查所有请求——除了同源的 `.task` / `.wasm` / `.js` / `.css`，不应出现任何携带图片内容的请求（没有 POST、没有第三方域名）。

**关于 MediaPipe 自带的使用统计（已拦截）**：`vendor/vision_bundle.mjs` 里打包了一个统计客户端，原本会在检测后向 `https://odml.pa.googleapis.com/v1/log` 以 protobuf 上报调用事件。这条上报不携带图片，但属于第三方域名，与上面那句徽标冲突。`assets/engine/detect.js` 里的 `blockMediaPipeTelemetry()` 在模块加载时按主机名精确拦截该请求（只拦这一个 host，模型 / WASM / 图片请求原样放行），`app.js` 在加载检测器之前调用它。拦截后该客户端收到空 200 并清空队列，检测功能不受影响。

---

## 七、已知限制与眼周保护逻辑

本版对「闭眼贴片」采取**能证明无瑕疵才启用，否则直接不做**的策略。判定在拼装阶段（`patch.js` 的 `buildEyePatch`）完成，逐眼评估，**任一眼不可用 → 整图禁用眨眼**（双眼同步，不出现只眨一只的 wink）；呼吸、转头、身体摆动、视线跟随不受影响，能力标签与 stage-meta 同步去掉眨眼项。

判据共五条，全部取自原图像素，逐条可复现（`EYE_GATE`）：

- **S1 供体面积**：取材窗 `w < 0.85×2·lensW` 或 `h < 0.9×2·lensH`（且不低于 12px），或四级降级链已落到「兜底」→ 判不可用。面积不够硬凑会导致折行/重复纹理。
- **S2 环带合格行**：睑裂左右 1.02~1.45·lensW 窄环内，中位亮度 L≥60 的行占比 < 0.80 → 判不可用。深色眼影、锅底阴影（L≈30~50）那类就卡在这里。
- **S3 上缘外侧深色横贯**：睑裂上缘上方 3~26px 带内，存在连续暗段 ≥1.6·lensW 的行占比 > 8% → 判不可用（刘海压在眼上）。
- **S4 眼区深色横贯**：眼心 ±1.2·lensH 的行里，最长连续暗段 ≥1.9·lensW 的占比 > 6% → 判不可用（头发/浓眼线横过整只眼）。
- **S5 贴片边界可见弧长**：贴片合成后，按 shader 的混合公式在 CPU 端还原闭眼帧，沿睑裂边界取 360 点、跨羽化带量 ΔL；凡「原图本来没有、贴片才带来」的台阶记为接缝，**连续 ≥24° 构成可被看成椭圆的轮廓** → 判不可用。前四条是预测，这条是实测。

实测对照（原图分辨率、360 点采样）：

| 图 | 眼A 接缝弧 | 眼B 接缝弧 | 结论 |
|---|---|---|---|
| clean_a.png（合成干净脸） | 1° | 7° | 启用眨眼 |
| got_a21d66.jpg（256px） | 0° | 0° | 启用眨眼 |
| face_a.jpg（眼镜＋眼线） | 18° | **39°** | 禁用 |
| pair2.jpg（刘海遮挡） | **27°** | **47°** | 禁用 |
| face_b.jpg（头发横穿右眼） | — | S2/S3/S4 三项超阈 | 禁用 |
| sq2048.jpg（高清同人） | — | S1 供体不足、降级到兜底 | 禁用 |

副作用说明：
- `got_a21d66.jpg` 只有 256×256，`lensH ≈ 8px`，解锁了对尺寸极小的图做贴片；这本就是最干净的一张，但分辨率不足以判定大图表现。
- 睁眼不受影响：`eyeOpen ≥ 0.92` 时贴片 mix=0，with/without 逐像素比对 **maxdiff=0、nonzero_px=0**（face_a / face_b / pair2 九档全零）。
- 未解决：`face_c.jpg` 源文件损坏（`image file is truncated`），`small300.jpg` 直接 error，`two_faces.jpg` 在 1200×1798 双脸图上跑 80.9s 仍停在 processing —— 属于脚本/浏览器侧超时，未证明为应用挂死。

## 八、许可

项目代码：MIT。
第三方组件（MediaPipe tasks-vision、face_landmarker 模型）：Apache-2.0，详见 `NOTICE.md`。
