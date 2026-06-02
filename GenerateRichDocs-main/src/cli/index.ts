import "dotenv/config";
import { Command } from "commander";
import { runGenerateCommand } from "./generate.js";
import { runValidateCommand } from "./validate.js";
import { scenarioCatalog } from "../scenarios/catalog.js";
import type { FictionalCountryId, SupportedLocale } from "../core/types.js";

const supportedLocales = new Set<SupportedLocale>(["en", "zh", "ru", "ar", "es"]);
const supportedCountryIds = new Set<FictionalCountryId>(["country-veloria", "country-astriv", "country-demeris"]);

function parseSupportedLocale(value: string, optionName: string): SupportedLocale {
  if (supportedLocales.has(value as SupportedLocale)) {
    return value as SupportedLocale;
  }

  throw new Error(`Unsupported ${optionName}: ${value}`);
}

function parseCountryId(value: string): FictionalCountryId {
  if (supportedCountryIds.has(value as FictionalCountryId)) {
    return value as FictionalCountryId;
  }

  throw new Error(`Unsupported country: ${value}`);
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${optionName}: ${value}. Expected a positive integer.`);
  }

  return parsed;
}

const program = new Command();

program
  .name("generate-rich-docs")
  .description("Generate seeded document packs for retrieval and demo scenarios.")
  .version("0.1.0");

program
  .command("generate")
  .description("Generate a seeded English-first scenario pack")
  .option("-s, --scenario <scenario>", "Scenario to generate", "correspondence-dossier")
  .option("-l, --locale <locale>", "Locale to render", "en")
  .option("--data-language <locale>", "Optional locale for generated names and operational CSV place labels")
  .option("--country <countryId>", "Optional fictional country override: country-veloria, country-astriv, or country-demeris")
  .option("--seed <seed>", "Deterministic random seed", "42")
  .option("--people-per-organization <count>", "People to generate per organization", "1")
  .option("--report-count <count>", "Reports to generate in the pack", "3")
  .option("--email-count <count>", "Emails to generate in the pack", "2")
  .option("--csv-scale <count>", "Multiplier for operational CSV row volume", "1")
  .option("-o, --output-dir <path>", "Optional output directory")
  .option("-p, --prompt <prompt>", "Additional scenario guidance")
  .option("--validate", "Validate the generated pack after writing files", false)
  .action(async (options) => {
    const scenario = options.scenario as keyof typeof scenarioCatalog;
    if (!(scenario in scenarioCatalog)) {
      throw new Error(`Unsupported scenario: ${options.scenario}`);
    }

    const locale = parseSupportedLocale(options.locale, "locale");
    const dataLanguage = options.dataLanguage ? parseSupportedLocale(options.dataLanguage, "data-language") : locale;
    const countryId = options.country ? parseCountryId(options.country) : undefined;
    const peoplePerOrganization = parsePositiveInteger(options.peoplePerOrganization, "people-per-organization");
    const reportCount = parsePositiveInteger(options.reportCount, "report-count");
    const emailCount = parsePositiveInteger(options.emailCount, "email-count");
    const csvScale = parsePositiveInteger(options.csvScale, "csv-scale");

    if (locale !== "en") {
      console.warn(`Locale ${locale} is not fully implemented yet; continuing with locale-ready English templates.`);
    }

    try {
      await runGenerateCommand({
        scenario,
        locale,
        dataLanguage,
        seed: Number.parseInt(options.seed, 10),
        countryId,
        peoplePerOrganization,
        reportCount,
        emailCount,
        csvScale,
        outputDir: options.outputDir,
        prompt: options.prompt,
        validate: options.validate
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    }
  });

program
  .command("list-scenarios")
  .description("List available scenario presets")
  .action(() => {
    for (const [scenarioId, info] of Object.entries(scenarioCatalog)) {
      console.log(`${scenarioId}: ${info.title}`);
      console.log(`  ${info.description}`);
    }
  });

program
  .command("validate")
  .description("Validate a generated scenario pack for internal consistency")
  .option("-o, --output-dir <path>", "Generated scenario output directory")
  .action(async (options) => {
    await runValidateCommand({
      outputDir: options.outputDir
    });
  });

await program.parseAsync(process.argv);