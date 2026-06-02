import type {
  CreativeDirective,
  DossierEmailPlan,
  DossierPlan,
  DossierReportPlan,
  EmailDraft,
  FictionalCountry,
  Organization,
  Person,
  ReportDocument,
  ReportDraft,
  ScenarioBrief
} from "../core/types.js";

export interface CreativeProviderContext {
  brief: ScenarioBrief;
  country: FictionalCountry;
  directive: CreativeDirective;
  organizations: Organization[];
  people: Person[];
  topics: string[];
  reportIds: string[];
  reportFormats: ReportDocument["outputFormat"][];
  emailIds: string[];
}

export interface ReportDraftContext extends CreativeProviderContext {
  plan: DossierPlan;
  reportPlan: DossierReportPlan;
}

export interface EmailDraftContext extends CreativeProviderContext {
  plan: DossierPlan;
  emailPlan: DossierEmailPlan;
  relatedReports: ReportDocument[];
}

export interface CreativeProvider {
  readonly name: string;
  createDossierPlan(context: CreativeProviderContext): Promise<DossierPlan>;
  createReportDraft(context: ReportDraftContext): Promise<ReportDraft>;
  createEmailDraft(context: EmailDraftContext): Promise<EmailDraft>;
}