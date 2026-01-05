// Types for the government contract financial assistant
export interface SecurityFlags {
  encrypted: boolean;
  pgp_key_exchanged: boolean;
}

export interface ProjectFinancials {
  total_budget?: string;
  committed_amount?: string;
  obligated_amount?: string;
  expended_amount?: string;
  remaining_budget?: string;
  burn_rate?: string;
  projected_completion?: string;
}

export interface WBSItem {
  wbs_number: string;
  description: string;
  budget_allocated: string;
  spent_to_date: string;
  remaining_balance: string;
  status: 'On Track' | 'At Risk' | 'Over Budget' | 'Complete';
}

export interface ProjectInfo {
  project_id: string;
  project_name: string;
  contract_number: string;
  start_date: string;
  end_date: string;
  project_manager: string;
  contracting_officer: string;
  contractor: string;
  project_status: 'Active' | 'On Hold' | 'Completed' | 'Cancelled';
}

export interface Message {
  turn_order: number;
  timestamp: string;
  role: "User" | "Assistant";
  handle: string;
  message: string;
  query_type: string;
  coded_language: boolean;
  security_flags: SecurityFlags;
  project_financials: ProjectFinancials | null;
  wbs_items?: WBSItem[];
}

export interface ConversationData {
  conversation_id: string;
  turns: Message[];
  outcome: "successful" | "failed" | "in_progress";
}

export interface Suggestion {
  id: string;
  type: "financial_analysis" | "budget_recommendation" | "risk_assessment" | "project_insight";
  title: string;
  content: string;
  confidence: number; // Confidence score from 0.0 to 1.0
  rank: number;       // Suggestion rank, 1 = highest priority
  next_response_area: string; // Logical next area the user should investigate
  action_items: string[];
}

export interface AzureSearchResult {
  projectId: string;
  similarity: number;
  context: string;
  recommendations: string[];
}

export interface OpenAIResponse {
  suggestions: Suggestion[];
  analysis: string;
  confidence: number;
}
