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
    MsalBroadcastService
  ]
}).catch(err => console.error(err));
