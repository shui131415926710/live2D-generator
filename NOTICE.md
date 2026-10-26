# 第三方组件与许可声明

本包内含以下第三方组件，均按其原始许可分发。项目自身代码为 MIT。

## @mediapipe/tasks-vision v1.1.1

- 许可：**Apache License 2.0**
- 来源：npm 包 `@mediapipe/tasks-vision@1.1.1`（上游项目 google-ai-edge/mediapipe-web）
- 包内文件：
  - `vendor/vision_bundle.mjs` — ES module 入口
  - `vendor/vision_wasm_internal.js` / `vendor/vision_wasm_internal.wasm` — SIMD 版运行时代码与 WASM
  - `vendor/vision_wasm_nosimd_internal.js` / `vendor/vision_wasm_nosimd_internal.wasm` — 非 SIMD 回落版本
- 许可全文：https://www.apache.org/licenses/LICENSE-2.0

## face_landmarker 模型

- 文件：`models/face_landmarker.task`（3,758,596 字节，float16）
- 来源：MediaPipe 官方模型库 `mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`
- 许可：随 MediaPipe 项目以 **Apache License 2.0** 分发
- 用途：在浏览器内输出 478 个脸部 3D 关键点

## 关于素材

本包**不含任何示例角色素材**（无 Miko 或其他第三方立绘）。页面内的品牌图标与空态网格都是代码绘制的（内联 SVG / Canvas），不涉及第三方版权。

处理用户上传的图片时，请确保你拥有该图片的使用权。
