import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { runGenerateCorpusCommand } from "../src/cli/generateCorpus.js";

test("runGenerateCorpusCommand writes a corpus manifest and one pack per scenario-country combination", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "generate-rich-docs-corpus-"));
  const outputDir = path.join(tempRoot, "corpus");

  try {
    await runGenerateCorpusCommand({
      scenarios: ["correspondence-dossier", "talent-mobility"],
      countries: ["country-veloria"],
      locale: "en",
      seed: 600,
      peoplePerOrganization: 2,
      reportCount: 4,
      emailCount: 3,
      csvScale: 1,
      outputDir,
      validate: true
    });

    const corpusManifestContent = await readFile(path.join(outputDir, "corpus-manifest.json"), "utf8");
    const corpusManifest = JSON.parse(corpusManifestContent) as {
      packCount: number;
      totalArtifacts: number;
      packs: Array<{ scenarioId: string; countryId: string; seed: number; outputDir: string; artifactCount: number }>;
    };

    assert.equal(corpusManifest.packCount, 2);
    assert.equal(corpusManifest.packs.length, 2);
    assert.equal(corpusManifest.packs[0]?.scenarioId, "correspondence-dossier");
    assert.equal(corpusManifest.packs[1]?.scenarioId, "talent-mobility");
    assert.equal(corpusManifest.packs[0]?.countryId, "country-veloria");
    assert.equal(corpusManifest.packs[0]?.seed, 600);
    assert.equal(corpusManifest.packs[1]?.seed, 601);
    assert.ok((corpusManifest.totalArtifacts ?? 0) >= 68);

    const firstPackManifestContent = await readFile(path.join(outputDir, "correspondence-dossier-country-veloria-seed-600", "manifest.json"), "utf8");
    const firstPackManifest = JSON.parse(firstPackManifestContent) as { artifacts: unknown[]; countryId: string };
    assert.equal(firstPackManifest.countryId, "country-veloria");
    assert.equal(firstPackManifest.artifacts.length, 39);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});