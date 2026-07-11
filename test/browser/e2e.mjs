#!/usr/bin/env node
/* End-to-end tests: drive the real pages in Chromium via Playwright.
 *
 *   - fonts.html: convert DejaVuSans.ttf at 14pt/latin-ext, then compare the
 *     .cpfont structurally against the Python reference (test/font_compare.py).
 *   - manga.html: convert a CBZ of the synthetic pages with OCR skipped and
 *     byte-compare panels.idx/panels.dat against the Python reference.
 *
 * Prereqs: `python3 test/gen_references.py` has been run, and the reference
 * .cpfont exists (see test/README.md).
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const OUT = path.join(FIXTURES, "e2e_out");
const FONT_PATH = process.env.TEST_FONT || "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
               ".css": "text/css", ".wasm": "application/wasm" };

function serve(rootDir) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(rootDir, p);
    if (!file.startsWith(rootDir) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); failures++; }
}

async function downloadFromPage(page, action) {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 300000 }), action()]);
  const target = path.join(OUT, download.suggestedFilename());
  await download.saveAs(target);
  return target;
}

function unzipTo(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync("python3", ["-c", `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z: z.extractall(sys.argv[2])
`, zipFile, destDir]);
}

function filesEqual(a, b) {
  const ba = fs.readFileSync(a), bb = fs.readFileSync(b);
  return ba.length === bb.length && ba.equals(bb);
}

async function testFonts(page, base) {
  console.log("fonts.html end-to-end:");
  await page.goto(`${base}/fonts.html`);
  await page.setInputFiles("#font-regular", FONT_PATH);
  for (const size of [12, 16, 18]) await page.uncheck(`#font-size-${size}`);
  // latin-ext is checked by default — matches the Python reference run.
  const zipFile = await downloadFromPage(page, () => page.click("#font-run"));
  const dest = path.join(OUT, "font");
  unzipTo(zipFile, dest);
  const cpfont = path.join(dest, ".fonts", "DejaVuSans", "DejaVuSans_14.cpfont");
  check("cpfont produced at expected path", fs.existsSync(cpfont));
  if (fs.existsSync(cpfont)) {
    let result;
    try {
      result = execFileSync("python3", [
        path.join(ROOT, "test", "font_compare.py"),
        path.join(FIXTURES, "ref_font", "DejaVuSans_14.cpfont"), cpfont,
      ], { encoding: "utf-8" });
    } catch (e) {
      result = (e.stdout || "") + (e.stderr || "");
    }
    process.stdout.write(result.split("\n").map((l) => "    " + l).join("\n") + "\n");
    check("cpfont structural comparison", result.includes("STRUCTURAL MATCH"));
  }
}

async function testManga(page, base) {
  console.log("manga.html end-to-end (CBZ, no OCR, grid detection):");
  await page.goto(`${base}/manga.html`);
  await page.setInputFiles("#manga-file", path.join(FIXTURES, "manga.cbz"));
  await page.check("#manga-no-ocr");
  await page.uncheck("#manga-yolo"); // byte-exact references use the grid path
  await page.fill("#manga-title", "Test Manga");
  await page.fill("#manga-author", "Test Author");
  const zipFile = await downloadFromPage(page, () => page.click("#manga-run"));
  const dest = path.join(OUT, "manga");
  unzipTo(zipFile, dest);
  const dir = path.join(dest, "Test Manga");
  for (const f of ["panels.idx", "panels.dat", "meta.bin"]) {
    const ref = path.join(FIXTURES, "ref_manga", f);
    const got = path.join(dir, f);
    check(`${f} matches Python reference`, fs.existsSync(got) && filesEqual(ref, got));
  }
  for (let i = 0; i < 3; i++) {
    const name = `page_${String(i).padStart(4, "0")}.png`;
    check(`${name} copied`, fs.existsSync(path.join(dir, name)));
  }
}

/* Parse the panel rectangles back out of panels.idx/panels.dat (no-OCR
 * layout: per page u8 count, u8 pad, then 12-byte panel records). */
function parsePanelBoxes(dir) {
  const idx = fs.readFileSync(path.join(dir, "panels.idx"));
  const dat = fs.readFileSync(path.join(dir, "panels.dat"));
  const pageCount = idx.readUInt32LE(4);
  const pages = [];
  for (let p = 0; p < pageCount; p++) {
    let off = idx.readUInt32LE(8 + p * 12);
    const count = dat.readUInt8(off);
    off += 2;
    const boxes = [];
    for (let i = 0; i < count; i++) {
      const x = dat.readUInt16LE(off), y = dat.readUInt16LE(off + 2);
      const w = dat.readUInt16LE(off + 4), h = dat.readUInt16LE(off + 6);
      boxes.push([x, y, x + w, y + h]);
      off += 12;
    }
    pages.push(boxes);
  }
  return pages;
}

async function testMangaYolo(page, base) {
  console.log("manga.html end-to-end (CBZ, no OCR, AI panel detection):");
  const refPath = path.join(FIXTURES, "ref_yolo", "boxes.json");
  if (!fs.existsSync(refPath)) {
    console.log("  skip (no ref_yolo fixtures — rerun gen_references.py with numpy + onnxruntime installed)");
    return;
  }
  const ref = JSON.parse(fs.readFileSync(refPath, "utf-8"));
  await page.goto(`${base}/manga.html`);
  await page.setInputFiles("#manga-file", path.join(FIXTURES, "manga.cbz"));
  await page.check("#manga-no-ocr");
  await page.check("#manga-yolo");
  await page.fill("#manga-title", "Yolo Manga");
  const zipFile = await downloadFromPage(page, () => page.click("#manga-run"));
  const dest = path.join(OUT, "manga_yolo");
  unzipTo(zipFile, dest);
  const pages = parsePanelBoxes(path.join(dest, "Yolo Manga"));
  const names = Object.keys(ref).sort();
  check("page count", pages.length === names.length, `got ${pages.length}`);
  // Same tolerance rationale as the Node test: inference backends round
  // floats differently, so ±2 px rather than byte-exact.
  const TOL = 2;
  for (let p = 0; p < names.length && p < pages.length; p++) {
    const expected = ref[names[p]];
    const got = pages[p];
    const ok = got.length === expected.length &&
               got.every((b, i) => b.every((v, j) => Math.abs(v - expected[i][j]) <= TOL));
    check(`${names[p]} ${expected.length} panel(s) within ±${TOL}px`, ok,
          ok ? "" : `got ${JSON.stringify(got)}, reference ${JSON.stringify(expected)}`);
  }
}

async function testMangaEpub(page, base) {
  console.log("manga.html end-to-end (EPUB with nav TOC, no OCR):");
  await page.goto(`${base}/manga.html`);
  await page.setInputFiles("#manga-file", path.join(FIXTURES, "manga.epub"));
  await page.check("#manga-no-ocr");
  await page.uncheck("#manga-yolo");
  const zipFile = await downloadFromPage(page, () => page.click("#manga-run"));
  const dest = path.join(OUT, "manga_epub");
  unzipTo(zipFile, dest);
  const dir = path.join(dest, "Epub Test Manga"); // title from dc:title
  for (const f of ["panels.idx", "panels.dat", "meta.bin", "toc.idx"]) {
    const ref = path.join(FIXTURES, "ref_manga_epub", f);
    const got = path.join(dir, f);
    check(`${f} matches Python reference`, fs.existsSync(got) && filesEqual(ref, got));
  }
}

async function testDict(page, base) {
  console.log("dictionary.html end-to-end (Yomitan zip):");
  await page.goto(`${base}/dictionary.html`);
  await page.setInputFiles("#dict-file", path.join(FIXTURES, "yomitan.zip"));
  const zipFile = await downloadFromPage(page, () => page.click("#dict-run"));
  const dest = path.join(OUT, "dict");
  unzipTo(zipFile, dest);
  for (const ext of ["idx", "dat", "spx"]) {
    const ref = path.join(FIXTURES, "ref_dict_yomitan", `jmdict.${ext}`);
    const got = path.join(dest, "dict", `jmdict.${ext}`);
    check(`jmdict.${ext} matches Python reference`, fs.existsSync(got) && filesEqual(ref, got));
  }
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve(ROOT);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  page.on("pageerror", (e) => { console.error("  page error:", e.message); failures++; });

  try {
    await testManga(page, base);
    await testMangaYolo(page, base);
    await testMangaEpub(page, base);
    await testDict(page, base);
    await testFonts(page, base);
  } finally {
    await browser.close();
    server.close();
  }
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nall e2e tests passed");
})();
