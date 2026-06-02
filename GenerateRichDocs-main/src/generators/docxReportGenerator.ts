import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type { OutputArtifact, ScenarioPack } from "../core/types.js";
import { EntityRegistry } from "../core/entityRegistry.js";
import { formatDisplayDate } from "./reportFormatting.js";
import { writeBinaryFile } from "./outputWriter.js";

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

export async function generateDocxReports(pack: ScenarioPack, outputDir: string): Promise<OutputArtifact[]> {
  const registry = EntityRegistry.fromScenario(pack);
  const artifacts: OutputArtifact[] = [];

  for (const report of pack.reports) {
    if (report.outputFormat !== "docx") {
      continue;
    }

    const author = registry.getPerson(report.authorPersonId);
    const organization = registry.getOrganization(report.organizationId);
    const createdAtDisplay = formatDisplayDate(report.createdAt);

    const document = new Document({
      sections: [
        {
          children: [
            new Paragraph({
              heading: HeadingLevel.TITLE,
              children: [new TextRun(report.title)]
            }),
            new Paragraph({
              spacing: { after: 240 },
              children: [
                new TextRun({ text: "Author: ", bold: true }),
                new TextRun(`${author.fullName}, ${author.title}`),
                new TextRun("\n"),
                new TextRun({ text: "Organization: ", bold: true }),
                new TextRun(organization.name),
                new TextRun("\n"),
                new TextRun({ text: "Country: ", bold: true }),
                new TextRun(pack.country.name),
                new TextRun("\n"),
                new TextRun({ text: "Issued: ", bold: true }),
                new TextRun(createdAtDisplay)
              ]
            }),
            new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Executive Summary" }),
            new Paragraph({ spacing: { after: 220 }, text: report.summary }),
            new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Findings" }),
            ...report.body.map((paragraph) => new Paragraph({ spacing: { after: 220 }, text: paragraph })),
            new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Referenced Entities" }),
            ...report.relatedEntityIds.map((entityId) => new Paragraph({ bullet: { level: 0 }, text: describeRelatedEntity(entityId, pack, registry) })),
            new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Tags" }),
            new Paragraph(report.subjectTags.join(", "))
          ]
        }
      ]
    });

    const buffer = await Packer.toBuffer(document);
    const relativePath = `reports/${report.id}.docx`;
    await writeBinaryFile(outputDir, relativePath, buffer);
    artifacts.push({
      id: `artifact-${report.id}-docx`,
      type: "docx",
      relativePath,
      description: `DOCX report for ${report.title}`,
      sourceEntityIds: [report.id, author.id, organization.id]
    });
  }

  return artifacts;
}