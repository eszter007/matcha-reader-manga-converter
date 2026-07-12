/* MDict (.mdx) parser: port of readmdict.py (the desktop tool's MDX reader)
 * plus convert_jmdict.py:convert_mdict / strip_html, producing the same
 * {hw, def, priority} records dict.js writes out.
 *
 * Supported like the Python stack: engine versions 1.2 and 2.0, zlib / LZO /
 * uncompressed blocks, "Encrypted=2" key-info encryption (ripemd128 +
 * fast_decrypt). "Encrypted=1" (registration-code record encryption) is
 * rejected with a clear error, matching readmdict's passcode requirement.
 * One deviation: invalid bytes in the declared encoding decode to U+FFFD
 * (TextDecoder) instead of being dropped (Python errors='ignore').
 *
 * Pure logic — no DOM. Node ≥ 18 provides TextDecoder/DecompressionStream.
 */
"use strict";

/* ── Small utilities ──────────────────────────────────────────── */

function mdxAdler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

async function mdxInflate(bytes) {
  const ds = new DecompressionStream("deflate"); // zlib-wrapped stream
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* Python str.strip() (unicode whitespace incl. \x1c-\x1f, \x85). */
function pyStrip(s) {
  return s.replace(/^[\s\u001c-\u001f\u0085]+/, "").replace(/[\s\u001c-\u001f\u0085]+$/, "");
}

/* Python str.strip('\x00') — NULs at the ends only. */
function stripNulls(s) {
  let a = 0, b = s.length;
  while (a < b && s.charCodeAt(a) === 0) a++;
  while (b > a && s.charCodeAt(b - 1) === 0) b--;
  return s.slice(a, b);
}

/* ── ripemd128 (for Encrypted=2 key-info decryption) ──────────── */

const RMD_ZL = [
  [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
  [7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8],
  [3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12],
  [1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2],
];
const RMD_ZR = [
  [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12],
  [6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2],
  [15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13],
  [8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14],
];
const RMD_SL = [
  [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8],
  [7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12],
  [11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5],
  [11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12],
];
const RMD_SR = [
  [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6],
  [9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11],
  [9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5],
  [15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8],
];
const RMD_KL = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc];
const RMD_KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x00000000];

function ripemd128(input) {
  const rol = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const f = (r, x, y, z) => {
    switch (r) {
      case 0: return (x ^ y ^ z) >>> 0;
      case 1: return ((x & y) | (~x & z)) >>> 0;
      case 2: return ((x | ~y) ^ z) >>> 0;
      default: return ((x & z) | (y & ~z)) >>> 0;
    }
  };

  // Pad: 0x80, zeros, 64-bit little-endian bit length.
  const bitLen = input.length * 8;
  const padded = new Uint8Array((Math.floor((input.length + 8) / 64) + 1) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476;
  const x = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) x[i] = dv.getUint32(off + i * 4, true);
    let al = h0, bl = h1, cl = h2, dl = h3;
    let ar = h0, br = h1, cr = h2, dr = h3;
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 16; i++) {
        let t = (al + f(round, bl, cl, dl) + x[RMD_ZL[round][i]] + RMD_KL[round]) >>> 0;
        t = rol(t, RMD_SL[round][i]);
        al = dl; dl = cl; cl = bl; bl = t;
        t = (ar + f(3 - round, br, cr, dr) + x[RMD_ZR[round][i]] + RMD_KR[round]) >>> 0;
        t = rol(t, RMD_SR[round][i]);
        ar = dr; dr = cr; cr = br; br = t;
      }
    }
    const t = (h1 + cl + dr) >>> 0;
    h1 = (h2 + dl + ar) >>> 0;
    h2 = (h3 + al + br) >>> 0;
    h3 = (h0 + bl + cr) >>> 0;
    h0 = t;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0, true);
  odv.setUint32(4, h1, true);
  odv.setUint32(8, h2, true);
  odv.setUint32(12, h3, true);
  return out;
}

/* readmdict._fast_decrypt */
function mdxFastDecrypt(data, key) {
  const b = new Uint8Array(data);
  let previous = 0x36;
  for (let i = 0; i < b.length; i++) {
    let t = ((b[i] >> 4) | (b[i] << 4)) & 0xff;
    t = t ^ previous ^ (i & 0xff) ^ key[i % key.length];
    previous = b[i];
    b[i] = t;
  }
  return b;
}

/* readmdict._mdx_decrypt */
function mdxDecryptKeyInfo(compBlock) {
  const seed = new Uint8Array(8);
  seed.set(compBlock.subarray(4, 8));
  seed[4] = 0x95; seed[5] = 0x36; // pack('<L', 0x3695)
  const key = ripemd128(seed);
  const out = new Uint8Array(compBlock.length);
  out.set(compBlock.subarray(0, 8));
  out.set(mdxFastDecrypt(compBlock.subarray(8), key), 8);
  return out;
}

/* ── LZO1X decompression (block type 1, used by pre-2.0 files) ── */

/* Structured to mirror minilzo's lzo1x_decompress control flow: LZO has two
 * different M1 (t < 16 in match position) encodings depending on whether the
 * previous instruction was a full literal run (3-byte match, distance
 * 0x801..0xc00) or a match/short-literal (2-byte match, distance 1..0x400). */
function lzo1xDecompress(src, outLen) {
  const dst = new Uint8Array(outLen);
  let ip = 0, op = 0;
  const fail = (why) => { throw new Error("LZO data corrupt (" + why + ")"); };
  const copyLiterals = (n) => {
    if (ip + n > src.length || op + n > outLen) fail("literal overrun");
    dst.set(src.subarray(ip, ip + n), op);
    ip += n; op += n;
  };
  const copyMatch = (mPos, n) => {
    if (mPos < 0 || op + n > outLen) fail("match overrun");
    for (let i = 0; i < n; i++) dst[op++] = dst[mPos++]; // byte-wise: overlaps allowed
  };
  const extendedCount = (base) => {
    let t = 0;
    while (src[ip] === 0) { t += 255; ip++; }
    return t + base + src[ip++];
  };

  // States: "lit" expect literal-run instruction; "first" match instruction
  // right after a literal run; "next" match instruction after a match's
  // trailing literals.
  let state = "lit";
  if (src[ip] > 17) {
    const t = src[ip++] - 17;
    copyLiterals(t);
    state = t < 4 ? "next" : "first";
  }

  for (;;) {
    let t = src[ip++];
    if (t === undefined) fail("truncated stream");

    if (state === "lit") {
      if (t < 16) {
        if (t === 0) t = extendedCount(15);
        copyLiterals(t + 3);
        state = "first";
        continue;
      }
      // t >= 16 falls through to the match decoder
    } else if (t < 16) {
      if (state === "first") {
        // M1 after a literal run: 3-byte match, distance 0x801..0xc00
        const mPos = op - (1 + 0x800) - (t >> 2) - (src[ip++] << 2);
        copyMatch(mPos, 3);
      } else {
        // M1 after a match: 2-byte match, distance 1..0x400
        const mPos = op - 1 - (t >> 2) - (src[ip++] << 2);
        copyMatch(mPos, 2);
      }
      const trailing = src[ip - 2] & 3;
      if (trailing) { copyLiterals(trailing); state = "next"; } else state = "lit";
      continue;
    }

    // Match instruction (t >= 16)
    let mPos, mLen;
    if (t >= 64) {          // M2: distance ≤ 0x800
      mPos = op - 1 - ((t >> 2) & 7) - (src[ip++] << 3);
      mLen = (t >> 5) + 1;
    } else if (t >= 32) {   // M3: distance ≤ 0x4000
      mLen = (t & 31) === 0 ? extendedCount(31) + 2 : (t & 31) + 2;
      mPos = op - 1 - ((src[ip] >> 2) + (src[ip + 1] << 6));
      ip += 2;
    } else {                // M4 (16..31): distance 0x4000..0xbfff, or end marker
      mPos = op - ((t & 8) << 11);
      mLen = (t & 7) === 0 ? extendedCount(7) + 2 : (t & 7) + 2;
      mPos -= (src[ip] >> 2) + (src[ip + 1] << 6);
      ip += 2;
      if (mPos === op) break; // end-of-stream marker
      mPos -= 0x4000;
    }
    copyMatch(mPos, mLen);
    const trailing = src[ip - 2] & 3;
    if (trailing) { copyLiterals(trailing); state = "next"; } else state = "lit";
  }
  if (op !== outLen) fail(`size mismatch: ${op} != ${outLen}`);
  return dst;
}

/* ── Block decompression (shared by key and record blocks) ────── */

async function mdxDecompressBlock(block, decompressedSize, what) {
  const type = block[0] | (block[1] << 8) | (block[2] << 16) | (block[3] << 24);
  const adler = (block[4] << 24 | block[5] << 16 | block[6] << 8 | block[7]) >>> 0;
  const data = block.subarray(8);
  let out;
  if (type === 0) out = data;
  else if (type === 1) out = lzo1xDecompress(data, decompressedSize);
  else if (type === 2) out = await mdxInflate(data);
  else throw new Error(`Unknown ${what} block compression type ${type}`);
  if (mdxAdler32(out) !== adler) throw new Error(`${what} block checksum mismatch`);
  return out;
}

/* ── Parser ───────────────────────────────────────────────────── */

function mdxParseHeaderAttrs(text) {
  const attrs = {};
  const re = /(\w+)="(.*?)"/gs;
  let m;
  while ((m = re.exec(text)) !== null) {
    attrs[m[1]] = m[2]
      .replaceAll("&lt;", "<").replaceAll("&gt;", ">")
      .replaceAll("&quot;", "\"").replaceAll("&amp;", "&");
  }
  return attrs;
}

function mdxTextDecoderLabel(encoding) {
  const e = (encoding || "").toUpperCase();
  if (!e || e === "UTF-8") return "utf-8";
  if (e === "UTF-16") return "utf-16le";
  if (e === "GBK" || e === "GB2312") return "gb18030"; // GB18030 ⊃ GBK ⊃ GB2312
  return e.toLowerCase();
}

/* Parse the whole .mdx and stream entries to onEntry(keyText, valueText).
 * Mirrors readmdict.MDX: keys/values decoded with the header's Encoding,
 * keys stripped, values stripped of NULs. Returns the parsed header attrs. */
async function mdxParse(bytes, onEntry) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const num = (pos, width) =>
    width === 8 ? Number(dv.getBigUint64(pos)) : dv.getUint32(pos);

  // Header: u32 BE length, UTF-16LE XML (ends \x00\x00), u32 LE adler32.
  const headerSize = dv.getUint32(0);
  const headerBytes = bytes.subarray(4, 4 + headerSize);
  if ((dv.getUint32(4 + headerSize, true) >>> 0) !== mdxAdler32(headerBytes)) {
    throw new Error("Not an MDX file (header checksum mismatch)");
  }
  let headerText = new TextDecoder("utf-16le").decode(headerBytes.subarray(0, headerSize - 2));
  if (headerText.charCodeAt(0) === 0xfeff) headerText = headerText.slice(1);
  const attrs = mdxParseHeaderAttrs(headerText);

  const version = parseFloat(attrs.GeneratedByEngineVersion || "2.0");
  if (version >= 3) throw new Error(`MDX engine version ${version} is not supported (readmdict supports 1.2–2.0)`);
  const W = version >= 2 ? 8 : 4;

  const enc = attrs.Encrypted;
  const encrypt = !enc || enc === "No" ? 0 : enc === "Yes" ? 1 : parseInt(enc, 10);
  if (encrypt & 1) {
    throw new Error("This MDX is registration-encrypted (Encrypted=1) and needs its owner passcode — not supported");
  }
  const decoder = new TextDecoder(mdxTextDecoderLabel(attrs.Encoding));
  const utf16 = (attrs.Encoding || "").toUpperCase() === "UTF-16";

  // ── Keyword section ──
  let pos = 4 + headerSize + 4;
  const numKeyBlocks = num(pos, W);
  pos += W * 2; // skip num_entries
  if (version >= 2) pos += W; // key_block_info_decomp_size
  const keyInfoSize = num(pos, W); pos += W;
  const keyBlocksSize = num(pos, W); pos += W;
  if (version >= 2) pos += 4; // adler of the 5 numbers

  let keyInfo = bytes.subarray(pos, pos + keyInfoSize);
  pos += keyInfoSize;
  if (version >= 2) {
    if (encrypt & 2) keyInfo = mdxDecryptKeyInfo(keyInfo);
    keyInfo = await mdxDecompressBlock(keyInfo, 0, "key info").catch(() => {
      throw new Error("Failed to read key index (corrupt or unsupported encryption)");
    });
  }

  // Key-block sizes from the info list (head/tail key texts are skipped).
  const kdv = new DataView(keyInfo.buffer, keyInfo.byteOffset, keyInfo.byteLength);
  const knum = (p) => (W === 8 ? Number(kdv.getBigUint64(p)) : kdv.getUint32(p));
  const blockSizes = [];
  {
    let i = 0;
    const textWidth = version >= 2 ? 2 : 1;
    const textTerm = version >= 2 ? 1 : 0;
    const textLen = (p) => (textWidth === 2 ? kdv.getUint16(p) : kdv.getUint8(p));
    while (i < keyInfo.byteLength) {
      i += W; // entry count in this block
      let n = textLen(i); i += textWidth;
      i += utf16 ? (n + textTerm) * 2 : n + textTerm;
      n = textLen(i); i += textWidth;
      i += utf16 ? (n + textTerm) * 2 : n + textTerm;
      blockSizes.push([knum(i), knum(i + W)]);
      i += W * 2;
    }
  }
  if (blockSizes.length !== numKeyBlocks) throw new Error("Key index is inconsistent");

  // Decompress key blocks → [recordOffset, keyText] list.
  const keyList = [];
  const delimWidth = utf16 ? 2 : 1;
  for (const [compSize, decompSize] of blockSizes) {
    const block = await mdxDecompressBlock(bytes.subarray(pos, pos + compSize), decompSize, "key");
    pos += compSize;
    const bdv = new DataView(block.buffer, block.byteOffset, block.byteLength);
    let i = 0;
    while (i < block.byteLength) {
      const id = W === 8 ? Number(bdv.getBigUint64(i)) : bdv.getUint32(i);
      let end = i + W;
      while (end < block.byteLength) {
        if (delimWidth === 1 ? block[end] === 0 : (block[end] === 0 && block[end + 1] === 0)) break;
        end += delimWidth;
      }
      keyList.push([id, decoder.decode(block.subarray(i + W, end)).trim()]);
      i = end + delimWidth;
    }
  }

  // ── Record section ──
  const numRecordBlocks = num(pos, W); pos += W * 3; // skip num_entries, info size
  pos += W; // record_blocks_size
  const recSizes = [];
  for (let i = 0; i < numRecordBlocks; i++) {
    recSizes.push([num(pos, W), num(pos + W, W)]);
    pos += W * 2;
  }

  let offset = 0, ki = 0;
  for (const [compSize, decompSize] of recSizes) {
    const block = await mdxDecompressBlock(bytes.subarray(pos, pos + compSize), decompSize, "record");
    pos += compSize;
    if (block.length !== decompSize) throw new Error("Record block size mismatch");
    while (ki < keyList.length) {
      const [recordStart, keyText] = keyList[ki];
      if (recordStart - offset >= block.length) break;
      const recordEnd = ki < keyList.length - 1 ? keyList[ki + 1][0] : block.length + offset;
      ki++;
      const value = stripNulls(decoder.decode(block.subarray(recordStart - offset, recordEnd - offset)));
      onEntry(keyText, value);
    }
    offset += block.length;
  }
  return attrs;
}

/* ── convert_jmdict.py ports ──────────────────────────────────── */

/* strip_html: tags out, common entities decoded, blank lines dropped. */
function mdxStripHtml(html) {
  let text = html.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replaceAll("&amp;", "&");
  text = text.replaceAll("&lt;", "<");
  text = text.replaceAll("&gt;", ">");
  text = text.replaceAll("&quot;", "\"");
  text = text.replaceAll("&nbsp;", " ");
  text = text.replaceAll("&#x27;", "'");
  text = text.replaceAll("&#39;", "'");
  return text.split("\n").map(pyStrip).filter((line) => line).join("\n");
}

/* convert_mdict: parse + filter into dictWriteBinary records. */
async function convertMdictRecords(bytes, onProgress) {
  const MDX_HEADWORD_SIZE = 32; // dict.js HEADWORD_SIZE
  const enc = new TextEncoder();
  const records = [];
  let entryCount = 0, skipped = 0, seen = 0;
  await mdxParse(bytes, (keyText, valText) => {
    seen++;
    if (onProgress && seen % 20000 === 0) onProgress(seen);
    const headword = pyStrip(keyText);
    const rawDef = pyStrip(valText);
    if (!headword || !rawDef) { skipped++; return; }
    if (rawDef.startsWith("@@@LINK=")) { skipped++; return; }
    const definition = mdxStripHtml(rawDef);
    if (!definition) { skipped++; return; }
    const hw = enc.encode(headword);
    if (hw.length >= MDX_HEADWORD_SIZE) { skipped++; return; }
    records.push({ hw, def: enc.encode(definition), priority: 100 });
    entryCount++;
  });
  return { records, entryCount, skipped };
}

if (typeof module !== "undefined") {
  module.exports = {
    mdxAdler32, ripemd128, mdxFastDecrypt, lzo1xDecompress,
    mdxParse, mdxStripHtml, convertMdictRecords, pyStrip, stripNulls,
  };
}
