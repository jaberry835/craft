import type {
  DossierEmailPlan,
  DossierPlan,
  DossierReportPlan,
  EmailDraft,
  ReportDraft
} from "../core/types.js";
import type {
  CreativeProvider,
  CreativeProviderContext,
  EmailDraftContext,
  ReportDraftContext
} from "./creativeProvider.js";

export class MockCreativeProvider implements CreativeProvider {
  public readonly name = "mock";

  public async createDossierPlan(context: CreativeProviderContext): Promise<DossierPlan> {
    const reportPlans = context.topics.slice(0, context.reportIds.length).map((topic, index) =>
      this.createReportPlan(context, topic, context.reportIds[index] ?? `report-${index + 1}`, index)
    );
    const emailPlans = context.emailIds.map((emailId, index) =>
      this.createEmailPlan(context, emailId, reportPlans[index % reportPlans.length], index)
    );

    return {
      overview: `${context.country.name} agencies and industry partners are exchanging internal reporting on ${context.topics.slice(0, Math.min(5, context.topics.length)).join(", ")}.`,
      anchorFacts: [
        `${context.country.name} officials are tracking operational bottlenecks affecting trade administration and industrial planning.`,
        "A ministry-led circulation note triggered follow-up analysis from research and commercial stakeholders.",
        "Later correspondence should reference earlier reporting in concrete, procedural terms."
      ],
      reportPlans,
      emailPlans
    };
  }

  public async createReportDraft(context: ReportDraftContext): Promise<ReportDraft> {
    const organization = context.organizations.find((candidate) => candidate.id === context.reportPlan.organizationId);
    const author = context.people.find((candidate) => candidate.id === context.reportPlan.authorPersonId);
    const focus = context.reportPlan.summaryFocus;
    const outline = context.reportPlan.outline;

    return {
      summary: context.reportPlan.kind === "government-report"
        ? `${organization?.name ?? context.country.name} prepared this brief for policy coordination on ${focus}.`
        : context.reportPlan.kind === "briefing-note"
          ? `${organization?.name ?? context.country.name} condensed the current position into a rapid briefing note on ${focus}.`
          : `${organization?.name ?? context.country.name} prepared this operations note on ${focus}.`,
      body: context.reportPlan.kind === "government-report"
        ? [
            `${organization?.name ?? context.country.name} frames ${outline[0]?.toLowerCase() ?? focus.toLowerCase()} as an immediate coordination issue for ${context.country.name}, with ${author?.title.toLowerCase() ?? "analysts"} tracking policy sequencing and review obligations.`,
            `${outline[1] ?? "Recent observations point to uneven implementation across reporting units."} Teams are aligning figures, annex references, and circulation lists before the next review window.`,
            `${outline[2] ?? "The document closes with a set of actions for the next coordination round."} Subsequent correspondence should cite these findings directly when requesting follow-up action.`
          ]
        : context.reportPlan.kind === "briefing-note"
          ? [
              `${organization?.name ?? context.country.name} treats ${outline[0]?.toLowerCase() ?? focus.toLowerCase()} as an issue set for rapid review, with ${author?.title.toLowerCase() ?? "analysts"} focusing on the specific questions that need immediate clarification.`,
              `${outline[1] ?? "Recent observations point to uneven implementation across reporting units."} The note is intentionally compact so recipients can compare the latest inputs against earlier material without reopening the full record.`,
              `${outline[2] ?? "The document closes with a set of actions for the next coordination round."} Any response should prioritize corrections, missing annexes, and decisions required before the meeting.`
            ]
          : [
              `${organization?.name ?? context.country.name} frames ${outline[0]?.toLowerCase() ?? focus.toLowerCase()} as an operational exposure issue, with ${author?.title.toLowerCase() ?? "analysts"} noting pressure on handling, scheduling, and commercial planning.`,
              `${outline[1] ?? "Recent observations point to uneven implementation across reporting units."} Teams are reconciling figures, shipment notes, and internal controls before the next coordination window.`,
              `${outline[2] ?? "The document closes with a set of actions for the next coordination round."} Subsequent correspondence is expected to carry these observations into the next action list.`
            ]
    };
  }

  public async createEmailDraft(context: EmailDraftContext): Promise<EmailDraft> {
    const sender = context.people.find((candidate) => candidate.id === context.emailPlan.fromPersonId);
    const recipient = context.people.find((candidate) => candidate.id === context.emailPlan.toPersonIds[0]);
    const relatedReport = context.relatedReports[0];
    const talkingPoint = context.emailPlan.talkingPoints[0] ?? context.emailPlan.purpose;

    return {
      plainTextBody: [
        `${recipient?.fullName ?? "Colleague"},`,
        "",
        `Attached is ${relatedReport?.title ?? "the attached report"} for your review. The note should help frame the next discussion on ${talkingPoint.toLowerCase()}.`,
        `${context.emailPlan.talkingPoints[1] ?? "Please flag any edits that should be incorporated before the next coordination meeting."}`,
        "",
        "Regards,",
        sender?.fullName ?? "Analyst"
      ].join("\n")
    };
  }

  private createReportPlan(
    context: CreativeProviderContext,
    topic: string,
    reportId: string,
    index: number
  ): DossierReportPlan {
    const organizationsByKind = {
      government: context.organizations.filter((organization) => organization.kind === "government"),
      research: context.organizations.filter((organization) => organization.kind === "research"),
      company: context.organizations.filter((organization) => organization.kind === "company")
    };
    const organizationSequence = [
      organizationsByKind.government,
      organizationsByKind.research,
      organizationsByKind.company,
      organizationsByKind.government,
      organizationsByKind.company
    ];
    const organizationPool = organizationSequence[index % organizationSequence.length];
    const organization = organizationPool[index % organizationPool.length] ?? context.organizations[index % context.organizations.length] ?? context.organizations[0];
    const organizationPeople = context.people.filter((person) => person.organizationId === organization.id);
    const author = organizationPeople[index % organizationPeople.length] ?? context.people[index % context.people.length] ?? context.people[0];

    return {
      reportId,
      kind: organization.kind === "company" ? "company-report" : organization.kind === "research" ? "briefing-note" : "government-report",
      outputFormat: context.reportFormats[index] ?? "pdf",
      styleProfile: organization.kind === "company"
        ? "commercial operations note"
        : organization.kind === "research"
          ? "rapid analytical briefing"
          : "formal ministerial brief",
      title: `${context.country.name} ${topic.replace(/\b\w/g, (value) => value.toUpperCase())} Memorandum ${index + 1}`,
      organizationId: organization.id,
      authorPersonId: author.id,
      subjectTags: [topic, context.country.name, organization.kind],
      summaryFocus: `${topic} and the resulting coordination burden across reporting teams in ${context.country.name}`,
      outline: [
        `${topic} is affecting internal reporting cadence and operational decision-making.`,
        "Several offices have requested reconciled figures, attachment indexes, and follow-up clarifications.",
        "The author recommends a documented review sequence ahead of the next interoffice meeting."
      ],
      relatedEntityIds: [context.country.id, organization.id, author.id],
      referenceDocumentIds: index > 0 ? [context.reportIds[index - 1] ?? context.reportIds[0]] : []
    };
  }

  private createEmailPlan(
    context: CreativeProviderContext,
    emailId: string,
    relatedReport: DossierReportPlan | undefined,
    index: number
  ): DossierEmailPlan {
    const sender = context.people[index % context.people.length] ?? context.people[0];
    const recipient = context.people[(index + 1) % context.people.length] ?? context.people[0];
    const cc = context.people.length > 2 ? [context.people[(index + 2) % context.people.length]!.id] : [];

    return {
      emailId,
      threadId: `thread-${context.brief.scenarioId}-${Math.floor(index / 4) + 1}`,
      styleProfile: index === 0 ? "formal circulation request" : "follow-up coordination note",
      subject: index === 0
        ? `Transmission of ${relatedReport?.title ?? "Attached Note"}`
        : `Follow-up on ${relatedReport?.title ?? "Attached Note"}`,
      fromPersonId: sender.id,
      toPersonIds: [recipient.id],
      ccPersonIds: cc,
      relatedDocumentIds: relatedReport ? [relatedReport.reportId] : [],
      purpose: `route ${relatedReport?.title ?? "the latest note"} for review and collect any required edits before the next coordination cycle`,
      talkingPoints: [
        `${relatedReport?.title ?? "The attached note"} should be reviewed for consistency with prior reporting.`,
        "Please respond with any corrections, missing annexes, or issues that should be raised at the meeting."
      ]
    };
  }
}