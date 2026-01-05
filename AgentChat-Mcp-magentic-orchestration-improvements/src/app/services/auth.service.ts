import { Injectable, inject } from '@angular/core';
import { MsalService, MsalBroadcastService } from '@azure/msal-angular';
import { InteractionStatus, RedirectRequest, EventType } from '@azure/msal-browser';
import { Observable, filter, map, BehaviorSubject } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private msalService = inject(MsalService);
  private msalBroadcastService = inject(MsalBroadcastService);
  private authStateSubject = new BehaviorSubject<boolean>(false);
  
  // Token caching
  private cachedADXToken: string | null = null;
  private adxTokenExpiry: number | null = null;
  private adxTokenAcquisitionInProgress = false;

  isLoggedIn$: Observable<boolean> = this.authStateSubject.asObservable();  constructor() {
    // console.log('AuthService constructor - initializing...');
    
    // Listen for MSAL events and update auth state
    this.msalBroadcastService.inProgress$
      .pipe(filter((status: InteractionStatus) => status === InteractionStatus.None))
      .subscribe(() => {
        // console.log('MSAL interaction completed, updating auth state...');
        this.updateAuthState();
      });

    // Also listen for specific MSAL events
    this.msalBroadcastService.msalSubject$
      .subscribe((msg) => {
        // console.log('MSAL Event received:', msg.eventType, msg);
        if (msg.eventType === EventType.LOGIN_SUCCESS) {
          // console.log('Login success detected');
          this.updateAuthState();
        }
        if (msg.eventType === EventType.ACQUIRE_TOKEN_SUCCESS) {
          // console.log('Token acquired successfully');
          this.updateAuthState();
        }
        if (msg.eventType === EventType.LOGIN_FAILURE) {
          console.log('Login failure detected:', msg.error);
        }
        if (msg.eventType === EventType.ACCOUNT_ADDED || msg.eventType === EventType.ACCOUNT_REMOVED) {
          // console.log('Account added/removed, updating auth state');
          this.updateAuthState();
        }
      });
  }

  updateAuthState(): void {
    try {
      const accounts = this.msalService.instance.getAllAccounts();
      const isLoggedIn = accounts.length > 0;
      // console.log('Auth state updated - accounts found:', accounts.length, 'isLoggedIn:', isLoggedIn);
      this.authStateSubject.next(isLoggedIn);
      
      // If user just logged in, proactively acquire ADX token
      if (isLoggedIn && !this.cachedADXToken) {
        // console.log('User logged in, proactively acquiring ADX token...');
        this.preloadADXToken();
      }
    } catch (error) {
      console.log('Error checking auth state, defaulting to false:', error);
      this.authStateSubject.next(false);
    }
  }

  /**
   * Proactively acquire ADX token to avoid delays later
   */
  private async preloadADXToken(): Promise<void> {
    try {
      await this.getADXAccessToken();
      // console.log('ADX token preloaded successfully');
    } catch (error) {
      // console.log('Failed to preload ADX token (will retry when needed):', error);
    }
  }  async login(): Promise<void> {
    // console.log('Login button clicked - starting authentication flow');
    try {
      // Check if already logged in
      const accounts = this.msalService.instance.getAllAccounts();
      if (accounts.length > 0) {
        // console.log('User already logged in:', accounts[0]);
        this.updateAuthState();
        return;
      }

      // Check if we're in the middle of handling a redirect
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.has('code') || urlParams.has('error')) {
        // console.log('Already in redirect flow, skipping new login');
        return;
      }

      const loginRequest: RedirectRequest = {
        scopes: environment.azure.scopes.basic,
        prompt: 'select_account'
      };
      // console.log('Login request:', loginRequest);
      // console.log('Starting redirect to:', this.msalService.instance.getConfiguration().auth.authority);
      
      await this.msalService.loginRedirect(loginRequest);
    } catch (error) {
      console.error('Error during login redirect:', error);
    }
  }

  logout(): void {
    // Clear cached tokens
    this.cachedADXToken = null;
    this.adxTokenExpiry = null;
    this.adxTokenAcquisitionInProgress = false;
    
    this.msalService.logoutRedirect({
      postLogoutRedirectUri: window.location.origin
    });
  }

  getUser() {
    const accounts = this.msalService.instance.getAllAccounts();
    return accounts.length > 0 ? accounts[0] : null;
  }

  getUserId(): string | null {
    const user = this.getUser();
    return user?.homeAccountId || null;
  }  async getAccessToken(): Promise<string | null> {
    try {
      const accounts = this.msalService.instance.getAllAccounts();
      if (accounts.length === 0) return null;

      // Request token for Azure Resource Manager (Azure Government)
      const tokenRequest = {
        scopes: [environment.azure.scopes.armDefault],
        account: accounts[0]
      };

      try {
        // Try silent token acquisition first
        const response = await this.msalService.instance.acquireTokenSilent(tokenRequest);
        return response.accessToken;
      } catch (silentError) {
        console.log('Silent token acquisition failed, trying interactive...', silentError);
        
        // If silent fails, try interactive
        try {
          const interactiveResponse = await this.msalService.instance.acquireTokenPopup(tokenRequest);
          return interactiveResponse.accessToken;
        } catch (interactiveError) {
          console.error('Interactive token acquisition also failed:', interactiveError);
          return null;
        }
      }
    } catch (error) {
      console.error('Error acquiring Azure Resource Manager token:', error);
      return null;
    }
  }
  /**
   * Interactive login specifically for Azure Resource Manager access
   */
  async loginInteractiveForAzureResources(): Promise<void> {
    try {
      // console.log('Starting interactive authentication for Azure Resource Manager...');
      
      const loginRequest = {
        scopes: [environment.azure.scopes.armDefault],
        prompt: 'consent' // Force consent dialog to appear
      };

      await this.msalService.instance.loginPopup(loginRequest);
      // console.log('Interactive authentication for Azure Resource Manager completed');
    } catch (error) {
      console.error('Error during interactive Azure Resource Manager authentication:', error);
      throw error;
    }
  }

  /**
   * Get access token specifically for Azure Data Explorer with caching
   */
  async getADXAccessToken(): Promise<string | null> {
    try {
      // console.log(`🔍 ADX Token Request - Cached: ${this.cachedADXToken ? 'YES' : 'NO'}, Expiry: ${this.adxTokenExpiry ? new Date(this.adxTokenExpiry).toISOString() : 'NONE'}`);
      
      // Check if we have a valid cached token
      if (this.cachedADXToken && this.adxTokenExpiry && Date.now() < this.adxTokenExpiry) {
        // console.log('✅ Using cached ADX token');
        return this.cachedADXToken;
      }

      // Check if token acquisition is already in progress
      if (this.adxTokenAcquisitionInProgress) {
        // console.log('ADX token acquisition already in progress, skipping...');
        return this.cachedADXToken; // Return cached token or null
      }

      const accounts = this.msalService.instance.getAllAccounts();
      if (accounts.length === 0) {
        console.log('❌ No accounts found for ADX token, user needs to login first');
        return null;
      }

      // console.log(`🔄 Acquiring ADX token for account: ${accounts[0].username}`);
      this.adxTokenAcquisitionInProgress = true;

      // For Azure Government, try the Azure Government specific resource ID
      // Azure Government may have a different resource ID for ADX
      const tokenRequest = {
        scopes: [environment.azure.scopes.adxUserImpersonation],
        account: accounts[0],
        prompt: 'none' // Try silent first
      };

      try {
        // Try silent token acquisition first
        // console.log('Attempting silent ADX token acquisition...');
        const response = await this.msalService.instance.acquireTokenSilent(tokenRequest);
        // console.log('✅ Silent ADX token acquisition successful');
        
        // Cache the token with expiry (expires 5 minutes before actual expiry for safety)
        this.cachedADXToken = response.accessToken;
        this.adxTokenExpiry = (response.expiresOn?.getTime() || Date.now() + 3600000) - 300000; // 5 min buffer
        
        return response.accessToken;
      } catch (silentError) {
        // console.log('Silent ADX token acquisition failed:', silentError);
        
        // Check if this is a consent error
        const isConsentError = this.shouldRetryInteractive(silentError) && 
                              ((silentError as any)?.errorMessage?.includes('AADSTS65001') || 
                               (silentError as any)?.errorCode === 'invalid_grant');
        
        if (isConsentError) {
          console.log('⚠️ ADX consent required. User needs to manually grant consent.');
          console.log('🔧 Call authService.forceADXConsent() to trigger consent flow.');
          return null; // Don't automatically trigger popups
        }
        
        // For other recoverable errors, don't auto-trigger interactive auth to avoid popup conflicts
        // console.log('Silent token acquisition failed, returning null to avoid popup conflicts');
        return null;
      }
    } catch (error) {
      console.error('Error acquiring ADX token:', error);
      return null;
    } finally {
      this.adxTokenAcquisitionInProgress = false;
    }
  }

  /**
   * Check if the error is recoverable with interactive authentication
   */
  private shouldRetryInteractive(error: any): boolean {
    // Don't retry if user is not logged in or account is not available
    if (!error) return false;
    
    // console.log(`🔍 Checking if error is recoverable:`, error);
    
    // Check error code first
    if (error.errorCode) {
      const recoverableErrors = [
        'interaction_required',
        'consent_required', 
        'login_required',
        'token_expired',
        'user_password_expired',
        'session_not_found',
        'fresh_token_needed',
        'invalid_grant' // This often indicates consent issues
      ];
      
      const isRecoverable = recoverableErrors.includes(error.errorCode);
      // console.log(`🔍 Error code "${error.errorCode}" is recoverable: ${isRecoverable}`);
      
      if (isRecoverable) {
        return true;
      }
    }
    
    // Also check for AADSTS consent errors in the error message
    if (error.errorMessage && typeof error.errorMessage === 'string') {
      const consentErrors = [
        'AADSTS65001', // User or administrator has not consented
        'AADSTS50105', // User not assigned to role
        'AADSTS70011', // Invalid scope
        'AADSTS50000'  // Generic consent error
      ];
      
      const hasConsentError = consentErrors.some(code => error.errorMessage.includes(code));
      // console.log(`🔍 Error message contains consent error: ${hasConsentError}`);
      
      return hasConsentError;
    }
    
    return false;
  }

  /**
   * Manually refresh the ADX token (clears cache and acquires new token)
   */
  async refreshADXToken(): Promise<string | null> {
    // console.log('Manually refreshing ADX token...');
    this.cachedADXToken = null;
    this.adxTokenExpiry = null;
    return await this.getADXAccessToken();
  }

  /**
   * Check if ADX token is available and valid
   */
  hasValidADXToken(): boolean {
    return this.cachedADXToken !== null && 
           this.adxTokenExpiry !== null && 
           Date.now() < this.adxTokenExpiry;
  }

  /**
   * Force ADX consent - useful for first-time setup or when consent is revoked
   * Uses popup to trigger interactive consent
   */
  async forceADXConsent(): Promise<string | null> {
    try {
      console.log('🔐 Forcing ADX consent dialog...');
      
      const accounts = this.msalService.instance.getAllAccounts();
      if (accounts.length === 0) {
        console.log('❌ No accounts found, user needs to login first');
        return null;
      }

      // Clear any cached token to force fresh acquisition
      this.cachedADXToken = null;
      this.adxTokenExpiry = null;

      const tokenRequest = {
        scopes: [environment.azure.scopes.adxUserImpersonation],
        account: accounts[0],
        prompt: 'consent' as any // Force consent dialog
      };

      // console.log('🔐 Launching consent popup...');
      
      // Use popup to trigger interactive consent
      const response = await this.msalService.instance.acquireTokenPopup(tokenRequest);
      
      if (response && response.accessToken) {
        console.log('✅ ADX consent granted and token acquired');
        
        // Cache the token with expiry (expires 5 minutes before actual expiry for safety)
        this.cachedADXToken = response.accessToken;
        this.adxTokenExpiry = (response.expiresOn?.getTime() || Date.now() + 3600000) - 300000; // 5 min buffer
        
        return response.accessToken;
      } else {
        console.log('⚠️ ADX consent completed but no token received');
        return null;
      }
    } catch (error) {
      console.error('❌ ADX consent failed:', error);
      
      // Check if it's a popup blocked error
      if (error && typeof error === 'object' && 'errorCode' in error) {
        if ((error as any).errorCode === 'popup_window_error') {
          console.log('🚫 Popup was blocked! Please allow popups for this site and try again.');
          alert('Popup was blocked! Please allow popups for this site and try again.');
        }
      }
      
      return null;
    }
  }

  /**
   * Test if popups are allowed by opening a small test popup
   */
  testPopups(): boolean {
    try {
      // console.log('🔍 Testing if popups are allowed...');
      
      // Try to open a small test popup
      const popup = window.open('', '_blank', 'width=100,height=100,scrollbars=no,resizable=no');
      
      if (popup) {
        console.log('✅ Popups are allowed');
        popup.close();
        return true;
      } else {
        console.log('🚫 Popups are blocked');
        return false;
      }
    } catch (error) {
      console.log('🚫 Popups are blocked (exception):', error);
      return false;
    }
  }

  /**
   * Clear all cached tokens
   */
  clearTokenCache(): void {
    // console.log('🧹 Clearing token cache...');
    this.cachedADXToken = null;
    this.adxTokenExpiry = null;
    
    // Clear MSAL cache
    try {
      this.msalService.instance.clearCache();
      console.log('✅ Token cache cleared successfully');
    } catch (error) {
      console.error('❌ Error clearing token cache:', error);
    }
  }
}
