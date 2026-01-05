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

  isLoggedIn$: Observable<boolean> = this.authStateSubject.asObservable();

  constructor() {
    // Listen for MSAL events and update auth state
    this.msalBroadcastService.inProgress$
      .pipe(filter((status: InteractionStatus) => status === InteractionStatus.None))
      .subscribe(() => {
        this.updateAuthState();
      });

    // Also listen for specific MSAL events
    this.msalBroadcastService.msalSubject$
      .pipe(filter((msg) => msg.eventType === EventType.LOGIN_SUCCESS))
      .subscribe(() => {
        console.log('Login success detected');
        this.updateAuthState();
      });

    // Initialize auth state
    setTimeout(() => this.updateAuthState(), 100);
  }

  private updateAuthState(): void {
    try {
      const accounts = this.msalService.instance.getAllAccounts();
      const isLoggedIn = accounts.length > 0;
      console.log('Auth state updated - accounts found:', accounts.length, 'isLoggedIn:', isLoggedIn);
      this.authStateSubject.next(isLoggedIn);
    } catch (error) {
      console.log('Error checking auth state, defaulting to false:', error);
      this.authStateSubject.next(false);
    }
  }

  async login(): Promise<void> {
    console.log('Login button clicked - starting authentication flow');
    try {
      // Check if already logged in
      const accounts = this.msalService.instance.getAllAccounts();
      if (accounts.length > 0) {
        console.log('User already logged in:', accounts[0]);
        this.updateAuthState();
        return;
      }

      const loginRequest: RedirectRequest = {
        scopes: ['openid', 'profile', 'email']
      };
      console.log('Login request:', loginRequest);
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
  }

  async getAccessToken(): Promise<string | null> {
    try {
      const accounts = this.msalService.instance.getAllAccounts();
      if (accounts.length === 0) return null;

      const tokenRequest = {
        scopes: ['https://graph.microsoft.com/.default'],
        account: accounts[0]
      };

      const response = await this.msalService.instance.acquireTokenSilent(tokenRequest);
      return response.accessToken;
    } catch (error) {
      console.error('Error acquiring token:', error);
      return null;
    }
  }
}
