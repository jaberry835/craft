import * as RAG from './aiServiceRAG';

// For now, we're only using the main aiServiceRAG.ts implementation
console.log('aiServiceRAG: Using main RAG service implementation');

// Export all services from the main RAG service
export const retrieveContext = RAG.retrieveContext;
export const getAssistantResponse = RAG.getAssistantResponse;
export const getAssistantResponseSimple = RAG.getAssistantResponseSimple;

export const getInitialProjectInfo = RAG.getInitialProjectInfo;
export const getPatternAnalysisSuggestions = RAG.getPatternAnalysisSuggestions;
export const getSuggestionDetails = RAG.getSuggestionDetails;
export const translateText = RAG.translateText;
