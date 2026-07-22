/* Manga converter: browser pipeline and page wiring.
 * Pure conversion logic lives in manga-core.js; this file handles file
 * input, image decoding, Gemini OCR calls, and the output zip. */
"use strict";

const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

/* Exact prompt from tools/manga_convert/convert_manga.py. */
const PANEL_OCR_PROMPT = `This image is a single panel cropped from a Japanese manga page.
List every piece of text/dialogue visible in this panel, in the order a
reader would read them (top-to-bottom, right-to-left for manga). Then give
a single natural English translation of all of it combined, in the same
reading order, as it would read in an English localization of this manga.

Return ONLY a JSON object, no other text:
{"blocks": [{"text": "<the Japanese text, line breaks as \\n>",
             "bbox_2d": [ymin, xmin, ymax, xmax]}, ...],
 "translation": "<natural English translation of all the panel's text combined, in reading order>"}

bbox_2d is each text region's bounding box normalized to a 0-1000 scale
(0,0 = top-left of the panel image, 1000,1000 = bottom-right). If you
cannot determine a precise box, omit bbox_2d for that entry.
If there is no text in the panel, return {"blocks": [], "translation": ""}.`;

/* ── Image helpers ────────────────────────────────────────────── */

const EXT_MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".bmp": "image/bmp",
};

async function decodeImage(bytes, ext) {
  const blob = new Blob([bytes], { type: EXT_MIME[ext] || "" });
  try {
    // 'none' matches PIL, which does not apply EXIF rotation on open.
    return await createImageBitmap(blob, { imageOrientation: "none" });
  } catch (e) {
    return await createImageBitmap(blob);
  }
}

async function canvasToJpegBytes(canvas, quality) {
  let blob;
  if (canvas.convertToBlob) {
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  } else {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  }
  return new Uint8Array(await blob.arrayBuffer());
}

async function canvasToPngBytes(canvas) {
  let blob;
  if (canvas.convertToBlob) {
    blob = await canvas.convertToBlob({ type: "image/png" });
  } else {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }
  return new Uint8Array(await blob.arrayBuffer());
}

/* Rotate a canvas 90° clockwise into a new (height×width) canvas. */
function rotateCanvas90CW(src) {
  const dst = makeCanvas(src.height, src.width);
  const c = dst.getContext("2d");
  c.translate(src.height, 0);
  c.rotate(Math.PI / 2);
  c.drawImage(src, 0, 0);
  return dst;
}

function bytesToBase64(bytes) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes]));
  });
}

/* ── Gemini OCR ───────────────────────────────────────────────── */

async function geminiOcrOnce(jpegBytes, apiKey, model) {
  const imageB64 = await bytesToBase64(jpegBytes);
  const payload = {
    contents: [{
      parts: [
        { text: PANEL_OCR_PROMPT },
        { inline_data: { mime_type: "image/jpeg", data: imageB64 } },
      ],
    }],
    generationConfig: { responseMimeType: "application/json" },
  };

  let resp;
  try {
    resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(payload),
      });
  } catch (e) {
    return null; // network-level failure — retry
  }

  let response;
  try {
    response = await resp.json();
  } catch (e) {
    return null; // malformed response — retry
  }

  if (response.error) {
    const status = response.error.status || "";
    if (["UNAVAILABLE", "RESOURCE_EXHAUSTED", "DEADLINE_EXCEEDED", "INTERNAL"].includes(status)) {
      return null; // transient API error — retry
    }
    logLine(`  Warning: Gemini error: ${String(response.error.message || status).substring(0, 200)}`, "warn");
    return { blocks: [], translation: "" }; // non-transient — give up on this panel
  }

  try {
    const textOut = response.candidates[0].content.parts[0].text;
    const parsed = JSON.parse(textOut);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { blocks: [], translation: "" };
    }
    let blocks = parsed.blocks;
    if (!Array.isArray(blocks)) blocks = [];
    blocks = blocks.filter((b) => b !== null && typeof b === "object" && !Array.isArray(b) && "text" in b);
    let translation = parsed.translation;
    if (typeof translation !== "string") translation = "";
    return { blocks, translation };
  } catch (e) {
    logLine(`  Warning: could not parse Gemini response (${e.message})`, "warn");
    return { blocks: [], translation: "" };
  }
}

async function geminiOcrPanel(jpegBytes, apiKey, model, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const result = await geminiOcrOnce(jpegBytes, apiKey, model);
    if (result !== null) return result;
    if (attempt < retries - 1) await sleep(Math.pow(2, attempt) * 1000);
  }
  return { blocks: [], translation: "" };
}

/* ── Page collection ──────────────────────────────────────────── */

/* files: FileList/array from the picker. Returns
 * {pages: [{name, read}], meta: {title, author}, tocEntries, sourceLabel}. */
/* ── PDF input (lazy-loaded pdf.js) ───────────────────────────── */

const PDFJS_DIR = "js/vendor/pdfjs/";
let pdfjsLoadPromise = null; // resolves to the pdf.js module

function loadPdfJs() {
  if (!pdfjsLoadPromise) {
    pdfjsLoadPromise = (async () => {
      const base = new URL(PDFJS_DIR, location.href).href;
      const pdfjs = await import(base + "pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.mjs";
      return pdfjs;
    })().catch((e) => { pdfjsLoadPromise = null; throw e; });
  }
  return pdfjsLoadPromise;
}

/* Mirror of convert_manga.py:_extract_pdf_pages: rasterize each page in
 * document order at 2x zoom (manga PDFs usually embed pages at 72–150 DPI,
 * so 2x lands near e-ink screen resolution) and name them pdfpage_NNNN.png.
 * Pages render lazily, one at a time, inside read() — a whole volume is
 * never held as pixels at once. */
async function collectFromPdf(bytes, name) {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    wasmUrl: new URL(PDFJS_DIR + "wasm/", location.href).href,
    isEvalSupported: false,
  });
  const doc = await loadingTask.promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    pages.push({
      name: `pdfpage_${String(i - 1).padStart(4, "0")}.png`,
      read: async () => {
        const pdfPage = await doc.getPage(i);
        const viewport = pdfPage.getViewport({ scale: 2 });
        const canvas = makeCanvas(Math.round(viewport.width), Math.round(viewport.height));
        await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        pdfPage.cleanup();
        return canvasToPngBytes(canvas);
      },
    });
  }

  // Same source as the desktop tool: the PDF's Title/Author metadata.
  let title = "", author = "";
  try {
    const md = await doc.getMetadata();
    title = ((md.info && md.info.Title) || "").trim();
    author = ((md.info && md.info.Author) || "").trim();
  } catch (e) { /* metadata is best-effort */ }

  return {
    pages,
    meta: { title, author },
    tocEntries: [],
    sourceLabel: baseName(name),
    cleanup: () => { loadingTask.destroy().catch(() => {}); },
  };
}

async function collectPagesFromInput(files) {
  if (files.length === 1 && !isImageName(files[0].name)) {
    const ext = mangaFileExt(files[0].name);
    const bytes = await readFileBytes(files[0]);
    if (ext === ".cbz" || ext === ".zip") return collectFromCbz(bytes, files[0].name);
    if (ext === ".epub") return collectFromEpub(bytes, files[0].name);
    if (ext === ".pdf") return collectFromPdf(bytes, files[0].name);
    throw new Error(`Unsupported input: ${files[0].name} (use .cbz, .zip, .epub, .pdf, or image files)`);
  }
  // Image list / folder selection.
  const images = [...files].filter((f) => isImageName(f.name));
  if (!images.length) throw new Error("No image files found in the selection");
  const byName = new Map(images.map((f) => [f.name, f]));
  const ordered = naturalSortPaths([...byName.keys()]);
  return {
    pages: ordered.map((name) => ({ name, read: () => readFileBytes(byName.get(name)) })),
    meta: { title: "", author: "" },
    tocEntries: [],
    sourceLabel: `${ordered.length} image files`,
  };
}

async function collectFromCbz(bytes, fileName) {
  const zip = new ZipReader(bytes);
  // Flatten by basename; later entries overwrite (matches the Python tool).
  const byBase = new Map();
  for (const e of zip.entries) {
    if (e.isDir || !isImageName(e.name)) continue;
    byBase.set(baseName(e.name), e);
  }
  if (!byBase.size) throw new Error("No image files found in the archive");
  const ordered = naturalSortPaths([...byBase.keys()]);

  let meta = { title: "", author: "" };
  const infoEntry = zip.entries.find((e) => baseName(e.name).toLowerCase() === "comicinfo.xml");
  if (infoEntry) {
    try {
      meta = cbzMetadataFromComicInfo(new TextDecoder().decode(await zip.readEntry(infoEntry)));
    } catch (e) { /* best-effort, like the Python tool */ }
  }

  return {
    pages: ordered.map((name) => ({ name, read: () => zip.readEntry(byBase.get(name)) })),
    meta,
    tocEntries: [],
    sourceLabel: fileName,
  };
}

async function collectFromEpub(bytes, fileName) {
  const zip = new ZipReader(bytes);
  const decoder = new TextDecoder();
  const container = decoder.decode(await zip.readEntryByName("META-INF/container.xml"));
  const opfPath = epubOpfPath(container);
  if (!opfPath) throw new Error("Could not find OPF in EPUB container.xml");
  const opfDir = pathDirname(opfPath);
  const opf = decoder.decode(await zip.readEntryByName(opfPath));

  const { manifest, spineIds } = epubParseOpf(opf);
  const pages = [];
  const spineMap = new Map(); // extracted basename → spine item href

  for (let idx = 0; idx < spineIds.length; idx++) {
    const href = manifest.get(spineIds[idx]);
    if (!href) continue;
    const fullHref = opfDir ? pathJoinNorm(opfDir, href) : pathNorm(href);
    let srcInZip;
    if (isImageName(fullHref)) {
      srcInZip = fullHref;
    } else {
      // Spine item is an XHTML wrapper page — find the embedded image.
      const entry = zip.findEntry(fullHref);
      if (!entry) continue;
      const xhtml = decoder.decode(await zip.readEntry(entry));
      const imgM = xhtml.match(/(?:src|xlink:href)="([^"]+)"/);
      if (!imgM) continue;
      srcInZip = pathJoinNorm(pathDirname(fullHref), imgM[1]);
    }
    const imgEntry = zip.findEntry(srcInZip);
    if (!imgEntry) {
      logLine(`Warning: image not found in EPUB: ${srcInZip}`, "warn");
      continue;
    }
    const targetBasename = `spine_${String(idx).padStart(4, "0")}_${baseName(srcInZip)}`;
    spineMap.set(fullHref, targetBasename);
    pages.push({ name: targetBasename, read: () => zip.readEntry(imgEntry) });
  }

  // Native EPUB table of contents → final page indices.
  let tocEntries = [];
  try {
    tocEntries = await epubNativeToc(zip, opf, opfDir, spineMap, pages);
  } catch (e) { /* fall back to no TOC */ }

  return { pages, meta: epubMetadataFromOpf(opf), tocEntries, sourceLabel: fileName };
}

async function epubNativeToc(zip, opf, opfDir, spineMap, pages) {
  const decoder = new TextDecoder();
  let raw = []; // [(href_with_optional_anchor, title)]
  const navHref = epubNavHref(opf);
  if (navHref) {
    const navPath = pathJoinNorm(opfDir, navHref);
    const navXhtml = decoder.decode(await zip.readEntryByName(navPath));
    raw = epubTocFromNav(navXhtml, navPath);
  } else {
    const ncxHref = epubNcxHref(opf);
    if (ncxHref) {
      const ncxPath = pathJoinNorm(opfDir, ncxHref);
      const ncx = decoder.decode(await zip.readEntryByName(ncxPath));
      raw = epubTocFromNcx(ncx, ncxPath);
    }
  }
  if (!raw.length) return [];

  const basenameToIndex = new Map(pages.map((p, i) => [p.name, i]));
  const resolved = [];
  for (const [href, title] of raw) {
    const hrefNoAnchor = href.split("#", 1)[0];
    const extractedBasename = spineMap.get(hrefNoAnchor);
    if (extractedBasename !== undefined && basenameToIndex.has(extractedBasename)) {
      resolved.push([basenameToIndex.get(extractedBasename), title]);
    }
  }
  return resolved;
}

/* ── AI panel detection (lazy-loaded ONNX Runtime + YOLO26 model) ── */

const YOLO_MODEL_URL = "models/manga_panel_detector_yolo26n.onnx";
const ORT_DIR = "js/vendor/ort/";
let yoloLoadPromise = null; // resolves to {ort, session}; reset to null on failure

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("failed to load " + src));
    document.head.appendChild(s);
  });
}

function loadYoloDetector() {
  if (!yoloLoadPromise) {
    yoloLoadPromise = (async () => {
      if (typeof ort === "undefined") await loadScriptOnce(ORT_DIR + "ort.wasm.min.js");
      // Must be absolute: ort dynamic-import()s its .mjs loader, and bare
      // relative specifiers are invalid module specifiers.
      ort.env.wasm.wasmPaths = new URL(ORT_DIR, location.href).href;
      const resp = await fetch(YOLO_MODEL_URL);
      if (!resp.ok) throw new Error(`model download failed (HTTP ${resp.status})`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
      return { ort, session };
    })().catch((e) => { yoloLoadPromise = null; throw e; });
  }
  return yoloLoadPromise;
}

/* ── Conversion pipeline ──────────────────────────────────────── */

const mangaState = { running: false, cancelled: false };

/* Assemble the collected page/panel images into a fixed-layout EPUB 3 (a zip
 * with the mandatory STORE-first mimetype). epubPages is [{pageIdx, images:
 * [{bytes, mime, w, h}]}] in reading order; the pure XML lives in manga-epub.js.
 * tocEntries ([[pageIndex, title]]) is carried into the EPUB's table of
 * contents, each chapter resolved to that page's first spine page. */
async function buildMangaEpub({ title, author, epubPages, tocEntries }) {
  const spine = [];
  const pageFirstHref = new Map();  // pageIdx → xhtmlHref of that page's first image
  for (const pg of epubPages) {
    pg.images.forEach((im, ii) => {
      const base = `p${String(pg.pageIdx).padStart(4, "0")}_${ii}`;
      const xhtmlHref = `text/${base}.xhtml`;
      if (ii === 0) pageFirstHref.set(pg.pageIdx, xhtmlHref);
      spine.push({
        xhtmlId: `x_${base}`, xhtmlHref,
        imgId: `img_${base}`, imgHref: `images/${base}.${epubImageExt(im.mime)}`,
        mime: im.mime, w: im.w, h: im.h,
        isCover: spine.length === 0,
        bytes: im.bytes,
      });
    });
  }

  let chapters = tocEntries
    .slice()
    .sort((a, b) => a[0] - b[0])
    .map(([pageIndex, chTitle]) => ({ href: pageFirstHref.get(pageIndex), title: chTitle }))
    .filter((c) => c.href);
  if (!chapters.length && spine.length) chapters = [{ href: spine[0].xhtmlHref, title: title || "Start" }];

  const identifier = epubIdentifier(title, author, spine.length);
  const files = buildEpubTextFiles({ identifier, title, author, language: "ja", spine, chapters });

  const zw = new ZipWriter();
  const enc = new TextEncoder();
  zw.addFile("mimetype", enc.encode(EPUB_MIMETYPE));  // must be first + STORE (OCF)
  for (const f of files) zw.addFile(f.path, enc.encode(f.text));
  for (const s of spine) zw.addFile("OEBPS/" + s.imgHref, s.bytes);
  return new Uint8Array(await zw.toBlob().arrayBuffer());
}

async function runMangaConversion() {
  const fileInput = $("manga-file");
  const files = fileInput.files;
  if (!files || !files.length) {
    logLine("Choose a .cbz/.zip/.epub file or a set of page images first.", "warn");
    return;
  }

  const noOcr = $("manga-no-ocr").checked;
  const mono = $("manga-mono").checked;
  const epub = $("manga-epub").checked;
  const apiKey = $("manga-key").value.trim();
  const model = $("manga-model").value.trim() || GEMINI_DEFAULT_MODEL;
  if (!noOcr && !apiKey) {
    logLine("Enter a Gemini API key, or tick \"Skip OCR\" for panels-only output.", "warn");
    return;
  }
  saveSetting("gemini-key", apiKey);
  saveSetting("gemini-model", model);
  saveSetting("manga-yolo", $("manga-yolo").checked ? "1" : "0");
  saveSetting("manga-mono", mono ? "1" : "0");
  saveSetting("manga-epub", epub ? "1" : "0");

  const panelMargin = parseInt($("manga-margin").value, 10);
  const margin = Number.isInteger(panelMargin) ? panelMargin : 10;
  const maxPagesRaw = parseInt($("manga-max-pages").value, 10);

  mangaState.running = true;
  mangaState.cancelled = false;
  $("manga-run").disabled = true;
  $("manga-cancel").hidden = false;
  clearLog();
  const wakeLock = new WakeLock();
  await wakeLock.acquire();

  let collected = null;
  try {
    logLine("Collecting pages…");
    collected = await collectPagesFromInput(files);
    let pages = collected.pages;

    // Resolve TOC before any max-pages truncation (indices stay correct).
    let tocEntries = collected.tocEntries;
    if (tocEntries.length) logLine(`Found ${tocEntries.length} chapter(s) in the EPUB's table of contents`);
    const tocText = $("manga-toc").value;
    if (tocText.trim()) {
      const parsed = parseTocText(tocText);
      parsed.warnings.forEach((warning) => logLine("Warning: " + warning, "warn"));
      tocEntries = parsed.entries;
      logLine(`Using ${tocEntries.length} chapter(s) from the chapter list`);
    }

    if (Number.isInteger(maxPagesRaw) && maxPagesRaw > 0) pages = pages.slice(0, maxPagesRaw);
    logLine(`Found ${pages.length} pages in ${collected.sourceLabel}`);

    // Same detector hierarchy as the Python tool: YOLO when available,
    // white-gutter grid heuristic as the fallback.
    let yolo = null;
    if ($("manga-yolo").checked) {
      try {
        logLine("Loading AI panel detector (first load downloads ~21 MB, then it's cached)…");
        yolo = await loadYoloDetector();
        logLine("AI panel detector ready");
      } catch (e) {
        logLine(`Could not load the AI panel detector (${e.message}); using the grid heuristic.`, "warn");
      }
    }

    const metaTitle = $("manga-title").value.trim() || collected.meta.title;
    const metaAuthor = $("manga-author").value.trim() || collected.meta.author;
    const folder = sanitizeFolderName(metaTitle || "Manga");

    const zip = new ZipWriter();
    const idxRecords = [];
    const datChunks = [];
    let datOffset = 0;
    let totalPanels = 0;
    let totalTextBlocks = 0;
    let pagesDone = 0;
    // For the optional portable EPUB: one entry per manga page, each holding the
    // full-page image followed by its (rotated) panel images. Assembled after
    // the loop; null when the EPUB export is off.
    const epubPages = epub ? [] : null;

    for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
      if (mangaState.cancelled) {
        logLine(`Cancelled after ${pagesDone} page(s); packaging what's done…`, "warn");
        break;
      }
      const page = pages[pageIdx];
      setProgress(pageIdx, pages.length, `Page ${pageIdx + 1} / ${pages.length}`);
      logLine(`[${pageIdx + 1}/${pages.length}] ${page.name}`);

      const srcBytes = await page.read();
      let ext = mangaFileExt(page.name);
      const bitmap = await decodeImage(srcBytes, ext);
      const imgW = bitmap.width, imgH = bitmap.height;

      const canvas = makeCanvas(imgW, imgH);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);

      const rgba = ctx.getImageData(0, 0, imgW, imgH).data;

      // Copy the page to a canonical, trivially-sortable filename. In mono mode
      // it becomes a 1-bit Floyd-Steinberg-dithered BMP the device paints with a
      // single fast black-and-white refresh (no 4-level gray pass).
      const pageBase = `page_${String(pageIdx).padStart(4, "0")}`;
      if (mono) {
        zip.addFile(`${folder}/${pageBase}.bmp`, encodeMonoBmpFromRGBA(rgba, imgW, imgH));
      } else if ([".jpg", ".jpeg", ".png"].includes(ext)) {
        zip.addFile(`${folder}/${pageBase}${ext}`, srcBytes);
      } else {
        zip.addFile(`${folder}/${pageBase}.jpg`, await canvasToJpegBytes(canvas, 0.92));
      }

      // The EPUB always uses a widely-supported core media type (JPEG/PNG); the
      // full page is never rotated (it's the overview). Reuse the source bytes
      // when they're already JPEG/PNG, otherwise re-encode from the canvas.
      const epubImages = [];
      if (epub) {
        let pageBytes, pageMime;
        if (ext === ".jpg" || ext === ".jpeg") { pageBytes = srcBytes; pageMime = "image/jpeg"; }
        else if (ext === ".png") { pageBytes = srcBytes; pageMime = "image/png"; }
        else { pageBytes = await canvasToJpegBytes(canvas, 0.92); pageMime = "image/jpeg"; }
        epubImages.push({ bytes: pageBytes, mime: pageMime, w: imgW, h: imgH });
      }

      let boxes = null;
      if (yolo) {
        try {
          boxes = await detectPanelsYolo(yolo.session, yolo.ort, rgba, imgW, imgH);
        } catch (e) {
          logLine(`AI detection failed on this page (${e.message}); using the grid heuristic.`, "warn");
        }
      }
      if (!boxes) {
        const gray = grayFromRGBA(rgba, imgW, imgH);
        boxes = detectPanelsGrid(gray, imgW, imgH);
      }
      boxes = sortPanelsMangaOrder(boxes);

      // Crop panels (fast, local) before dispatching OCR calls concurrently.
      const panelCrops = [];  // Uint8Array | null (null = full-page panel)
      const panelRects = [];
      for (let panelIdx = 0; panelIdx < boxes.length; panelIdx++) {
        const [x1, y1, x2, y2] = boxes[panelIdx];
        const mx1 = Math.max(0, x1 - margin);
        const my1 = Math.max(0, y1 - margin);
        const mx2 = Math.min(imgW, x2 + margin);
        const my2 = Math.min(imgH, y2 + margin);
        let cropBytes = null;  // full-colour JPEG crop for OCR (null = no crop / no OCR)
        if (!isFullPagePanel(boxes[panelIdx], imgW, imgH)) {
          const cw = mx2 - mx1, ch = my2 - my1;
          const cropCanvas = makeCanvas(cw, ch);
          const cropCtx = cropCanvas.getContext("2d");
          cropCtx.drawImage(bitmap, mx1, my1, cw, ch, 0, 0, cw, ch);
          if (mono) {
            const cropRgba = cropCtx.getImageData(0, 0, cw, ch).data;
            zip.addFile(`${folder}/p${pageIdx}_${panelIdx}.bmp`, encodeMonoBmpFromRGBA(cropRgba, cw, ch));
            // OCR still reads a full-colour JPEG crop: the dithered BMP would
            // only hurt text recognition (the --mono guidance to pair with
            // --no-ocr still applies, but OCR stays usable when both are on).
            if (!noOcr) cropBytes = await canvasToJpegBytes(cropCanvas, 0.90);
          } else {
            cropBytes = await canvasToJpegBytes(cropCanvas, 0.90);
            zip.addFile(`${folder}/p${pageIdx}_${panelIdx}.jpg`, cropBytes);
          }
          if (epub) {
            // Rotate wide (landscape) panels to portrait so they display as
            // large as possible on the usual portrait reading screen; the
            // fixed-layout reader then scales each to fullscreen.
            let panelCanvas = cropCanvas, pw = cw, ph = ch;
            if (cw > ch) { panelCanvas = rotateCanvas90CW(cropCanvas); pw = ch; ph = cw; }
            epubImages.push({ bytes: await canvasToJpegBytes(panelCanvas, 0.90), mime: "image/jpeg", w: pw, h: ph });
          }
        }
        panelCrops.push(cropBytes);
        panelRects.push([mx1, my1, mx2, my2]);
      }
      bitmap.close();

      if (epub) epubPages.push({ pageIdx, images: epubImages });

      let ocrResults;
      if (!noOcr) {
        ocrResults = await mapLimit(panelCrops, Math.min(8, Math.max(1, panelCrops.length)),
          (crop) => crop ? geminiOcrPanel(crop, apiKey, model) : Promise.resolve({ blocks: [], translation: "" }));
      } else {
        ocrResults = panelCrops.map(() => ({ blocks: [], translation: "" }));
      }

      const panelsWithText = [];
      for (let panelIdx = 0; panelIdx < boxes.length; panelIdx++) {
        const [x1, y1, x2, y2] = boxes[panelIdx];
        const [mx1, my1, mx2, my2] = panelRects[panelIdx];
        const ocr = ocrResults[panelIdx];
        const panelW = mx2 - mx1, panelH = my2 - my1;

        const textBlocks = [];
        for (const b of ocr.blocks || []) {
          const text = String(b.text ?? "").trim();
          if (!text) continue;
          const bbox = b.bbox_2d;
          let tb;
          if (Array.isArray(bbox) && bbox.length === 4) {
            const [ymin, xmin, ymax, xmax] = bbox;
            tb = [
              x1 + Math.trunc((xmin / 1000) * panelW),
              y1 + Math.trunc((ymin / 1000) * panelH),
              x1 + Math.trunc((xmax / 1000) * panelW),
              y1 + Math.trunc((ymax / 1000) * panelH),
            ];
          } else {
            tb = [x1, y1, x2, y2];
          }
          textBlocks.push({ box: tb, text });
        }
        panelsWithText.push({ box: boxes[panelIdx], textBlocks, translation: ocr.translation || "" });
        totalPanels += 1;
        totalTextBlocks += textBlocks.length;
      }

      const pageData = encodePage(panelsWithText);
      idxRecords.push({ offset: datOffset, length: pageData.length, w: Math.min(imgW, 0xffff), h: Math.min(imgH, 0xffff) });
      datChunks.push(pageData);
      datOffset += pageData.length;
      pagesDone++;
    }

    if (!pagesDone) throw new Error("No pages were processed");

    zip.addFile(`${folder}/panels.idx`, writePanelsIdx(idxRecords));
    const dat = new Uint8Array(datOffset);
    let off = 0;
    for (const chunk of datChunks) { dat.set(chunk, off); off += chunk.length; }
    zip.addFile(`${folder}/panels.dat`, dat);

    const metaBin = writeMetaBin(metaTitle, metaAuthor);
    if (metaBin) zip.addFile(`${folder}/meta.bin`, metaBin);
    if (tocEntries.length) zip.addFile(`${folder}/toc.idx`, writeTocIdx(tocEntries));

    // Optional portable EPUB alongside the native panel folder.
    if (epub && epubPages.length) {
      setProgress(pagesDone, pages.length, "Building EPUB…");
      const epubBytes = await buildMangaEpub({ title: metaTitle, author: metaAuthor, epubPages, tocEntries });
      zip.addFile(`${folder}.epub`, epubBytes);
      logLine(`Built ${folder}.epub (${epubPages.reduce((n, p) => n + p.images.length, 0)} images) — a portable copy for other readers.`);
    }

    setProgress(pagesDone, pages.length, "Packaging…");
    const blob = zip.toBlob();
    logLine(`Done: ${pagesDone} pages, ${totalPanels} panels` +
      (noOcr ? "" : `, ${totalTextBlocks} text blocks`) +
      (mono ? ", 1-bit dithered BMP" : "") +
      (epub ? ", + portable EPUB" : "") + ` — ${formatBytes(blob.size)}`);
    logLine(`Unzip onto the SD card (e.g. /manga/) or upload the "${folder}" folder via the device's web file transfer.` +
      (epub ? ` The "${folder}.epub" inside the zip is a standalone copy for other e-readers/apps.` : ""));
    downloadBlob(blob, `${folder}.zip`);
    setProgress(pagesDone, pagesDone, "Complete");
  } catch (e) {
    logLine("Error: " + e.message, "error");
    console.error(e);
  } finally {
    if (collected && collected.cleanup) collected.cleanup();
    mangaState.running = false;
    $("manga-run").disabled = false;
    $("manga-cancel").hidden = true;
    wakeLock.release();
  }
}

/* ── Page wiring ──────────────────────────────────────────────── */

if (typeof document !== "undefined" && document.getElementById("manga-run")) {
  $("manga-key").value = loadSetting("gemini-key", "");
  $("manga-model").value = loadSetting("gemini-model", GEMINI_DEFAULT_MODEL);
  $("manga-yolo").checked = loadSetting("manga-yolo", "1") === "1";
  $("manga-mono").checked = loadSetting("manga-mono", "0") === "1";
  $("manga-epub").checked = loadSetting("manga-epub", "0") === "1";
  $("manga-run").addEventListener("click", runMangaConversion);
  $("manga-cancel").addEventListener("click", () => { mangaState.cancelled = true; });
  $("manga-file").addEventListener("change", () => {
    const files = $("manga-file").files;
    if (files.length) {
      $("manga-file-label").textContent = files.length === 1
        ? files[0].name : `${files.length} files selected`;
    }
  });
}
