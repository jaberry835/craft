import OpenAI from "openai";
import type { AppConfig } from "../config.js";
import type {
  DossierPlan,
  EmailDraft,
  ReportDraft
} from "../core/types.js";
import type {
  CreativeProvider,
  CreativeProviderContext,
  EmailDraftContext,
  ReportDraftContext
} from "./creativeProvider.js";

export class AzureOpenAiCreativeProvider implements CreativeProvider {
  public readonly name = "azure-openai";
  private readonly client: OpenAI;
  private readonly endpointRoot: string;
  private static readonly defaultRequestTimeoutMs = 60000;
  private static readonly dossierPlanTimeoutMs = AzureOpenAiCreativeProvider.defaultRequestTimeoutMs;
  private hasLoggedConnection = false;

  private static shouldLogPrompts(): boolean {
    return process.env.GENERATE_RICH_DOCS_SHOW_PROMPTS === "1";
  }

  private static normalizeEndpoint(endpoint: string): { endpointRoot: string; warnings: string[] } {
    const warnings: string[] = [];
    let normalized = endpoint.trim().replace(/\/+$/, "");

    if (/\/openai\/deployments\//i.test(normalized)) {
      warnings.push("AZURE_OPENAI_ENDPOINT appears to include '/openai/deployments/...'. Use only the resource root endpoint.");
      normalized = normalized.replace(/\/openai\/deployments\/.*$/i, "");
    } else if (/\/openai$/i.test(normalized)) {
      warnings.push("AZURE_OPENAI_ENDPOINT appears to include '/openai'. Use only the resource root endpoint.");
      normalized = normalized.replace(/\/openai$/i, "");
    }

    if (/\/models$/i.test(normalized)) {
      warnings.push("AZURE_OPENAI_ENDPOINT appears to include '/models'. Use the Azure OpenAI resource root endpoint.");
      normalized = normalized.replace(/\/models$/i, "");
    }

    return { endpointRoot: normalized, warnings };
  }

  public constructor(private readonly config: Required<Pick<AppConfig, "azureOpenAiApiKey" | "azureOpenAiApiVersion" | "azureOpenAiDeployment" | "azureOpenAiEndpoint">>) {
    const normalizedEndpoint = AzureOpenAiCreativeProvider.normalizeEndpoint(config.azureOpenAiEndpoint);
    this.endpointRoot = normalizedEndpoint.endpointRoot;

    for (const warning of normalizedEndpoint.warnings) {
      console.warn(`[azure-openai] ${warning}`);
    }

    this.client = new OpenAI({
      apiKey: config.azureOpenAiApiKey,
      baseURL: `${this.endpointRoot}/openai/deployments/${config.azureOpenAiDeployment}`,
      defaultQuery: { "api-version": config.azureOpenAiApiVersion },
      defaultHeaders: { "api-key": config.azureOpenAiApiKey }
    });
  }

  public async createDossierPlan(context: CreativeProviderContext): Promise<DossierPlan> {
    return this.requestStructuredJson<DossierPlan>(
      "You plan synthetic institutional dossiers. Use only invented institutions, domains, and people. Never mention that the content is invented, fictional, synthetic, or generated. Use internal IDs only inside JSON identifier fields. Never place internal IDs in titles, summaries, outlines, talking points, or other natural-language text. Return strict JSON only.",
      [
        "Create a dossier plan for a pack of interlinked reports and emails.",
        `Scenario: ${context.brief.scenarioId}`,
        `Country: ${context.country.name}`,
        `Audience: ${context.directive.audience}`,
        `Narrative focus: ${context.directive.narrativeFocus}`,
        `Constraints: ${context.directive.writingConstraints.join(" | ")}`,
        `Available organizations: ${context.organizations.map((organization) => `${organization.id}: ${organization.name} (${organization.kind})`).join("; ")}`,
        `Available people: ${context.people.map((person) => `${person.id}: ${person.fullName}, ${person.title}, organization=${context.organizations.find((organization) => organization.id === person.organizationId)?.name ?? person.organizationId}`).join("; ")}`,
        `Topic families: ${context.topicDetails.map((detail) => `${detail.familyLabel} => ${detail.topic}`).join("; ")}`,
        `Topics: ${context.topics.join(", ")}`,
        `Report IDs: ${context.reportIds.join(", ")}`,
        `Required report output formats: ${context.reportIds.map((reportId, index) => `${reportId}=${context.reportFormats[index]}`).join("; ")}`,
        `Email IDs: ${context.emailIds.join(", ")}`,
        "Return JSON with this shape:",
        '{"overview":"string","anchorFacts":["string"],"reportPlans":[{"reportId":"string","title":"string","organizationId":"string","authorPersonId":"string","outputFormat":"txt|html|docx|pdf","styleProfile":"string","subjectTags":["string"],"summaryFocus":"string","outline":["string"],"relatedEntityIds":["string"],"referenceDocumentIds":["string"]}],"emailPlans":[{"emailId":"string","threadId":"string","styleProfile":"string","subject":"string","fromPersonId":"string","toPersonIds":["string"],"ccPersonIds":["string"],"relatedDocumentIds":["string"],"purpose":"string","talkingPoints":["string"]}]}'
      ].join("\n"),
      "dossier plan",
      AzureOpenAiCreativeProvider.dossierPlanTimeoutMs
    );
  }

  public async createReportDraft(context: ReportDraftContext): Promise<ReportDraft> {
    const reportOrganization = context.organizations.find((organization) => organization.id === context.reportPlan.organizationId);
    const reportAuthor = context.people.find((person) => person.id === context.reportPlan.authorPersonId);
    return this.requestStructuredJson<ReportDraft>(
      "You write concise, plausible institutional reports. Use only the provided invented entities. Never say the report is fictional, invented, synthetic, or generated. Never include internal identifiers such as org-*, person-*, report-*, email-*, thread-*, or country-* in the prose. Refer to organizations, people, and prior documents by their names or titles only. Return strict JSON only.",
      [
        `Report title: ${context.reportPlan.title}`,
        `Report kind: ${context.reportPlan.kind}`,
        `Intended output format: ${context.reportPlan.outputFormat}`,
        `Style profile: ${context.reportPlan.styleProfile}`,
        `Kind guidance: ${this.describeReportKindGuidance(context.reportPlan.kind)}`,
        `Country: ${context.country.name}`,
        `Organization: ${reportOrganization?.name ?? context.reportPlan.organizationId}`,
        `Author: ${reportAuthor?.fullName ?? context.reportPlan.authorPersonId}`,
        `Audience: ${context.directive.audience}`,
        `Tone: ${context.directive.tone}`,
        `Summary focus: ${context.reportPlan.summaryFocus}`,
        `Outline: ${context.reportPlan.outline.join(" | ")}`,
        `Anchor facts: ${context.plan.anchorFacts.join(" | ")}`,
        `Related entities: ${this.describeEntities(context.reportPlan.relatedEntityIds, context)}`,
        `Referenced documents: ${this.describeReferencedDocuments(context.reportPlan.referenceDocumentIds, context)}`,
        "Return JSON with this shape:",
        '{"summary":"string","body":["paragraph 1","paragraph 2","paragraph 3"]}'
      ].join("\n"),
      `report draft ${context.reportPlan.reportId}`
    );
  }

  public async createEmailDraft(context: EmailDraftContext): Promise<EmailDraft> {
    const sender = context.people.find((person) => person.id === context.emailPlan.fromPersonId);
    const recipients = context.emailPlan.toPersonIds
      .map((personId) => context.people.find((person) => person.id === personId)?.fullName)
      .filter((value): value is string => Boolean(value));
    return this.requestStructuredJson<EmailDraft>(
      "You write concise internal email prose for institutions and companies. Use only the provided invented entities. Never say the email or attachments are fictional, invented, synthetic, or generated. Never include internal identifiers such as org-*, person-*, report-*, email-*, thread-*, or country-* in the prose. Refer to people, organizations, and documents by names or titles only. Preserve blank lines between greeting, body, and sign-off. Return strict JSON only.",
      [
        `Subject: ${context.emailPlan.subject}`,
        `Style profile: ${context.emailPlan.styleProfile}`,
        `Style guidance: ${this.describeEmailStyleGuidance(context.emailPlan.styleProfile)}`,
        `Sender: ${sender?.fullName ?? context.emailPlan.fromPersonId}`,
        `Recipients: ${recipients.join(", ")}`,
        `Purpose: ${context.emailPlan.purpose}`,
        `Talking points: ${context.emailPlan.talkingPoints.join(" | ")}`,
        `Related reports: ${context.relatedReports.map((report) => `${report.title}: ${report.summary}`).join(" | ")}`,
        "Return JSON with this shape:",
        '{"plainTextBody":"multi-paragraph email body including greeting and sign-off, but no subject line or headers"}'
      ].join("\n"),
      `email draft ${context.emailPlan.emailId}`
    );
  }

  private async requestStructuredJson<T>(systemPrompt: string, userPrompt: string, label: string, timeoutMs = AzureOpenAiCreativeProvider.defaultRequestTimeoutMs): Promise<T> {
    const attempts = [
      {
        temperature: 0.6,
        systemPrompt,
        userPrompt
      },
      {
        temperature: 0.2,
        systemPrompt: `${systemPrompt} The response must be valid JSON that parses without repair.`,
        userPrompt: `${userPrompt}\nReturn compact valid JSON only. Do not use markdown fences.`
      }
    ];

    let lastError: Error | undefined;

    for (const attempt of attempts) {
      let content: string;
      const attemptStartedAt = Date.now();
      console.log(`[azure-openai] Requesting ${label} (temperature=${attempt.temperature}, timeoutMs=${timeoutMs})...`);

      if (AzureOpenAiCreativeProvider.shouldLogPrompts()) {
        console.log(`[azure-openai] Prompt label: ${label}`);
        console.log(`[azure-openai] ---- SYSTEM PROMPT START (${label}) ----`);
        console.log(attempt.systemPrompt);
        console.log(`[azure-openai] ---- SYSTEM PROMPT END (${label}) ----`);
        console.log(`[azure-openai] ---- USER PROMPT START (${label}) ----`);
        console.log(attempt.userPrompt);
        console.log(`[azure-openai] ---- USER PROMPT END (${label}) ----`);
      }

      try {
        content = await this.requestJson(attempt.systemPrompt, attempt.userPrompt, attempt.temperature, timeoutMs);
      } catch (error) {
        throw this.wrapAzureRequestError(error, label);
      }

      if (!this.hasLoggedConnection) {
        console.log(
          `[azure-openai] Connection verified endpoint=${this.endpointRoot} deployment=${this.config.azureOpenAiDeployment}`
        );
        this.hasLoggedConnection = true;
      }

      console.log(`[azure-openai] Received ${label} (${Date.now() - attemptStartedAt} ms)`);

      try {
        return this.parseJson<T>(content, label);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error(`Azure OpenAI returned invalid JSON for ${label}.`);
  }

  private async requestJson(systemPrompt: string, userPrompt: string, temperature: number, timeoutMs: number): Promise<string> {
    const completion = await this.client.chat.completions.create(
      {
        model: this.config.azureOpenAiDeployment,
        temperature,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: userPrompt
          }
        ]
      },
      {
        timeout: timeoutMs
      }
    );

    return completion.choices[0]?.message?.content?.trim() ?? "";
  }

  private wrapAzureRequestError(error: unknown, label: string): Error {
    const contextLabel = `endpoint=${this.endpointRoot} deployment=${this.config.azureOpenAiDeployment}`;
    const errorType = this.classifyError(error);

    if (error instanceof OpenAI.APIError) {
      const status = error.status ? ` ${error.status}` : "";
      const code = error.code ? ` (${error.code})` : "";
      const detail = error.message || "Unknown Azure OpenAI error";

      if (errorType === "timeout") {
        return new Error(
          `Azure OpenAI request timed out for ${label} (${contextLabel}). ` +
          `Check that AZURE_OPENAI_ENDPOINT is reachable and AZURE_OPENAI_DEPLOYMENT is deployed. ` +
          `${status}${code} ${detail}`.trim()
        );
      }

      if (errorType === "connection") {
        return new Error(
          `Azure OpenAI connection failed for ${label} (${contextLabel}). ` +
          `Verify AZURE_OPENAI_ENDPOINT is valid and accessible. ` +
          `Check network connectivity and firewall rules. ` +
          `${status}${code} ${detail}`.trim()
        );
      }

      if (errorType === "auth") {
        return new Error(
          `Azure OpenAI authentication failed for ${label} (${contextLabel}). ` +
          `Verify AZURE_OPENAI_API_KEY is valid and has permission for AZURE_OPENAI_DEPLOYMENT. ` +
          `${status}${code} ${detail}`.trim()
        );
      }

      return new Error(`Azure OpenAI request failed for ${label} (${contextLabel}):${status}${code} ${detail}`.trim());
    }

    if (error instanceof Error) {
      const message = error.message;

      if (errorType === "timeout") {
        return new Error(
          `Azure OpenAI request timed out for ${label} (${contextLabel}). ` +
          `Request did not complete within configured timeout. ${message}`
        );
      }

      if (errorType === "connection") {
        return new Error(
          `Azure OpenAI connection failed for ${label} (${contextLabel}). ` +
          `Check network connectivity and AZURE_OPENAI_ENDPOINT validity. ${message}`
        );
      }

      return new Error(`Azure OpenAI request failed for ${label} (${contextLabel}): ${message}`);
    }

    return new Error(`Azure OpenAI request failed for ${label} (${contextLabel}): ${String(error)}`);
  }

  private classifyError(error: unknown): "timeout" | "connection" | "auth" | "other" {
    if (error instanceof OpenAI.APIError) {
      const message = error.message.toLowerCase();
      const code = error.code?.toLowerCase() ?? "";

      if (message.includes("timeout") || code === "econnaborted" || code === "etimedout") {
        return "timeout";
      }

      if (
        message.includes("econnrefused") ||
        message.includes("enotfound") ||
        message.includes("connection refused") ||
        message.includes("network") ||
        code === "econnrefused" ||
        code === "enotfound" ||
        code === "ehostunreach"
      ) {
        return "connection";
      }

      if (error.status === 401 || error.status === 403 || message.includes("unauthorized") || message.includes("forbidden")) {
        return "auth";
      }

      return "other";
    }

    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      if (message.includes("timeout") || message.includes("etimedout")) {
        return "timeout";
      }

      if (message.includes("econnrefused") || message.includes("enotfound") || message.includes("connection")) {
        return "connection";
      }
    }

    return "other";
  }

  private parseJson<T>(content: string, label: string): T {
    const trimmed = content.trim();
    const unwrapped = trimmed.startsWith("```")
      ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
      : trimmed;
    const startIndex = unwrapped.indexOf("{");
    const endIndex = unwrapped.lastIndexOf("}");
    const candidate = startIndex >= 0 && endIndex >= startIndex ? unwrapped.slice(startIndex, endIndex + 1) : unwrapped;

    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Azure OpenAI returned invalid JSON for ${label}: ${reason}`);
    }
  }

  private describeEntities(entityIds: string[], context: ReportDraftContext): string {
    const descriptions = entityIds.map((entityId) => {
      if (entityId === context.country.id) {
        return `${context.country.name} (country)`;
      }

      const organization = context.organizations.find((candidate) => candidate.id === entityId);
      if (organization) {
        return `${organization.name} (${organization.kind})`;
      }

      const person = context.people.find((candidate) => candidate.id === entityId);
      if (person) {
        const organizationName = context.organizations.find((candidate) => candidate.id === person.organizationId)?.name ?? person.organizationId;
        return `${person.fullName}, ${person.title}, ${organizationName}`;
      }

      const reportPlan = context.plan.reportPlans.find((candidate) => candidate.reportId === entityId);
      if (reportPlan) {
        return `${reportPlan.title} (linked report)`;
      }

      return entityId;
    });

    return descriptions.join("; ");
  }

  private describeReferencedDocuments(reportIds: string[], context: ReportDraftContext): string {
    if (reportIds.length === 0) {
      return "none";
    }

    return reportIds
      .map((reportId) => context.plan.reportPlans.find((candidate) => candidate.reportId === reportId)?.title ?? reportId)
      .join("; ");
  }

  private describeReportKindGuidance(kind: ReportDraftContext["reportPlan"]["kind"]): string {
    switch (kind) {
      case "government-report":
        return "Write as a formal coordination brief with institutional framing, procedural observations, and next-step recommendations.";
      case "briefing-note":
        return "Write as a compact analytical note optimized for rapid review, highlighting the immediate issue set, key comparisons, and clarifications needed.";
      case "company-report":
        return "Write as an operations-facing business note focused on handling constraints, commercial implications, scheduling pressure, and practical mitigations.";
      default:
        return "Write as a concise institutional report with concrete observations and clear follow-up actions.";
    }
  }

  private describeEmailStyleGuidance(styleProfile: string): string {
    if (/circulation/i.test(styleProfile)) {
      return "Use a formal distribution style that foregrounds the attachment, requested review scope, and response deadline.";
    }

    if (/follow-up/i.test(styleProfile)) {
      return "Use a follow-up coordination style that references prior circulation, requests specific corrections, and narrows the outstanding actions.";
    }

    return "Use a concise internal coordination style with a clear request and a direct sign-off.";
  }
}