import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { runGenerateCorpusCommand } from "../src/cli/generateCorpus.js";
import { runPrepareCorpusIngestCommand } from "../src/cli/prepareCorpusIngest.js";

test("runPrepareCorpusIngestCommand emits upload and ADX ingest scripts from the corpus manifest", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "generate-rich-docs-ingest-"));
  const corpusDir = path.join(tempRoot, "corpus");

  try {
    await runGenerateCorpusCommand({
      scenarios: ["correspondence-dossier"],
      countries: ["country-veloria"],
      locale: "en",
      seed: 700,
      peoplePerOrganization: 2,
      reportCount: 4,
      emailCount: 3,
      csvScale: 1,
      outputDir: corpusDir,
      validate: true
    });

    await runPrepareCorpusIngestCommand({ corpusDir });

    const uploadScript = await readFile(path.join(corpusDir, "ingest", "upload-corpus-to-blob.ps1"), "utf8");
    const createTablesKql = await readFile(path.join(corpusDir, "ingest", "adx-create-tables.kql"), "utf8");
    const createMappingsKql = await readFile(path.join(corpusDir, "ingest", "adx-create-mappings.kql"), "utf8");
    const ingestKql = await readFile(path.join(corpusDir, "ingest", "adx-ingest-corpus.kql"), "utf8");

    assert.match(uploadScript, /az storage blob upload-batch/);
    assert.match(createTablesKql, /\.create-merge table TravelBookings/);
    assert.match(createMappingsKql, /TravelBookingsCsvMapping/);
    assert.match(ingestKql, /https:\/\/{STORAGE_ACCOUNT}\.blob\.core\.windows\.net\/{CONTAINER}\/{BLOB_PREFIX}\/correspondence-dossier-country-veloria-seed-700\/exports\/reports\.csv\{SAS_TOKEN\}/);
    assert.match(ingestKql, /Pack correspondence-dossier-country-veloria-seed-700/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});