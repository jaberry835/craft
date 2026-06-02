import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
}

export async function resetGeneratedOutput(rootDirectory: string): Promise<void> {
  await ensureDirectory(rootDirectory);

  await Promise.all([
    rm(path.join(rootDirectory, "reports"), { recursive: true, force: true }),
    rm(path.join(rootDirectory, "emails"), { recursive: true, force: true }),
    rm(path.join(rootDirectory, "exports"), { recursive: true, force: true }),
    rm(path.join(rootDirectory, "manifest.json"), { force: true }),
    rm(path.join(rootDirectory, "validation-report.json"), { force: true })
  ]);
}

export async function writeTextFile(rootDirectory: string, relativePath: string, content: string): Promise<string> {
  const targetPath = path.join(rootDirectory, relativePath);
  await ensureDirectory(path.dirname(targetPath));
  await writeFile(targetPath, content, "utf8");
  return targetPath;
}

export async function writeBinaryFile(rootDirectory: string, relativePath: string, content: Uint8Array): Promise<string> {
  const targetPath = path.join(rootDirectory, relativePath);
  await ensureDirectory(path.dirname(targetPath));
  await writeFile(targetPath, content);
  return targetPath;
}