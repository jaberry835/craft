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

/**
 * Perform a search on the Azure Cognitive Search index to retrieve relevant context.
 */
export async function retrieveContext(query: string, topK: number = 5): Promise<string[]> {
  // Use Azure Cognitive Search REST API to POST a search query
  // Format: /indexes('indexName')/docs/search
  const url = `${searchEndpoint.replace(/\/+$/, '')}/indexes('${searchIndexName}')/docs/search?api-version=2024-07-01`;
  // Prevent empty search expressions, use '*' to match all if query is blank
  const searchText = query.trim() === '' ? '*' : query;
  const payload = {
    search: searchText,
    top: topK
  };
  console.debug('retrieveContext - POST', url);
  console.debug('retrieveContext - payload', JSON.stringify(payload, null, 2));
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': searchApiKey
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      console.error('retrieveContext - HTTP error', response.status, response.statusText);
      return [];
    }
    const data = await response.json();
    console.debug('retrieveContext - response', JSON.stringify(data, null, 2));
    if (data.value && Array.isArray(data.value)) {
      return data.value.map((doc: any) => JSON.stringify(doc));
    }
    return [];
  } catch (err) {
    console.error('retrieveContext - error', err);
    return [];
  }
}

/**
 * Generate assistant response for government contract financial analysis
 */
export async function getAssistantResponse(
  projectId: string,
  wbsNumber: string,
  initialQuery: string,
  currentQuery: string,
  conversationHistory: Message[] = []
): Promise<string> {
  try {
    // First, retrieve relevant context from Azure Search
    const contexts = await retrieveContext(currentQuery);
    // Limit to top 3 contexts and truncate each to 1000 chars to reduce token usage
    const limitedContexts = contexts.slice(0, 3).map(c => c.length > 1000 ? c.slice(0, 1000) : c);
    
    // Construct chat messages including trimmed context and recent history
    // Only include the last 10 messages from history
    const recentHistory = conversationHistory.slice(-10);
    const messages = [
      { role: "system" as const,
        content: `You are a Government Contract Financial Assistant providing analysis for project ${projectId} with WBS ${wbsNumber}. 
        
        Your role is to help government contracting officers analyze project finances, spending patterns, and provide insights about:
        - Budget allocation and spending patterns
        - WBS (Work Breakdown Structure) analysis
        - Personnel costs and assignments
        - Timeline and milestone tracking
        - Risk assessment and recommendations
        
        IMPORTANT: If no specific information is found in the context or if context is limited, you must generate realistic sample data including:

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

        Always present data in a professional government contract format with appropriate financial metrics, percentages, dollar amounts, and dates. Use realistic government contract terminology and structure your responses as a financial analyst would.
        
        Context from project database:
        ${limitedContexts.length > 0 ? limitedContexts.join('\n\n') : 'No project data available - generate realistic sample data as specified above.'}
        
        Maintain a professional, analytical tone suitable for government personnel.` },
      // Include prior conversation messages
      ...recentHistory.map(h => ({
        role: h.role === 'User' ? 'user' : 'assistant',
        content: h.message
      })),
      // Latest user message
      { role: "user" as const, content: currentQuery }
    ];

    // @ts-ignore
    const result = await openaiClient.chat.completions.create({
      model: openaiDeployment,
      messages: messages as any,
      temperature: 0.7,
      max_tokens: 500,
    });

    const chatChoice = result.choices[0];
    return chatChoice.message?.content?.trim() ||
      "I'm having trouble analyzing the project data right now. Could you please try again?";
  } catch (error) {
    console.error("Error generating assistant response:", error);
    return "I'm experiencing some technical difficulties. Please try your query again.";
  }
}

/**
 * Alternative fallback function that generates responses without RAG if search fails
 */
export async function getAssistantResponseSimple(
  projectId: string,
  currentQuery: string
): Promise<string> {
  try {
    // Simplified fallback uses only the latest user message
    const messages = [
       { 
         role: "system" as const, 
        content: `You are a Government Contract Financial Assistant for project ${projectId}. 

IMPORTANT: Since no specific project data is available, you must generate realistic sample data including:

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

Always present data in a professional government contract format with appropriate financial metrics, percentages, dollar amounts, and dates. Use realistic government contract terminology and structure your responses as a financial analyst would. Maintain a professional, analytical tone suitable for government personnel.`,
       },
       { role: "user" as const, content: currentQuery }
     ];

    const result = await openaiClient.chat.completions.create({
       model: openaiDeployment,
       messages: messages as any,
       temperature: 0.7,
       max_tokens: 500,
     });

    const chatChoice = result.choices[0];
    return chatChoice.message?.content?.trim() || "I apologize, but I'm having trouble processing your request right now. Please try again.";
    
  } catch (error) {
    console.error("Error generating assistant response:", error);
    return "I'm currently experiencing some technical difficulties. Please allow me a moment to get back to you with a proper response.";
  }
}

/**
 * Generate the initial project information based on the user's query.
 */
export async function getInitialProjectInfo(
  projectId: string,
  userQuery: string
): Promise<string> {
  try {
    // First, retrieve relevant context from Azure Search
    const contexts = await retrieveContext(userQuery);
    const limitedContexts = contexts.slice(0, 3).map(c => c.length > 800 ? c.slice(0, 800) : c);
    
    const messages = [
      {
        role: 'system' as const,
        content: `You are a Government Contract Financial Assistant providing initial project analysis for project ${projectId}. 
        
        Based on the user's query and available project data, provide a comprehensive initial overview including:
        - Project summary and current status
        - Budget overview (total budget, committed, obligated, expended amounts)
        - Key financial metrics and burn rate
        - Risk assessment and alerts
        - Recent activities and milestones
        
        IMPORTANT: If no specific information is found in the context or if context is limited, you must generate realistic sample data including:

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

        Always present data in a professional government contract format with appropriate financial metrics, percentages, dollar amounts, and dates. Use realistic government contract terminology.
        
        Context from project database:
        ${limitedContexts.length > 0 ? limitedContexts.join('\n\n') : 'Limited project data available.'}
        
        Maintain a professional, analytical tone suitable for government personnel.`
      },
      {
        role: 'user' as const,
        content: userQuery
      }
    ];

    const result = await openaiClient.chat.completions.create({
      model: openaiDeployment,
      messages,
      temperature: 0.7,
      max_tokens: 400
    });

    return result.choices[0].message?.content?.trim() ||
      `Initial project analysis for ${projectId} based on your query: ${userQuery}`;
  } catch (err) {
    console.error('Error generating initial project info:', err);
    return `Here's the initial project analysis for ${projectId}. Please specify what aspects you'd like to explore further.`;
  }
}

/**
 * Generate financial analysis suggestions based on the current conversation history.
 * Uses Azure Cognitive Search for context, then OpenAI to craft suggestions.
 */
export async function getPatternAnalysisSuggestions(
  conversation: Message[]
): Promise<Suggestion[]> {
  try {
    // Retrieve relevant context from Azure Search using last user message
    const lastMessage = conversation.length > 0 ? conversation[conversation.length - 1].message : '';
    const contexts = await retrieveContext(lastMessage);
    // Limit to top 3 contexts and truncate each to 1000 chars
    const limitedContexts = contexts.slice(0, 3).map(c => c.length > 1000 ? c.slice(0, 1000) : c);

    // Build chat messages for financial analysis
    const messagesPayload: any[] = [
      {
        role: 'system',
        content: `You are a Government Contract Financial Analysis Assistant helping contracting officers make informed decisions about project finances. ` +
          `Analyze financial patterns from the conversation and similar past project data, and provide 3 concise suggestions tailored to government financial management. ` +
          `Output JSON with id, type, title, content, confidence (0.0–1.0), rank (1 highest), next_response_area, and action_items array.` +
          `
Project Data Contexts (trimmed):
${limitedContexts.join('\n\n')}`
      },
      {
        role: 'user',
        content: `Conversation History (last 10):
${conversation.slice(-10).map(m => `${m.role}: ${m.message}`).join('\n')}`
      }
    ];

    // @ts-ignore bypass type mismatch
    const result = await openaiClient.chat.completions.create({
      model: openaiDeployment,
      messages: messagesPayload,
      temperature: 0.7,
      max_tokens: 800
    });
    
    // Get raw LLM output and sanitize markdown fences
    let raw = result.choices[0].message?.content || '[]';
    let text = raw.trim();
    // If wrapped in markdown fences (e.g., ```json ... ```), strip them
    if (text.startsWith('```')) {
      const lines = text.split('\n');
      // Remove opening fence
      if (lines[0].startsWith('```')) lines.shift();
      // Remove closing fence if present
      if (lines[lines.length - 1].startsWith('```')) lines.pop();
      text = lines.join('\n').trim();
    }

    let suggestions: Suggestion[];
    try {
      suggestions = JSON.parse(text);
    } catch (parseErr) {
      console.error('Failed to parse suggestions JSON, attempting fallback parse:', parseErr, text);
      // Fallback suggestions
      suggestions = [
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

    return Array.isArray(suggestions) ? suggestions : [];
  } catch (error) {
    console.error('Error generating pattern analysis suggestions:', error);
    return [];
  }
}

/**
 * Get detailed information about a specific suggestion.
 */
export async function getSuggestionDetails(
  suggestion: Suggestion,
  conversationHistory: Message[]
): Promise<string> {
  try {
    const contexts = await retrieveContext(suggestion.content);
    return contexts.join('\n\n') || 'No additional details available.';
  } catch (error) {
    console.error('Error getting suggestion details:', error);
    return 'Error retrieving suggestion details.';
  }
}

/**
 * Translate text to the specified language using OpenAI.
 */
export async function translateText(
  text: string,
  targetLanguage: string
): Promise<string> {
  try {
    if (targetLanguage === 'English') {
      return text;
    }

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
