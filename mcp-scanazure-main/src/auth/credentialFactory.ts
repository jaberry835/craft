import type { TokenCredential } from "@azure/core-auth";
import { DefaultAzureCredential } from "@azure/identity";
import type { CloudProfile } from "../cloud/profile.js";
import type { AppConfig } from "../config.js";

export function createCredential(config: AppConfig, profile: CloudProfile): TokenCredential {
  if (config.authMode !== "none") {
    throw new Error("The process credential is only available when AUTH_MODE=none");
  }

  return new DefaultAzureCredential({
    authorityHost: profile.authorityHost,
    ...(config.tenantId ? { tenantId: config.tenantId } : {}),
    ...(config.managedIdentityClientId
      ? { managedIdentityClientId: config.managedIdentityClientId }
      : {})
  });
}
