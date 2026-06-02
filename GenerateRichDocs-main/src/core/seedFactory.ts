import { Faker, en } from "@faker-js/faker";
import type {
  CreativeDirective,
  DossierEmailPlan,
  DossierPlan,
  DossierReportPlan,
  EmailMessage,
  FictionalCountry,
  GenerationProfile,
  Organization,
  Person,
  ReportDocument,
  ScenarioBrief,
  ScenarioPack,
  ScenarioTopicDetail
} from "./types.js";
import type { CreativeProvider } from "../providers/creativeProvider.js";
import { getScenarioTopicDetails, getScenarioTopics } from "../scenarios/catalog.js";

const reportOutputFormats: Array<ReportDocument["outputFormat"]> = ["pdf", "html", "docx", "txt"];

const countries: FictionalCountry[] = [
  {
    id: "country-veloria",
    name: "Veloria",
    demonym: "Velorian",
    capital: "Mariton",
    region: "Southern Isthmus"
  },
  {
    id: "country-astriv",
    name: "Astriv",
    demonym: "Astrivan",
    capital: "Keral",
    region: "Inner Continental Belt"
  },
  {
    id: "country-demeris",
    name: "Demeris",
    demonym: "Demerian",
    capital: "Soreth",
    region: "Eastern Maritime Arc"
  }
];

const governmentNames = [
  "Ministry of Economic Coordination",
  "Bureau of Strategic Minerals",
  "National Trade Observatory"
];

const companyNames = [
  "North Coast Mineral Logistics",
  "Harborline Chemicals Group",
  "Veloria Industrial Metals",
  "Mariton Bulk Analytics"
];

const titles = [
  "Senior Policy Analyst",
  "Deputy Director",
  "Research Coordinator",
  "Commercial Strategy Lead",
  "Trade Compliance Officer"
];

const topicExpansionSuffixes = [
  "annex review",
  "exception handling",
  "distribution controls",
  "procurement variance",
  "border review",
  "escalation tracking",
  "compliance reconciliation",
  "workstream follow-up"
];

const defaultGenerationProfile: GenerationProfile = {
  peoplePerOrganization: 1,
  reportCount: 3,
  emailCount: 2,
  csvScale: 1
};

function createFaker(seed: number): Faker {
  const faker = new Faker({ locale: [en] });
  faker.seed(seed);
  return faker;
}

function normalizeGenerationProfile(profile: Partial<GenerationProfile> | undefined): GenerationProfile {
  return {
    peoplePerOrganization: Math.max(1, profile?.peoplePerOrganization ?? defaultGenerationProfile.peoplePerOrganization),
    reportCount: Math.max(1, profile?.reportCount ?? defaultGenerationProfile.reportCount),
    emailCount: Math.max(1, profile?.emailCount ?? defaultGenerationProfile.emailCount),
    csvScale: Math.max(1, profile?.csvScale ?? defaultGenerationProfile.csvScale)
  };
}

function selectCountry(brief: ScenarioBrief): FictionalCountry {
  if (brief.countryId) {
    return countries.find((country) => country.id === brief.countryId) ?? countries[brief.seed % countries.length]!;
  }

  return countries[brief.seed % countries.length]!;
}

function createTopicSequence(scenarioId: ScenarioBrief["scenarioId"], reportCount: number): ScenarioTopicDetail[] {
  const baseTopics = getScenarioTopicDetails(scenarioId);

  return Array.from({ length: reportCount }, (_, index) => {
    const rootTopic = baseTopics[index % baseTopics.length] ?? {
      familyId: "general",
      familyLabel: "General Coordination",
      topic: "coordination review"
    };
    const cycle = Math.floor(index / baseTopics.length);

    if (cycle === 0) {
      return rootTopic;
    }

    const suffix = topicExpansionSuffixes[(cycle - 1) % topicExpansionSuffixes.length] ?? topicExpansionSuffixes[0];
    return {
      ...rootTopic,
      topic: `${rootTopic.topic} ${suffix}`
    };
  });
}

function createThreadId(scenarioId: ScenarioBrief["scenarioId"], index: number): string {
  return `thread-${scenarioId}-${Math.floor(index / 4) + 1}`;
}

function pickOrganizationForReport(organizations: Organization[], index: number): Organization {
  const governmentOrganizations = organizations.filter((organization) => organization.kind === "government");
  const researchOrganizations = organizations.filter((organization) => organization.kind === "research");
  const companyOrganizations = organizations.filter((organization) => organization.kind === "company");
  const sequence = [governmentOrganizations, researchOrganizations, companyOrganizations, governmentOrganizations, companyOrganizations];
  const organizationPool = sequence[index % sequence.length];

  return organizationPool[index % organizationPool.length] ?? organizations[index % organizations.length] ?? organizations[0]!;
}

function pickAuthorForOrganization(people: Person[], organizationId: string, index: number): Person {
  const organizationPeople = people.filter((person) => person.organizationId === organizationId);
  return organizationPeople[index % organizationPeople.length] ?? people[index % people.length] ?? people[0]!;
}

function buildOrganizations(country: FictionalCountry, faker: Faker): Organization[] {
  const governmentOrganizations = governmentNames.map((name, index) => ({
    id: `org-gov-${index + 1}`,
    name: `${name}, ${country.name}`,
    kind: "government" as const,
    domain: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}.${country.name.toLowerCase()}.gov.fiction`,
    description: `Public-sector body in ${country.name} responsible for ${index === 0 ? "economic monitoring" : index === 1 ? "resource oversight" : "trade reporting"}.`
  }));

  const companyOrganizations = companyNames.slice(0, 3).map((name, index) => ({
    id: `org-co-${index + 1}`,
    name: `${name} ${country.name}`,
    kind: "company" as const,
    domain: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}.${country.name.toLowerCase()}.corp.fiction`,
    description: `Private company operating in ${country.name} across mining, trade, and industrial analysis.`
  }));

  const researchOrganization: Organization = {
    id: "org-rs-1",
    name: `${country.name} Institute for Applied Trade Studies`,
    kind: "research",
    domain: `trade-studies.${country.name.toLowerCase()}.research.fiction`,
    description: `Independent policy and market research institute focused on commodity and trade developments in ${country.name}.`
  };

  return [...governmentOrganizations, ...companyOrganizations, researchOrganization].map((organization) => {
    if (organization.kind !== "company") {
      return organization;
    }

    const qualifier = faker.helpers.arrayElement(["Private", "Commercial", "Regional"]);
    return {
      ...organization,
      description: organization.description.replace("Private company", `${qualifier.toLowerCase()} company`)
    };
  });
}

function buildPeople(organizations: Organization[], faker: Faker, peoplePerOrganization: number): Person[] {
  return organizations.flatMap((organization, organizationIndex) =>
    Array.from({ length: peoplePerOrganization }, (_, personIndex) => {
      const firstName = faker.person.firstName();
      const lastName = faker.person.lastName();
      const fullName = `${firstName} ${lastName}`;
      const globalIndex = organizationIndex * peoplePerOrganization + personIndex;

      return {
        id: `person-${globalIndex + 1}`,
        fullName,
        title: titles[globalIndex % titles.length],
        organizationId: organization.id,
        email: `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]+/g, "") + `@${organization.domain}`
      };
    })
  );
}

function createDirective(brief: ScenarioBrief, country: FictionalCountry): CreativeDirective {
  const scenarioTopics = getScenarioTopics(brief.scenarioId);

  return {
    tone: "formal, analytical, and institutionally credible",
    audience: "policy analysts, ministerial staff, and company research teams",
    narrativeFocus: `Create a plausible dossier centered on ${country.name} involving ${scenarioTopics.join(", ")}.`,
    writingConstraints: [
      "Use invented institutions, people, domains, and seals, but do not mention that constraint in the document text.",
      "Keep the style comparable to real government or corporate technical reporting.",
      "Use concise evidence-oriented prose with tables, references, and attached brief mentions where relevant.",
      brief.customPrompt ? `Honor this additional context: ${brief.customPrompt}` : ""
    ].filter(Boolean)
  };
}

function createCreativeContext(
  brief: ScenarioBrief,
  country: FictionalCountry,
  directive: CreativeDirective,
  organizations: Organization[],
  people: Person[],
  generationProfile: GenerationProfile
) {
  const topicDetails = createTopicSequence(brief.scenarioId, generationProfile.reportCount);
  const reportIds = topicDetails.map((_, index) => `report-${brief.scenarioId}-${index + 1}`);
  return {
    brief,
    country,
    directive,
    organizations,
    people,
    topicDetails,
    topics: topicDetails.map((detail) => detail.topic),
    reportIds,
    reportFormats: selectReportOutputFormats(brief, reportIds.length),
    emailIds: Array.from({ length: generationProfile.emailCount }, (_, index) => `email-${brief.scenarioId}-${index + 1}`)
  };
}

function selectReportOutputFormats(brief: ScenarioBrief, reportCount: number): Array<ReportDocument["outputFormat"]> {
  const scenarioOffset = Array.from(brief.scenarioId).reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const offset = (brief.seed + scenarioOffset) % reportOutputFormats.length;
  return Array.from({ length: reportCount }, (_, index) => reportOutputFormats[(offset + index) % reportOutputFormats.length] ?? "pdf");
}

function getReportOutputFormats(context: ReturnType<typeof createCreativeContext>): Array<ReportDocument["outputFormat"]> {
  const scenarioOffset = Array.from(context.brief.scenarioId).reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const offset = (context.brief.seed + scenarioOffset) % reportOutputFormats.length;
  return context.reportIds.map((_, index) => reportOutputFormats[(offset + index) % reportOutputFormats.length] ?? "pdf");
}

function describeReportStyle(kind: ReportDocument["kind"]): string {
  switch (kind) {
    case "government-report":
      return "ministerial briefing voice with policy framing, procedural requests, and concise administrative language";
    case "briefing-note":
      return "short analytical briefing voice with rapid review emphasis, issue lists, and decision-oriented phrasing";
    case "company-report":
      return "commercial operations voice with exposure analysis, practical constraints, and direct recommendations";
  }
}

function describeEmailStyle(index: number): string {
  return index === 0
    ? "formal circulation email requesting comments on an attached working brief"
    : "follow-up coordination email consolidating actions, clarifications, and next-step requests";
}

function createDefaultDossierPlan(
  context: ReturnType<typeof createCreativeContext>
): DossierPlan {
  const plannedFormats = getReportOutputFormats(context);

  const reportPlans: DossierReportPlan[] = context.topicDetails.map((topicDetail, index) => {
    const organization = pickOrganizationForReport(context.organizations, index);
    const author = pickAuthorForOrganization(context.people, organization.id, index);
    const kind = organization.kind === "company" ? "company-report" : organization.kind === "research" ? "briefing-note" : "government-report";
    const topic = topicDetail.topic;

    return {
      reportId: context.reportIds[index] ?? `report-${context.brief.scenarioId}-${index + 1}`,
      kind,
      outputFormat: plannedFormats[index] ?? "pdf",
      styleProfile: describeReportStyle(kind),
      title: `${context.country.name} ${topic.replace(/\b\w/g, (value) => value.toUpperCase())} Memorandum ${index + 1}`,
      organizationId: organization.id,
      authorPersonId: author.id,
      subjectTags: [topic, topicDetail.familyLabel, context.country.name, organization.kind],
      summaryFocus: `${topic} within the ${topicDetail.familyLabel.toLowerCase()} workstream under review in ${context.country.name}`,
      outline: [
        `${topic} is affecting internal reporting and review cadence.`,
        "Stakeholders are reconciling figures, annex references, and distribution lists across offices.",
        "The note should identify the next actions expected before the next coordination meeting."
      ],
      relatedEntityIds: [context.country.id, organization.id, author.id],
      referenceDocumentIds: index > 0 ? [context.reportIds[index - 1] ?? context.reportIds[0]] : []
    };
  });

  const topFamilies = Array.from(new Set(context.topicDetails.map((detail) => detail.familyLabel))).slice(0, 3);

  const emailPlans: DossierEmailPlan[] = context.emailIds.map((emailId, index) => {
    const sender = context.people[index % context.people.length] ?? context.people[0];
    const recipient = context.people[(index + 1) % context.people.length] ?? context.people[0];
    const cc = context.people.length > 2 ? [context.people[(index + 2) % context.people.length]!.id] : [];
    const relatedReport = reportPlans[index % reportPlans.length];

    return {
      emailId,
      threadId: createThreadId(context.brief.scenarioId, index),
      styleProfile: describeEmailStyle(index),
      subject: index === 0
        ? `Transmission of ${relatedReport?.title ?? "Attached Note"}`
        : `Follow-up on ${relatedReport?.title ?? "Attached Note"}`,
      fromPersonId: sender.id,
      toPersonIds: [recipient.id],
      ccPersonIds: cc,
      relatedDocumentIds: relatedReport ? [relatedReport.reportId] : [],
      purpose: `route ${relatedReport?.title ?? "the attached note"} for review and confirm the next actions before the interoffice meeting`,
      talkingPoints: [
        `${relatedReport?.title ?? "The attached note"} should be reviewed alongside prior circulation material.`,
        "Please flag any revisions, missing annexes, or unresolved observations before the meeting."
      ]
    };
  });

  return {
    overview: `${context.country.name} agencies, researchers, and commercial stakeholders are coordinating across ${topFamilies.join(", ")} while tracking ${context.topics.slice(0, Math.min(6, context.topics.length)).join(", ")} through linked reports and follow-up email traffic.`,
    anchorFacts: [
      `${context.country.name} has active reporting pressure across trade administration, industrial planning, and review workflows.`,
      "The first memorandum establishes a shared record that later documents should cite or answer.",
      "Follow-up correspondence should reflect attachment handling, review sequencing, and meeting preparation."
    ],
    reportPlans,
    emailPlans
  };
}

function sanitizeText(value: string | undefined, fallback: string): string {
  const normalized = decodeHtmlEntities(value)
    ?.replace(/\s+/g, " ")
    .trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function sanitizeMultilineText(value: string | undefined, fallback: string): string {
  const normalized = decodeHtmlEntities(value)
    ?.replace(/\r\n/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n[\t ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function sanitizeTextList(values: string[] | undefined, fallback: string[]): string[] {
  const normalized = values
    ?.map((value) => decodeHtmlEntities(value)?.replace(/\s+/g, " ").trim() ?? "")
    .filter((value) => value.length > 0);
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function decodeHtmlEntities(value: string | undefined): string | undefined {
  return value
    ?.replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeReportBodyParagraphs(values: string[] | undefined, fallback: string[]): string[] {
  const paragraphs = sanitizeTextList(values, fallback);
  const normalized: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= 520) {
      normalized.push(paragraph);
      continue;
    }

    const sentences = paragraph
      .split(/(?<=[.!?])\s+(?=[A-Z])/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0);

    if (sentences.length < 3) {
      normalized.push(paragraph);
      continue;
    }

    let chunk = "";
    for (const sentence of sentences) {
      const candidate = chunk.length > 0 ? `${chunk} ${sentence}` : sentence;
      if (candidate.length > 420 && chunk.length > 0) {
        normalized.push(chunk);
        chunk = sentence;
      } else {
        chunk = candidate;
      }
    }

    if (chunk.length > 0) {
      normalized.push(chunk);
    }
  }

  return normalized.flatMap((paragraph) => splitStandaloneLeadSentence(paragraph));
}

function splitStandaloneLeadSentence(paragraph: string): string[] {
  const sentences = paragraph
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

  const leadSentence = sentences[0];
  if (!leadSentence || sentences.length < 2) {
    return [paragraph];
  }

  if (/^\d+[.)]?$/.test(leadSentence)) {
    return [paragraph];
  }

  const leadWordCount = leadSentence.replace(/[.!?]$/, "").split(/\s+/).filter(Boolean).length;
  if (leadSentence.length > 70 || leadWordCount > 8 || /[:;]/.test(leadSentence)) {
    return [paragraph];
  }

  return [leadSentence, sentences.slice(1).join(" ")];
}

function sanitizeIds(values: string[] | undefined, allowedIds: Set<string>, fallback: string[]): string[] {
  const normalized = values?.filter((value) => allowedIds.has(value));
  return normalized && normalized.length > 0 ? Array.from(new Set(normalized)) : fallback;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildInternalReferenceMap(
  context: ReturnType<typeof createCreativeContext>,
  plan: DossierPlan,
  reports: ReportDocument[] = []
): Map<string, string> {
  const replacements = new Map<string, string>();

  replacements.set(context.country.id, context.country.name);

  for (const organization of context.organizations) {
    replacements.set(organization.id, organization.name);
  }

  for (const person of context.people) {
    replacements.set(person.id, person.fullName);
  }

  for (const reportPlan of plan.reportPlans) {
    replacements.set(reportPlan.reportId, reportPlan.title);
  }

  for (const report of reports) {
    replacements.set(report.id, report.title);
  }

  for (const emailPlan of plan.emailPlans) {
    replacements.set(emailPlan.emailId, emailPlan.subject);
    replacements.set(emailPlan.threadId, `${context.country.name} correspondence thread`);
  }

  return replacements;
}

function scrubInternalReferences(value: string, replacements: Map<string, string>): string {
  let nextValue = value;

  for (const [internalId, humanLabel] of replacements.entries()) {
    const pattern = new RegExp(`\\b${escapeRegExp(internalId)}\\b`, "g");
    nextValue = nextValue.replace(pattern, humanLabel);
  }

  return nextValue;
}

function scrubTextList(values: string[], replacements: Map<string, string>): string[] {
  return values.map((value) => scrubInternalReferences(value, replacements));
}

function normalizeDossierPlan(
  plan: DossierPlan,
  fallback: DossierPlan,
  context: ReturnType<typeof createCreativeContext>
): DossierPlan {
  const organizationIds = new Set(context.organizations.map((organization) => organization.id));
  const personIds = new Set(context.people.map((person) => person.id));
  const reportIds = new Set(context.reportIds);
  const entityIds = new Set<string>([
    context.country.id,
    ...organizationIds,
    ...personIds,
    ...reportIds,
    ...context.emailIds
  ]);

  return {
    overview: sanitizeText(plan.overview, fallback.overview),
    anchorFacts: sanitizeTextList(plan.anchorFacts, fallback.anchorFacts),
    reportPlans: fallback.reportPlans.map((defaultPlan) => {
      const candidate = plan.reportPlans.find((entry) => entry.reportId === defaultPlan.reportId);
      return {
        ...defaultPlan,
        outputFormat: candidate?.outputFormat && reportOutputFormats.includes(candidate.outputFormat) ? candidate.outputFormat : defaultPlan.outputFormat,
        styleProfile: sanitizeText(candidate?.styleProfile, defaultPlan.styleProfile),
        title: sanitizeText(candidate?.title, defaultPlan.title),
        organizationId: candidate?.organizationId && organizationIds.has(candidate.organizationId) ? candidate.organizationId : defaultPlan.organizationId,
        authorPersonId: candidate?.authorPersonId && personIds.has(candidate.authorPersonId) ? candidate.authorPersonId : defaultPlan.authorPersonId,
        subjectTags: sanitizeTextList(candidate?.subjectTags, defaultPlan.subjectTags),
        summaryFocus: sanitizeText(candidate?.summaryFocus, defaultPlan.summaryFocus),
        outline: sanitizeTextList(candidate?.outline, defaultPlan.outline),
        relatedEntityIds: sanitizeIds(candidate?.relatedEntityIds, entityIds, defaultPlan.relatedEntityIds),
        referenceDocumentIds: sanitizeIds(candidate?.referenceDocumentIds, reportIds, defaultPlan.referenceDocumentIds)
      };
    }),
    emailPlans: fallback.emailPlans.map((defaultPlan) => {
      const candidate = plan.emailPlans.find((entry) => entry.emailId === defaultPlan.emailId);
      return {
        ...defaultPlan,
        styleProfile: sanitizeText(candidate?.styleProfile, defaultPlan.styleProfile),
        subject: sanitizeText(candidate?.subject, defaultPlan.subject),
        fromPersonId: candidate?.fromPersonId && personIds.has(candidate.fromPersonId) ? candidate.fromPersonId : defaultPlan.fromPersonId,
        toPersonIds: sanitizeIds(candidate?.toPersonIds, personIds, defaultPlan.toPersonIds),
        ccPersonIds: sanitizeIds(candidate?.ccPersonIds, personIds, defaultPlan.ccPersonIds),
        relatedDocumentIds: sanitizeIds(candidate?.relatedDocumentIds, reportIds, defaultPlan.relatedDocumentIds),
        purpose: sanitizeText(candidate?.purpose, defaultPlan.purpose),
        talkingPoints: sanitizeTextList(candidate?.talkingPoints, defaultPlan.talkingPoints)
      };
    })
  };
}

function createFallbackReportDraft(
  reportPlan: DossierReportPlan,
  country: FictionalCountry,
  organization: Organization,
  author: Person,
  directive: CreativeDirective,
  plan: DossierPlan
): { summary: string; body: string[] } {
  return {
    summary: reportPlan.kind === "government-report"
      ? `${organization.name} prepared this brief for ${directive.audience} to support policy coordination on ${reportPlan.summaryFocus.toLowerCase()}.`
      : reportPlan.kind === "briefing-note"
        ? `${organization.name} condensed the current position into a briefing note on ${reportPlan.summaryFocus.toLowerCase()} for immediate review.`
        : `${organization.name} prepared this operational note for ${directive.audience} on ${reportPlan.summaryFocus.toLowerCase()}.`,
    body: reportPlan.kind === "government-report"
      ? [
          `${organization.name} identifies ${reportPlan.subjectTags[0]} as an active coordination concern for ${country.name}, with ${author.title.toLowerCase()} staff focusing on policy sequencing, reporting cadence, and inter-agency review obligations.`,
          `${reportPlan.outline[1] ?? "Supporting offices are reconciling figures and annex references before the next review window."} ${plan.anchorFacts[0] ?? "The reporting chain remains under pressure across multiple offices."}`,
          `${reportPlan.outline[2] ?? "The document concludes with actions for the next coordination round."} This brief should be read alongside ${reportPlan.referenceDocumentIds.join(", ") || "the broader dossier record"}.`
        ]
      : reportPlan.kind === "briefing-note"
        ? [
            `${organization.name} summarizes the immediate review position on ${reportPlan.subjectTags[0]} with emphasis on rapid issue triage, outstanding annexes, and the decisions needed before the next coordination checkpoint.`,
            `${reportPlan.outline[1] ?? "Supporting offices are reconciling figures and annex references before the next review window."} The note is intentionally compact so recipients can compare the current issue set against the initial circulation brief without reopening the full record.`,
            `${reportPlan.outline[2] ?? "The document concludes with actions for the next coordination round."} Comments should focus on material corrections, missing evidence, and issues that need escalation into the meeting agenda.`
          ]
        : [
            `${organization.name} treats ${reportPlan.subjectTags[0]} as an operational exposure issue for ${country.name}, with ${author.title.toLowerCase()} staff highlighting constraints in scheduling, handling, and reporting discipline.`,
            `${reportPlan.outline[1] ?? "Supporting offices are reconciling figures and annex references before the next review window."} The note focuses on practical impacts for processing, logistics, and commercial planning rather than policy commentary.`,
            `${reportPlan.outline[2] ?? "The document concludes with actions for the next coordination round."} This report should be read alongside ${reportPlan.referenceDocumentIds.join(", ") || "the broader dossier record"}.`
          ]
  };
}

async function buildReports(
  context: ReturnType<typeof createCreativeContext>,
  organizations: Organization[],
  people: Person[],
  directive: CreativeDirective,
  plan: DossierPlan,
  provider: CreativeProvider,
  faker: Faker
): Promise<ReportDocument[]> {
  const reports: ReportDocument[] = [];
  const internalReferenceMap = buildInternalReferenceMap(context, plan);

  for (const reportPlan of plan.reportPlans) {
    const organization = organizations.find((candidate) => candidate.id === reportPlan.organizationId) ?? organizations[0];
    const author = people.find((candidate) => candidate.id === reportPlan.authorPersonId) ?? people[0];
    const createdAt = faker.date.betweens({
      from: "2025-01-10T08:00:00.000Z",
      to: "2025-11-30T18:00:00.000Z",
      count: 1
    })[0]?.toISOString() ?? "2025-05-14T09:00:00.000Z";

    const fallbackDraft = createFallbackReportDraft(reportPlan, context.country, organization, author, directive, plan);
    const reportDraft = await provider.createReportDraft({
      ...context,
      plan,
      reportPlan
    });

    reports.push({
      id: reportPlan.reportId,
      kind: reportPlan.kind,
      outputFormat: reportPlan.outputFormat,
      title: reportPlan.title,
      summary: scrubInternalReferences(sanitizeText(reportDraft.summary, fallbackDraft.summary), internalReferenceMap),
      body: scrubTextList(normalizeReportBodyParagraphs(reportDraft.body, fallbackDraft.body), internalReferenceMap),
      authorPersonId: author.id,
      organizationId: organization.id,
      subjectTags: reportPlan.subjectTags,
      createdAt,
      relatedEntityIds: Array.from(new Set([...reportPlan.relatedEntityIds, ...reportPlan.referenceDocumentIds]))
    });
  }

  return reports;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderEmailHtmlFromPlainText(body: string): string {
  return body
    .split(/\n\s*\n/g)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

function createFallbackEmailDraft(
  emailPlan: DossierEmailPlan,
  sender: Person,
  recipient: Person,
  relatedReport: ReportDocument | undefined
): { plainTextBody: string } {
  return {
    plainTextBody: [
      `${recipient.fullName},`,
      "",
      `Attached is ${relatedReport?.title ?? "the attached report"} for your review. Please focus on the requested follow-up items before the next coordination meeting.`,
      `${emailPlan.talkingPoints[0] ?? "Please note any corrections or additions that should be carried into the next revision."}`,
      "",
      "Regards,",
      sender.fullName
    ].join("\n")
  };
}

async function buildEmails(
  context: ReturnType<typeof createCreativeContext>,
  plan: DossierPlan,
  reports: ReportDocument[],
  people: Person[],
  provider: CreativeProvider,
  faker: Faker
): Promise<EmailMessage[]> {
  const emails: EmailMessage[] = [];
  const internalReferenceMap = buildInternalReferenceMap(context, plan, reports);

  const mimeTypeByFormat: Record<ReportDocument["outputFormat"], string> = {
    txt: "text/plain",
    html: "text/html",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pdf: "application/pdf"
  };

  for (const emailPlan of plan.emailPlans) {
    const relatedReport = reports.find((report) => report.id === emailPlan.relatedDocumentIds[0]);
    const sentAt = faker.date.betweens({
      from: relatedReport?.createdAt ?? "2025-01-10T08:00:00.000Z",
      to: "2025-12-12T17:00:00.000Z",
      count: 1
    })[0]?.toISOString() ?? relatedReport?.createdAt ?? "2025-05-14T09:00:00.000Z";
    const sender = people.find((person) => person.id === emailPlan.fromPersonId) ?? people[0];
    const recipient = people.find((person) => person.id === emailPlan.toPersonIds[0]) ?? people[0];
    const fallbackDraft = createFallbackEmailDraft(emailPlan, sender, recipient, relatedReport);
    const emailDraft = await provider.createEmailDraft({
      ...context,
      plan,
      emailPlan,
      relatedReports: reports.filter((report) => emailPlan.relatedDocumentIds.includes(report.id))
    });
    const plainTextBody = scrubInternalReferences(
      sanitizeMultilineText(emailDraft.plainTextBody, fallbackDraft.plainTextBody),
      internalReferenceMap
    );

    emails.push({
      id: emailPlan.emailId,
      threadId: emailPlan.threadId,
      subject: emailPlan.subject,
      fromPersonId: sender.id,
      toPersonIds: emailPlan.toPersonIds,
      ccPersonIds: emailPlan.ccPersonIds,
      sentAt,
      plainTextBody,
      htmlBody: renderEmailHtmlFromPlainText(plainTextBody),
      relatedDocumentIds: emailPlan.relatedDocumentIds,
      attachments: reports
        .filter((report) => emailPlan.relatedDocumentIds.includes(report.id))
        .map((report) => ({
          id: `attachment-${report.id}-${report.outputFormat}`,
          documentId: report.id,
          fileName: `${report.id}.${report.outputFormat}`,
          mimeType: mimeTypeByFormat[report.outputFormat]
        }))
    });
  }

  return emails;
}

function buildEvents(reports: ReportDocument[], emails: EmailMessage[]) {
  return [
    ...reports.map((report) => ({
      id: `event-${report.id}`,
      timestamp: report.createdAt,
      type: report.kind === "briefing-note" ? "briefing-prepared" as const : "report-issued" as const,
      summary: `Issued ${report.title}`,
      entityIds: [report.id, report.organizationId, report.authorPersonId]
    })),
    ...emails.map((email) => ({
      id: `event-${email.id}`,
      timestamp: email.sentAt,
      type: "email-sent" as const,
      summary: `Sent ${email.subject}`,
      entityIds: [email.id, email.fromPersonId, ...email.toPersonIds, ...email.relatedDocumentIds]
    }))
  ].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

export async function createScenarioPack(
  brief: ScenarioBrief,
  provider: CreativeProvider
): Promise<ScenarioPack> {
  const generationProfile = normalizeGenerationProfile(brief.generationProfile);
  const faker = createFaker(brief.seed);
  const country = selectCountry(brief);
  const organizations = buildOrganizations(country, faker);
  const people = buildPeople(organizations, faker, generationProfile.peoplePerOrganization);
  const directive = createDirective(brief, country);
  const context = createCreativeContext(brief, country, directive, organizations, people, generationProfile);
  const fallbackPlan = createDefaultDossierPlan(context);
  const providerPlan = await provider.createDossierPlan(context);
  const dossierPlan = normalizeDossierPlan(providerPlan, fallbackPlan, context);
  const reports = await buildReports(context, organizations, people, directive, dossierPlan, provider, faker);
  const emails = await buildEmails(context, dossierPlan, reports, people, provider, faker);
  const events = buildEvents(reports, emails);

  return {
    scenarioId: brief.scenarioId,
    locale: brief.locale,
    dataLanguage: brief.dataLanguage ?? brief.locale,
    seed: brief.seed,
    country,
    generationProfile,
    organizations,
    people,
    reports,
    emails,
    events,
    dossierPlan,
    directive
  };
}