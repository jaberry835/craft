import { readFile } from "node:fs/promises";
import path from "node:path";
import MailComposer from "mailcomposer";
import type { MailComposerOptions } from "mailcomposer";
import type { OutputArtifact, ScenarioPack } from "../core/types.js";
import { EntityRegistry } from "../core/entityRegistry.js";
import { renderTemplate } from "../core/templateRenderer.js";
import { writeBinaryFile, writeTextFile } from "./outputWriter.js";

function describeAttachment(fileName: string, relatedReports: ScenarioPack["reports"]): string {
  const extension = path.extname(fileName).replace(".", "").toUpperCase();
  const reportId = path.basename(fileName, path.extname(fileName));
  const report = relatedReports.find((candidate) => candidate.id === reportId);
  return report ? `${report.title} (${extension})` : fileName;
}

async function buildEml(emailOptions: MailComposerOptions): Promise<Buffer> {
  const composer = MailComposer(emailOptions);
  return new Promise<Buffer>((resolve, reject) => {
    composer.build((error, message) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(message);
    });
  });
}

export async function generateEmailArtifacts(pack: ScenarioPack, outputDir: string): Promise<OutputArtifact[]> {
  const registry = EntityRegistry.fromScenario(pack);
  const artifacts: OutputArtifact[] = [];

  for (const email of pack.emails) {
    const fromPerson = registry.getPerson(email.fromPersonId);
    const toPeople = email.toPersonIds.map((personId) => registry.getPerson(personId));
    const ccPeople = email.ccPersonIds.map((personId) => registry.getPerson(personId));
    const relatedReports = email.relatedDocumentIds.map((reportId) => registry.getReport(reportId));

    const jsonRelativePath = `emails/${email.id}.json`;
    await writeTextFile(
      outputDir,
      jsonRelativePath,
      JSON.stringify(
        {
          ...email,
          from: fromPerson,
          to: toPeople,
          cc: ccPeople,
          relatedReports
        },
        null,
        2
      )
    );
    artifacts.push({
      id: `artifact-${email.id}-json`,
      type: "json",
      relativePath: jsonRelativePath,
      description: `Structured email record for ${email.subject}`,
      sourceEntityIds: [email.id, fromPerson.id, ...email.toPersonIds, ...email.relatedDocumentIds]
    });

    const txtRelativePath = `emails/${email.id}.txt`;
    const txtContent = await renderTemplate(pack.locale, "email.txt.ejs", {
      email,
      fromPerson,
      toPeople,
      ccPeople,
      relatedReports,
      attachmentLabels: email.attachments.map((attachment) => describeAttachment(attachment.fileName, relatedReports))
    });
    await writeTextFile(outputDir, txtRelativePath, txtContent);
    artifacts.push({
      id: `artifact-${email.id}-txt`,
      type: "txt",
      relativePath: txtRelativePath,
      description: `Plain-text email view for ${email.subject}`,
      sourceEntityIds: [email.id, fromPerson.id, ...email.toPersonIds, ...email.relatedDocumentIds]
    });

    const htmlRelativePath = `emails/${email.id}.html`;
    const htmlContent = await renderTemplate(pack.locale, "email.html.ejs", {
      email,
      fromPerson,
      toPeople,
      ccPeople,
      relatedReports,
      attachmentLabels: email.attachments.map((attachment) => describeAttachment(attachment.fileName, relatedReports))
    });
    await writeTextFile(outputDir, htmlRelativePath, htmlContent);
    artifacts.push({
      id: `artifact-${email.id}-html`,
      type: "html",
      relativePath: htmlRelativePath,
      description: `HTML email view for ${email.subject}`,
      sourceEntityIds: [email.id, fromPerson.id, ...email.toPersonIds, ...email.relatedDocumentIds]
    });

    const emlAttachments = await Promise.all(
      email.attachments.map(async (attachment) => {
        const filePath = path.join(outputDir, "reports", attachment.fileName);
        const content = await readFile(filePath);
        return {
          filename: attachment.fileName,
          content,
          contentType: attachment.mimeType
        };
      })
    );

    const emlBuffer = await buildEml({
      from: `${fromPerson.fullName} <${fromPerson.email}>`,
      to: toPeople.map((person) => `${person.fullName} <${person.email}>`).join(", "),
      cc: ccPeople.length ? ccPeople.map((person) => `${person.fullName} <${person.email}>`).join(", ") : undefined,
      subject: email.subject,
      date: new Date(email.sentAt),
      text: email.plainTextBody,
      html: htmlContent,
      attachments: emlAttachments
    });

    const emlRelativePath = `emails/${email.id}.eml`;
    await writeBinaryFile(outputDir, emlRelativePath, emlBuffer);
    artifacts.push({
      id: `artifact-${email.id}-eml`,
      type: "eml",
      relativePath: emlRelativePath,
      description: `RFC 822 email package for ${email.subject}`,
      sourceEntityIds: [email.id, fromPerson.id, ...email.toPersonIds, ...email.relatedDocumentIds]
    });
  }

  return artifacts;
}