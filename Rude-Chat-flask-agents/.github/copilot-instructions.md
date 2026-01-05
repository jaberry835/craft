# Copilot Instructions

<!-- Use this file to provide workspace-specific custom instructions to Copilot. For more details, visit https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file -->

## Project Overview
This is an Angular application that provides a ChatGPT-style UI with the following key features:

- **ChatGPT-style conversational UI** with message bubbles, typing indicators, and modern chat interface
- **Azure OpenAI integration** for LLM capabilities
- **Azure Entra ID authentication** for user login and security
- **Azure AI Search integration** for RAG (Retrieval-Augmented Generation) content
- **Azure Functions MCP server** integration for advanced tooling skills
- **Document upload functionality** for private RAG content per user
- **Chat history management** with persistence capabilities
- **Modern, responsive design** using Angular Material and SCSS

## Architecture Guidelines
- Use Angular standalone components with signals and modern Angular patterns
- Implement reactive programming with RxJS for state management
- Follow Angular Material design patterns for consistent UI
- Use TypeScript strict mode for type safety
- Implement proper error handling and loading states
- Use environment variables for Azure service configurations

## Azure Integration Patterns
- Use @azure/msal-angular for Entra ID authentication
- Implement Azure OpenAI SDK for chat completions
- Use Azure AI Search SDK for RAG functionality
- Create HTTP interceptors for Azure service authentication
- Implement proper token management and refresh patterns

## UI/UX Guidelines
- Follow ChatGPT-style conversation patterns
- Implement message bubbles with user/assistant differentiation
- Add typing indicators and loading states
- Use proper accessibility features (ARIA labels, keyboard navigation)
- Implement responsive design for mobile and desktop
- Add smooth animations and transitions

## Security Considerations
- Never expose API keys in frontend code
- Use Azure Functions as proxy for sensitive operations
- Implement proper CORS configurations
- Use secure token storage practices
- Validate all user inputs before processing
