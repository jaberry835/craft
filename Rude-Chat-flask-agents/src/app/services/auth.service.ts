import { Injectable, inject } from '@angular/core';
import { MsalService, MsalBroadcastService } from '@azure/msal-angular';
import { InteractionStatus, RedirectRequest, EventType } from '@azure/msal-browser';
import { Observable, filter, map, BehaviorSubject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private msalService = inject(MsalService);
  private msalBroadcastService = inject(MsalBroadcastService);
  private authStateSubject = new BehaviorSubject<boolean>(false);

  isLoggedIn$: Observable<boolean> = this.authStateSubject.asObservable();  constructor() {
    console.log('AuthService constructor - initializing...');
    
    // Listen for MSAL events and update auth state
    this.msalBroadcastService.inProgress$
      .pipe(filter((status: InteractionStatus) => status === InteractionStatus.None))
      .subscribe(() => {
        console.log('MSAL interaction completed, updating auth state...');
        this.updateAuthState();
      });

    // Also listen for specific MSAL events
    this.msalBroadcastService.msalSubject$
      .subscribe((msg) => {
        console.log('MSAL Event received:', msg.eventType, msg);
        if (msg.eventType === EventType.LOGIN_SUCCESS) {
          console.log('Login success detected');
          this.updateAuthState();
        }
        if (msg.eventType === EventType.ACQUIRE_TOKEN_SUCCESS) {
          console.log('Token acquired successfully');
          this.updateAuthState();
        }
        if (msg.eventType === EventType.LOGIN_FAILURE) {
          console.log('Login failure detected:', msg.error);
        }
        if (msg.eventType === EventType.ACCOUNT_ADDED || msg.eventType === EventType.ACCOUNT_REMOVED) {
          console.log('Account added/removed, updating auth state');
          this.updateAuthState();
        }
      });
  }

  updateAuthState(): void {
    try {
      const accounts = this.msalService.instance.getAllAccounts();
      const isLoggedIn = accounts.length > 0;
      console.log('Auth state updated - accounts found:', accounts.length, 'isLoggedIn:', isLoggedIn);
      this.authStateSubject.next(isLoggedIn);
    } catch (error) {
      console.log('Error checking auth state, defaulting to false:', error);
      this.authStateSubject.next(false);
    }
  }  async login(): Promise<void> {
    console.log('Login button clicked - starting authentication flow');
    try {
      // Check if already logged in
      const accounts = this.msalService.instance.getAllAccounts();
      if (accounts.length > 0) {
        console.log('User already logged in:', accounts[0]);
        this.updateAuthState();
        return;
      }

      // Check if we're in the middle of handling a redirect
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.has('code') || urlParams.has('error')) {
        console.log('Already in redirect flow, skipping new login');
        return;
      }

      const loginRequest: RedirectRequest = {
        scopes: ['openid', 'profile', 'email'],
        prompt: 'select_account'
      };
      console.log('Login request:', loginRequest);
      console.log('Starting redirect to:', this.msalService.instance.getConfiguration().auth.authority);
      
      await this.msalService.loginRedirect(loginRequest);
    } catch (error) {
      console.error('Error during login redirect:', error);
    }
  }

  logout(): void {
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
        scopes: ['https://management.usgovcloudapi.net/.default'],
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
      console.log('Starting interactive authentication for Azure Resource Manager...');
      
      const loginRequest = {
        scopes: ['https://management.usgovcloudapi.net/.default'],
        prompt: 'consent' // Force consent dialog to appear
      };

      await this.msalService.instance.loginPopup(loginRequest);
      console.log('Interactive authentication for Azure Resource Manager completed');
    } catch (error) {
      console.error('Error during interactive Azure Resource Manager authentication:', error);
      throw error;
    }
  }
}
