/* Dictionary converter: JMdict-simplified JSON / Yomitan zip → CrossPoint
 * binary dictionary (.idx/.dat) plus the .spx sparse-index sidecar.
 *
 * This is a line-faithful port of matcha-reader's
 * tools/dict_convert/convert_jmdict.py and scripts/gen_dict_spx.py: the
 * .idx/.dat/.spx bytes produced here match the Python tool's output for the
 * same input. MDict (.mdx) input is not supported in the web tool.
 */
"use strict";

const HEADWORD_SIZE = 32;
const RECORD_SIZE = 40;   // headword(32) + offset(4) + length(2) + priority(1) + posFlags(1)

/* Part-of-speech flag bits packed into the record's final byte — must mirror
 * DictIndexRecord::POS_* in matcha-reader's lib/Dict/DictIndex.h. 0 means "no
 * POS data" and the firmware then accepts every deinflection candidate, so
 * leaving flags unset is always safe (fail open). */
const POS_V1 = 0x01;      // ichidan verb
const POS_V5 = 0x02;      // godan verb
const POS_VS = 0x04;      // suru verb
const POS_VK = 0x08;      // kuru verb
const POS_ADJ_I = 0x10;   // i-adjective
const POS_OTHER = 0x20;   // tagged, but none of the above (noun, particle, na-adjective, ...)
const POS_READING = 0x40; // kana READING record of an entry that has kanji headwords (not a kana lemma)
const POS_ANY_VERB = POS_V1 | POS_V5 | POS_VS | POS_VK;

/* Map JMdict partOfSpeech tags / Yomitan rules to POS flag bits. Prefix-matches
 * the verb classes so subtags stay covered (v5k-s, v5aru, v1-s, vs-i, adj-ix); a
 * verb-ish tag with an unrecognized class fails OPEN (all verb bits) rather than
 * closed; transitivity tags (vt/vi) say nothing about conjugation and are
 * ignored. Faithful port of pos_flags_from_tags in convert_jmdict.py. */
function posFlagsFromTags(tags) {
  let flags = 0;
  for (const t of tags) {
    if (!t) continue;
    if (t === "vt" || t === "vi" || t === "aux" || t === "aux-adj" || t === "exp") continue;
    if (t.startsWith("v1")) flags |= POS_V1;
    else if (t.startsWith("v5") || t.startsWith("v4") || t.startsWith("iv")) flags |= POS_V5;
    else if (t.startsWith("vs")) flags |= POS_VS;
    else if (t.startsWith("vk")) flags |= POS_VK;
    else if (t.startsWith("adj-i")) flags |= POS_ADJ_I;
    else if (t.startsWith("v") || t === "aux-v") flags |= POS_ANY_VERB;
    else flags |= POS_OTHER;
  }
  return flags;
}

function posFlagsJmdict(entry) {
  const tags = [];
  for (const sense of entry.sense || []) {
    for (const p of sense.partOfSpeech || []) tags.push(p);
  }
  return posFlagsFromTags(tags);
}

const SPX_STRIDE = 48;
const SPX_VERSION = 1;
const SPX_HEADER_SIZE = 32;

const dictEncoder = new TextEncoder();

/* ── Shared output writer ─────────────────────────────────────── */

/* records: array of {hw: Uint8Array, def: Uint8Array, priority: int,
 * posFlags?: int}. posFlags defaults to 0 (fail-open / no POS data), matching
 * the MDict path and any pre-flags caller. Returns {idx, dat}. */
function dictWriteBinary(records) {
  // Stable sort by headword bytes (Python: records.sort(key=lambda r: r[0])).
  records = records.map((r, i) => ({ r, i }));
  records.sort((a, b) => compareBytes(a.r.hw, b.r.hw) || a.i - b.i);
  records = records.map((x) => x.r);

  const dat = new ByteWriter(1 << 20);
  const idx = new ByteWriter(records.length * RECORD_SIZE + 16);

  let datOffset = 0;
  let prevDef = null;
  let prevOffset = 0;
  let prevLength = 0;
  const entries = [];

  for (const rec of records) {
    let defBytes = rec.def;
    let offset, length;
    if (prevDef !== null && bytesEqual(defBytes, prevDef)) {
      offset = prevOffset;
      length = prevLength;
    } else {
      offset = datOffset;
      length = defBytes.length;
      if (length > 0xffff) {
        length = 0xffff;
        defBytes = defBytes.subarray(0, 0xffff);
      }
      dat.bytes(defBytes);
      datOffset += defBytes.length;
      prevDef = defBytes;
      prevOffset = offset;
      prevLength = length;
    }
    entries.push({ hw: rec.hw, offset, length, priority: rec.priority, posFlags: rec.posFlags || 0 });
  }

  for (const e of entries) {
    idx.bytes(e.hw);
    idx.zeros(HEADWORD_SIZE - e.hw.length);
    idx.u32(e.offset);
    idx.u16(e.length);
    idx.u8(e.priority);
    idx.u8(e.posFlags & 0xff);
  }

  return { idx: idx.toUint8Array(), dat: dat.toUint8Array(), recordCount: entries.length };
}

/* .spx sparse-index sidecar: one 32-byte headword checkpoint per SPX_STRIDE
 * records of the .idx (port of scripts/gen_dict_spx.py). */
function dictGenSpx(idxBytes) {
  if (idxBytes.length % RECORD_SIZE !== 0) {
    throw new Error(`idx size ${idxBytes.length} not a multiple of ${RECORD_SIZE}`);
  }
  const count = idxBytes.length / RECORD_SIZE;
  const fineCount = Math.ceil(count / SPX_STRIDE);
  const out = new ByteWriter(SPX_HEADER_SIZE + fineCount * HEADWORD_SIZE);
  out.bytes(dictEncoder.encode("CPSPX1"));
  out.zeros(2); // magic is "CPSPX1\0\0"
  out.u32(SPX_VERSION);
  out.u32(SPX_STRIDE);
  out.u32(count);
  out.u32(fineCount);
  out.u32(0);
  out.zeros(SPX_HEADER_SIZE - out.length);
  for (let rec = 0; rec < count; rec += SPX_STRIDE) {
    out.bytes(idxBytes.subarray(rec * RECORD_SIZE, rec * RECORD_SIZE + HEADWORD_SIZE));
  }
  return out.toUint8Array();
}

/* ── JMdict (jmdict-simplified JSON) ──────────────────────────── */

function computePriorityJmdict(entry) {
  let isCommon = false;
  for (const kanji of entry.kanji || []) {
    if (kanji.common) { isCommon = true; break; }
  }
  if (!isCommon) {
    for (const kana of entry.kana || []) {
      if (kana.common) { isCommon = true; break; }
    }
  }
  return isCommon ? 200 : 100;
}

function formatDefinitionJmdict(entry) {
  const parts = [];
  const readings = (entry.kana || []).map((k) => k.text);
  if (readings.length) parts.push("【" + readings.slice(0, 3).join("、") + "】");

  const senses = entry.sense || [];
  const shown = senses.slice(0, 3);
  for (let i = 0; i < shown.length; i++) {
    const glosses = (shown[i].gloss || []).map((g) => g.text);
    if (glosses.length) {
      const prefix = senses.length > 1 ? `${i + 1}. ` : "";
      parts.push(prefix + glosses.slice(0, 4).join("; "));
    }
  }
  return parts.join("\n");
}

/* data: parsed jmdict-simplified JSON object. Returns records for dictWriteBinary. */
function convertJmdictRecords(data, onProgress) {
  const words = data.words || [];
  const records = [];
  for (let wi = 0; wi < words.length; wi++) {
    const entry = words[wi];
    const definition = formatDefinitionJmdict(entry);
    const defBytes = dictEncoder.encode(definition);
    const priority = computePriorityJmdict(entry);
    const posFlags = posFlagsJmdict(entry);

    const seen = new Set();
    for (const kanji of entry.kanji || []) {
      const hwBytes = dictEncoder.encode(kanji.text);
      const key = kanji.text;
      if (hwBytes.length >= HEADWORD_SIZE || seen.has(key)) continue;
      seen.add(key);
      records.push({ hw: hwBytes, def: defBytes, priority, posFlags });
    }
    // Kana records of an entry that also has kanji headwords are READING records:
    // text matching them is usually conjugation morphology, not the word itself.
    // Kana-only lemmas (no kanji form) stay unflagged. Empty kanji list is
    // falsy in Python, so guard on length to match (POS_READING only when set).
    const kanaFlags = posFlags | (entry.kanji && entry.kanji.length ? POS_READING : 0);
    for (const kana of entry.kana || []) {
      const hwBytes = dictEncoder.encode(kana.text);
      const key = kana.text;
      if (hwBytes.length >= HEADWORD_SIZE || seen.has(key)) continue;
      seen.add(key);
      records.push({ hw: hwBytes, def: defBytes, priority, posFlags: kanaFlags });
    }
    if (onProgress && wi % 20000 === 0) onProgress(wi, words.length);
  }
  return records;
}

/* ── Yomitan / Yomichan (.zip) ────────────────────────────────── */

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/* Recursively extract display text from Yomitan structured content, using
 * the semantic data-content attributes from Jitendex. */
function flattenStructuredContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(flattenStructuredContent).join("");
  if (isPlainObject(content)) {
    const ctype = content.type || "";
    if (ctype === "text") return content.text || "";
    if (ctype === "image") return "";
    if (ctype === "structured-content") return flattenStructuredContent(content.content ?? "");

    const inner = content.content ?? "";
    const tag = content.tag || "";
    const data = isPlainObject(content.data) ? content.data : {};
    const dc = data.content || "";
    const cls = data.class || "";
    const text = flattenStructuredContent(inner);

    if (tag === "br") return "\n";
    if (tag === "rt") return "";
    if (tag === "ruby") return text;

    if (cls === "tag" && ["part-of-speech-info", "field-info", "misc-info",
      "dialect-info", "language-info"].includes(dc)) {
      return "[" + text + "] ";
    }
    if (cls === "tag" && dc === "forms-label") return "";

    if (dc === "glossary" && tag === "ul") return "\n" + text;
    if (tag === "li" && !dc) return "• " + text.trim() + "\n";

    if (dc === "sense-group" && (tag === "li" || tag === "div")) return text + "\n";
    if (dc === "sense" && tag === "li") return text;

    if (dc === "sense-note-label") return text + ": ";
    if (dc === "sense-note-content") return text + "\n";
    if (dc === "sense-note" && cls === "extra-box") return "  → " + text;

    if (dc === "example-sentence-a") return text + "\n";
    if (dc === "example-sentence-b") return text + "\n";
    if (dc === "example-sentence" && cls === "extra-box") return "  " + text;
    if (dc === "example-keyword") return text;

    if (dc === "xref" && cls === "extra-box") return "";
    if (dc === "reference-label") return text + " ";

    if (dc === "forms") return "";
    if (dc === "attribution-footnote") return "";

    if (["div", "p", "blockquote", "section"].includes(tag)) return text;
    if (tag === "ol" || tag === "ul") return text;

    return text;
  }
  return String(content);
}

function formatDefinitionYomitan(headword, reading, definitions) {
  const parts = [];
  if (reading && reading !== headword) parts.push(`【${reading}】`);

  function flattenListDefn(d) {
    if (typeof d === "string") {
      if (d.startsWith("redirected from")) return "";
      return d;
    }
    if (isPlainObject(d)) return flattenStructuredContent(d);
    if (Array.isArray(d)) {
      const pieces = d.map(flattenListDefn);
      return pieces.filter((p) => p).join(" ");
    }
    return "";
  }

  if (Array.isArray(definitions)) {
    let nonEmpty = [];
    for (const defn of definitions.slice(0, 6)) {
      let text;
      if (typeof defn === "string") text = defn;
      else if (isPlainObject(defn)) text = flattenStructuredContent(defn);
      else if (Array.isArray(defn)) text = flattenListDefn(defn);
      else text = String(defn);
      text = text.trim();
      if (text) nonEmpty.push(text);
    }
    const deduped = [];
    for (const t of nonEmpty) if (!deduped.includes(t)) deduped.push(t);
    nonEmpty = deduped;

    for (let i = 0; i < nonEmpty.length; i++) {
      if (nonEmpty.length > 1) parts.push(`\n${i + 1}. ${nonEmpty[i]}`);
      else parts.push(`\n${nonEmpty[i]}`);
    }
  }

  let result = parts.join("\n");
  result = result.replace(/[ \t]+/g, " ");
  result = result.replace(/\n{3,}/g, "\n\n");
  result = result.split("• • ").join("• ");
  return result.trim();
}

/* If a Yomitan entry is purely a redirect, return the target headword. */
function findRedirectTarget(definitions) {
  function search(node) {
    if (isPlainObject(node)) {
      const data = node.data;
      if (isPlainObject(data) && data.content === "redirect-glossary") {
        return flattenStructuredContent(node).split("⟶").join("").trim();
      }
      return search(node.content);
    }
    if (Array.isArray(node)) {
      for (const x of node) {
        const r = search(x);
        if (r) return r;
      }
    }
    return "";
  }
  return search(definitions);
}

function yomitanPriority(score) {
  if (typeof score === "number" && !Number.isNaN(score)) {
    return Math.max(0, Math.min(255, Math.trunc(score) + 128));
  }
  return 100;
}

/* termBanks: array of parsed term_bank JSON arrays, in lexicographic
 * filename order. Returns {records, entryCount}. */
function convertYomitanRecords(termBanks, onProgress) {
  // Pass 1: collect entries; canonical headword → best definition for
  // non-redirect entries so variant/redirect entries can be resolved.
  const allEntries = [];
  const canonicalDefs = new Map(); // headword → [definition, priority]
  for (const entries of termBanks) {
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length < 6) continue;
      const headword = entry[0];
      if (!headword || typeof headword !== "string") continue;
      const reading = entry.length > 1 ? entry[1] : "";
      const rules = (entry.length > 3 && typeof entry[3] === "string") ? entry[3] : "";
      const score = entry.length > 4 ? entry[4] : 0;
      const definitions = entry.length > 5 ? entry[5] : [];
      const redirect = findRedirectTarget(definitions);
      allEntries.push([headword, reading, score, definitions, redirect, rules]);
      if (!redirect) {
        const definition = formatDefinitionYomitan(headword, reading, definitions);
        if (definition) {
          const priority = yomitanPriority(score);
          const prev = canonicalDefs.get(headword);
          if (prev === undefined || priority > prev[1]) {
            canonicalDefs.set(headword, [definition, priority]);
          }
        }
      }
    }
  }

  // Pass 2: emit records, resolving redirects to the target's definition.
  const records = [];
  let entryCount = 0;
  for (let ei = 0; ei < allEntries.length; ei++) {
    const [headword, reading, score, definitions, redirect, rules] = allEntries[ei];
    let definition, priority;
    if (redirect) {
      const target = canonicalDefs.get(redirect);
      if (!target) continue; // dangling redirect
      definition = `= ${redirect}\n${target[0]}`;
      priority = target[1];
    } else {
      definition = formatDefinitionYomitan(headword, reading, definitions);
      if (!definition) continue;
      priority = yomitanPriority(score);
    }

    const defBytes = dictEncoder.encode(definition);
    // Yomitan spec: empty rules = "word is not inflected" — that IS positive POS
    // data (a non-conjugating word), so stamp POS_OTHER rather than fail-open 0.
    const posFlags = rules.trim() ? posFlagsFromTags(rules.trim().split(/\s+/)) : POS_OTHER;
    const seen = new Set();
    const hwBytes = dictEncoder.encode(headword);
    if (hwBytes.length < HEADWORD_SIZE) {
      seen.add(headword);
      records.push({ hw: hwBytes, def: defBytes, priority, posFlags });
    }

    if (reading && reading !== headword && !redirect) {
      const rBytes = dictEncoder.encode(reading);
      if (rBytes.length < HEADWORD_SIZE && !seen.has(reading)) {
        const rDef = formatDefinitionYomitan(reading, reading, definitions);
        if (rDef) {
          // reading != headword: kana reading of a kanji headword → flag it.
          records.push({ hw: rBytes, def: dictEncoder.encode(rDef), priority, posFlags: posFlags | POS_READING });
        }
      }
    }
    entryCount++;
    if (onProgress && ei % 20000 === 0) onProgress(ei, allEntries.length);
  }
  return { records, entryCount };
}

if (typeof module !== "undefined") {
  module.exports = {
    dictWriteBinary, dictGenSpx,
    convertJmdictRecords, convertYomitanRecords,
    formatDefinitionJmdict, formatDefinitionYomitan,
    flattenStructuredContent, findRedirectTarget,
    posFlagsFromTags, posFlagsJmdict,
  };
}
