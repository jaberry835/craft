import { Injectable } from '@angular/core';
import { MsalService } from '@azure/msal-angular';
import { PopupRequest, RedirectRequest } from '@azure/msal-browser';
import { BehaviorSubject, Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Authentication service for role-based access control.
 * Checks user roles from the ID token claims.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private isAdminSubject = new BehaviorSubject<boolean>(false);
  isAdmin$ = this.isAdminSubject.asObservable();

  constructor(private msalService: MsalService) {
    this.checkAdminRole();
  }

  /**
   * Check if the current user has admin role.
   * In development mode, everyone is treated as admin (matches backend behavior).
   * In production, roles come from the 'roles' claim in the ID token.
   */
  checkAdminRole(): boolean {
    // In development, everyone is admin (backend skips role check too)
    if (!environment.production) {
      this.isAdminSubject.next(true);
      return true;
    }

    const account = this.msalService.instance.getActiveAccount();
    if (!account) {
      this.isAdminSubject.next(false);
      return false;
    }

    // Roles are in the idTokenClaims
    const claims = account.idTokenClaims as { roles?: string[] } | undefined;
    const roles = claims?.roles || [];
    
    // Check for 'admin' role (case-insensitive)
    const isAdmin = roles.some(role => role.toLowerCase() === 'admin');
    this.isAdminSubject.next(isAdmin);
    
    return isAdmin;
  }

  /**
   * Get the current user's roles.
   */
  getUserRoles(): string[] {
    const account = this.msalService.instance.getActiveAccount();
    if (!account) {
      return [];
    }

    const claims = account.idTokenClaims as { roles?: string[] } | undefined;
    return claims?.roles || [];
  }

  /**
   * Get the current user's email/username.
   */
  getUserEmail(): string | null {
    const account = this.msalService.instance.getActiveAccount();
    return account?.username || null;
  }

  /**
   * Get the current user's display name.
   */
  getUserName(): string | null {
    const account = this.msalService.instance.getActiveAccount();
    return account?.name || null;
  }

  /** Session-storage key to signal that a consent redirect is in progress. */
  static readonly CONSENT_FLAG = 'force_consent';

  /**
   * Force a re-consent prompt via popup.  Falls back to redirect if the
   * popup is blocked by the browser.
   */
  async reConsent(): Promise<void> {
    const account = this.msalService.instance.getActiveAccount() || undefined;
    // Use consentScopes which includes all delegated permissions from the app registration
    // (including User.Read and other Graph/API scopes that trigger the consent dialog)
    const consentScopes = environment.consentScopes || [...environment.loginScopes, ...environment.apiScopes];

    const popupRequest: PopupRequest = {
      scopes: consentScopes,
      prompt: 'consent',
      account
    };

    console.log('[Auth] Requesting re-consent via popup with scopes:', consentScopes);

    try {
      const result = await this.msalService.instance.acquireTokenPopup(popupRequest);
      console.log('[Auth] Re-consent popup succeeded for:', result.account?.username);

      // Update the active account with the fresh token
      if (result.account) {
        this.msalService.instance.setActiveAccount(result.account);
      }

      // Reload to pick up any new permissions/claims
      window.location.reload();
    } catch (popupError: any) {
      console.warn('[Auth] Popup consent failed:', popupError?.message || popupError);

      // If popup was blocked or failed, fall back to redirect
      if (popupError?.errorCode === 'popup_window_error' ||
          popupError?.errorCode === 'empty_window_error' ||
          popupError?.message?.includes('popup')) {
        console.log('[Auth] Popup blocked — falling back to redirect for consent');

        // Set flag so we know to clear it on return
        sessionStorage.setItem(AuthService.CONSENT_FLAG, 'true');

        const redirectRequest: RedirectRequest = {
          scopes: consentScopes,
          prompt: 'consent',
          account
        };

        // Use the msal-browser instance directly (Promise API)
        await this.msalService.instance.acquireTokenRedirect(redirectRequest);
      }
    }
  }

  /** True when a consent redirect is in-flight (used by interceptor to avoid competing redirects). */
  static isConsentPending(): boolean {
    return sessionStorage.getItem(AuthService.CONSENT_FLAG) === 'true';
  }

  /** Clear the flag after the redirect completes (called from AppComponent). */
  static clearConsentFlag(): void {
    sessionStorage.removeItem(AuthService.CONSENT_FLAG);
  }
}
