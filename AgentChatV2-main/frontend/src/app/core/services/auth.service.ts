import { Injectable } from '@angular/core';
import { MsalService } from '@azure/msal-angular';
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
}
