import { Component, OnInit, OnDestroy } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { MsalService, MsalBroadcastService } from '@azure/msal-angular';
import { InteractionStatus } from '@azure/msal-browser';
import { Subject, filter, takeUntil } from 'rxjs';

import { SidebarComponent } from './shared/components/sidebar/sidebar.component';
import { HeaderComponent } from './shared/components/header/header.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, SidebarComponent, HeaderComponent],
  template: `
    @if (!isLoading) {
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
    .app-container {
      display: flex;
      height: 100vh;
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

  constructor(
    private authService: MsalService,
    private broadcastService: MsalBroadcastService
  ) {}

  ngOnInit(): void {
    // Handle the redirect callback from Azure AD login
    this.authService.handleRedirectObservable().subscribe({
      next: (result) => {
        if (result) {
          // Set the account from the successful login
          this.authService.instance.setActiveAccount(result.account);
          console.log('[MSAL] Login successful, active account set:', result.account?.username);
        }
      },
      error: (error) => {
        console.error('[MSAL] Redirect error:', error);
      }
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
        this.isLoading = false;
      });
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
