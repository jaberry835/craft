import type { ScenarioDefinition, ScenarioId, ScenarioTopicDetail } from "../core/types.js";

export const scenarioCatalog: Record<ScenarioId, ScenarioDefinition> = {
  "government-economy": {
    title: "Government Economy Report Pack",
    description: "Government-style reporting on macroeconomic and industrial topics.",
    topicFamilies: [
      {
        id: "macro-monitoring",
        label: "Macroeconomic Monitoring",
        topics: ["inflation monitoring", "household purchasing power", "industrial output"]
      },
      {
        id: "trade-infrastructure",
        label: "Trade and Infrastructure",
        topics: ["port activity", "rail throughput review", "fuel allocation planning"]
      },
      {
        id: "mobility-controls",
        label: "Travel and Labor Oversight",
        topics: ["travel approval routing", "labor mobility review", "conference delegation planning"]
      }
    ]
  },
  "government-mining-trade": {
    title: "Government Mining and Trade Pack",
    description: "Government-style reporting on chemical mining, trade flow, and extraction oversight.",
    topicFamilies: [
      {
        id: "extraction-oversight",
        label: "Extraction Oversight",
        topics: ["chemical extraction", "site inspection variance", "refined mineral exports"]
      },
      {
        id: "trade-controls",
        label: "Trade Controls",
        topics: ["trade licensing", "cross-border shipment exceptions", "port manifest reconciliation"]
      },
      {
        id: "permits-and-compliance",
        label: "Permits and Compliance",
        topics: ["permit renewal follow-up", "export authorization review", "vendor due diligence"]
      }
    ]
  },
  "company-market-report": {
    title: "Company Market Report Pack",
    description: "Corporate research and business reporting aligned with the same topics.",
    topicFamilies: [
      {
        id: "operations-and-margin",
        label: "Operations and Margin",
        topics: ["ore processing margins", "plant utilization", "procurement exposure"]
      },
      {
        id: "commercial-planning",
        label: "Commercial Planning",
        topics: ["cross-border shipping", "vendor onboarding review", "market entry planning"]
      },
      {
        id: "talent-and-travel",
        label: "Talent and Travel",
        topics: ["regional hiring pipeline", "candidate travel coordination", "field visit scheduling"]
      }
    ]
  },
  "correspondence-dossier": {
    title: "Company-Government Correspondence Dossier",
    description: "Exchange of research papers, briefings, and follow-up emails between company and government bodies.",
    topicFamilies: [
      {
        id: "research-and-briefings",
        label: "Research and Briefings",
        topics: ["brief circulation", "research exchange", "joint review meeting"]
      },
      {
        id: "compliance-follow-up",
        label: "Compliance Follow-up",
        topics: ["compliance follow-up", "document request response", "escalation tracking"]
      },
      {
        id: "jobs-and-mobility",
        label: "Jobs and Mobility",
        topics: ["resume routing", "job application review", "government liaison hiring note"]
      }
    ]
  },
  "talent-mobility": {
    title: "Talent and Mobility Dossier",
    description: "Hiring, resume circulation, interview planning, relocation, and work-travel correspondence across fictional companies and agencies.",
    topicFamilies: [
      {
        id: "recruiting-and-resumes",
        label: "Recruiting and Resumes",
        topics: ["resume screening", "candidate shortlist review", "job requisition approval"]
      },
      {
        id: "interviews-and-offers",
        label: "Interviews and Offers",
        topics: ["interview scheduling", "offer package discussion", "background review follow-up"]
      },
      {
        id: "relocation-and-travel",
        label: "Relocation and Travel",
        topics: ["travel booking request", "work-travel approval", "relocation expense review"]
      }
    ]
  },
  "permits-procurement": {
    title: "Permits and Procurement Pack",
    description: "Government approvals, vendor due diligence, procurement correspondence, and shipment or travel permissions.",
    topicFamilies: [
      {
        id: "permit-workflows",
        label: "Permit Workflows",
        topics: ["permit intake review", "approval memorandum", "denial rationale summary"]
      },
      {
        id: "vendor-and-procurement",
        label: "Vendor and Procurement",
        topics: ["vendor onboarding review", "procurement exception handling", "contract routing note"]
      },
      {
        id: "shipment-and-travel-clearance",
        label: "Shipment and Travel Clearance",
        topics: ["shipment clearance follow-up", "inspection scheduling", "travel permit escalation"]
      }
    ]
  }
};

export function getScenarioTopics(scenarioId: ScenarioId): string[] {
  return scenarioCatalog[scenarioId].topicFamilies.flatMap((family) => family.topics);
}

export function getScenarioTopicDetails(scenarioId: ScenarioId): ScenarioTopicDetail[] {
  return scenarioCatalog[scenarioId].topicFamilies.flatMap((family) =>
    family.topics.map((topic) => ({
      familyId: family.id,
      familyLabel: family.label,
      topic
    }))
  );
}