// =============================================================================
// Environment configuration for production
// =============================================================================
// IMPORTANT: These values are currently configured for Azure Government.
// For Azure Commercial, update the following:
//   - authority: https://login.microsoftonline.com/{your-tenant-id}
//   - knownAuthorities: ['login.microsoftonline.com']
// =============================================================================

export const environment = {
  production: true,
  // API URL - in production, this should point to the backend service
  // Set via BACKEND_URL build arg during Docker build
  apiUrl: '',  // Will be set to BACKEND_URL + '/api' during build, or '/api' for same-origin
  backendUrl: '',  // Set during Docker build via BACKEND_URL build arg
  msalConfig: {
    auth: {
      // TODO: Move these to environment variables or config service
      // Azure Government: login.microsoftonline.us
      // Azure Commercial: login.microsoftonline.com
      clientId: '5e9822c5-f870-4acb-b2e6-1852254d9cbb',
      authority: 'https://login.microsoftonline.us/03f141f3-496d-4319-bbea-a3e9286cab10',
      redirectUri: typeof window !== 'undefined' ? window.location.origin : '',
      postLogoutRedirectUri: typeof window !== 'undefined' ? window.location.origin : '',
      // Azure Government: login.microsoftonline.us
      // Azure Commercial: login.microsoftonline.com
      knownAuthorities: ['login.microsoftonline.us']
    },
    cache: {
      cacheLocation: 'localStorage',
      storeAuthStateInCookie: true  // Helps with iframe token refresh in strict cookie environments
    },
    system: {
      allowNativeBroker: false,  // Disable WAM broker for local dev
      tokenRenewalOffsetSeconds: 300  // Renew tokens 5 min before expiry
    }
  },
  // Standard OIDC scopes for login
  loginScopes: ['openid', 'profile', 'email'],
  // API scope from app registration - use your exposed API scope
  apiScopes: ['api://5e9822c5-f870-4acb-b2e6-1852254d9cbb/mcp-access']
};
