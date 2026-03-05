import { Component, OnInit, OnDestroy } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { MsalService, MsalBroadcastService } from '@azure/msal-angular';
import { InteractionStatus, InteractionRequiredAuthError, BrowserAuthError } from '@azure/msal-browser';
import { Subject, filter, takeUntil } from 'rxjs';

import { SidebarComponent } from './shared/components/sidebar/sidebar.component';
import { HeaderComponent } from './shared/components/header/header.component';
import { ClassificationBannerComponent } from './shared/components/classification-banner/classification-banner.component';
import { SettingsService } from './core/services/settings.service';
import { PreferencesService } from './core/services/preferences.service';
import { AuthService } from './core/services/auth.service';
import { environment } from '@env/environment';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, SidebarComponent, HeaderComponent, ClassificationBannerComponent],
  template: `
    @if (!isLoading) {
      <app-classification-banner></app-classification-banner>
      <div class="app-container">
        <app-sidebar></app-sidebar>
        <div class="main-content">
          <app-header></app-header>
          <router-outlet></router-outlet>
        </div>
      </div>
    }
    @if (isLoading) {
      <div class="loading-container">
        <div class="loading-spinner"></div>
        <p>Authenticating...</p>
      </div>
    }
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    
    .app-container {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    
    .main-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    
    .loading-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      gap: 16px;
      
      .loading-spinner {
        width: 40px;
        height: 40px;
        border: 3px solid var(--border-color);
        border-top-color: var(--primary);
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  isLoading = true;
  private readonly destroy$ = new Subject<void>();
  private authInitialized = false;

  constructor(
    private authService: MsalService,
    private broadcastService: MsalBroadcastService,
    private settingsService: SettingsService,
    private preferencesService: PreferencesService
  ) {}

  ngOnInit(): void {
    // Load UI settings (classification banner, branding) early
    this.settingsService.loadSettings().subscribe();

    // Handle redirect responses from login. This is the SOLE redirect handler;
    // APP_INITIALIZER only calls initialize(). MsalGuard waits for inProgress$
    // to reach None before firing, so there is no race condition.
    this.authService.handleRedirectObservable().subscribe({
      next: (result) => {
        if (result?.account) {
          this.authService.instance.setActiveAccount(result.account);
          console.log('[MSAL] Active account set:', result.account.username);
          // Clear consent flag now that the redirect completed successfully
          AuthService.clearConsentFlag();
        }
      },
      error: (error) => console.error('[MSAL] Redirect error:', error)
    });
    
    // Also check if there's already an account in cache (page refresh scenario)
    this.checkAndSetActiveAccount();
    
    this.broadcastService.inProgress$
      .pipe(
        filter((status: InteractionStatus) => status === InteractionStatus.None),
        takeUntil(this.destroy$)
      )
      .subscribe(() => {
        this.checkAndSetActiveAccount();

        // Only run the API-token warm-up once per page load.
        // This prevents the "double login prompt" when MsalGuard's initial login
        // only grants loginScopes and the API scope token hasn't been cached yet.
        if (!this.authInitialized) {
          this.authInitialized = true;
          this.initializeAuthAndRender();
        }
      });
  }

  /**
   * Proactively acquire an API-scope token before rendering the app.
   * This ensures the MSAL token cache is warm so that component HTTP requests
   * (which go through the auth interceptor) find a valid cached token instead
   * of all racing to call acquireTokenSilent concurrently.
   */
  private async initializeAuthAndRender(): Promise<void> {
    const account = this.authService.instance.getActiveAccount();

    if (account) {
      try {
        await this.authService.instance.acquireTokenSilent({
          scopes: environment.apiScopes,
          account: account,
          forceRefresh: false
        });
        console.log('[MSAL] API token cached successfully');
      } catch (error: any) {
        console.warn('[MSAL] Silent API token acquisition failed:', error?.message);

        // If interaction is required (consent needed, expired refresh token, etc.),
        // trigger a single redirect to acquire the API token.  The page will reload
        // after the redirect, so we return early without setting isLoading = false.
        if (
          error instanceof InteractionRequiredAuthError ||
          error instanceof BrowserAuthError
        ) {
          console.log('[MSAL] Interaction required - redirecting for API token');
          try {
            await this.authService.instance.acquireTokenRedirect({
              scopes: environment.apiScopes,
              account: account
            });
          } catch (redirectError) {
            console.error('[MSAL] Redirect for API token failed:', redirectError);
          }
          return; // page will reload after redirect
        }
        // For other errors (transient / network), continue — interceptor will retry per-request
      }
    }

    this.isLoading = false;
    // Load user preferences (theme) after auth and API token are ready
    this.preferencesService.loadPreferences().subscribe();
  }

  private checkAndSetActiveAccount(): void {
    const activeAccount = this.authService.instance.getActiveAccount();
    if (!activeAccount) {
      // No active account set - check if there are any accounts in cache
      const accounts = this.authService.instance.getAllAccounts();
      if (accounts.length > 0) {
        // Set the first account as active
        this.authService.instance.setActiveAccount(accounts[0]);
        console.log('[MSAL] Active account set from cache:', accounts[0]?.username);
      } else {
        console.log('[MSAL] No accounts in cache');
      }
    } else {
      console.log('[MSAL] Active account already set:', activeAccount?.username);
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
