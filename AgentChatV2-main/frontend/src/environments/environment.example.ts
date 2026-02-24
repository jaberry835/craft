// =============================================================================
// Environment configuration for development
// =============================================================================
// Copy this file to environment.ts and fill in your values.
//
// AZURE GOVERNMENT vs AZURE COMMERCIAL:
//   Government:
//     - authority: https://login.microsoftonline.us/{your-tenant-id}
//     - knownAuthorities: ['login.microsoftonline.us']
//   Commercial:
//     - authority: https://login.microsoftonline.com/{your-tenant-id}
//     - knownAuthorities: ['login.microsoftonline.com']
// =============================================================================

export const environment = {
  production: false,
  apiUrl: '/api',
  backendUrl: 'http://localhost:5000',  // Direct backend URL for A2A endpoints
  msalConfig: {
    auth: {
      clientId: '<your-app-registration-client-id>',
      authority: 'https://login.microsoftonline.com/<your-tenant-id>',
      redirectUri: 'http://localhost:4200',
      postLogoutRedirectUri: 'http://localhost:4200',
      knownAuthorities: ['login.microsoftonline.com']
    },
    cache: {
      cacheLocation: 'localStorage',
      storeAuthStateInCookie: true
    },
    system: {
      allowNativeBroker: false,
      tokenRenewalOffsetSeconds: 300,
      iframeHashTimeout: 10000,
      loadFrameTimeout: 10000
    }
  },
  // Standard OIDC scopes for login
  loginScopes: ['openid', 'profile', 'email'],
  // API scope from app registration
  // Format: api://<client-id>/<scope-name> — must match "Expose an API" in your app registration
  apiScopes: ['api://<your-client-id>/<your-scope-name>']
};
