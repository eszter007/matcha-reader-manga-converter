#!/usr/bin/env node
/* Byte-compares the JS converters' output against reference files produced
 * by the matcha-reader firmware's Python tools (see ../gen_references.py). */
"use strict";

const fs = require("fs");
const path = require("path");

const FIXTURES = path.join(__dirname, "..", "fixtures");

// The site's scripts are classic <script> files sharing globals; recreate
// that environment for Node.
const binary = require("../../js/binary.js");
global.ByteWriter = binary.ByteWriter;
global.compareBytes = binary.compareBytes;
global.bytesEqual = binary.bytesEqual;
const zip = require("../../js/zip.js");
const dict = require("../../js/dict.js");
const manga = require("../../js/manga-core.js");

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
    failures++;
  }
}

function compareFile(name, actual, refPath) {
  const ref = new Uint8Array(fs.readFileSync(refPath));
  if (ref.length !== actual.length) {
    check(name, false, `size ${actual.length} != reference ${ref.length}`);
    return;
  }
  for (let i = 0; i < ref.length; i++) {
    if (ref[i] !== actual[i]) {
      check(name, false, `first difference at byte ${i} (0x${actual[i].toString(16)} != 0x${ref[i].toString(16)})`);
      return;
    }
  }
  check(name, true);
}

/* ── Manga: grid detection + binary output vs convert_manga.py ── */

function testManga() {
  console.log("manga converter (vs convert_manga.py --no-ocr):");
  const pagesDir = path.join(FIXTURES, "manga_pages");
  const refDir = path.join(FIXTURES, "ref_manga");
  const dims = JSON.parse(fs.readFileSync(path.join(pagesDir, "dims.json"), "utf-8"));

  const names = manga.naturalSortPaths(Object.keys(dims));
  const idxRecords = [];
  const datChunks = [];
  let datOffset = 0;

  for (const name of names) {
    const [w, h] = dims[name];
    const gray = new Uint8Array(fs.readFileSync(path.join(pagesDir, name.replace(".png", ".gray"))));
    let boxes = manga.detectPanelsGrid(gray, w, h);
    boxes = manga.sortPanelsMangaOrder(boxes);
    const panelsWithText = boxes.map((box) => ({ box, textBlocks: [], translation: "" }));
    const pageData = manga.encodePage(panelsWithText);
    idxRecords.push({ offset: datOffset, length: pageData.length, w: Math.min(w, 0xffff), h: Math.min(h, 0xffff) });
    datChunks.push(pageData);
    datOffset += pageData.length;
  }

  compareFile("panels.idx", manga.writePanelsIdx(idxRecords), path.join(refDir, "panels.idx"));
  const dat = new Uint8Array(datOffset);
  let off = 0;
  for (const c of datChunks) { dat.set(c, off); off += c.length; }
  compareFile("panels.dat", dat, path.join(refDir, "panels.dat"));
  compareFile("meta.bin", manga.writeMetaBin("Test Manga", "Test Author"), path.join(refDir, "meta.bin"));

  // The reference run should have produced renamed page copies too.
  for (let i = 0; i < names.length; i++) {
    const pageName = `page_${String(i).padStart(4, "0")}.png`;
    check(`reference has ${pageName}`, fs.existsSync(path.join(refDir, pageName)));
  }

  // Reading-order sort: one tall right panel beside two stacked left panels
  // (the mixed-size layout simple row-clustering gets wrong). The tall right
  // panel reads first, then top-left, then bottom-left.
  const tall = [420, 40, 760, 1160], topLeft = [40, 40, 380, 580], bottomLeft = [40, 640, 380, 1160];
  const order = manga.sortPanelsMangaOrder([bottomLeft, tall, topLeft]);
  check("reading order tall-right first", order[0] === tall && order[1] === topLeft && order[2] === bottomLeft);
  // Plain 2x2 grid reads right-to-left, top-to-bottom.
  const tl = [0, 0, 100, 100], tr = [110, 0, 210, 100], bl = [0, 110, 100, 210], br = [110, 110, 210, 210];
  const grid = manga.sortPanelsMangaOrder([tl, tr, bl, br]);
  check("2x2 grid order", grid[0] === tr && grid[1] === tl && grid[2] === br && grid[3] === bl);
}

/* ── Manga: 1-bit Floyd-Steinberg BMP output (--mono) ─────────── */

/* Decode the structural fields and unpack the bits of a 1-bit BMP the way the
 * device's Bitmap reader does (MSB-first, bottom-up, 4-byte row stride). */
function decodeBmp1bit(bmp) {
  const dv = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
  const offBits = dv.getUint32(10, true);
  const width = dv.getInt32(18, true);
  const height = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true);
  const comp = dv.getUint32(30, true);
  const colorsUsed = dv.getUint32(46, true);
  const rowBytes = ((width + 31) >> 5) << 2;
  const mono = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const srcRow = offBits + (height - 1 - y) * rowBytes; // bottom-up
    for (let x = 0; x < width; x++) {
      const bit = bmp[srcRow + (x >> 3)] & (0x80 >> (x & 7));
      mono[y * width + x] = bit ? 1 : 0;
    }
  }
  return { magic: bmp[0] === 0x42 && bmp[1] === 0x4d, offBits, width, height, bpp, comp, colorsUsed, rowBytes, mono };
}

function testMangaMono() {
  console.log("manga 1-bit BMP output (--mono / Floyd-Steinberg):");

  // Solid inputs must dither to a uniform field regardless of size.
  const w = 13, h = 7;                       // width forces row padding (13 → 4-byte stride)
  const white = new Uint8Array(w * h).fill(255);
  const black = new Uint8Array(w * h).fill(0);
  check("solid white → all 1s", manga.floydSteinbergMono(white, w, h).every((v) => v === 1));
  check("solid black → all 0s", manga.floydSteinbergMono(black, w, h).every((v) => v === 0));

  // BMP structure the device relies on: BI_RGB, 1 bpp, 2-colour palette, and a
  // 4-byte-aligned row stride (13px → 4 bytes, not 2).
  const mono = manga.floydSteinbergMono(white, w, h);
  const bmp = manga.encodeBmp1bit(mono, w, h);
  const d = decodeBmp1bit(bmp);
  check("BMP magic 'BM'", d.magic);
  check("BMP is 1 bpp", d.bpp === 1, `got ${d.bpp}`);
  check("BMP is BI_RGB", d.comp === 0, `got ${d.comp}`);
  check("BMP width/height", d.width === w && d.height === h, `got ${d.width}x${d.height}`);
  check("BMP palette 2 colours", d.colorsUsed === 2, `got ${d.colorsUsed}`);
  check("BMP row stride padded to 4", d.rowBytes === 4, `got ${d.rowBytes}`);
  check("BMP total size", bmp.length === 62 + d.rowBytes * h, `got ${bmp.length}`);

  // Bits round-trip through the device's unpacking exactly.
  const monoBack = decodeBmp1bit(manga.encodeBmp1bit(mono, w, h)).mono;
  check("mono bits round-trip", monoBack.every((v, i) => v === mono[i]));

  // A vertical split (left black, right white) survives dithering and packing:
  // the left half stays black, the right half stays white.
  const split = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) split[y * w + x] = x < w >> 1 ? 0 : 255;
  const splitBack = decodeBmp1bit(manga.encodeBmp1bit(manga.floydSteinbergMono(split, w, h), w, h)).mono;
  let leftBlack = true, rightWhite = true;
  for (let y = 0; y < h; y++) {
    if (splitBack[y * w + 0] !== 0) leftBlack = false;
    if (splitBack[y * w + (w - 1)] !== 1) rightWhite = false;
  }
  check("split page: left edge black", leftBlack);
  check("split page: right edge white", rightWhite);

  // RGBA convenience path packs the same bytes as gray → dither → encode.
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255; }
  const viaRgba = manga.encodeMonoBmpFromRGBA(rgba, w, h);
  const viaGray = manga.encodeBmp1bit(manga.floydSteinbergMono(manga.grayFromRGBA(rgba, w, h), w, h), w, h);
  check("encodeMonoBmpFromRGBA matches manual path", binary.bytesEqual(viaRgba, viaGray));
}

/* ── Manga: YOLO panel detection vs Python reference ──────────── */

async function testMangaYolo() {
  console.log("manga YOLO panel detection (vs ref_yolo/boxes.json):");
  const refPath = path.join(FIXTURES, "ref_yolo", "boxes.json");
  if (!fs.existsSync(refPath)) {
    console.log("  skip (no ref_yolo fixtures — rerun gen_references.py with numpy + onnxruntime installed)");
    return;
  }
  let ort;
  try {
    ort = require("onnxruntime-web");
  } catch {
    console.log("  skip (npm install onnxruntime-web)");
    return;
  }
  const yolo = require("../../js/yolo.js");
  const model = new Uint8Array(fs.readFileSync(path.join(__dirname, "..", "..", "models", "manga_panel_detector_yolo26n.onnx")));
  const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });

  const pagesDir = path.join(FIXTURES, "manga_pages");
  const dims = JSON.parse(fs.readFileSync(path.join(pagesDir, "dims.json"), "utf-8"));
  const ref = JSON.parse(fs.readFileSync(refPath, "utf-8"));

  // Inference backends round floats differently, so unlike the byte-exact
  // grid comparisons this is tolerance-based: same panels, same reading
  // order, coordinates within ±2 px.
  const TOL = 2;
  for (const name of Object.keys(ref)) {
    const [w, h] = dims[name];
    const rgba = new Uint8Array(fs.readFileSync(path.join(pagesDir, name.replace(".png", ".rgba"))));
    let boxes = await yolo.detectPanelsYolo(session, ort, rgba, w, h);
    boxes = manga.sortPanelsMangaOrder(boxes);
    const expected = ref[name];
    if (boxes.length !== expected.length) {
      check(`${name} panel count`, false, `got ${boxes.length}, reference ${expected.length}`);
      continue;
    }
    const ok = boxes.every((b, i) => b.every((v, j) => Math.abs(v - expected[i][j]) <= TOL));
    check(`${name} ${boxes.length} panel(s) within ±${TOL}px`, ok,
          ok ? "" : `got ${JSON.stringify(boxes)}, reference ${JSON.stringify(expected)}`);
  }
}

/* ── Dictionary: vs convert_jmdict.py + gen_dict_spx.py ───────── */

async function testDictYomitan() {
  console.log("dictionary converter, Yomitan (vs convert_jmdict.py):");
  const refDir = path.join(FIXTURES, "ref_dict_yomitan");
  const zr = new zip.ZipReader(new Uint8Array(fs.readFileSync(path.join(FIXTURES, "yomitan.zip"))));
  const bankEntries = zr.entries
    .filter((e) => /^term_bank_\d+\.json$/.test(e.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const banks = [];
  for (const e of bankEntries) {
    banks.push(JSON.parse(new TextDecoder().decode(await zr.readEntry(e))));
  }
  const { records } = dict.convertYomitanRecords(banks);
  const { idx, dat } = dict.dictWriteBinary(records);
  compareFile("jmdict.idx", idx, path.join(refDir, "jmdict.idx"));
  compareFile("jmdict.dat", dat, path.join(refDir, "jmdict.dat"));
  compareFile("jmdict.spx", dict.dictGenSpx(idx), path.join(refDir, "jmdict.spx"));
}

async function testDictMdx() {
  console.log("dictionary converter, MDict .mdx (vs readmdict + convert_jmdict.py):");
  if (!fs.existsSync(path.join(FIXTURES, "dict.mdx"))) {
    console.log("  skip (no MDX fixtures — rerun gen_references.py with readmdict + python-lzo installed)");
    return;
  }
  const mdx = require("../../js/mdx.js");
  const refDir = path.join(FIXTURES, "ref_dict_mdx");
  // Three variants of the same content: plain zlib (+ one uncompressed
  // record block), Encrypted=2 key index, and LZO-compressed blocks — all
  // must produce the same bytes as the Python reference.
  for (const name of ["dict.mdx", "dict_enc.mdx", "dict_lzo.mdx"]) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
    const { records } = await mdx.convertMdictRecords(bytes);
    const { idx, dat } = dict.dictWriteBinary(records);
    compareFile(`${name} → jmdict.idx`, idx, path.join(refDir, "jmdict.idx"));
    compareFile(`${name} → jmdict.dat`, dat, path.join(refDir, "jmdict.dat"));
    compareFile(`${name} → jmdict.spx`, dict.dictGenSpx(idx), path.join(refDir, "jmdict.spx"));
  }

  // Registration-encrypted (Encrypted=1): the owner passcode decrypts the
  // keyword header (Salsa20/8); without it the readmdict-style key-block
  // scan recovers the same content.
  const regBytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, "dict_reg.mdx")));
  const passcode = { regcode: Uint8Array.from({ length: 16 }, (_, i) => i), userid: "test@example.com" };
  let reg = await mdx.convertMdictRecords(regBytes, null, { passcode });
  check("dict_reg.mdx decrypted via passcode", reg.keysReadVia === "passcode", `got ${reg.keysReadVia}`);
  compareFile("dict_reg.mdx (passcode) → jmdict.idx", dict.dictWriteBinary(reg.records).idx, path.join(refDir, "jmdict.idx"));
  reg = await mdx.convertMdictRecords(regBytes);
  check("dict_reg.mdx recovered via scan", reg.keysReadVia === "brutal", `got ${reg.keysReadVia}`);
  compareFile("dict_reg.mdx (no passcode) → jmdict.idx", dict.dictWriteBinary(reg.records).idx, path.join(refDir, "jmdict.idx"));
}

function testDictJmdict() {
  console.log("dictionary converter, JMdict JSON (vs convert_jmdict.py):");
  const refDir = path.join(FIXTURES, "ref_dict_jmdict");
  const data = JSON.parse(fs.readFileSync(path.join(FIXTURES, "jmdict.json"), "utf-8"));
  const records = dict.convertJmdictRecords(data);
  const { idx, dat } = dict.dictWriteBinary(records);
  compareFile("jmdict.idx", idx, path.join(refDir, "jmdict.idx"));
  compareFile("jmdict.dat", dat, path.join(refDir, "jmdict.dat"));
  compareFile("jmdict.spx", dict.dictGenSpx(idx), path.join(refDir, "jmdict.spx"));
}

/* ── Zip writer round-trip via our own reader ─────────────────── */

async function testZipRoundTrip() {
  console.log("zip writer round-trip:");
  const zw = new zip.ZipWriter();
  const payloadA = new TextEncoder().encode("hello matcha");
  const payloadB = new Uint8Array(70000).map((_, i) => i % 251);
  zw.addFile("Folder/ページ.txt", payloadA);
  zw.addFile("Folder/big.bin", payloadB);
  const blob = zw.toBlob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const zr = new zip.ZipReader(bytes);
  check("entry count", zr.entries.length === 2, `got ${zr.entries.length}`);
  check("utf-8 name", zr.findEntry("Folder/ページ.txt") !== null);
  const a = await zr.readEntryByName("Folder/ページ.txt");
  const b = await zr.readEntryByName("Folder/big.bin");
  check("payload A", binary.bytesEqual(a, payloadA));
  check("payload B", binary.bytesEqual(b, payloadB));
}

(async () => {
  testManga();
  testMangaMono();
  await testMangaYolo();
  await testDictYomitan();
  testDictJmdict();
  await testDictMdx();
  await testZipRoundTrip();
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nall tests passed");
})();
