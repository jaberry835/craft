import ExcelJS from "exceljs";
import type { OutputArtifact, ScenarioPack } from "../core/types.js";
import { writeBinaryFile } from "./outputWriter.js";

export async function generateXlsxWorkbook(pack: ScenarioPack, outputDir: string): Promise<OutputArtifact[]> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "GenerateRichDocs";
  workbook.created = new Date("2025-01-01T00:00:00.000Z");
  workbook.modified = new Date("2025-01-01T00:00:00.000Z");
  workbook.lastPrinted = new Date("2025-01-01T00:00:00.000Z");

  const overviewSheet = workbook.addWorksheet("Reports Overview");
  overviewSheet.columns = [
    { header: "Report ID", key: "reportId", width: 28 },
    { header: "Title", key: "title", width: 42 },
    { header: "Kind", key: "kind", width: 20 },
    { header: "Created", key: "createdAt", width: 24 },
    { header: "Tags", key: "tags", width: 40 }
  ];
  overviewSheet.getRow(1).font = { bold: true };

  for (const report of pack.reports) {
    overviewSheet.addRow({
      reportId: report.id,
      title: report.title,
      kind: report.kind,
      createdAt: report.createdAt,
      tags: report.subjectTags.join(", ")
    });
  }

  const emailSheet = workbook.addWorksheet("Email Threads");
  emailSheet.columns = [
    { header: "Email ID", key: "emailId", width: 28 },
    { header: "Thread ID", key: "threadId", width: 22 },
    { header: "Subject", key: "subject", width: 44 },
    { header: "Sent", key: "sentAt", width: 24 },
    { header: "Documents", key: "documents", width: 40 }
  ];
  emailSheet.getRow(1).font = { bold: true };

  for (const email of pack.emails) {
    emailSheet.addRow({
      emailId: email.id,
      threadId: email.threadId,
      subject: email.subject,
      sentAt: email.sentAt,
      documents: email.relatedDocumentIds.join(", ")
    });
  }

  const timelineSheet = workbook.addWorksheet("Timeline");
  timelineSheet.columns = [
    { header: "Event ID", key: "eventId", width: 28 },
    { header: "Timestamp", key: "timestamp", width: 24 },
    { header: "Type", key: "type", width: 22 },
    { header: "Summary", key: "summary", width: 64 }
  ];
  timelineSheet.getRow(1).font = { bold: true };
  for (const event of pack.events) {
    timelineSheet.addRow(event);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const relativePath = "exports/scenario-pack.xlsx";
  await writeBinaryFile(outputDir, relativePath, Buffer.from(buffer));

  return [
    {
      id: "artifact-scenario-pack-xlsx",
      type: "xlsx",
      relativePath,
      description: "Workbook summarizing reports, email threads, and the narrative timeline",
      sourceEntityIds: [...pack.reports.map((report) => report.id), ...pack.emails.map((email) => email.id)]
    }
  ];
}