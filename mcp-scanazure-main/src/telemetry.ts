import { useAzureMonitor } from "@azure/monitor-opentelemetry";
import { ManagedIdentityCredential } from "@azure/identity";

if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  const clientId = process.env.MANAGED_IDENTITY_CLIENT_ID;
  useAzureMonitor({
    azureMonitorExporterOptions: {
      ...(clientId
        ? { credential: new ManagedIdentityCredential({ clientId }) }
        : {})
    }
  });
}
