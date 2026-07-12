/* Dictionary converter: page wiring. Conversion logic lives in dict.js. */
"use strict";

async function runDictConversion() {
  const fileInput = $("dict-file");
  if (!fileInput.files.length) {
    logLine("Choose a dictionary file first (Yomitan .zip, or jmdict-simplified .json/.tgz).", "warn");
    return;
  }
  const file = fileInput.files[0];
  const outName = $("dict-name").value; // jmdict | jmnedict | grammar

  $("dict-run").disabled = true;
  clearLog();
  const wakeLock = new WakeLock();
  await wakeLock.acquire();

  try {
    const lower = file.name.toLowerCase();
    let records;

    if (lower.endsWith(".zip")) {
      logLine(`Loading ${file.name} (Yomitan format)…`);
      const zip = new ZipReader(await readFileBytes(file));
      const decoder = new TextDecoder("utf-8");

      const indexEntry = zip.findEntry("index.json");
      if (indexEntry) {
        try {
          const meta = JSON.parse(decoder.decode(await zip.readEntry(indexEntry)));
          logLine(`  Dictionary: ${meta.title || "(unknown)"}`);
          logLine(`  Format version: ${meta.format ?? meta.version ?? "?"}`);
        } catch (e) { /* metadata is informational only */ }
      }

      const bankEntries = zip.entries
        .filter((e) => /^term_bank_\d+\.json$/.test(e.name))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (!bankEntries.length) throw new Error("No term_bank_N.json files found in zip — is this a Yomitan dictionary?");
      logLine(`  Found ${bankEntries.length} term bank files`);

      const termBanks = [];
      for (let i = 0; i < bankEntries.length; i++) {
        setProgress(i, bankEntries.length, `Reading term banks: ${i + 1}/${bankEntries.length}`);
        termBanks.push(JSON.parse(decoder.decode(await zip.readEntry(bankEntries[i]))));
        await sleep(0); // keep the UI alive between large JSON parses
      }

      setProgress(0, 1, "Converting entries…");
      const result = convertYomitanRecords(termBanks, (done, total) => setProgress(done, total, `Converting entries: ${done}/${total}`));
      logLine(`Processed ${result.entryCount} Yomitan entries → ${result.records.length} index records`);
      records = result.records;

    } else if (lower.endsWith(".json") || lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) {
      logLine(`Loading ${file.name} (jmdict-simplified format)…`);
      let jsonText;
      if (lower.endsWith(".json")) {
        jsonText = new TextDecoder("utf-8").decode(await readFileBytes(file));
      } else {
        setProgress(0, 1, "Decompressing…");
        const tarBytes = await gunzip(await readFileBytes(file));
        const member = parseTar(tarBytes).find((f) => f.name.endsWith(".json"));
        if (!member) throw new Error("No JSON file found in the tarball");
        jsonText = new TextDecoder("utf-8").decode(member.data);
      }
      setProgress(0, 1, "Parsing JSON…");
      await sleep(0);
      const data = JSON.parse(jsonText);
      jsonText = null;
      logLine(`Processing ${(data.words || []).length} JMdict entries…`);
      records = convertJmdictRecords(data, (done, total) => setProgress(done, total, `Converting entries: ${done}/${total}`));

    } else if (lower.endsWith(".mdx")) {
      logLine(`Loading ${file.name} (MDict format)…`);
      setProgress(0, 1, "Parsing MDX…");
      const bytes = await readFileBytes(file);
      const result = await convertMdictRecords(bytes, (seen) => setProgress(0, 1, `Reading entries: ${seen.toLocaleString()}…`));
      logLine(`Processed ${result.entryCount} MDict entries (${result.skipped} skipped) → ${result.records.length} index records`);
      records = result.records;

    } else {
      throw new Error("Unsupported input. Use a Yomitan .zip, jmdict-simplified .json/.json.tgz, or MDict .mdx.");
    }

    setProgress(0, 1, "Sorting and writing binary index…");
    await sleep(0);
    const { idx, dat, recordCount } = dictWriteBinary(records);
    const spx = dictGenSpx(idx);

    logLine(`Output:`);
    logLine(`  dict/${outName}.idx: ${formatBytes(idx.length)} (${recordCount.toLocaleString()} records)`);
    logLine(`  dict/${outName}.dat: ${formatBytes(dat.length)}`);
    logLine(`  dict/${outName}.spx: ${formatBytes(spx.length)} (lookup accelerator)`);

    const zipOut = new ZipWriter();
    zipOut.addFile(`dict/${outName}.idx`, idx);
    zipOut.addFile(`dict/${outName}.dat`, dat);
    zipOut.addFile(`dict/${outName}.spx`, spx);
    const blob = zipOut.toBlob();
    logLine(`Done — ${formatBytes(blob.size)}. Unzip at the SD card root: files land in /dict/.`);
    downloadBlob(blob, `${outName}-dict.zip`);
    setProgress(1, 1, "Complete");
  } catch (e) {
    logLine("Error: " + e.message, "error");
    console.error(e);
  } finally {
    $("dict-run").disabled = false;
    wakeLock.release();
  }
}

if (typeof document !== "undefined" && document.getElementById("dict-run")) {
  $("dict-run").addEventListener("click", runDictConversion);
}
