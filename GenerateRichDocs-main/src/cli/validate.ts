import path from "node:path";
import { runValidation } from "../validators/validatePack.js";

export interface ValidateCommandOptions {
  outputDir?: string;
}

export async function runValidateCommand(options: ValidateCommandOptions): Promise<void> {
  const outputDirectory = options.outputDir ?? path.resolve(
    process.cwd(),
    "generated",
    "correspondence-dossier-en-seed-42"
  );

  let report;

  try {
    report = await runValidation(outputDirectory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
    return;
  }

  console.log(`Validated scenario ${report.scenarioId}`);
  console.log(`Artifacts checked: ${report.artifactCount}`);
  console.log(`Issues: ${report.issueCount}`);

  if (report.issues.length > 0) {
    for (const issue of report.issues) {
      console.log(`${issue.severity.toUpperCase()} [${issue.code}] ${issue.message}`);
    }
    process.exitCode = 1;
  }
}