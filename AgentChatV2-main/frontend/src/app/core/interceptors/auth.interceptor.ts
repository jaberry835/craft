import { HttpInterceptorFn, HttpRequest, HttpHandlerFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { MsalService } from '@azure/msal-angular';
import { InteractionRequiredAuthError, SilentRequest } from '@azure/msal-browser';
import { from, switchMap, catchError, throwError, EMPTY } from 'rxjs';
import { environment } from '@env/environment';

/**
 * Auth interceptor that attaches JWT tokens to API requests.
 * 
 * Key behavior:
 * 1. First checks MSAL's token cache for a valid cached token (fast, no iframe)
 * 2. Only calls acquireTokenSilent if no cached token exists
 * 3. Falls back to popup/redirect if silent fails
 */
export const authInterceptor: HttpInterceptorFn = (
  req: HttpRequest<unknown>,
  next: HttpHandlerFn
) => {
  const msalService = inject(MsalService);
  
  // Only add token for API requests
  const isApiRequest = (environment.apiUrl && req.url.startsWith(environment.apiUrl)) || 
                       req.url.startsWith('/api') ||
                       (environment.backendUrl && req.url.startsWith(environment.backendUrl));
  
  if (!isApiRequest) {
    return next(req);
  }
  
  const account = msalService.instance.getActiveAccount();
  
  if (!account) {
    console.error('[Auth] No active account - redirecting to login');
    msalService.loginRedirect({ scopes: environment.loginScopes });
    return EMPTY;
  }
  
  // Build the token request
  const tokenRequest: SilentRequest = {
    scopes: environment.apiScopes,
    account: account,
    forceRefresh: false
  };
  
  // OPTIMIZATION: Check cache first before calling acquireTokenSilent
  // This avoids creating iframes for every API request when we already have a valid token
  const cachedToken = getCachedAccessToken(msalService, tokenRequest);
  
  if (cachedToken) {
    // We have a valid cached token - use it directly (no iframe needed)
    const authReq = req.clone({
      setHeaders: { Authorization: `Bearer ${cachedToken}` }
    });
    return next(authReq);
  }
  
  // No cached token - need to acquire one silently (uses iframe)
  return from(
    msalService.instance.acquireTokenSilent(tokenRequest)
  ).pipe(
    switchMap(result => {
      const authReq = req.clone({
        setHeaders: { Authorization: `Bearer ${result.accessToken}` }
      });
      return next(authReq);
    }),
    catchError(error => {
      console.error('[Auth] Token acquisition failed:', error.name);
      
      // If interaction required, redirect to login
      if (error instanceof InteractionRequiredAuthError) {
        msalService.loginRedirect({
          scopes: environment.apiScopes,
          account: account
        });
        return EMPTY;
      }
      
      return throwError(() => error);
    })
  );
};

/**
 * Check if there's a valid cached access token.
 * This is much faster than acquireTokenSilent because it doesn't create iframes.
 * 
 * Returns the access token if cached and not expired, null otherwise.
 */
function getCachedAccessToken(msalService: MsalService, request: SilentRequest): string | null {
  try {
    // Get all cached tokens for this account
    const tokenCache = msalService.instance.getTokenCache();
    
    // Try to get the access token from cache without network call
    // MSAL's getAllAccounts and internal cache can be used
    const account = request.account;
    if (!account) return null;
    
    // Use MSAL's internal cache lookup
    // The acquireTokenSilent with forceRefresh:false will use cache,
    // but calling it creates Promise overhead. Instead, check cache directly.
    const allAccounts = msalService.instance.getAllAccounts();
    const activeAccount = allAccounts.find(a => a.homeAccountId === account.homeAccountId);
    
    if (!activeAccount) return null;
    
    // MSAL doesn't expose direct cache access easily, but we can check
    // if acquireTokenSilent would succeed by looking at the cache state.
    // The safest approach is to use the internal cache mechanism.
    
    // Get cached tokens - MSAL stores them in localStorage/sessionStorage
    const cacheKey = `${account.homeAccountId}-${environment.msalConfig.auth.clientId}`;
    const storage = window.localStorage;
    
    // Look for access token in cache
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.includes(account.homeAccountId) && key.includes('accesstoken')) {
        try {
          const cached = JSON.parse(storage.getItem(key) || '{}');
          const expiresOn = cached.expiresOn ? parseInt(cached.expiresOn, 10) : 0;
          const now = Math.floor(Date.now() / 1000);
          
          // Check if token is still valid (with 5 min buffer)
          if (expiresOn > now + 300) {
            // Verify this token is for our requested scopes
            const cachedScopes = (cached.target || '').toLowerCase().split(' ');
            const requestedScopes = request.scopes.map(s => s.toLowerCase());
            const hasAllScopes = requestedScopes.every(s => cachedScopes.includes(s));
            
            if (hasAllScopes && cached.secret) {
              return cached.secret; // This is the actual access token
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
    
    return null;
  } catch {
    // If anything fails, fall back to acquireTokenSilent
    return null;
  }
}
