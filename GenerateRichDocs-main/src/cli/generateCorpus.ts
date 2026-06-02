import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { FictionalCountryId, GenerationProfile, RunManifest, ScenarioId, SupportedLocale } from "../core/types.js";
import { runGenerateCommand } from "./generate.js";

export interface GenerateCorpusCommandOptions {
  scenarios: ScenarioId[];
  countries: FictionalCountryId[];
  locale: SupportedLocale;
  dataLanguage?: SupportedLocale;
  seed: number;
  peoplePerOrganization?: number;
  reportCount?: number;
  emailCount?: number;
  csvScale?: number;
  outputDir?: string;
  prompt?: string;
  validate?: boolean;
}

interface CorpusPackSummary {
  packId: string;
  corpusRunId: string;
  scenarioId: ScenarioId;
  countryId: FictionalCountryId;
  seed: number;
  outputDir: string;
  provider: string;
  artifactCount: number;
  generationProfile: GenerationProfile;
}

interface CorpusManifest {
  corpusRunId: string;
  seedStart: number;
  generatedAt: string;
  locale: SupportedLocale;
  dataLanguage: SupportedLocale;
  outputDir: string;
  packCount: number;
  totalArtifacts: number;
  packs: CorpusPackSummary[];
}

export async function runGenerateCorpusCommand(options: GenerateCorpusCommandOptions): Promise<void> {
  const outputDirectory = options.outputDir ?? path.resolve(process.cwd(), "generated", `corpus-seed-${options.seed}`);
  const corpusRunId = path.basename(outputDirectory);
  const packs: CorpusPackSummary[] = [];
  let nextSeed = options.seed;

  await mkdir(outputDirectory, { recursive: true });

  for (const scenario of options.scenarios) {
    for (const countryId of options.countries) {
      const packId = `${scenario}-${countryId}-seed-${nextSeed}`;
      const packOutputDir = path.join(outputDirectory, packId);

      await runGenerateCommand({
        scenario,
        locale: options.locale,
        dataLanguage: options.dataLanguage ?? options.locale,
        seed: nextSeed,
        packId,
        corpusRunId,
        countryId,
        peoplePerOrganization: options.peoplePerOrganization,
        reportCount: options.reportCount,
        emailCount: options.emailCount,
        csvScale: options.csvScale,
        outputDir: packOutputDir,
        prompt: options.prompt,
        validate: options.validate
      });

      const manifestContent = await readFile(path.join(packOutputDir, "manifest.json"), "utf8");
      const manifest = JSON.parse(manifestContent) as RunManifest;

      packs.push({
        packId: manifest.packId,
        corpusRunId,
        scenarioId: manifest.scenarioId,
        countryId: manifest.countryId,
        seed: manifest.seed,
        outputDir: packOutputDir,
        provider: manifest.provider,
        artifactCount: manifest.artifacts.length,
        generationProfile: manifest.generationProfile
      });

      nextSeed += 1;
    }
  }

  const corpusManifest: CorpusManifest = {
    corpusRunId,
    seedStart: options.seed,
    generatedAt: new Date().toISOString(),
    locale: options.locale,
    dataLanguage: options.dataLanguage ?? options.locale,
    outputDir: outputDirectory,
    packCount: packs.length,
    totalArtifacts: packs.reduce((sum, pack) => sum + pack.artifactCount, 0),
    packs
  };

  await writeFile(path.join(outputDirectory, "corpus-manifest.json"), `${JSON.stringify(corpusManifest, null, 2)}\n`, "utf8");

  console.log(`Generated corpus with ${corpusManifest.packCount} packs`);
  console.log(`Corpus run id: ${corpusManifest.corpusRunId}`);
  console.log(`Seed start: ${corpusManifest.seedStart}`);
  console.log(`Total artifacts: ${corpusManifest.totalArtifacts}`);
  console.log(`Output: ${outputDirectory}`);
}