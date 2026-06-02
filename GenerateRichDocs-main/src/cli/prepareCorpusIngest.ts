import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { RunManifest } from "../core/types.js";

interface CorpusPackSummary {
  packId: string;
  outputDir: string;
}

interface CorpusManifest {
  corpusRunId: string;
  outputDir: string;
  packs: CorpusPackSummary[];
}

export interface PrepareCorpusIngestOptions {
  corpusDir: string;
  outputDir?: string;
}

function dedupeBlocks(contents: string[]): string {
  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const content of contents) {
    for (const block of content.split(/\r?\n\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      if (seen.has(block)) {
        continue;
      }

      seen.add(block);
      blocks.push(block);
    }
  }

  return blocks.join("\n\n");
}

function replaceOutputDirPlaceholder(content: string, packId: string): string {
  return content.replace(/'\{OUTPUT_DIR\}\/([^']+)'/g, (_match, relativePath: string) =>
    `'https://{STORAGE_ACCOUNT}.blob.core.windows.net/{CONTAINER}/{BLOB_PREFIX}/${packId}/${relativePath}{SAS_TOKEN}'`
  );
}

function buildUploadScript(corpusDir: string): string {
  return [
    "param(",
    "  [Parameter(Mandatory=$true)][string]$StorageAccountName,",
    "  [Parameter(Mandatory=$true)][string]$ContainerName,",
    "  [string]$BlobPrefix = \"generated-demo\"",
    ")",
    "",
    "$ErrorActionPreference = \"Stop\"",
    `$CorpusDir = \"${corpusDir.replaceAll("\\", "\\\\")}\"`,
    "az storage blob upload-batch --account-name $StorageAccountName --destination $ContainerName --source $CorpusDir --destination-path $BlobPrefix --overwrite true"
  ].join("\n");
}

function buildIngestInstructions(corpusRunId: string): string {
  return [
    "// Replace the placeholders before running these commands in Azure Data Explorer.",
    `// Corpus run id: ${corpusRunId}`,
    "// {STORAGE_ACCOUNT} => your storage account name without suffix",
    "// {CONTAINER} => your blob container name",
    "// {BLOB_PREFIX} => the upload prefix used by upload-corpus-to-blob.ps1",
    "// {SAS_TOKEN} => optional SAS token starting with ? if ADX is not using managed identity"
  ].join("\n");
}

export async function runPrepareCorpusIngestCommand(options: PrepareCorpusIngestOptions): Promise<void> {
  const corpusDir = path.resolve(options.corpusDir);
  const outputDir = options.outputDir ?? path.join(corpusDir, "ingest");
  const corpusManifestContent = await readFile(path.join(corpusDir, "corpus-manifest.json"), "utf8");
  const corpusManifest = JSON.parse(corpusManifestContent) as CorpusManifest;
  const tableScripts: string[] = [];
  const mappingScripts: string[] = [];
  const ingestScripts: string[] = [];

  await mkdir(outputDir, { recursive: true });

  for (const pack of corpusManifest.packs) {
    const manifestContent = await readFile(path.join(pack.outputDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestContent) as RunManifest;
    const tablesKql = await readFile(path.join(pack.outputDir, "exports", "adx-create-tables.kql"), "utf8");
    const mappingsKql = await readFile(path.join(pack.outputDir, "exports", "adx-create-mappings.kql"), "utf8");
    const ingestKql = await readFile(path.join(pack.outputDir, "exports", "adx-ingest-commands.kql"), "utf8");

    tableScripts.push(tablesKql);
    mappingScripts.push(mappingsKql);
    ingestScripts.push(`// Pack ${manifest.packId}\n${replaceOutputDirPlaceholder(ingestKql, manifest.packId)}`);
  }

  await writeFile(path.join(outputDir, "upload-corpus-to-blob.ps1"), `${buildUploadScript(corpusDir)}\n`, "utf8");
  await writeFile(path.join(outputDir, "adx-create-tables.kql"), `${buildIngestInstructions(corpusManifest.corpusRunId)}\n\n${dedupeBlocks(tableScripts)}\n`, "utf8");
  await writeFile(path.join(outputDir, "adx-create-mappings.kql"), `${buildIngestInstructions(corpusManifest.corpusRunId)}\n\n${dedupeBlocks(mappingScripts)}\n`, "utf8");
  await writeFile(path.join(outputDir, "adx-ingest-corpus.kql"), `${buildIngestInstructions(corpusManifest.corpusRunId)}\n\n${ingestScripts.join("\n\n")}\n`, "utf8");

  console.log(`Prepared corpus ingest scripts for ${corpusManifest.packs.length} packs`);
  console.log(`Corpus run id: ${corpusManifest.corpusRunId}`);
  console.log(`Output: ${outputDir}`);
}