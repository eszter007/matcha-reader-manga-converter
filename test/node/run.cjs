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
  await testMangaYolo();
  await testDictYomitan();
  testDictJmdict();
  await testZipRoundTrip();
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nall tests passed");
})();
