export const environment = {
  production: true,
  azure: {
    clientId: '__CLIENT_ID__',
    authority: '__AUTHORITY__',
    redirectUri: '__REDIRECT_URI__',
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
