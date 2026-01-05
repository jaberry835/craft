export const environment = {
  production: true,
  azure: {
    clientId: '5e9822c5-f870-4acb-b2e6-1852254d9cbb',
    authority: 'https://login.microsoftonline.us/03f141f3-496d-4319-bbea-a3e9286cab10',
    redirectUri: 'https://agent-a2a.azurewebsites.us',
    scopes: {
      // Azure Resource Manager (ARM) scopes
      armDefault: 'https://management.usgovcloudapi.net/.default',
      armUserImpersonation: 'https://management.usgovcloudapi.net/user_impersonation',
      // Azure Data Explorer (ADX) scopes
      adxUserImpersonation: 'https://api.kusto.usgovcloudapi.net/user_impersonation',
      // Basic authentication scopes
      basic: ['openid', 'profile', 'email']
    },
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
      mcpServerUrl: 'https://<mcpserver>.azurewebsites.us/api' // Points to MCP server base URL (endpoints append /tools, /tools/list, etc.)
    }
  },
  api: {
    baseUrl: 'https://agent-a2a.azurewebsites.us/api', // Same app service API endpoints
  }
};




