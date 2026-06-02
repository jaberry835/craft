import type { ScenarioId } from "../core/types.js";

export const scenarioCatalog: Record<ScenarioId, { title: string; description: string }> = {
  "government-economy": {
    title: "Government Economy Report Pack",
    description: "Government-style reporting on macroeconomic and industrial topics."
  },
  "government-mining-trade": {
    title: "Government Mining and Trade Pack",
    description: "Government-style reporting on chemical mining, trade flow, and extraction oversight."
  },
  "company-market-report": {
    title: "Company Market Report Pack",
    description: "Corporate research and business reporting aligned with the same topics."
  },
  "correspondence-dossier": {
    title: "Company-Government Correspondence Dossier",
    description: "Exchange of research papers, briefings, and follow-up emails between company and government bodies."
  }
};