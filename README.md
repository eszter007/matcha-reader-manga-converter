# 🍵 Matcha Reader Tools

Browser-based converters for the [Matcha Reader](https://github.com/eszter007/matcha-reader)
e-reader firmware (a CrossPoint Reader fork with Japanese learning features). Everything runs
client-side — **no installs, no uploads, works from a smartphone**. Your files never leave your
device, except manga panel images sent to Google's Gemini API when you supply your own API key
for OCR.

**Three tools:**

| Tool | Input | Output |
|---|---|---|
| 📖 **Manga Converter** | CBZ / ZIP / EPUB / page images | Manga folder: renamed pages, panel crops, `panels.idx`/`panels.dat` (with OCR text + English translations), `meta.bin`, `toc.idx` |
| 📚 **Dictionary Converter** | Yomitan `.zip` (Jitendex, JMnedict, grammar) or jmdict-simplified `.json`/`.json.tgz` | `dict/<name>.idx` + `.dat` + `.spx` lookup accelerator |
| 🔤 **Font Converter** | TTF / OTF (up to 4 styles + fallback font) | `.fonts/<Family>/<Family>_<size>.cpfont` (v4, with kerning + ligatures) |

Each tool downloads a zip already laid out for the SD card: unzip it onto the card, or upload the
files from your phone via the reader's built-in Wi-Fi web file transfer — no computer needed.

## Hosting / running

It's a static site with no build step. Any static host works:

- **GitHub Pages**: enable Pages for this repo (Settings → Pages → Source: *GitHub Actions*).
  The included workflow (`.github/workflows/pages.yml`) deploys on every push to `main`.
- **Locally**: `python3 -m http.server` in the repo root, then open `http://localhost:8000`.

## Fidelity to the firmware's Python tools

These are ports of the firmware's conversion scripts, not reimplementations from the spec:

- **Manga** ports `tools/manga_convert/convert_manga.py` (AI panel detection, white-gutter grid
  fallback, reading-order topological sort, Gemini panel OCR with the same prompt/model/retry
  behaviour, and the same binary writers). Given identical input pixels and the grid detector,
  the binary output is **byte-identical** to the Python tool. AI panel detection runs the *same*
  fine-tuned YOLO26 model as the Python tool
  ([leoxs22/manga-panel-detector-yolo26n](https://huggingface.co/leoxs22/manga-panel-detector-yolo26n),
  exported to ONNX in `models/`) in-browser via a vendored ONNX Runtime Web — no PyTorch, no
  server; the ~21 MB (runtime + model) loads lazily on first use and is cached by the browser.
  Detected boxes match the Python tool's within a pixel or two (float rounding differs across
  inference backends); post-processing (confidence 0.4, sliver filter, overlap dedupe, reading
  order) is identical. Untick *AI panel detection* to force the grid heuristic, which is also
  the automatic fallback wherever WebAssembly or the download fails. PDF input still needs the
  desktop tool.
- **Dictionary** ports `tools/dict_convert/convert_jmdict.py` and `scripts/gen_dict_spx.py`
  **byte-identically** (JMdict-simplified JSON and Yomitan zip inputs; MDict `.mdx` needs the
  desktop tool).
- **Fonts** ports `lib/EpdFont/scripts/fontconvert_sdcard.py` (.cpfont v4). Everything read from
  the font file — cmap intervals, advance widths, kerning classes/matrix, ligature tables —
  matches the Python tool byte-for-byte. Glyph bitmaps are rasterized by the browser's font
  engine instead of FreeType, so pixel edges differ very slightly (typically within antialiasing
  noise; verified within ±2px on bitmap metrics).

## Tests

The test suite generates reference outputs with the actual firmware Python tools and compares
bytes. It needs a checkout of the firmware repo next door (or set `MATCHA_READER=/path/to/repo`):

```bash
pip install Pillow freetype-py fonttools    # for reference generation
pip install numpy onnxruntime               # optional: YOLO panel-detection references
python3 test/gen_references.py             # build fixtures + Python references

npm install onnxruntime-web                # optional: YOLO detection in the Node tests
node test/node/run.cjs                     # pure-logic byte comparisons (Node ≥ 18)

npm install playwright                     # browser end-to-end (drives the real pages)
python3 /path/to/matcha-reader/lib/EpdFont/scripts/fontconvert_sdcard.py \
  --intervals latin-ext --size 14 --style regular \
  /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
  -o test/fixtures/ref_font/DejaVuSans_14.cpfont
node test/browser/e2e.mjs
```

## Notes & limits

- **Gemini OCR** requires your own API key (free tier works, but rate limits make long volumes
  slow — the converter retries with backoff, keeps the screen awake, and pressing *Stop* still
  packages every fully-converted page). The key is kept in `localStorage` and sent only to
  Google's API endpoint.
- **Memory**: pages are processed one at a time, but the output zip is assembled in memory —
  very large volumes (many hundreds of MB) may struggle on low-RAM phones.
- Browsers with `DecompressionStream` are required (Chrome/Edge ≥ 80, Safari ≥ 16.4,
  Firefox ≥ 113).

## License

MIT — see [LICENSE](LICENSE).
