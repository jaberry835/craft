import type { OutputArtifact, ScenarioPack } from "../core/types.js";
import { EntityRegistry } from "../core/entityRegistry.js";
import { renderTemplate } from "../core/templateRenderer.js";
import { formatDisplayDate } from "./reportFormatting.js";
import { writeTextFile } from "./outputWriter.js";

function describeRelatedEntity(entityId: string, pack: ScenarioPack, registry: EntityRegistry): string {
  if (entityId === pack.country.id) {
    return pack.country.name;
  }

  if (registry.organizations.has(entityId)) {
    return registry.getOrganization(entityId).name;
  }

  if (registry.people.has(entityId)) {
    const person = registry.getPerson(entityId);
    return `${person.fullName}, ${person.title}`;
  }

  if (registry.reports.has(entityId)) {
    return registry.getReport(entityId).title;
  }

  if (registry.emails.has(entityId)) {
    return registry.emails.get(entityId)?.subject ?? entityId;
  }

  return entityId;
}

export async function generateHtmlReports(pack: ScenarioPack, outputDir: string): Promise<OutputArtifact[]> {
  const registry = EntityRegistry.fromScenario(pack);
  const artifacts: OutputArtifact[] = [];

  for (const report of pack.reports) {
    if (report.outputFormat !== "html") {
      continue;
    }

    const author = registry.getPerson(report.authorPersonId);
    const organization = registry.getOrganization(report.organizationId);
    const rendered = await renderTemplate(pack.locale, "report.html.ejs", {
      country: pack.country,
      report,
      author,
      organization,
      createdAtDisplay: formatDisplayDate(report.createdAt),
      relatedEntityLabels: report.relatedEntityIds.map((entityId) => describeRelatedEntity(entityId, pack, registry))
    });

    const relativePath = `reports/${report.id}.html`;
    await writeTextFile(outputDir, relativePath, rendered);
    artifacts.push({
      id: `artifact-${report.id}-html`,
      type: "html",
      relativePath,
      description: `HTML report for ${report.title}`,
      sourceEntityIds: [report.id, author.id, organization.id]
    });
  }

  return artifacts;
}