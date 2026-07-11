# Vendored ONNX Runtime Web

`ort.wasm.min.js`, `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm`
are the unmodified WASM-only distribution of
[onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web) **1.22.0**
(MIT license, © Microsoft Corporation), vendored so the site stays fully
self-contained (no CDN). They are lazy-loaded by `js/manga-ui.js` only when
AI panel detection is enabled.

To upgrade: `npm pack onnxruntime-web@<version>` and copy the three files
from `package/dist/`.
