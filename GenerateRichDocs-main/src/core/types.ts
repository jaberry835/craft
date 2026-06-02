export type SupportedLocale = "en" | "zh" | "ru" | "ar" | "es";

export type FictionalCountryId = "country-veloria" | "country-astriv" | "country-demeris";

export type ScenarioId =
  | "government-economy"
  | "government-mining-trade"
  | "company-market-report"
  | "correspondence-dossier";

export interface Person {
  id: string;
  fullName: string;
  title: string;
  organizationId: string;
  email: string;
}

export interface Organization {
  id: string;
  name: string;
  kind: "government" | "company" | "research";
  domain: string;
  description: string;
}

export interface FictionalCountry {
  id: FictionalCountryId;
  name: string;
  demonym: string;
  capital: string;
  region: string;
}

export interface ReportDocument {
  id: string;
  kind: "government-report" | "company-report" | "briefing-note";
  outputFormat: "txt" | "html" | "docx" | "pdf";
  title: string;
  summary: string;
  body: string[];
  authorPersonId: string;
  organizationId: string;
  subjectTags: string[];
  createdAt: string;
  relatedEntityIds: string[];
}

export interface AttachmentReference {
  id: string;
  documentId: string;
  fileName: string;
  mimeType: string;
}

export interface EmailMessage {
  id: string;
  threadId: string;
  subject: string;
  fromPersonId: string;
  toPersonIds: string[];
  ccPersonIds: string[];
  sentAt: string;
  plainTextBody: string;
  htmlBody: string;
  relatedDocumentIds: string[];
  attachments: AttachmentReference[];
}

export interface DossierReportPlan {
  reportId: string;
  kind: ReportDocument["kind"];
  outputFormat: ReportDocument["outputFormat"];
  styleProfile: string;
  title: string;
  organizationId: string;
  authorPersonId: string;
  subjectTags: string[];
  summaryFocus: string;
  outline: string[];
  relatedEntityIds: string[];
  referenceDocumentIds: string[];
}

export interface DossierEmailPlan {
  emailId: string;
  threadId: string;
  styleProfile: string;
  subject: string;
  fromPersonId: string;
  toPersonIds: string[];
  ccPersonIds: string[];
  relatedDocumentIds: string[];
  purpose: string;
  talkingPoints: string[];
}

export interface DossierPlan {
  overview: string;
  anchorFacts: string[];
  reportPlans: DossierReportPlan[];
  emailPlans: DossierEmailPlan[];
}

export interface ReportDraft {
  summary: string;
  body: string[];
}

export interface EmailDraft {
  plainTextBody: string;
}

export interface NarrativeEvent {
  id: string;
  timestamp: string;
  type: "report-issued" | "briefing-prepared" | "email-sent";
  summary: string;
  entityIds: string[];
}

export interface ScenarioBrief {
  scenarioId: ScenarioId;
  locale: SupportedLocale;
  dataLanguage?: SupportedLocale;
  seed: number;
  outputDir: string;
  countryId?: FictionalCountryId;
  generationProfile?: Partial<GenerationProfile>;
  customPrompt?: string;
}

export interface GenerationProfile {
  peoplePerOrganization: number;
  reportCount: number;
  emailCount: number;
  csvScale: number;
}

export interface CreativeDirective {
  tone: string;
  audience: string;
  narrativeFocus: string;
  writingConstraints: string[];
}

export interface ScenarioPack {
  scenarioId: ScenarioId;
  locale: SupportedLocale;
  dataLanguage: SupportedLocale;
  seed: number;
  country: FictionalCountry;
  generationProfile: GenerationProfile;
  organizations: Organization[];
  people: Person[];
  reports: ReportDocument[];
  emails: EmailMessage[];
  events: NarrativeEvent[];
  dossierPlan: DossierPlan;
  directive: CreativeDirective;
}

export interface OutputArtifact {
  id: string;
  type: "txt" | "html" | "csv" | "json" | "jsonl" | "docx" | "pdf" | "xlsx" | "eml" | "kql";
  relativePath: string;
  description: string;
  sourceEntityIds: string[];
}

export interface RunManifest {
  scenarioId: ScenarioId;
  locale: SupportedLocale;
  dataLanguage: SupportedLocale;
  seed: number;
  generatedAt: string;
  provider: string;
  countryId: FictionalCountryId;
  countryName: string;
  outputDir: string;
  generationProfile: GenerationProfile;
  artifacts: OutputArtifact[];
}

export interface ScenarioEntitiesExport {
  country: FictionalCountry;
  organizations: Organization[];
  people: Person[];
  reports: ReportDocument[];
  emails: EmailMessage[];
  events: NarrativeEvent[];
  dossierPlan: DossierPlan;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface ValidationReport {
  scenarioId: ScenarioId;
  locale: SupportedLocale;
  seed: number;
  validatedAt: string;
  outputDir: string;
  artifactCount: number;
  issueCount: number;
  issues: ValidationIssue[];
}