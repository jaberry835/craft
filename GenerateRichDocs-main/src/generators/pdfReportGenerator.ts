import PDFDocument from "pdfkit";
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

async function createPdfBuffer(build: (document: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({ margin: 54, size: "A4", info: { Producer: "GenerateRichDocs", Creator: "GenerateRichDocs" } });
    const chunks: Buffer[] = [];

    document.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    document.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    document.on("error", (error) => {
      reject(error);
    });

    build(document);
    document.end();
  });
}

export async function generatePdfReports(pack: ScenarioPack, outputDir: string): Promise<OutputArtifact[]> {
  const registry = EntityRegistry.fromScenario(pack);
  const artifacts: OutputArtifact[] = [];

  for (const report of pack.reports) {
    if (report.outputFormat !== "pdf") {
      continue;
    }

    const author = registry.getPerson(report.authorPersonId);
    const organization = registry.getOrganization(report.organizationId);
    const createdAtDisplay = formatDisplayDate(report.createdAt);
    const buffer = await createPdfBuffer((document) => {
      document.font("Times-Bold").fontSize(20).text(report.title);
      document.moveDown(0.5);
      document.font("Times-Roman").fontSize(11);
      document.text(`Author: ${author.fullName}, ${author.title}`);
      document.text(`Organization: ${organization.name}`);
      document.text(`Country: ${pack.country.name}`);
      document.text(`Issued: ${createdAtDisplay}`);
      document.moveDown();
      document.font("Times-Bold").fontSize(14).text("Executive Summary");
      document.font("Times-Roman").fontSize(11).text(report.summary, { align: "justify" });
      document.moveDown();
      document.font("Times-Bold").fontSize(14).text("Findings");
      for (const paragraph of report.body) {
        document.font("Times-Roman").fontSize(11).text(paragraph, { align: "justify" });
        document.moveDown(0.75);
      }
      document.font("Times-Bold").fontSize(14).text("Referenced Entities");
      document.font("Times-Roman").fontSize(11);
      for (const entityId of report.relatedEntityIds) {
        document.text(`• ${describeRelatedEntity(entityId, pack, registry)}`);
      }
      document.moveDown();
      document.font("Times-Bold").fontSize(14).text("Tags");
      document.font("Times-Roman").fontSize(11).text(report.subjectTags.join(" | "));
    });

    const relativePath = `reports/${report.id}.pdf`;
    await writeBinaryFile(outputDir, relativePath, buffer);
    artifacts.push({
      id: `artifact-${report.id}-pdf`,
      type: "pdf",
      relativePath,
      description: `PDF report for ${report.title}`,
      sourceEntityIds: [report.id, author.id, organization.id]
    });
  }

  return artifacts;
}