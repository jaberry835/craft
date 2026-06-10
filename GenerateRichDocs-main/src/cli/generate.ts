import path from "node:path";
import { createScenarioPack } from "../core/seedFactory.js";
import type { FictionalCountryId, GenerationProfile, ScenarioBrief, ScenarioId, SupportedLocale } from "../core/types.js";
import { generateCsvExports } from "../generators/csvExportGenerator.js";
import { generateDocxReports } from "../generators/docxReportGenerator.js";
import { generateEmailArtifacts } from "../generators/emailGenerator.js";
import { generateHtmlReports } from "../generators/htmlReportGenerator.js";
import { generateJsonlExports } from "../generators/jsonlExportGenerator.js";
import { createEntitiesExport, generateManifest } from "../generators/manifestGenerator.js";
import { resetGeneratedOutput } from "../generators/outputWriter.js";
import { generatePdfReports } from "../generators/pdfReportGenerator.js";
import { generateTxtReports } from "../generators/txtReportGenerator.js";
import { generateXlsxWorkbook } from "../generators/xlsxReportGenerator.js";
import { createCreativeProvider } from "../providers/index.js";
import { scenarioCatalog } from "../scenarios/catalog.js";
import { runValidation } from "../validators/validatePack.js";

export interface GenerateCommandOptions {
  scenario: ScenarioId;
  locale: SupportedLocale;
  dataLanguage?: SupportedLocale;
  seed: number;
  packId?: string;
  corpusRunId?: string;
  countryId?: FictionalCountryId;
  peoplePerOrganization?: number;
  reportCount?: number;
  emailCount?: number;
  csvScale?: number;
  outputDir?: string;
  prompt?: string;
  validate?: boolean;
}

function resolveGenerationProfile(options: GenerateCommandOptions): Partial<GenerationProfile> | undefined {
  const profile: Partial<GenerationProfile> = {};

  if (options.peoplePerOrganization !== undefined) {
    profile.peoplePerOrganization = options.peoplePerOrganization;
  }

  if (options.reportCount !== undefined) {
    profile.reportCount = options.reportCount;
  }

  if (options.emailCount !== undefined) {
    profile.emailCount = options.emailCount;
  }

  if (options.csvScale !== undefined) {
    profile.csvScale = options.csvScale;
  }

  return Object.keys(profile).length > 0 ? profile : undefined;
}

export async function runGenerateCommand(options: GenerateCommandOptions): Promise<void> {
  const provider = createCreativeProvider();
  const outputDirectory = options.outputDir ?? path.resolve(
    process.cwd(),
    "generated",
    `${options.scenario}-${options.locale}${options.countryId ? `-${options.countryId}` : ""}-seed-${options.seed}`
  );

  const brief: ScenarioBrief = {
    scenarioId: options.scenario,
    locale: options.locale,
    dataLanguage: options.dataLanguage ?? options.locale,
    seed: options.seed,
    outputDir: outputDirectory,
    packId: options.packId,
    corpusRunId: options.corpusRunId,
    countryId: options.countryId,
    generationProfile: resolveGenerationProfile(options),
    customPrompt: options.prompt
  };

  const startedAt = Date.now();
  const step = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
    const stepStartedAt = Date.now();
    console.log(`[generate] ${label}...`);
    const result = await action();
    const elapsedMs = Date.now() - stepStartedAt;
    console.log(`[generate] ${label} completed (${elapsedMs} ms)`);
    return result;
  };

  console.log(`[generate] Starting pack generation`);
  console.log(`[generate] Scenario: ${options.scenario}`);
  console.log(`[generate] Locale: ${options.locale}`);
  console.log(`[generate] Data language: ${options.dataLanguage ?? options.locale}`);
  console.log(`[generate] Seed: ${options.seed}`);
  console.log(`[generate] Output: ${outputDirectory}`);

  const pack = await step("Build seeded scenario pack", () => createScenarioPack(brief, provider));

  await step("Reset output directory", () => resetGeneratedOutput(outputDirectory));

  const entities = createEntitiesExport(pack);
  const txtArtifacts = await step("Generate TXT reports", () => generateTxtReports(pack, outputDirectory));
  const htmlArtifacts = await step("Generate HTML reports", () => generateHtmlReports(pack, outputDirectory));
  const docxArtifacts = await step("Generate DOCX reports", () => generateDocxReports(pack, outputDirectory));
  const pdfArtifacts = await step("Generate PDF reports", () => generatePdfReports(pack, outputDirectory));
  const csvArtifacts = await step("Generate CSV exports", () => generateCsvExports(pack, outputDirectory));
  const xlsxArtifacts = await step("Generate XLSX workbook", () => generateXlsxWorkbook(pack, outputDirectory));
  const jsonlArtifacts = await step("Generate JSONL exports", () => generateJsonlExports(pack, entities, outputDirectory));
  const emailArtifacts = await step("Generate email artifacts", () => generateEmailArtifacts(pack, outputDirectory));
  const manifest = await step("Write manifest", () =>
    generateManifest(
      pack,
      outputDirectory,
      [
        ...txtArtifacts,
        ...htmlArtifacts,
        ...docxArtifacts,
        ...pdfArtifacts,
        ...csvArtifacts,
        ...xlsxArtifacts,
        ...jsonlArtifacts,
        ...emailArtifacts
      ],
      provider.name
    )
  );

  const scenarioTitle = scenarioCatalog[options.scenario]?.title ?? options.scenario;
  console.log(`Generated ${scenarioTitle}`);
  console.log(`Provider: ${manifest.provider}`);
  console.log(`Country: ${manifest.countryName}`);
  console.log(`Data language: ${manifest.dataLanguage}`);
  console.log(`People per organization: ${pack.generationProfile.peoplePerOrganization}`);
  console.log(`Report count: ${pack.generationProfile.reportCount}`);
  console.log(`Email count: ${pack.generationProfile.emailCount}`);
  console.log(`CSV scale: ${pack.generationProfile.csvScale}`);
  console.log(`Artifacts: ${manifest.artifacts.length}`);
  console.log(`Output: ${outputDirectory}`);

  if (options.validate) {
    console.log("[generate] Validation starting...");
    const validationStartedAt = Date.now();
    const validationReport = await runValidation(outputDirectory);
    const validationElapsedMs = Date.now() - validationStartedAt;
    console.log(`[generate] Validation completed (${validationElapsedMs} ms)`);
    console.log(`Validation issues: ${validationReport.issueCount}`);
    const errorCount = validationReport.issues.filter((issue) => issue.severity === "error").length;
    if (errorCount > 0) {
      process.exitCode = 1;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`[generate] Pack completed in ${elapsedMs} ms`);
}