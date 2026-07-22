/* Manga converter core: pure logic ported line-for-line from matcha-reader's
 * tools/manga_convert/convert_manga.py (grid panel detection path).
 *
 * Given identical input pixels, panels.idx / panels.dat / meta.bin / toc.idx
 * produced here are byte-identical to the Python tool run with --no-ocr.
 * No DOM or canvas dependencies in this file — the browser pipeline lives in
 * manga-ui.js, and Node tests exercise these functions directly.
 */
"use strict";

const MANGA_FORMAT_VERSION = 2;   // v2 adds a per-panel translation string
const TOC_FORMAT_VERSION = 1;
const META_FORMAT_VERSION = 1;

const MANGA_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);

const mangaEncoder = new TextEncoder();

function mangaFileExt(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.substring(i).toLowerCase();
}

function isImageName(name) {
  return MANGA_IMAGE_EXTS.has(mangaFileExt(name));
}

function baseName(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.substring(i + 1);
}

/* ── Page ordering (matches FsHelpers::sortFileList on the device) ── */

/* Natural sort key: list of [group, len, str] triples. Cover and copyright
 * pages are pinned to the front (see convert_manga.py:_natural_sort_key). */
function naturalSortKey(path) {
  const name = baseName(path);
  const lower = name.toLowerCase();
  if (lower.includes("cover")) return [[-2, 0, ""]];
  if (lower.includes("copyright")) return [[-1, 0, ""]];
  const parts = [];
  let i = 0;
  while (i < name.length) {
    if (name[i] >= "0" && name[i] <= "9") {
      let j = i;
      while (j < name.length && name[j] >= "0" && name[j] <= "9") j++;
      const numStr = name.substring(i, j).replace(/^0+/, "");
      parts.push([0, numStr.length, numStr]);
      i = j;
    } else {
      parts.push([1, 0, name[i].toLowerCase()]);
      i += 1;
    }
  }
  return parts;
}

function compareNaturalKeys(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const [g1, l1, s1] = a[i];
    const [g2, l2, s2] = b[i];
    if (g1 !== g2) return g1 - g2;
    if (l1 !== l2) return l1 - l2;
    if (s1 !== s2) return s1 < s2 ? -1 : 1;
  }
  return a.length - b.length;
}

function naturalSortPaths(paths) {
  return paths
    .map((p) => ({ p, k: naturalSortKey(p) }))
    .sort((x, y) => compareNaturalKeys(x.k, y.k))
    .map((x) => x.p);
}

/* ── Panel detection: white-gutter grid heuristic ─────────────── */

/* PIL Image.convert("L") luminance (ITU-R 601-2), bit-exact. */
function grayFromRGBA(rgba, w, h) {
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (rgba[p] * 19595 + rgba[p + 1] * 38470 + rgba[p + 2] * 7471 + 0x8000) >>> 16;
  }
  return gray;
}

/* Collapse boundary points that would create a too-small segment. */
function mergeSmallGaps(splits, minSize) {
  if (splits.length <= 2) return splits;
  const merged = [splits[0]];
  for (let i = 1; i < splits.length; i++) {
    const s = splits[i];
    if (s - merged[merged.length - 1] < minSize) continue;
    merged.push(s);
  }
  if (merged[merged.length - 1] !== splits[splits.length - 1]) {
    merged[merged.length - 1] = splits[splits.length - 1];
  }
  return merged;
}

/* Detect panel rectangles by finding solid white gutter bands.
 * gray: Uint8Array of w*h luminance values. Returns [[x1,y1,x2,y2], ...]. */
function detectPanelsGrid(gray, w, h) {
  const threshold = 215;
  const purity = 0.95;
  const minGutter = Math.max(6, Math.trunc(h * 0.013));
  const minBandH = Math.max(Math.trunc(h * 0.05), 60);
  const minBandW = Math.max(Math.trunc(w * 0.06), 60);

  function isWhiteRow(y) {
    let white = 0;
    const row = y * w;
    for (let x = 0; x < w; x += 2) {
      if (gray[row + x] > threshold) white++;
    }
    return white > Math.floor(w / 2) * purity;
  }

  let hSplits = [0];
  let inGutter = false;
  let gutterStart = 0;
  for (let y = 0; y < h; y++) {
    const whiteRow = isWhiteRow(y);
    if (whiteRow && !inGutter) {
      inGutter = true;
      gutterStart = y;
    } else if (!whiteRow && inGutter) {
      if (y - gutterStart >= minGutter) {
        hSplits.push(Math.floor((gutterStart + y) / 2));
      }
      inGutter = false;
    }
  }
  hSplits.push(h);
  hSplits = mergeSmallGaps(hSplits, minBandH);

  const panels = [];
  for (let bandIdx = 0; bandIdx < hSplits.length - 1; bandIdx++) {
    const y1 = hSplits[bandIdx], y2 = hSplits[bandIdx + 1];

    function isWhiteCol(x) {
      let white = 0;
      for (let y = y1; y < y2; y += 2) {
        if (gray[y * w + x] > threshold) white++;
      }
      return white > Math.floor((y2 - y1) / 2) * purity;
    }

    let vSplits = [0];
    inGutter = false;
    gutterStart = 0;
    for (let x = 0; x < w; x++) {
      const whiteCol = isWhiteCol(x);
      if (whiteCol && !inGutter) {
        inGutter = true;
        gutterStart = x;
      } else if (!whiteCol && inGutter) {
        if (x - gutterStart >= minGutter) {
          vSplits.push(Math.floor((gutterStart + x) / 2));
        }
        inGutter = false;
      }
    }
    vSplits.push(w);
    vSplits = mergeSmallGaps(vSplits, minBandW);

    for (let colIdx = 0; colIdx < vSplits.length - 1; colIdx++) {
      panels.push([vSplits[colIdx], y1, vSplits[colIdx + 1], y2]);
    }
  }

  if (panels.length === 0) panels.push([0, 0, w, h]);
  return panels;
}

/* True when the panel covers almost the entire page in both dimensions. */
function isFullPagePanel(box, pageW, pageH, threshold = 0.95) {
  const w = Math.max(1, box[2] - box[0]);
  const h = Math.max(1, box[3] - box[1]);
  return w / Math.max(1, pageW) >= threshold && h / Math.max(1, pageH) >= threshold;
}

/* ── Device downscaling (--x3 / --x4) ─────────────────────────── */

/* Device screen sizes (portrait width × height), mirroring DEVICE_TARGETS in
 * convert_manga.py. Used to downscale pages/panels so the device never decodes
 * more pixels than its screen can show. */
const MANGA_DEVICE_TARGETS = { x3: [528, 792], x4: [480, 800] };

/* Compute the fitted size for an image of w×h against a device target (a
 * [tw, th] pair, or null to keep the original). Never upscales, never changes
 * aspect ratio. The firmware rotates a page/panel whose aspect doesn't match
 * the screen, so landscape images (w > h) are fitted against the swapped box.
 * Returns { w, h, resized }. Faithful port of convert_manga.py:fit_to_device's
 * dimension math (the actual pixel resample happens on a canvas in the UI). */
function fitToDeviceSize(w, h, target) {
  if (!Array.isArray(target) || target.length < 2) return { w, h, resized: false };
  let tw = target[0], th = target[1];
  if (w > h) { const t = tw; tw = th; th = t; }
  const scale = Math.min(tw / w, th / h);
  if (scale >= 1.0) return { w, h, resized: false };  // never upscale
  const nw = Math.min(tw, Math.max(1, Math.round(w * scale)));
  const nh = Math.min(th, Math.max(1, Math.round(h * scale)));
  return { w: nw, h: nh, resized: true };
}

/* ── Reading-order sort (topological "reads-before" graph) ────── */

function yOverlapFrac(a, b) {
  const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const minH = Math.min(a[3] - a[1], b[3] - b[1]);
  return Math.max(0, overlap) / Math.max(1, minH);
}

function sortPanelsMangaOrder(panels) {
  const n = panels.length;
  if (n <= 1) return panels;

  const OVERLAP_THRESHOLD = 0.3;
  const edges = Array.from({ length: n }, () => []);
  const inDegree = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const a = panels[i], b = panels[j];
      if (yOverlapFrac(a, b) > OVERLAP_THRESHOLD) {
        const aCx = (a[0] + a[2]) / 2, bCx = (b[0] + b[2]) / 2;
        if (aCx > bCx) { // same tier: right-to-left
          edges[i].push(j);
          inDegree[j]++;
        }
      } else {
        const aCy = (a[1] + a[3]) / 2, bCy = (b[1] + b[3]) / 2;
        if (aCy < bCy) { // different tiers: top-to-bottom
          edges[i].push(j);
          inDegree[j]++;
        }
      }
    }
  }

  function tieKey(i) {
    const [x1, y1, x2, y2] = panels[i];
    return [(y1 + y2) / 2, -(x1 + x2) / 2];
  }

  let available = [];
  for (let i = 0; i < n; i++) if (inDegree[i] === 0) available.push(i);
  const result = [];
  while (available.length) {
    available.sort((a, b) => {
      const ka = tieKey(a), kb = tieKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1];
    });
    const node = available.shift();
    result.push(node);
    for (const j of edges[node]) {
      inDegree[j]--;
      if (inDegree[j] === 0) available.push(j);
    }
  }

  if (result.length !== n) return panels; // cyclic constraints: keep original
  return result.map((i) => panels[i]);
}

/* ── 1-bit BMP output (Floyd-Steinberg dithering) ─────────────── */

/* Floyd-Steinberg error-diffusion dither of an 8-bit grayscale buffer down to
 * 1-bit black/white. Returns a Uint8Array of w*h values (1 = white, 0 = black).
 * Mirrors the intent of convert_manga.py's --mono path, which uses PIL's
 * Image.convert("L").convert("1") (Floyd-Steinberg is PIL's default dither):
 * threshold at 128, error diffused with the classic 7/3/5/1 kernel. Byte-exact
 * parity with PIL is not required — page and panel images are re-encoded in the
 * browser exactly like the JPEG path, and only the binary panels.idx/dat/
 * meta.bin/toc.idx files are compared byte-for-byte against the Python tool. */
function floydSteinbergMono(gray, w, h) {
  // Signed accumulator so diffused error can push a pixel outside 0..255.
  const acc = new Int32Array(gray.length);
  for (let i = 0; i < gray.length; i++) acc[i] = gray[i];

  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const oldVal = acc[i];
      const newVal = oldVal < 128 ? 0 : 255;
      out[i] = newVal ? 1 : 0;
      const err = oldVal - newVal;
      if (err === 0) continue;
      if (x + 1 < w) acc[i + 1] += (err * 7) >> 4;
      if (y + 1 < h) {
        if (x > 0) acc[i + w - 1] += (err * 3) >> 4;
        acc[i + w] += (err * 5) >> 4;
        if (x + 1 < w) acc[i + w + 1] += err >> 4;
      }
    }
  }
  return out;
}

/* Pack a 1-bit mono buffer (1 = white) into a standard uncompressed BI_RGB BMP:
 * 14-byte file header, 40-byte BITMAPINFOHEADER, a 2-entry black/white palette,
 * then bottom-up rows padded to a 4-byte stride with MSB-first bit packing.
 * This is exactly the shape the device's 1-bit fast path expects (see
 * lib/GfxRenderer/Bitmap.cpp in matcha-reader). */
function encodeBmp1bit(mono, w, h) {
  const rowBytes = ((w + 31) >> 5) << 2;   // 4-byte-aligned row stride
  const pixelBytes = rowBytes * h;
  const HEADER = 14 + 40 + 8;              // file header + DIB header + palette
  const out = new ByteWriter(HEADER + pixelBytes);

  // BMP file header (14 bytes).
  out.u8(0x42); out.u8(0x4d);              // "BM"
  out.u32(HEADER + pixelBytes);            // file size
  out.u32(0);                              // reserved
  out.u32(HEADER);                         // offset to pixel data

  // BITMAPINFOHEADER (40 bytes).
  out.u32(40);                             // header size
  out.u32(w);                              // width  (positive)
  out.u32(h);                              // height (positive → bottom-up)
  out.u16(1);                              // planes
  out.u16(1);                              // bits per pixel
  out.u32(0);                              // BI_RGB (uncompressed)
  out.u32(pixelBytes);                     // image byte size
  out.u32(0); out.u32(0);                  // x/y pixels-per-metre
  out.u32(2);                              // colours used
  out.u32(0);                              // important colours

  // Palette: index 0 = black, index 1 = white (stored B, G, R, reserved).
  out.u8(0); out.u8(0); out.u8(0); out.u8(0);
  out.u8(0xff); out.u8(0xff); out.u8(0xff); out.u8(0);

  // Pixel rows: bottom-up, MSB-first bits, zero-padded to rowBytes.
  const rowBuf = new Uint8Array(rowBytes);
  for (let y = h - 1; y >= 0; y--) {
    rowBuf.fill(0);
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mono[row + x]) rowBuf[x >> 3] |= 0x80 >> (x & 7);
    }
    out.bytes(rowBuf);
  }
  return out.toUint8Array();
}

/* Convenience: RGBA pixels → 1-bit Floyd-Steinberg-dithered BMP bytes. */
function encodeMonoBmpFromRGBA(rgba, w, h) {
  return encodeBmp1bit(floydSteinbergMono(grayFromRGBA(rgba, w, h), w, h), w, h);
}

/* ── Binary output ────────────────────────────────────────────── */

/* panelsWithText: [{box:[x1,y1,x2,y2], textBlocks:[{box:[x1,y1,x2,y2], text}],
 * translation}] — encodes one page's data (convert_manga.py:encode_page).
 * Note: text block boxes are stored as raw corner coordinates, matching the
 * Python tool byte-for-byte. */
function encodePage(panelsWithText) {
  const buf = new ByteWriter(256);
  const panelCount = Math.min(panelsWithText.length, 255);
  buf.u8(panelCount);
  buf.u8(0);

  for (const panel of panelsWithText.slice(0, panelCount)) {
    const [x1, y1, x2, y2] = panel.box;
    const w = x2 - x1, h = y2 - y1;
    const textBlocks = panel.textBlocks || [];
    const textCount = Math.min(textBlocks.length, 255);

    let translationBytes = mangaEncoder.encode(panel.translation || "");
    if (translationBytes.length > 0xffff) translationBytes = translationBytes.subarray(0, 0xffff);

    buf.u16(Math.max(0, x1));
    buf.u16(Math.max(0, y1));
    buf.u16(Math.max(0, w));
    buf.u16(Math.max(0, h));
    buf.u8(textCount);
    buf.u8(0);
    buf.u16(translationBytes.length);
    buf.bytes(translationBytes);

    for (const tb of textBlocks.slice(0, textCount)) {
      const [tx, ty, tw, th] = tb.box;
      let textBytes = mangaEncoder.encode(tb.text);
      if (textBytes.length > 0xffff) textBytes = textBytes.subarray(0, 0xffff);
      buf.u16(Math.max(0, tx));
      buf.u16(Math.max(0, ty));
      buf.u16(Math.max(0, tw));
      buf.u16(Math.max(0, th));
      buf.u16(textBytes.length);
      buf.bytes(textBytes);
    }
  }

  return buf.toUint8Array();
}

/* idxRecords: [{offset, length, w, h}]. Returns panels.idx bytes. */
function writePanelsIdx(idxRecords) {
  const out = new ByteWriter(8 + idxRecords.length * 12);
  out.u32(MANGA_FORMAT_VERSION);
  out.u32(idxRecords.length);
  for (const r of idxRecords) {
    out.u32(r.offset);
    out.u32(r.length);
    out.u16(r.w);
    out.u16(r.h);
  }
  return out.toUint8Array();
}

function writeMetaBin(title, author) {
  if (!title && !author) return null;
  let titleBytes = mangaEncoder.encode(title || "");
  let authorBytes = mangaEncoder.encode(author || "");
  if (titleBytes.length > 0xffff) titleBytes = titleBytes.subarray(0, 0xffff);
  if (authorBytes.length > 0xffff) authorBytes = authorBytes.subarray(0, 0xffff);
  const out = new ByteWriter(8 + titleBytes.length + authorBytes.length);
  out.u32(META_FORMAT_VERSION);
  out.u16(titleBytes.length);
  out.u16(authorBytes.length);
  out.bytes(titleBytes);
  out.bytes(authorBytes);
  return out.toUint8Array();
}

/* entries: [[pageIndex, title], ...]. Returns toc.idx bytes. */
function writeTocIdx(entries, addCover = true) {
  entries = entries.slice().sort((a, b) => a[0] - b[0]);
  if (addCover && (entries.length === 0 || entries[0][0] !== 0)) {
    entries = [[0, "Cover"], ...entries];
  }
  const out = new ByteWriter(64);
  out.u32(TOC_FORMAT_VERSION);
  out.u32(entries.length);
  for (const [pageIndex, title] of entries) {
    let titleBytes = mangaEncoder.encode(title);
    if (titleBytes.length > 0xffff) titleBytes = titleBytes.subarray(0, 0xffff);
    out.u32(pageIndex);
    out.u16(titleBytes.length);
    out.bytes(titleBytes);
  }
  return out.toUint8Array();
}

/* ── EPUB helpers (regex-based, mirroring the Python tool) ────── */

function pathDirname(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.substring(0, i);
}

function pathNorm(p) {
  const parts = p.split("/");
  const out = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else {
      out.push(part);
    }
  }
  return out.join("/") || ".";
}

function pathJoinNorm(dir, rel) {
  return pathNorm(dir ? dir + "/" + rel : rel);
}

/* Parse the OPF path out of META-INF/container.xml. */
function epubOpfPath(containerXml) {
  const m = containerXml.match(/full-path="([^"]+)"/);
  return m ? m[1] : null;
}

/* Returns {manifest: Map(id→href), spineIds: [id, ...]}. */
function epubParseOpf(opf) {
  const manifest = new Map();
  for (const m of opf.matchAll(/<item[^>]*id="([^"]+)"[^>]*href="([^"]+)"/g)) {
    manifest.set(m[1], m[2]);
  }
  for (const m of opf.matchAll(/<item[^>]*href="([^"]+)"[^>]*id="([^"]+)"/g)) {
    manifest.set(m[2], m[1]);
  }
  const spineIds = [...opf.matchAll(/<itemref[^>]*idref="([^"]+)"/g)].map((m) => m[1]);
  return { manifest, spineIds };
}

function epubMetadataFromOpf(opf) {
  let title = "", author = "";
  const t = opf.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/);
  if (t) title = t[1].trim();
  const a = opf.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/);
  if (a) author = a[1].trim();
  return { title, author };
}

function cbzMetadataFromComicInfo(xml) {
  let title = "", author = "";
  const t = xml.match(/<Title>([^<]+)<\/Title>/);
  if (t) title = t[1].trim();
  const a = xml.match(/<Writer>([^<]+)<\/Writer>/);
  if (a) author = a[1].trim();
  return { title, author };
}

/* Extract [(href, title)] entries from an EPUB3 nav document's toc nav. */
function epubTocFromNav(navXhtml, navPath) {
  const navDir = pathDirname(navPath);
  const entries = [];
  const tocM = navXhtml.match(/<nav[^>]*epub:type="toc"[^>]*>([\s\S]*?)<\/nav>/);
  if (!tocM) return entries;
  for (const aM of tocM[1].matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = pathJoinNorm(navDir, aM[1]);
    const title = aM[2].replace(/<[^>]+>/g, "").trim();
    if (title) entries.push([href, title]);
  }
  return entries;
}

/* Extract [(href, title)] entries from an EPUB2 toc.ncx document. */
function epubTocFromNcx(ncx, ncxPath) {
  const ncxDir = pathDirname(ncxPath);
  const entries = [];
  for (const npM of ncx.matchAll(/<navPoint\b[\s\S]*?<\/navPoint>/g)) {
    const block = npM[0];
    const textM = block.match(/<text>([\s\S]*?)<\/text>/);
    const srcM = block.match(/<content[^>]*src="([^"]+)"/);
    if (textM && srcM) {
      const href = pathJoinNorm(ncxDir, srcM[1]);
      const title = textM[1].trim();
      if (title) entries.push([href, title]);
    }
  }
  return entries;
}

/* Find the EPUB3 nav document href in an OPF, or null. */
function epubNavHref(opf) {
  let m = opf.match(/<item[^>]*properties="[^"]*\bnav\b[^"]*"[^>]*href="([^"]+)"/);
  if (m) return m[1];
  m = opf.match(/<item[^>]*href="([^"]+)"[^>]*properties="[^"]*\bnav\b[^"]*"/);
  return m ? m[1] : null;
}

/* Find the EPUB2 NCX href in an OPF, or null. */
function epubNcxHref(opf) {
  const ncxM = opf.match(/<spine[^>]*toc="([^"]+)"/);
  if (!ncxM) return null;
  const ncxId = ncxM[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let hrefM = opf.match(new RegExp(`<item[^>]*id="${ncxId}"[^>]*href="([^"]+)"`));
  if (!hrefM) hrefM = opf.match(new RegExp(`<item[^>]*href="([^"]+)"[^>]*id="${ncxId}"`));
  return hrefM ? hrefM[1] : null;
}

/* Parse the chapters textarea: one per line, "<page_index><TAB or |><title>". */
function parseTocText(text) {
  const entries = [];
  const warnings = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (!line.trim()) continue;
    const sep = line.includes("\t") ? "\t" : "|";
    const idx = line.indexOf(sep);
    if (idx < 0) {
      warnings.push(`Chapter line ${i + 1} not in "<page> ${sep === "\t" ? "TAB" : "|"} <title>" format, skipping`);
      continue;
    }
    const pageIndex = parseInt(line.substring(0, idx).trim(), 10);
    if (!Number.isInteger(pageIndex)) {
      warnings.push(`Chapter line ${i + 1} has a non-integer page index, skipping`);
      continue;
    }
    entries.push([pageIndex, line.substring(idx + 1).trim()]);
  }
  return { entries, warnings };
}

if (typeof module !== "undefined") {
  module.exports = {
    MANGA_FORMAT_VERSION, isImageName, baseName, mangaFileExt,
    naturalSortKey, compareNaturalKeys, naturalSortPaths,
    grayFromRGBA, mergeSmallGaps, detectPanelsGrid, isFullPagePanel,
    floydSteinbergMono, encodeBmp1bit, encodeMonoBmpFromRGBA,
    MANGA_DEVICE_TARGETS, fitToDeviceSize,
    yOverlapFrac, sortPanelsMangaOrder,
    encodePage, writePanelsIdx, writeMetaBin, writeTocIdx,
    pathDirname, pathNorm, pathJoinNorm,
    epubOpfPath, epubParseOpf, epubMetadataFromOpf, cbzMetadataFromComicInfo,
    epubTocFromNav, epubTocFromNcx, epubNavHref, epubNcxHref, parseTocText,
  };
}
