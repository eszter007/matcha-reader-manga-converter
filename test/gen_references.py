#!/usr/bin/env python3
"""Generate reference outputs using the matcha-reader firmware's own Python
conversion tools, for byte-comparison against this repo's JS ports.

Usage:
    MATCHA_READER=/path/to/matcha-reader python3 test/gen_references.py

Produces under test/fixtures/:
    manga_pages/         synthetic PNG pages + raw grayscale (.gray) and RGBA (.rgba) dumps
    ref_manga/           convert_manga.py --no-ocr output
    ref_yolo/boxes.json  YOLO panel boxes (needs numpy + onnxruntime, else skipped)
    yomitan.zip          synthetic Yomitan dictionary
    jmdict.json          synthetic jmdict-simplified JSON
    ref_dict_yomitan/    convert_jmdict.py output + .spx
    ref_dict_jmdict/     convert_jmdict.py output + .spx
"""

import json
import os
import random
import shutil
import subprocess
import sys
import zipfile

from PIL import Image, ImageDraw

FIRMWARE = os.environ.get("MATCHA_READER", os.path.join(os.path.dirname(__file__), "..", "..", "matcha-reader"))
FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def make_manga_pages():
    out = os.path.join(FIXTURES, "manga_pages")
    os.makedirs(out, exist_ok=True)
    rng = random.Random(42)
    dims = {}

    def noise_rect(draw, x1, y1, x2, y2):
        # Dense mid-gray fill so panel interiors never read as white gutters.
        draw.rectangle([x1, y1, x2 - 1, y2 - 1], fill=(150, 150, 150), outline=0, width=3)
        for _ in range(400):
            px = rng.randint(x1 + 4, x2 - 5)
            py = rng.randint(y1 + 4, y2 - 5)
            draw.point((px, py), fill=rng.randint(0, 180))

    # Page 1: 2x2 grid with white gutters.
    img = Image.new("RGB", (800, 1200), "white")
    d = ImageDraw.Draw(img)
    for (x1, y1, x2, y2) in [(30, 30, 390, 580), (410, 30, 770, 580),
                             (30, 620, 390, 1170), (410, 620, 770, 1170)]:
        noise_rect(d, x1, y1, x2, y2)
    img.save(os.path.join(out, "page01.png"))

    # Page 2: one tall panel beside two stacked panels (reading-order test).
    img = Image.new("RGB", (800, 1200), "white")
    d = ImageDraw.Draw(img)
    noise_rect(d, 420, 40, 760, 1160)   # tall right panel (read first)
    noise_rect(d, 40, 40, 380, 580)     # top-left
    noise_rect(d, 40, 640, 380, 1160)   # bottom-left
    img.save(os.path.join(out, "page02.png"))

    # Page 3: borderless full-page art (single panel fallback).
    img = Image.new("RGB", (800, 1200), "white")
    d = ImageDraw.Draw(img)
    for _ in range(6000):
        px = rng.randint(0, 799)
        py = rng.randint(0, 1199)
        d.point((px, py), fill=rng.randint(0, 200))
    img.save(os.path.join(out, "page03.png"))

    # Raw grayscale dumps: exactly what PIL convert("L") feeds the detector.
    # Raw RGBA dumps: exactly what canvas getImageData feeds the YOLO path
    # (PNG decoding is lossless, so browser RGBA matches PIL byte-for-byte).
    for name in sorted(os.listdir(out)):
        if not name.endswith(".png"):
            continue
        img = Image.open(os.path.join(out, name))
        gray = img.convert("L")
        with open(os.path.join(out, name.replace(".png", ".gray")), "wb") as f:
            f.write(gray.tobytes())
        with open(os.path.join(out, name.replace(".png", ".rgba")), "wb") as f:
            f.write(img.convert("RGBA").tobytes())
        dims[name] = list(img.size)
    with open(os.path.join(out, "dims.json"), "w") as f:
        json.dump(dims, f)
    print(f"manga pages: {out}")


def grid_only_env():
    """Environment that forces convert_manga.py onto its grid-heuristic path
    even when ultralytics/huggingface_hub are installed: a stub module that
    raises ImportError shadows the real ones, triggering the tool's own
    fallback. The grid references must stay byte-comparable to the JS grid
    port no matter what the local Python happens to have installed."""
    stub_dir = os.path.join(FIXTURES, "_grid_only_stub")
    os.makedirs(stub_dir, exist_ok=True)
    with open(os.path.join(stub_dir, "huggingface_hub.py"), "w") as f:
        f.write("raise ImportError('YOLO disabled: grid reference generation')\n")
    env = dict(os.environ)
    env["PYTHONPATH"] = stub_dir + os.pathsep + env.get("PYTHONPATH", "")
    return env


def run_manga_reference():
    out = os.path.join(FIXTURES, "ref_manga")
    shutil.rmtree(out, ignore_errors=True)
    script = os.path.join(FIRMWARE, "tools", "manga_convert", "convert_manga.py")
    subprocess.run([sys.executable, script,
                    "--input", os.path.join(FIXTURES, "manga_pages"),
                    "--output-dir", out,
                    "--no-ocr",
                    "--title", "Test Manga", "--author", "Test Author"],
                   check=True, env=grid_only_env())
    print(f"manga reference: {out}")


def make_manga_cbz():
    """CBZ of the synthetic pages, for the browser end-to-end test."""
    path = os.path.join(FIXTURES, "manga.cbz")
    pages = os.path.join(FIXTURES, "manga_pages")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(os.listdir(pages)):
            if name.endswith(".png"):
                z.write(os.path.join(pages, name), name)
    print(f"manga cbz: {path}")


def make_manga_epub():
    """Synthetic fixed-layout EPUB: XHTML spine wrappers around the pages,
    dc: metadata, and an EPUB3 nav TOC. Exercises spine-order extraction,
    metadata auto-detection, and toc.idx generation."""
    path = os.path.join(FIXTURES, "manga.epub")
    pages_dir = os.path.join(FIXTURES, "manga_pages")
    page_files = sorted(n for n in os.listdir(pages_dir) if n.endswith(".png"))

    manifest_items = ['<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>']
    spine_items = []
    for i, name in enumerate(page_files):
        manifest_items.append(f'<item id="pg{i}" href="text/pg{i}.xhtml" media-type="application/xhtml+xml"/>')
        manifest_items.append(f'<item id="img{i}" href="images/{name}" media-type="image/png"/>')
        spine_items.append(f'<itemref idref="pg{i}"/>')

    opf = f'''<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">test-epub</dc:identifier>
    <dc:title>Epub Test Manga</dc:title>
    <dc:creator>Epub Author</dc:creator>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>{"".join(manifest_items)}</manifest>
  <spine>{"".join(spine_items)}</spine>
</package>'''

    nav = f'''<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol>
<li><a href="text/pg0.xhtml">Cover</a></li>
<li><a href="text/pg1.xhtml">Chapter 1</a></li>
<li><a href="text/pg2.xhtml#top">Chapter 2</a></li>
</ol></nav>
</body></html>'''

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("META-INF/container.xml",
                   '<?xml version="1.0"?><container version="1.0" '
                   'xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                   '<rootfiles><rootfile full-path="OEBPS/content.opf" '
                   'media-type="application/oebps-package+xml"/></rootfiles></container>')
        z.writestr("OEBPS/content.opf", opf)
        z.writestr("OEBPS/nav.xhtml", nav)
        for i, name in enumerate(page_files):
            z.writestr(f"OEBPS/text/pg{i}.xhtml",
                       f'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
                       f'<img src="../images/{name}"/></body></html>')
            z.write(os.path.join(pages_dir, name), f"OEBPS/images/{name}")
    print(f"manga epub: {path}")


def run_manga_epub_reference():
    out = os.path.join(FIXTURES, "ref_manga_epub")
    shutil.rmtree(out, ignore_errors=True)
    script = os.path.join(FIRMWARE, "tools", "manga_convert", "convert_manga.py")
    subprocess.run([sys.executable, script,
                    "--input", os.path.join(FIXTURES, "manga.epub"),
                    "--output-dir", out,
                    "--no-ocr"],
                   check=True, env=grid_only_env())
    print(f"manga epub reference: {out}")


def run_yolo_reference():
    """Reference panel boxes for the AI (YOLO) detection path.

    Mirrors js/yolo.js preprocessing/decoding numerically (bilinear letterbox,
    float32 tensor, conf 0.4, class 0) against the same ONNX model the site
    ships (models/manga_panel_detector_yolo26n.onnx), then reuses the firmware
    tool's own is_sliver_panel / _dedupe_boxes / sort_panels_manga_order so
    post-processing semantics can't drift from convert_manga.py.

    Inference backends differ in float rounding, so the JS comparison is
    tolerance-based (±2 px), unlike the byte-exact grid references.
    """
    try:
        import numpy as np
        import onnxruntime as ort
    except ImportError as e:
        print(f"yolo reference: SKIPPED ({e}; pip install numpy onnxruntime)")
        return

    sys.path.insert(0, os.path.join(FIRMWARE, "tools", "manga_convert"))
    import convert_manga

    model_path = os.path.join(os.path.dirname(__file__), "..", "models",
                              "manga_panel_detector_yolo26n.onnx")
    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    size, conf_thresh = 640, 0.4

    def letterbox(rgb):
        h, w = rgb.shape[:2]
        scale = min(size / w, size / h)
        nw, nh = round(w * scale), round(h * scale)
        padx, pady = (size - nw) // 2, (size - nh) // 2
        out = np.full((3, size, size), np.float32(114 / 255), dtype=np.float32)
        ys = np.clip((np.arange(nh) + 0.5) / scale - 0.5, 0, h - 1)
        xs = np.clip((np.arange(nw) + 0.5) / scale - 0.5, 0, w - 1)
        y0 = np.floor(ys).astype(int); y1 = np.minimum(y0 + 1, h - 1)
        x0 = np.floor(xs).astype(int); x1 = np.minimum(x0 + 1, w - 1)
        fy = (ys - y0)[:, None, None]; fx = (xs - x0)[None, :, None]
        p = rgb.astype(np.float64)
        resized = (p[y0][:, x0] * (1 - fy) * (1 - fx) + p[y0][:, x1] * (1 - fy) * fx +
                   p[y1][:, x0] * fy * (1 - fx) + p[y1][:, x1] * fy * fx)
        out[:, pady:pady + nh, padx:padx + nw] = (resized / 255).transpose(2, 0, 1).astype(np.float32)
        return out[None], scale, padx, pady

    pages_dir = os.path.join(FIXTURES, "manga_pages")
    out_dir = os.path.join(FIXTURES, "ref_yolo")
    os.makedirs(out_dir, exist_ok=True)
    result = {}
    for name in sorted(os.listdir(pages_dir)):
        if not name.endswith(".png"):
            continue
        img = Image.open(os.path.join(pages_dir, name)).convert("RGB")
        inp, scale, padx, pady = letterbox(np.asarray(img))
        rows = sess.run(None, {sess.get_inputs()[0].name: inp})[0][0]
        boxes_with_conf = []
        for x1, y1, x2, y2, conf, cls in rows:
            if conf < conf_thresh or round(float(cls)) != 0:
                continue
            box = [int(max(0, min((x1 - padx) / scale, img.width))),
                   int(max(0, min((y1 - pady) / scale, img.height))),
                   int(max(0, min((x2 - padx) / scale, img.width))),
                   int(max(0, min((y2 - pady) / scale, img.height)))]
            if convert_manga.is_sliver_panel(box, img.width, img.height):
                continue
            boxes_with_conf.append((box, float(conf)))
        boxes = convert_manga._dedupe_boxes(boxes_with_conf)
        if not boxes:
            boxes = [[0, 0, img.width, img.height]]
        result[name] = convert_manga.sort_panels_manga_order(boxes)
    with open(os.path.join(out_dir, "boxes.json"), "w") as f:
        json.dump(result, f, indent=1)
    print(f"yolo reference: {out_dir}")
    for name, boxes in result.items():
        print(f"  {name}: {boxes}")


def make_yomitan_zip():
    """Synthetic Yomitan dictionary exercising structured content, redirects,
    readings, list definitions, and priority scores."""
    path = os.path.join(FIXTURES, "yomitan.zip")
    bank1 = [
        # plain string definition
        ["猫", "ねこ", "", "", 5, ["cat; kitty"], 1, ""],
        # structured content with sense groups / tags / examples
        ["食べる", "たべる", "v1", "", 10, [{
            "type": "structured-content",
            "content": [
                {"tag": "span", "data": {"class": "tag", "content": "part-of-speech-info"}, "content": "Ichidan verb"},
                {"tag": "ul", "data": {"content": "glossary"}, "content": [
                    {"tag": "li", "content": "to eat"},
                    {"tag": "li", "content": "to live on (e.g. a salary)"},
                ]},
                {"tag": "div", "data": {"content": "extra-info"}, "content":
                    {"tag": "div", "data": {"content": "example-sentence"}, "class": "extra-box", "content": [
                        {"tag": "div", "data": {"content": "example-sentence-a"}, "content": "ご飯を食べる"},
                        {"tag": "div", "data": {"content": "example-sentence-b"}, "content": "to eat a meal"},
                    ]},
                },
            ],
        }], 2, ""],
        # kana-only entry (reading == headword)
        ["それ", "それ", "", "", 3, ["that; that one"], 3, ""],
        # multiple definitions → numbered
        ["走る", "はしる", "v5r", "", -2, ["to run", "to dash"], 4, ""],
    ]
    bank2 = [
        # redirect entry pointing at 食べる
        ["食べれる", "たべれる", "", "", 1, [{
            "type": "structured-content",
            "content": {"tag": "div", "data": {"content": "redirect-glossary"},
                        "content": "⟶食べる"},
        }], 5, ""],
        # dangling redirect (target missing) — must be skipped
        ["消える語", "きえるご", "", "", 1, [{
            "type": "structured-content",
            "content": {"tag": "div", "data": {"content": "redirect-glossary"},
                        "content": "⟶存在しない"},
        }], 6, ""],
        # list-form definition
        ["引っ張る", "ひっぱる", "", "", 0, [["to pull", ["redirected from 引っぱる"]]], 7, ""],
    ]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("index.json", json.dumps({"title": "Test Dict", "format": 3}))
        z.writestr("term_bank_1.json", json.dumps(bank1, ensure_ascii=False))
        z.writestr("term_bank_2.json", json.dumps(bank2, ensure_ascii=False))
    print(f"yomitan zip: {path}")


def make_jmdict_json():
    path = os.path.join(FIXTURES, "jmdict.json")
    data = {"words": [
        {"kanji": [{"text": "犬", "common": True}],
         "kana": [{"text": "いぬ", "common": True}],
         "sense": [{"gloss": [{"text": "dog"}]}]},
        {"kanji": [{"text": "山", "common": False}, {"text": "峰", "common": False}],
         "kana": [{"text": "やま", "common": False}],
         "sense": [{"gloss": [{"text": "mountain"}, {"text": "hill"}]},
                   {"gloss": [{"text": "heap"}, {"text": "pile"}]}]},
        {"kanji": [],
         "kana": [{"text": "とても", "common": True}],
         "sense": [{"gloss": [{"text": "very"}, {"text": "awfully"}, {"text": "exceedingly"},
                              {"text": "extremely"}, {"text": "dropped-5th"}]}]},
    ]}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"jmdict json: {path}")


def run_dict_references():
    script = os.path.join(FIRMWARE, "tools", "dict_convert", "convert_jmdict.py")
    spx_script = os.path.join(FIRMWARE, "scripts", "gen_dict_spx.py")

    for name, args in [("ref_dict_yomitan", ["--input", os.path.join(FIXTURES, "yomitan.zip")]),
                       ("ref_dict_jmdict", ["--input", os.path.join(FIXTURES, "jmdict.json")])]:
        out = os.path.join(FIXTURES, name)
        shutil.rmtree(out, ignore_errors=True)
        subprocess.run([sys.executable, script, *args, "--output-dir", out], check=True)
        subprocess.run([sys.executable, spx_script, out], check=True)
        print(f"dict reference: {out}")


if __name__ == "__main__":
    os.makedirs(FIXTURES, exist_ok=True)
    make_manga_pages()
    run_manga_reference()
    run_yolo_reference()
    make_manga_cbz()
    make_manga_epub()
    run_manga_epub_reference()
    make_yomitan_zip()
    make_jmdict_json()
    run_dict_references()
    print("done")
