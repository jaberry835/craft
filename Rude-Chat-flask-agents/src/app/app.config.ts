import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection, importProvidersFrom } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { MsalModule, MsalRedirectComponent } from '@azure/msal-angular';
import { PublicClientApplication, InteractionType, BrowserCacheLocation } from '@azure/msal-browser';
import { environment } from '../environments/environment';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(withInterceptorsFromDi()),
    provideAnimationsAsync(),
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
              'openid', 
              'profile', 
              'email',
              'https://management.usgovcloudapi.net/user_impersonation'
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
