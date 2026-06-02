import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ejs from "ejs";
import type { SupportedLocale } from "./types.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "..", "..");

export async function renderTemplate<TData extends object>(
  locale: SupportedLocale,
  templateName: string,
  data: TData
): Promise<string> {
  const templatePath = path.join(projectRoot, "src", "locales", locale, templateName);
  const templateSource = await readFile(templatePath, "utf8");
  return ejs.render(templateSource, data, { async: false });
}

export function getProjectRoot(): string {
  return projectRoot;
}