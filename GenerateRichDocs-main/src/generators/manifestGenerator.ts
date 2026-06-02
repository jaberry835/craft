import type { OutputArtifact, RunManifest, ScenarioEntitiesExport, ScenarioPack } from "../core/types.js";
import { writeTextFile } from "./outputWriter.js";

export async function generateManifest(
  pack: ScenarioPack,
  outputDir: string,
  artifacts: OutputArtifact[],
  providerName: string
): Promise<RunManifest> {
  const manifestArtifacts: OutputArtifact[] = [
    ...artifacts,
    {
      id: "artifact-exports-dossier-plan-json",
      type: "json",
      relativePath: "exports/dossier-plan.json",
      description: "Canonical dossier planning record for linked document generation",
      sourceEntityIds: [
        ...pack.reports.map((report) => report.id),
        ...pack.emails.map((email) => email.id)
      ]
    }
  ];

  const entities: ScenarioEntitiesExport = {
    country: pack.country,
    organizations: pack.organizations,
    people: pack.people,
    reports: pack.reports,
    emails: pack.emails,
    events: pack.events,
    dossierPlan: pack.dossierPlan
  };

  const manifest: RunManifest = {
    scenarioId: pack.scenarioId,
    locale: pack.locale,
    dataLanguage: pack.dataLanguage,
    seed: pack.seed,
    generatedAt: new Date().toISOString(),
    provider: providerName,
    countryId: pack.country.id,
    countryName: pack.country.name,
    outputDir,
    generationProfile: pack.generationProfile,
    artifacts: manifestArtifacts
  };

  await writeTextFile(outputDir, "manifest.json", JSON.stringify(manifest, null, 2));
  await writeTextFile(outputDir, "exports/dossier-plan.json", JSON.stringify(pack.dossierPlan, null, 2));
  await writeTextFile(outputDir, "exports/entities.json", JSON.stringify(entities, null, 2));

  return manifest;
}

export function createEntitiesExport(pack: ScenarioPack): ScenarioEntitiesExport {
  return {
    country: pack.country,
    organizations: pack.organizations,
    people: pack.people,
    reports: pack.reports,
    emails: pack.emails,
    events: pack.events,
    dossierPlan: pack.dossierPlan
  };
}