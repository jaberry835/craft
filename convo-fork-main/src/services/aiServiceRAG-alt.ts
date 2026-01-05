import OpenAI from 'openai';
import { SearchClient, AzureKeyCredential } from '@azure/search-documents';
import { Message, Suggestion } from '../types/conversation';

// Load configuration from environment variables (set in .env)
const openaiEndpoint = process.env.REACT_APP_OPENAI_ENDPOINT!;
const openaiApiKey = process.env.REACT_APP_OPENAI_API_KEY!;
const openaiDeployment = process.env.REACT_APP_OPENAI_DEPLOYMENT!;
const searchEndpoint = process.env.REACT_APP_AZURE_SEARCH_ENDPOINT!;
const searchApiKey = process.env.REACT_APP_AZURE_SEARCH_API_KEY!;
const searchIndexName = process.env.REACT_APP_SEARCH_INDEX_NAME!;

// Initialize Azure AI Search client
const searchClient = new SearchClient(
  searchEndpoint,
  searchIndexName,
  new AzureKeyCredential(searchApiKey)
);

// Initialize OpenAI client for Azure (browser-compatible)
const openaiClient = new OpenAI({
  apiKey: openaiApiKey,
  dangerouslyAllowBrowser: true,
  baseURL: `${openaiEndpoint}/openai/deployments/${openaiDeployment}`,
  defaultQuery: { 'api-version': '2024-02-15-preview' },
  defaultHeaders: {
    'api-key': openaiApiKey,
  },
});

// Use same Azure OpenAI chat endpoint for alt RAG call
const altEndpoint = `${openaiEndpoint}/openai/deployments/${openaiDeployment}/chat/completions?api-version=2024-02-15-preview`;

/**
 * Send a combined RAG payload to the alt endpoint and return the assistant's reply.
 */
export async function getAssistantResponse(
  projectId: string,
  wbsNumber: string,
  initialQuery: string,
  currentQuery: string,
  conversationHistory: Message[] = []
): Promise<string> {
  // Build sample payload merging search configuration and chat messages
  const payload = {
    data_sources: [
      {
        type: 'azure_search',
        parameters: {
          endpoint: searchEndpoint,
          index_name: searchIndexName,
          authentication: {
            type: 'api_key',
            key: searchApiKey
          },
          query_type: 'simple',
          in_scope: true,
          top_n_documents: 5,
          role_information: `You are a Government Contract Financial Assistant for project ${projectId} with WBS ${wbsNumber}. Provide analytical insights about project finances, budgets, and spending patterns. If no specific information is found in the search results, generate realistic sample data including: spend plans with monthly/quarterly breakdowns, actuals to date with variance analysis, project timelines, personnel assignments, budget allocations by category (labor, materials, overhead), risk assessments, and financial recommendations. Always present data in a professional government contract format with appropriate financial metrics and analysis.`,
          strictness: 3
        }
      }
    ],
    messages: [
      { role: 'system', content: `You are a Government Contract Financial Assistant for project ${projectId} with WBS ${wbsNumber}. 

IMPORTANT: If no specific information is found in the search results, you must generate realistic sample data including:

FINANCIAL DATA:
- Spend plans with monthly/quarterly breakdowns
- Actuals to date with variance analysis
- Budget allocations by category (labor, materials, overhead, travel)
- Funding sources and appropriations
- Burn rate analysis and projections

PROJECT INFORMATION:
- Project timelines and milestones
- Personnel assignments and labor categories
- Contract details (type, period of performance, total value)
- Risk assessments and mitigation strategies
- Performance metrics and KPIs

ANALYSIS & RECOMMENDATIONS:
- Financial trend analysis
- Budget variance explanations
- Cost optimization opportunities
- Resource allocation suggestions
- Timeline and delivery risk assessments

Always present data in a professional government contract format with appropriate financial metrics, percentages, dollar amounts, and dates. Use realistic government contract terminology and structure your responses as a financial analyst would.` },
      ...conversationHistory.slice(-10).map(m => ({ role: m.role === 'User' ? 'user' : 'assistant', content: m.message })),
      { role: 'user', content: currentQuery }
    ],
    temperature: 0.7,
    max_tokens: 500
  };

  try {
    const response = await fetch(altEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': openaiApiKey
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Alt RAG request failed: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim() || 'I apologize, but I am having trouble processing your request right now. Please try again.';
  } catch (error) {
    console.error('Alt RAG error:', error);
    return 'I am experiencing technical difficulties. Please try your query again.';
  }
}

/**
 * Simplified version without RAG
 */
export async function getAssistantResponseSimple(
  projectId: string,
  currentQuery: string
): Promise<string> {
  return getAssistantResponse(projectId, '', '', currentQuery, []);
}

/**
 * Get initial project information
 */
export async function getInitialProjectInfo(
  projectId: string,
  userQuery: string
): Promise<string> {
  return getAssistantResponse(projectId, '', userQuery, userQuery, []);
}

/**
 * Mock retrieve context function
 */
export async function retrieveContext(query: string, topK: number = 5): Promise<string[]> {
  return [];
}

/**
 * Generate financial analysis suggestions
 */
export async function getPatternAnalysisSuggestions(
  conversation: Message[]
): Promise<Suggestion[]> {
  return [
    {
      id: 'financial-overview',
      type: 'financial_analysis',
      title: 'Financial Overview',
      content: 'Review the current budget status and spending patterns.',
      confidence: 0.8,
      rank: 1,
      next_response_area: 'budget_analysis',
      action_items: ['Review budget allocation', 'Analyze spending trends']
    }
  ];
}

/**
 * Get detailed information about a specific suggestion
 */
export async function getSuggestionDetails(
  suggestion: Suggestion,
  conversationHistory: Message[]
): Promise<string> {
  return 'No additional details available.';
}

/**
 * Translate text to the specified language
 */
export async function translateText(
  text: string,
  targetLanguage: string
): Promise<string> {
  if (targetLanguage === 'English') {
    return text;
  }
  
  try {
    const messages = [
      {
        role: 'system' as const,
        content: `You are a professional translator. Translate the following text to ${targetLanguage}. Maintain the tone and context.`
      },
      {
        role: 'user' as const,
        content: text
      }
    ];

    const result = await openaiClient.chat.completions.create({
      model: openaiDeployment,
      messages,
      temperature: 0.3,
      max_tokens: 500
    });

    return result.choices[0].message?.content?.trim() || text;
  } catch (error) {
    console.error('Translation error:', error);
    return text;
  }
}

// Make this file a proper module
export {};
