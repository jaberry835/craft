import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  OutputArtifact,
  ReportDocument,
  ScenarioEntitiesExport,
  ValidationIssue,
  ValidationReport,
  RunManifest
} from "../core/types.js";
import { writeTextFile } from "../generators/outputWriter.js";

const emailArtifactTypes = ["json", "txt", "html", "eml"] as const;

function createMissingPackArtifactError(outputDir: string, missingPath: string): Error {
  return new Error(
    `Generated pack is missing required artifact ${missingPath}. Run the generate command first or pass --output-dir to an existing generated pack under ${outputDir}.`
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getEntityIds(entities: ScenarioEntitiesExport): Set<string> {
  return new Set<string>([
    entities.country.id,
    ...entities.organizations.map((organization) => organization.id),
    ...entities.people.map((person) => person.id),
    ...entities.reports.map((report) => report.id),
    ...entities.emails.map((email) => email.id),
    ...entities.events.map((event) => event.id)
  ]);
}

function addIssue(issues: ValidationIssue[], severity: ValidationIssue["severity"], code: string, message: string): void {
  issues.push({ severity, code, message });
}

function findArtifact(artifacts: OutputArtifact[], relativePath: string): OutputArtifact | undefined {
  return artifacts.find((artifact) => artifact.relativePath === relativePath);
}

function validateExpectedArtifacts(manifest: RunManifest, entities: ScenarioEntitiesExport, issues: ValidationIssue[]): void {
  for (const report of entities.reports) {
    const expectedPath = `reports/${report.id}.${report.outputFormat}`;
    if (!findArtifact(manifest.artifacts, expectedPath)) {
      addIssue(issues, "error", "missing-report-artifact", `Missing ${report.outputFormat.toUpperCase()} artifact for ${report.id}.`);
    }

    for (const artifactType of ["txt", "html", "docx", "pdf"] as const) {
      if (artifactType === report.outputFormat) {
        continue;
      }

      const duplicatePath = `reports/${report.id}.${artifactType}`;
      if (findArtifact(manifest.artifacts, duplicatePath)) {
        addIssue(issues, "error", "duplicate-report-artifact", `Unexpected duplicate report artifact ${duplicatePath}; each report should render in one primary format only.`);
      }
    }
  }

  for (const email of entities.emails) {
    for (const artifactType of emailArtifactTypes) {
      const expectedPath = `emails/${email.id}.${artifactType}`;
      if (!findArtifact(manifest.artifacts, expectedPath)) {
        addIssue(issues, "error", "missing-email-artifact", `Missing ${artifactType.toUpperCase()} artifact for ${email.id}.`);
      }
    }
    for (const attachment of email.attachments) {
      const expectedAttachmentPath = `reports/${attachment.fileName}`;
      if (!findArtifact(manifest.artifacts, expectedAttachmentPath)) {
        addIssue(issues, "error", "missing-attachment-artifact", `Missing attachment artifact ${expectedAttachmentPath} referenced by ${email.id}.`);
      }
    }
  }

  if (!findArtifact(manifest.artifacts, "exports/reports.csv")) {
    addIssue(issues, "error", "missing-export", "Missing reports CSV export.");
  }

  if (!findArtifact(manifest.artifacts, "exports/emails.csv")) {
    addIssue(issues, "error", "missing-export", "Missing emails CSV export.");
  }

  for (const csvPath of [
    "exports/people-directory.csv",
    "exports/addresses.csv",
    "exports/vehicles.csv",
    "exports/toll-booths.csv",
    "exports/toll-transactions.csv",
    "exports/border-crossings.csv",
    "exports/flight-manifests.csv",
    "exports/person-mentions.csv"
  ]) {
    if (!findArtifact(manifest.artifacts, csvPath)) {
      addIssue(issues, "error", "missing-export", `Missing CSV export ${csvPath}.`);
    }
  }

  for (const kqlPath of [
    "exports/adx-create-tables.kql",
    "exports/adx-create-mappings.kql",
    "exports/adx-ingest-commands.kql"
  ]) {
    if (!findArtifact(manifest.artifacts, kqlPath)) {
      addIssue(issues, "error", "missing-export", `Missing KQL export ${kqlPath}.`);
    }
  }

  if (!findArtifact(manifest.artifacts, "exports/scenario-pack.xlsx")) {
    addIssue(issues, "error", "missing-export", "Missing scenario workbook export.");
  }

  for (const jsonlPath of [
    "exports/reports.jsonl",
    "exports/emails.jsonl",
    "exports/organizations.jsonl",
    "exports/people.jsonl",
    "exports/events.jsonl",
    "exports/country.jsonl"
  ]) {
    if (!findArtifact(manifest.artifacts, jsonlPath)) {
      addIssue(issues, "error", "missing-export", `Missing JSONL export ${jsonlPath}.`);
    }
  }

  if (!findArtifact(manifest.artifacts, "exports/dossier-plan.json")) {
    addIssue(issues, "error", "missing-export", "Missing dossier plan export.");
  }
}

async function validateArtifactFiles(outputDir: string, manifest: RunManifest, issues: ValidationIssue[]): Promise<void> {
  for (const artifact of manifest.artifacts) {
    const artifactPath = path.join(outputDir, artifact.relativePath);
    if (!(await fileExists(artifactPath))) {
      addIssue(issues, "error", "missing-file", `Artifact file does not exist: ${artifact.relativePath}`);
      continue;
    }

    const metadata = await stat(artifactPath);
    if (metadata.size === 0) {
      addIssue(issues, "error", "empty-file", `Artifact file is empty: ${artifact.relativePath}`);
    }
  }
}

function validateEntityReferences(manifest: RunManifest, entities: ScenarioEntitiesExport, issues: ValidationIssue[]): void {
  const entityIds = getEntityIds(entities);
  for (const artifact of manifest.artifacts) {
    for (const sourceEntityId of artifact.sourceEntityIds) {
      if (!entityIds.has(sourceEntityId)) {
        addIssue(issues, "error", "unknown-source-entity", `Artifact ${artifact.relativePath} references unknown entity ${sourceEntityId}.`);
      }
    }
  }

  for (const report of entities.reports) {
    for (const entityId of report.relatedEntityIds) {
      if (!entityIds.has(entityId)) {
        addIssue(issues, "error", "unknown-related-entity", `Report ${report.id} references unknown related entity ${entityId}.`);
      }
    }
  }

  for (const email of entities.emails) {
    if (!entities.people.some((person) => person.id === email.fromPersonId)) {
      addIssue(issues, "error", "unknown-email-sender", `Email ${email.id} references unknown sender ${email.fromPersonId}.`);
    }

    for (const personId of [...email.toPersonIds, ...email.ccPersonIds]) {
      if (!entities.people.some((person) => person.id === personId)) {
        addIssue(issues, "error", "unknown-email-recipient", `Email ${email.id} references unknown recipient ${personId}.`);
      }
    }

    for (const reportId of email.relatedDocumentIds) {
      if (!entities.reports.some((report) => report.id === reportId)) {
        addIssue(issues, "error", "unknown-related-report", `Email ${email.id} references unknown report ${reportId}.`);
      }
    }
  }
}

function validateDossierLinkages(entities: ScenarioEntitiesExport, issues: ValidationIssue[]): void {
  const reportById = new Map(entities.reports.map((report) => [report.id, report]));
  const emailById = new Map(entities.emails.map((email) => [email.id, email]));

  for (const reportPlan of entities.dossierPlan.reportPlans) {
    const report = reportById.get(reportPlan.reportId);
    if (!report) {
      addIssue(issues, "error", "missing-planned-report", `Planned report ${reportPlan.reportId} is missing from the generated pack.`);
      continue;
    }

    const combinedContent = `${report.summary}\n${report.body.join("\n")}`;
    for (const referenceId of reportPlan.referenceDocumentIds) {
      const referencedReport = reportById.get(referenceId);
      if (!referencedReport) {
        addIssue(issues, "error", "unknown-planned-reference", `Report plan ${reportPlan.reportId} references unknown report ${referenceId}.`);
        continue;
      }

      if (!report.relatedEntityIds.includes(referenceId)) {
        addIssue(issues, "error", "missing-structured-linkage", `Report ${report.id} does not expose planned linkage to ${referenceId} in relatedEntityIds.`);
      }
    }
  }

  for (const emailPlan of entities.dossierPlan.emailPlans) {
    const email = emailById.get(emailPlan.emailId);
    if (!email) {
      addIssue(issues, "error", "missing-planned-email", `Planned email ${emailPlan.emailId} is missing from the generated pack.`);
      continue;
    }

    for (const relatedDocumentId of emailPlan.relatedDocumentIds) {
      const relatedReport = reportById.get(relatedDocumentId);
      if (!relatedReport) {
        addIssue(issues, "error", "unknown-email-linkage", `Email plan ${emailPlan.emailId} references unknown report ${relatedDocumentId}.`);
        continue;
      }

      if (!email.attachments.some((attachment) => attachment.documentId === relatedDocumentId)) {
        addIssue(issues, "error", "missing-email-attachment", `Email ${email.id} is missing an attachment for related report ${relatedReport.title}.`);
      }
    }
  }
}

async function loadJsonFile<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content) as T;
}

export async function runValidation(outputDir: string): Promise<ValidationReport> {
  const manifestPath = path.join(outputDir, "manifest.json");
  const entitiesPath = path.join(outputDir, "exports", "entities.json");

  if (!(await fileExists(manifestPath))) {
    throw createMissingPackArtifactError(outputDir, manifestPath);
  }

  if (!(await fileExists(entitiesPath))) {
    throw createMissingPackArtifactError(outputDir, entitiesPath);
  }

  const manifest = await loadJsonFile<RunManifest>(manifestPath);
  const entities = await loadJsonFile<ScenarioEntitiesExport>(entitiesPath);

  const issues: ValidationIssue[] = [];
  validateExpectedArtifacts(manifest, entities, issues);
  await validateArtifactFiles(outputDir, manifest, issues);
  validateEntityReferences(manifest, entities, issues);
  validateDossierLinkages(entities, issues);

  const report: ValidationReport = {
    scenarioId: manifest.scenarioId,
    locale: manifest.locale,
    seed: manifest.seed,
    validatedAt: new Date().toISOString(),
    outputDir,
    artifactCount: manifest.artifacts.length,
    issueCount: issues.length,
    issues
  };

  await writeTextFile(outputDir, "validation-report.json", JSON.stringify(report, null, 2));
  return report;
}