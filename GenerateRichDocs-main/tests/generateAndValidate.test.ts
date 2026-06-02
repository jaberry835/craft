import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { runGenerateCommand } from "../src/cli/generate.js";
import { runValidation } from "../src/validators/validatePack.js";
import { AzureOpenAiCreativeProvider } from "../src/providers/azureOpenAiCreativeProvider.js";
import type { RunManifest } from "../src/core/types.js";

test("runGenerateCommand writes a complete pack that validates successfully", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "generate-rich-docs-"));
  const outputDir = path.join(tempRoot, "pack");

  try {
    await runGenerateCommand({
      scenario: "government-mining-trade",
      locale: "en",
      dataLanguage: "ru",
      seed: 77,
      outputDir,
      validate: true
    });

    const manifestContent = await readFile(path.join(outputDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestContent) as RunManifest;

    assert.equal(manifest.provider, "mock");
    assert.equal(manifest.dataLanguage, "ru");
    assert.equal(manifest.artifacts.length, 32);
    const reportArtifacts = manifest.artifacts.filter((artifact) => artifact.relativePath.startsWith("reports/"));
    assert.equal(reportArtifacts.length, 3);
    assert.ok(manifest.artifacts.some((artifact) => artifact.relativePath === "emails/email-government-mining-trade-1.eml"));
    assert.ok(manifest.artifacts.some((artifact) => artifact.relativePath === "exports/reports.jsonl"));
    assert.ok(manifest.artifacts.some((artifact) => artifact.relativePath === "exports/dossier-plan.json"));
    assert.ok(manifest.artifacts.some((artifact) => artifact.relativePath === "exports/vehicles.csv"));
    assert.ok(manifest.artifacts.some((artifact) => artifact.relativePath === "exports/toll-transactions.csv"));
    assert.ok(manifest.artifacts.some((artifact) => artifact.relativePath === "exports/border-crossings.csv"));
    assert.ok(manifest.artifacts.some((artifact) => artifact.relativePath === "exports/adx-create-tables.kql"));
    assert.ok(manifest.artifacts.some((artifact) => artifact.relativePath === "exports/adx-create-mappings.kql"));
    assert.ok(manifest.artifacts.some((artifact) => artifact.relativePath === "exports/adx-ingest-commands.kql"));

    const vehiclesCsv = await readFile(path.join(outputDir, "exports", "vehicles.csv"), "utf8");
    assert.match(vehiclesCsv, /vehicle_id/);
    assert.match(vehiclesCsv, /Toyota|Honda|Ford|Nissan|Hyundai|Kia|Volkswagen|Mazda/);

    const peopleDirectoryCsv = await readFile(path.join(outputDir, "exports", "people-directory.csv"), "utf8");
    assert.match(peopleDirectoryCsv, /data_language/);
    assert.match(peopleDirectoryCsv, /[А-Яа-яЁё]/);
    assert.match(peopleDirectoryCsv, /"ru"/);
    assert.match(peopleDirectoryCsv, /"(en|zh|ar|es)"/);

    const mentionsCsv = await readFile(path.join(outputDir, "exports", "person-mentions.csv"), "utf8");
    assert.match(mentionsCsv, /source_table/);
    assert.match(mentionsCsv, /reports|emails|vehicles|toll_transactions|border_crossings/);

    const tablesKql = await readFile(path.join(outputDir, "exports", "adx-create-tables.kql"), "utf8");
    assert.match(tablesKql, /\.create-merge table PeopleDirectory/);

    const mappingsKql = await readFile(path.join(outputDir, "exports", "adx-create-mappings.kql"), "utf8");
    assert.match(mappingsKql, /ingestion csv mapping/);

    const ingestKql = await readFile(path.join(outputDir, "exports", "adx-ingest-commands.kql"), "utf8");
    assert.match(ingestKql, /\.ingest into table PeopleDirectory/);

    const report = await runValidation(outputDir);
    assert.equal(report.issueCount, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runGenerateCommand removes stale generated artifacts on rerun", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "generate-rich-docs-"));
  const outputDir = path.join(tempRoot, "pack");

  try {
    await mkdir(path.join(outputDir, "reports"), { recursive: true });
    await writeFile(path.join(outputDir, "reports", "stale-report.pdf"), "stale", "utf8");

    await runGenerateCommand({
      scenario: "government-mining-trade",
      locale: "en",
      seed: 77,
      outputDir,
      validate: true
    });

    const manifestContent = await readFile(path.join(outputDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestContent) as RunManifest;

    assert.equal(manifest.artifacts.length, 32);
    await assert.rejects(readFile(path.join(outputDir, "reports", "stale-report.pdf"), "utf8"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runGenerateCommand supports larger dataset tuning from the CLI options", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "generate-rich-docs-"));
  const outputDir = path.join(tempRoot, "scaled-pack");

  try {
    await runGenerateCommand({
      scenario: "correspondence-dossier",
      locale: "en",
      seed: 42,
      countryId: "country-demeris",
      peoplePerOrganization: 4,
      reportCount: 12,
      emailCount: 10,
      csvScale: 3,
      outputDir
    });

    const manifestContent = await readFile(path.join(outputDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestContent) as RunManifest;
    const entitiesContent = await readFile(path.join(outputDir, "exports", "entities.json"), "utf8");
    const entities = JSON.parse(entitiesContent) as { people: Array<{ id: string }> };
    const reportArtifacts = manifest.artifacts.filter((artifact) => artifact.relativePath.startsWith("reports/"));
    const emailArtifacts = manifest.artifacts.filter((artifact) => artifact.relativePath.startsWith("emails/") && /\.(json|txt|html|eml)$/.test(artifact.relativePath));
    const tollTransactionsCsv = await readFile(path.join(outputDir, "exports", "toll-transactions.csv"), "utf8");
    const tollRows = tollTransactionsCsv.trim().split(/\r?\n/).length - 1;

    assert.equal(manifest.countryId, "country-demeris");
    assert.equal(manifest.generationProfile.peoplePerOrganization, 4);
    assert.equal(manifest.generationProfile.reportCount, 12);
    assert.equal(manifest.generationProfile.emailCount, 10);
    assert.equal(manifest.generationProfile.csvScale, 3);
    assert.equal(reportArtifacts.length, 12);
    assert.equal(emailArtifacts.length, 40);
    assert.equal(entities.people.length, 28);
    assert.ok(tollRows > 5000);

    const report = await runValidation(outputDir);
    assert.equal(report.issueCount, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runValidation fails with an actionable error when the pack has not been generated", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "generate-rich-docs-"));
  const outputDir = path.join(tempRoot, "missing-pack");

  try {
    await assert.rejects(
      runValidation(outputDir),
      /Run the generate command first or pass --output-dir to an existing generated pack/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runGenerateCommand surfaces Azure errors and does not create output on provider failure", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "generate-rich-docs-"));
  const outputDir = path.join(tempRoot, "pack");
  const originalEnv = {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION
  };

  process.env.AZURE_OPENAI_ENDPOINT = "https://example-resource.openai.azure.com";
  process.env.AZURE_OPENAI_API_KEY = "test-key";
  process.env.AZURE_OPENAI_DEPLOYMENT = "test-deployment";
  process.env.AZURE_OPENAI_API_VERSION = "2024-10-21";

  t.mock.method(AzureOpenAiCreativeProvider.prototype, "createDossierPlan", async () => {
    throw new Error("Azure OpenAI request failed for dossier plan: 404 Resource not found");
  });

  try {
    await assert.rejects(
      runGenerateCommand({
        scenario: "correspondence-dossier",
        locale: "en",
        dataLanguage: "ru",
        seed: 42,
        outputDir
      }),
      /Azure OpenAI request failed for dossier plan/
    );

    await assert.rejects(access(outputDir));
  } finally {
    if (originalEnv.endpoint === undefined) {
      delete process.env.AZURE_OPENAI_ENDPOINT;
    } else {
      process.env.AZURE_OPENAI_ENDPOINT = originalEnv.endpoint;
    }

    if (originalEnv.apiKey === undefined) {
      delete process.env.AZURE_OPENAI_API_KEY;
    } else {
      process.env.AZURE_OPENAI_API_KEY = originalEnv.apiKey;
    }

    if (originalEnv.deployment === undefined) {
      delete process.env.AZURE_OPENAI_DEPLOYMENT;
    } else {
      process.env.AZURE_OPENAI_DEPLOYMENT = originalEnv.deployment;
    }

    if (originalEnv.apiVersion === undefined) {
      delete process.env.AZURE_OPENAI_API_VERSION;
    } else {
      process.env.AZURE_OPENAI_API_VERSION = originalEnv.apiVersion;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});