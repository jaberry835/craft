export const environment = {
  production: true,
  azure: {
    clientId: '5e9822c5-f870-4acb-b2e6-1852254d9cbb',
    authority: 'https://login.microsoftonline.us/03f141f3-496d-4319-bbea-a3e9286cab10',
    redirectUri: 'https://rude-chat-python.azurewebsites.us',
    openai: {
      endpoint: 'https://rudeaoai-gov.openai.azure.us/',
      apiKey: '', // Not used in production - handled by backend
      deploymentName: 'gpt-4o'
    },
    search: {
      endpoint: 'https://rude-search.search.azure.us',
      apiKey: '', // Not used in production - handled by backend
      indexName: 'chat-documents'
    },
    maps: {
      subscriptionKey: '' // Not used in production - handled by backend
    },
    functions: {
      baseUrl: '', // Not using Azure Functions
      mcpServerUrl: 'https://rude-chat-python.azurewebsites.us/api/mcp' // Points to same app service
    }
  },
  api: {
    baseUrl: 'https://rude-chat-python.azurewebsites.us/api', // Same app service API endpoints
    socketUrl: 'https://rude-chat-python.azurewebsites.us' // SocketIO server URL for production
  }
};

