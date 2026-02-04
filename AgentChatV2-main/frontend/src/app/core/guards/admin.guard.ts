import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * Route guard that requires admin role.
 * Redirects to home if user is not an admin.
 */
export const adminGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.checkAdminRole()) {
    return true;
  }

  // Not an admin - redirect to home
  console.warn('Admin access denied - user does not have admin role');
  router.navigate(['/']);
  return false;
};
