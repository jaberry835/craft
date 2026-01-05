import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection, importProvidersFrom } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptorsFromDi, HTTP_INTERCEPTORS } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { MsalModule, MsalRedirectComponent } from '@azure/msal-angular';
import { PublicClientApplication, InteractionType, BrowserCacheLocation } from '@azure/msal-browser';
import { environment } from '../environments/environment';
import { AuthInterceptor } from './interceptors/auth.interceptor';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(withInterceptorsFromDi()),
    provideAnimationsAsync(),
    // HTTP Interceptors
    {
      provide: HTTP_INTERCEPTORS,
      useClass: AuthInterceptor,
      multi: true
    },
    // MSAL Angular module provider
    importProvidersFrom(
      MsalModule.forRoot(
        new PublicClientApplication({
          auth: {
            clientId: environment.azure.clientId,
            authority: environment.azure.authority,
            redirectUri: environment.azure.redirectUri,
            navigateToLoginRequestUrl: false
          },
          cache: {
            cacheLocation: BrowserCacheLocation.LocalStorage,
            storeAuthStateInCookie: false
          },
          system: {
            loggerOptions: {
              loggerCallback: (level, message, containsPii) => {
                if (containsPii) return;
                console.log(`MSAL [${level}]:`, message);
              },
              logLevel: 1,
              piiLoggingEnabled: false
            }
          }
        }),        {
          interactionType: InteractionType.Redirect,
          authRequest: {
            scopes: [
              ...environment.azure.scopes.basic,
              environment.azure.scopes.armUserImpersonation
            ]
          }
        },
        {
          interactionType: InteractionType.Redirect,
          protectedResourceMap: new Map()
        }
      )
    )
  ]
};
