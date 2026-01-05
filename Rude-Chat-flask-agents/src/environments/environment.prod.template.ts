export const environment = {
  production: true,
  azure: {
    clientId: '__CLIENT_ID__',
    authority: '__AUTHORITY__',
    redirectUri: '__REDIRECT_URI__',
    openai: {
      endpoint: '__OPENAI_ENDPOINT__',
      apiKey: '', // Not used in production - handled by backend
      deploymentName: '__OPENAI_DEPLOYMENT__'
    },
    search: {
      endpoint: '__SEARCH_ENDPOINT__',
      apiKey: '', // Not used in production - handled by backend
      indexName: '__SEARCH_INDEX__'
    },
    maps: {
      subscriptionKey: '' // Not used in production - handled by backend
    },
    functions: {
      baseUrl: '', // Not using Azure Functions
      mcpServerUrl: '__MCP_API_BASE_URL__' // Points to same app service
    }
  },
  api: {
    baseUrl: '__API_BASE_URL__' // Same app service API endpoints
  }
};
