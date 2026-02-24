import { APP_INITIALIZER } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import {
  MSAL_INSTANCE,
  MSAL_GUARD_CONFIG,
  MSAL_INTERCEPTOR_CONFIG,
  MsalGuard,
  MsalInterceptor,
  MsalBroadcastService,
  MsalService
} from '@azure/msal-angular';
import {
  PublicClientApplication,
  InteractionType,
  IPublicClientApplication
} from '@azure/msal-browser';

import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';
import { environment } from './environments/environment';
import { authInterceptor } from './app/core/interceptors/auth.interceptor';

// MSAL instance factory
export function MSALInstanceFactory(): IPublicClientApplication {
  return new PublicClientApplication(environment.msalConfig);
}

// Ensure MSAL is fully initialized and any redirect response is processed
// before the app boots. msal-browser v3 requires initialize() to be awaited
// before any other API call, and handleRedirectPromise() must complete before
// MsalGuard fires to avoid 'interaction_in_progress' errors.
export function initializeMsal(msalService: MsalService) {
  return () =>
    msalService.instance.initialize().then(() =>
      msalService.instance.handleRedirectPromise().then((result) => {
        if (result?.account) {
          msalService.instance.setActiveAccount(result.account);
          console.log('[MSAL] Redirect login successful:', result.account.username);
        }
      })
    );
}

// MSAL Guard configuration - used for login
export function MSALGuardConfigFactory() {
  return {
    interactionType: InteractionType.Redirect,
    authRequest: {
      scopes: environment.loginScopes
    }
  };
}

// MSAL Interceptor configuration - attaches tokens to API calls
export function MSALInterceptorConfigFactory() {
  return {
    interactionType: InteractionType.Redirect,
    protectedResourceMap: new Map([
      [environment.apiUrl + '/*', environment.apiScopes]
    ])
  };
}

bootstrapApplication(AppComponent, {
  providers: [
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor])),
    provideAnimations(),
    {
      provide: MSAL_INSTANCE,
      useFactory: MSALInstanceFactory
    },
    {
      provide: MSAL_GUARD_CONFIG,
      useFactory: MSALGuardConfigFactory
    },
    {
      provide: MSAL_INTERCEPTOR_CONFIG,
      useFactory: MSALInterceptorConfigFactory
    },
    MsalService,
    MsalGuard,
    MsalBroadcastService,
    {
      provide: APP_INITIALIZER,
      useFactory: initializeMsal,
      deps: [MsalService],
      multi: true
    }
  ]
}).catch(err => console.error(err));
