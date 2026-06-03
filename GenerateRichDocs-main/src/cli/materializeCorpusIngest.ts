import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadConfig } from "../config.js";

export interface MaterializeCorpusIngestOptions {
  ingestDir: string;
  outputDir?: string;
  storageAccountName?: string;
  containerName?: string;
  blobPrefix?: string;
  sasToken?: string;
}

function replaceAllPlaceholders(
  content: string,
  values: {
    storageAccountName: string;
    containerName: string;
    blobPrefix: string;
    sasToken: string;
  }
): string {
  return content
    .replaceAll("{STORAGE_ACCOUNT}", values.storageAccountName)
    .replaceAll("{CONTAINER}", values.containerName)
    .replaceAll("{BLOB_PREFIX}", values.blobPrefix)
    .replaceAll("{SAS_TOKEN}", values.sasToken);
}

function buildResolvedUploadScript(
  corpusDir: string,
  storageAccountName: string,
  containerName: string,
  blobPrefix: string
): string {
  return [
    "$ErrorActionPreference = \"Stop\"",
    `$CorpusDir = \"${corpusDir.replaceAll("\\", "\\\\")}\"`,
    `$StorageAccountName = \"${storageAccountName}\"`,
    `$ContainerName = \"${containerName}\"`,
    `$BlobPrefix = \"${blobPrefix}\"`,
    "az storage blob upload-batch --account-name $StorageAccountName --destination $ContainerName --source $CorpusDir --destination-path $BlobPrefix --overwrite true"
  ].join("\n");
}

export async function runMaterializeCorpusIngestCommand(options: MaterializeCorpusIngestOptions): Promise<void> {
  const config = loadConfig();
  const ingestDir = path.resolve(options.ingestDir);
  const outputDir = options.outputDir ?? path.join(ingestDir, "resolved");
  const storageAccountName = options.storageAccountName ?? config.azureStorageAccountName;
  const containerName = options.containerName ?? config.azureStorageContainerName;
  const blobPrefix = options.blobPrefix ?? config.azureStorageBlobPrefix ?? "generated-demo";
  const sasToken = options.sasToken ?? config.azureStorageSasToken ?? "";

  if (!storageAccountName) {
    throw new Error("Missing storage account name. Pass --storage-account or set AZURE_STORAGE_ACCOUNT_NAME.");
  }

  if (!containerName) {
    throw new Error("Missing container name. Pass --container or set AZURE_STORAGE_CONTAINER_NAME.");
  }

  await mkdir(outputDir, { recursive: true });

  const uploadScript = buildResolvedUploadScript(path.dirname(ingestDir), storageAccountName, containerName, blobPrefix);
  const createTablesKql = await readFile(path.join(ingestDir, "adx-create-tables.kql"), "utf8");
  const createMappingsKql = await readFile(path.join(ingestDir, "adx-create-mappings.kql"), "utf8");
  const ingestKql = await readFile(path.join(ingestDir, "adx-ingest-corpus.kql"), "utf8");

  const resolvedValues = {
    storageAccountName,
    containerName,
    blobPrefix,
    sasToken
  };

  await writeFile(path.join(outputDir, "upload-corpus-to-blob.ps1"), `${uploadScript}\n`, "utf8");
  await writeFile(path.join(outputDir, "adx-create-tables.kql"), `${replaceAllPlaceholders(createTablesKql, resolvedValues)}\n`, "utf8");
  await writeFile(path.join(outputDir, "adx-create-mappings.kql"), `${replaceAllPlaceholders(createMappingsKql, resolvedValues)}\n`, "utf8");
  await writeFile(path.join(outputDir, "adx-ingest-corpus.kql"), `${replaceAllPlaceholders(ingestKql, resolvedValues)}\n`, "utf8");

  console.log(`Materialized corpus ingest scripts`);
  console.log(`Storage account: ${storageAccountName}`);
  console.log(`Container: ${containerName}`);
  console.log(`Blob prefix: ${blobPrefix}`);
  console.log(`Output: ${outputDir}`);
}