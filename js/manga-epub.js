/* Manga EPUB export: builds a portable, fixed-layout EPUB 3 so a converted
 * volume reads on any e-reader/app that lacks Matcha's native panel format.
 *
 * Layout is one image per spine page (pre-paginated / fixed-layout, so each
 * image is scaled to fill the screen with its aspect ratio preserved). Per
 * manga page the spine holds the full page first, then each detected panel —
 * wide panels are rotated to portrait by the caller so they display as large
 * as possible. The source chapter list is carried over into the EPUB's nav +
 * ncx table of contents, and the spine reads right-to-left like manga.
 *
 * This file is pure string logic (no DOM/canvas), so the Node tests can build
 * and inspect an EPUB directly; the browser pipeline (image decode, panel
 * rotation, zip assembly) lives in manga-ui.js. */
"use strict";

const EPUB_MIMETYPE = "application/epub+zip";
/* Fixed modified-timestamp keeps output deterministic, like ZipWriter's clock. */
const EPUB_MODIFIED = "2026-01-01T00:00:00Z";

function xmlEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/* File extension for an image media type used in EPUB image hrefs. */
function epubImageExt(mime) {
  return mime === "image/png" ? "png" : "jpg";
}

function epubContainerXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
}

function epubStyleCss() {
  // Fill the fixed-layout viewport; black matte behind any letterboxing.
  // object-fit:contain keeps the aspect ratio even on readers that don't size
  // the viewport to the image exactly (or fall back to a reflowable render).
  return `@page { margin: 0; }
html, body { margin: 0; padding: 0; height: 100%; }
body { background: #000; }
.page { margin: 0; padding: 0; text-align: center; }
.page img { display: block; width: 100%; height: 100%; object-fit: contain; }
`;
}

/* One fixed-layout page: a single image sized to the page viewport. imgHref is
 * relative to OEBPS/ (e.g. "images/p0000_0.jpg"); the page lives in OEBPS/text/
 * so it references the image one directory up. */
function epubPageXhtml({ title, imgHref, w, h, language }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xmlEscape(language)}" xml:lang="${xmlEscape(language)}">
<head>
  <meta charset="utf-8"/>
  <title>${xmlEscape(title)}</title>
  <meta name="viewport" content="width=${w}, height=${h}"/>
  <link rel="stylesheet" type="text/css" href="../style.css"/>
</head>
<body>
  <section class="page"><img src="../${xmlEscape(imgHref)}" alt="" width="${w}" height="${h}"/></section>
</body>
</html>
`;
}

function epubContentOpf({ identifier, title, author, language, spine, coverImgId }) {
  const metaLines = [
    `    <dc:identifier id="bookid">${xmlEscape(identifier)}</dc:identifier>`,
    `    <dc:title>${xmlEscape(title || "Manga")}</dc:title>`,
  ];
  if (author) metaLines.push(`    <dc:creator>${xmlEscape(author)}</dc:creator>`);
  metaLines.push(`    <dc:language>${xmlEscape(language)}</dc:language>`);
  metaLines.push(`    <meta property="dcterms:modified">${EPUB_MODIFIED}</meta>`);
  metaLines.push(`    <meta property="rendition:layout">pre-paginated</meta>`);
  metaLines.push(`    <meta property="rendition:spread">auto</meta>`);
  if (coverImgId) metaLines.push(`    <meta name="cover" content="${coverImgId}"/>`);

  const manifest = [
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `    <item id="css" href="style.css" media-type="text/css"/>`,
  ];
  const spineRefs = [];
  for (const s of spine) {
    manifest.push(`    <item id="${s.xhtmlId}" href="${s.xhtmlHref}" media-type="application/xhtml+xml"/>`);
    manifest.push(`    <item id="${s.imgId}" href="${s.imgHref}" media-type="${s.mime}"${s.isCover ? ` properties="cover-image"` : ""}/>`);
    spineRefs.push(`    <itemref idref="${s.xhtmlId}"/>`);
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${xmlEscape(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${metaLines.join("\n")}
  </metadata>
  <manifest>
${manifest.join("\n")}
  </manifest>
  <spine toc="ncx" page-progression-direction="rtl">
${spineRefs.join("\n")}
  </spine>
</package>
`;
}

function epubNavXhtml({ title, language, chapters }) {
  const items = chapters
    .map((c) => `      <li><a href="${xmlEscape(c.href)}">${xmlEscape(c.title)}</a></li>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xmlEscape(language)}" xml:lang="${xmlEscape(language)}">
<head>
  <meta charset="utf-8"/>
  <title>${xmlEscape(title || "Contents")}</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${xmlEscape(title || "Contents")}</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>
`;
}

function epubTocNcx({ identifier, title, chapters }) {
  const points = chapters
    .map((c, i) => `    <navPoint id="np${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${xmlEscape(c.title)}</text></navLabel>
      <content src="${xmlEscape(c.href)}"/>
    </navPoint>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${xmlEscape(identifier)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${xmlEscape(title || "Manga")}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>
`;
}

/* Build every text file of the EPUB (everything except the mimetype entry and
 * the image blobs, which the caller adds). Returns [{path, text}] with paths
 * relative to the EPUB (zip) root.
 *
 * spine: ordered [{xhtmlId, xhtmlHref, imgId, imgHref, mime, w, h, isCover}].
 * chapters: [{href, title}] where href is a spine item's xhtmlHref. */
function buildEpubTextFiles({ identifier, title, author, language, spine, chapters }) {
  language = language || "ja";
  const cover = spine.find((s) => s.isCover);
  const coverImgId = cover ? cover.imgId : null;

  const files = [];
  files.push({ path: "META-INF/container.xml", text: epubContainerXml() });
  files.push({ path: "OEBPS/style.css", text: epubStyleCss() });
  files.push({ path: "OEBPS/content.opf", text: epubContentOpf({ identifier, title, author, language, spine, coverImgId }) });
  files.push({ path: "OEBPS/nav.xhtml", text: epubNavXhtml({ title, language, chapters }) });
  files.push({ path: "OEBPS/toc.ncx", text: epubTocNcx({ identifier, title, chapters }) });
  for (const s of spine) {
    files.push({ path: "OEBPS/" + s.xhtmlHref, text: epubPageXhtml({ title, imgHref: s.imgHref, w: s.w, h: s.h, language }) });
  }
  return files;
}

/* Stable, book-specific identifier so re-running the converter on the same
 * volume yields the same EPUB id — no Date/random needed. Two independent 32-bit
 * rolling hashes over the metadata (a forward FNV-1a pass and a reverse pass
 * seeded/mixed with a Murmur-style constant) are concatenated into a 64-bit hex
 * id, keeping collisions across a library negligible. */
function epubIdentifier(title, author, count) {
  const str = `${title || ""}|${author || ""}|${count}`;
  let a = 0x811c9dc5, b = 0x1000193;
  for (let i = 0; i < str.length; i++) {
    a = Math.imul(a ^ str.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ str.charCodeAt(str.length - 1 - i), 0x85ebca6b) >>> 0;
  }
  const hex = (a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0"));
  return `urn:matcha-reader:${hex}`;
}

if (typeof module !== "undefined") {
  module.exports = {
    EPUB_MIMETYPE, epubImageExt, buildEpubTextFiles, epubIdentifier,
    epubContainerXml, epubContentOpf, epubNavXhtml, epubTocNcx, epubPageXhtml, xmlEscape,
  };
}
