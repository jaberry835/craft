import { Injectable } from "@angular/core";
import { ApplicationInsights } from "@microsoft/applicationinsights-web";
import { environment } from "../environments/environment";
import { MsalService } from "@azure/msal-angular";
@Injectable({
  providedIn: "root",
})

export class AppInsightsService {

  export class AppInsightsService {
    private appInsights: ApplicationInsights;
  
    constructor(private authService: MsalService) {
      this.appInsights = new ApplicationInsights({
        config: {
          instrumentationKey: environment.insightsKey, // Replace with your Azure App Insights key
        },
      });
      this.appInsights.loadAppInsights();
    }
  
    logCustomEvent(eventName: string, properties?: { [key: string]: any }) {
      const account = this.authService.instance.getAllAccounts()[0];
      const name = account.username;
      
      this.appInsights.setAuthenticatedUserContext(name, account.idTokenClaims?.upn || name, true);
      this.appInsights.trackEvent({ name: eventName, properties });
    }