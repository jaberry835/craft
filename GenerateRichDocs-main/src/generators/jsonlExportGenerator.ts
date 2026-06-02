import type { OutputArtifact, ScenarioEntitiesExport, ScenarioPack } from "../core/types.js";
import { writeTextFile } from "./outputWriter.js";

function toJsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

export async function generateJsonlExports(
  pack: ScenarioPack,
  entities: ScenarioEntitiesExport,
  outputDir: string
): Promise<OutputArtifact[]> {
  const artifacts: OutputArtifact[] = [];

  const files: Array<{ relativePath: string; records: unknown[]; description: string; sourceEntityIds: string[] }> = [
    {
      relativePath: "exports/reports.jsonl",
      records: entities.reports,
      description: "JSONL export of report entities",
      sourceEntityIds: entities.reports.map((report) => report.id)
    },
    {
      relativePath: "exports/emails.jsonl",
      records: entities.emails,
      description: "JSONL export of email entities",
      sourceEntityIds: entities.emails.map((email) => email.id)
    },
    {
      relativePath: "exports/organizations.jsonl",
      records: entities.organizations,
      description: "JSONL export of organization entities",
      sourceEntityIds: entities.organizations.map((organization) => organization.id)
    },
    {
      relativePath: "exports/people.jsonl",
      records: entities.people,
      description: "JSONL export of people entities",
      sourceEntityIds: entities.people.map((person) => person.id)
    },
    {
      relativePath: "exports/events.jsonl",
      records: entities.events,
      description: "JSONL export of narrative events",
      sourceEntityIds: entities.events.map((event) => event.id)
    },
    {
      relativePath: "exports/country.jsonl",
      records: [entities.country],
      description: "JSONL export of the country entity",
      sourceEntityIds: [entities.country.id]
    }
  ];

  for (const file of files) {
    await writeTextFile(outputDir, file.relativePath, toJsonLines(file.records));
    artifacts.push({
      id: `artifact-${file.relativePath.replace(/[/.]+/g, "-")}`,
      type: "jsonl",
      relativePath: file.relativePath,
      description: file.description,
      sourceEntityIds: file.sourceEntityIds
    });
  }

  return artifacts;
}