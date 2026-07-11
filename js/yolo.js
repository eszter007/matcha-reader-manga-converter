/* YOLO panel detection: browser port of the Python tool's primary detector
 * (convert_manga.py:_detect_panels_yolo), running the same fine-tuned
 * YOLO26-nano model (leoxs22/manga-panel-detector-yolo26n) client-side via
 * ONNX Runtime Web instead of PyTorch.
 *
 * Pure logic only in this file — preprocessing (letterbox), output decoding,
 * and the sliver/dedupe post-processing ported line-for-line from the Python
 * tool. Session creation and lazy runtime loading live in manga-ui.js so
 * Node tests can exercise these functions with onnxruntime-web's wasm
 * backend directly.
 */
"use strict";

const YOLO_INPUT_SIZE = 640;
const YOLO_CONF_THRESHOLD = 0.4;   // convert_manga.py:_detect_panels_yolo(conf=0.4)
const YOLO_PANEL_CLASS = 0;        // 0=panel, 1=text — we only want panels

/* Letterbox an RGBA image into a 640x640 float32 CHW tensor (RGB, /255),
 * padding with 114-gray like ultralytics' LetterBox(auto=False). Bilinear
 * resample. Returns {data, scale, padX, padY} — scale/pad are needed to map
 * detected boxes back to source-image pixels. */
function yoloLetterbox(rgba, w, h, size) {
  size = size || YOLO_INPUT_SIZE;
  const scale = Math.min(size / w, size / h);
  const newW = Math.round(w * scale);
  const newH = Math.round(h * scale);
  const padX = Math.trunc((size - newW) / 2);
  const padY = Math.trunc((size - newH) / 2);

  const data = new Float32Array(3 * size * size).fill(114 / 255);
  const plane = size * size;

  for (let y = 0; y < newH; y++) {
    // Bilinear sample positions (align pixel centers, cv2.INTER_LINEAR style).
    const sy = Math.min(Math.max((y + 0.5) / scale - 0.5, 0), h - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, h - 1);
    const fy = sy - y0;
    const row = (padY + y) * size + padX;
    for (let x = 0; x < newW; x++) {
      const sx = Math.min(Math.max((x + 0.5) / scale - 0.5, 0), w - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, w - 1);
      const fx = sx - x0;
      const p00 = (y0 * w + x0) * 4, p01 = (y0 * w + x1) * 4;
      const p10 = (y1 * w + x0) * 4, p11 = (y1 * w + x1) * 4;
      const w00 = (1 - fy) * (1 - fx), w01 = (1 - fy) * fx;
      const w10 = fy * (1 - fx), w11 = fy * fx;
      const o = row + x;
      for (let c = 0; c < 3; c++) {
        const v = rgba[p00 + c] * w00 + rgba[p01 + c] * w01 +
                  rgba[p10 + c] * w10 + rgba[p11 + c] * w11;
        data[c * plane + o] = v / 255;
      }
    }
  }
  return { data, scale, padX, padY };
}

/* Decode the end-to-end YOLO26 ONNX output — [1, N, 6] rows of
 * (x1, y1, x2, y2, confidence, class) in letterboxed 640x640 pixels — into
 * source-image pixel boxes with confidences, filtered to the panel class
 * and the Python tool's confidence threshold. */
function yoloDecodeOutput(out, rows, lb, imgW, imgH, conf) {
  conf = conf === undefined ? YOLO_CONF_THRESHOLD : conf;
  const boxesWithConf = [];
  for (let i = 0; i < rows; i++) {
    const o = i * 6;
    const score = out[o + 4];
    if (score < conf) continue;
    if (Math.round(out[o + 5]) !== YOLO_PANEL_CLASS) continue;
    const x1 = Math.min(Math.max((out[o] - lb.padX) / lb.scale, 0), imgW);
    const y1 = Math.min(Math.max((out[o + 1] - lb.padY) / lb.scale, 0), imgH);
    const x2 = Math.min(Math.max((out[o + 2] - lb.padX) / lb.scale, 0), imgW);
    const y2 = Math.min(Math.max((out[o + 3] - lb.padY) / lb.scale, 0), imgH);
    boxesWithConf.push([[Math.trunc(x1), Math.trunc(y1), Math.trunc(x2), Math.trunc(y2)], score]);
  }
  return boxesWithConf;
}

/* ── Post-processing ported from convert_manga.py ─────────────── */

function yoloBoxArea(b) {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

function yoloOverlapArea(a, b) {
  const ox1 = Math.max(a[0], b[0]), oy1 = Math.max(a[1], b[1]);
  const ox2 = Math.min(a[2], b[2]), oy2 = Math.min(a[3], b[3]);
  return Math.max(0, ox2 - ox1) * Math.max(0, oy2 - oy1);
}

/* Collapse boxes that substantially overlap into their union (measured
 * against the smaller box so containment is caught either way), highest
 * confidence first. Port of convert_manga.py:_dedupe_boxes. */
function yoloDedupeBoxes(boxesWithConf, overlapThresh) {
  overlapThresh = overlapThresh === undefined ? 0.6 : overlapThresh;
  const ordered = boxesWithConf.slice().sort((a, b) => b[1] - a[1]);
  const kept = [];
  for (const [box] of ordered) {
    const area = yoloBoxArea(box);
    if (area === 0) continue;
    let mergedInto = -1;
    for (let i = 0; i < kept.length; i++) {
      const kArea = yoloBoxArea(kept[i]);
      if (kArea > 0 && yoloOverlapArea(box, kept[i]) / Math.min(area, kArea) > overlapThresh) {
        mergedInto = i;
        break;
      }
    }
    if (mergedInto >= 0) {
      const k = kept[mergedInto];
      kept[mergedInto] = [Math.min(k[0], box[0]), Math.min(k[1], box[1]),
                          Math.max(k[2], box[2]), Math.max(k[3], box[3])];
    } else {
      kept.push(box.slice());
    }
  }
  return kept;
}

/* Degenerate detections: small relative to the page AND extremely elongated.
 * Port of convert_manga.py:is_sliver_panel. */
function isSliverPanel(box, pageW, pageH) {
  const w = Math.max(1, box[2] - box[0]);
  const h = Math.max(1, box[3] - box[1]);
  const areaFrac = (w * h) / Math.max(1, pageW * pageH);
  const aspect = Math.max(w / h, h / w);
  return areaFrac < 0.025 && aspect > 4.0;
}

/* Full pipeline for one page: letterbox → inference → decode → sliver filter
 * → dedupe, falling back to one full-page box when nothing is detected —
 * mirrors convert_manga.py:_detect_panels_yolo. `session` is an ONNX Runtime
 * InferenceSession for the panel model; `ortApi` is the onnxruntime module
 * (for its Tensor constructor). */
async function detectPanelsYolo(session, ortApi, rgba, w, h) {
  const lb = yoloLetterbox(rgba, w, h);
  const inputName = session.inputNames[0];
  const feeds = {};
  feeds[inputName] = new ortApi.Tensor("float32", lb.data, [1, 3, YOLO_INPUT_SIZE, YOLO_INPUT_SIZE]);
  const results = await session.run(feeds);
  const output = results[session.outputNames[0]];
  const rows = output.dims[output.dims.length - 2];

  const raw = yoloDecodeOutput(output.data, rows, lb, w, h);
  const filtered = raw.filter(([box]) => !isSliverPanel(box, w, h));
  const boxes = yoloDedupeBoxes(filtered);
  if (!boxes.length) return [[0, 0, w, h]];
  return boxes;
}

if (typeof module !== "undefined") {
  module.exports = {
    YOLO_INPUT_SIZE, YOLO_CONF_THRESHOLD, YOLO_PANEL_CLASS,
    yoloLetterbox, yoloDecodeOutput, yoloDedupeBoxes, isSliverPanel,
    yoloBoxArea, yoloOverlapArea, detectPanelsYolo,
  };
}
