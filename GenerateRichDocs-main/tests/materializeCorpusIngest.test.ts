import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { runGenerateCorpusCommand } from "../src/cli/generateCorpus.js";
import { runPrepareCorpusIngestCommand } from "../src/cli/prepareCorpusIngest.js";
import { runMaterializeCorpusIngestCommand } from "../src/cli/materializeCorpusIngest.js";

test("runMaterializeCorpusIngestCommand resolves storage placeholders into execution-ready scripts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "generate-rich-docs-materialize-"));
  const corpusDir = path.join(tempRoot, "corpus");

  try {
    await runGenerateCorpusCommand({
      scenarios: ["correspondence-dossier"],
      countries: ["country-veloria"],
      locale: "en",
      seed: 710,
      peoplePerOrganization: 2,
      reportCount: 4,
      emailCount: 3,
      csvScale: 1,
      outputDir: corpusDir,
      validate: true
    });

    await runPrepareCorpusIngestCommand({ corpusDir });
    await runMaterializeCorpusIngestCommand({
      ingestDir: path.join(corpusDir, "ingest"),
      storageAccountName: "mystorageacct",
      containerName: "demo-corpus",
      blobPrefix: "generated-demo",
      sasToken: "?sig=test"
    });

    const resolvedUpload = await readFile(path.join(corpusDir, "ingest", "resolved", "upload-corpus-to-blob.ps1"), "utf8");
    const resolvedIngest = await readFile(path.join(corpusDir, "ingest", "resolved", "adx-ingest-corpus.kql"), "utf8");

    assert.match(resolvedUpload, /mystorageacct/);
    assert.match(resolvedUpload, /demo-corpus/);
    assert.match(resolvedIngest, /https:\/\/mystorageacct\.blob\.core\.windows\.net\/demo-corpus\/generated-demo\/correspondence-dossier-country-veloria-seed-710\/exports\/reports\.csv\?sig=test/);
    assert.doesNotMatch(resolvedIngest, /\{STORAGE_ACCOUNT\}|\{CONTAINER\}|\{BLOB_PREFIX\}|\{SAS_TOKEN\}/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});