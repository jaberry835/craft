import "./telemetry.js";
import { createCredential } from "./auth/credentialFactory.js";
import { probeCloudCapabilities } from "./cloud/capabilities.js";
import { resolveCloudProfile } from "./cloud/profile.js";
import { loadConfig } from "./config.js";
import { createApplication } from "./server.js";
import type { CloudCapabilities } from "./cloud/capabilities.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const resolvedCloud = await resolveCloudProfile(
    config.cloudProfilePath,
    config.cloudOverrides
  );
  const credential =
    config.authMode === "none"
      ? createCredential(config, resolvedCloud.profile)
      : undefined;
  const capabilities: CloudCapabilities = credential
    ? await probeCloudCapabilities(credential, resolvedCloud.profile)
    : {
        resourceManager: {
          status: "unknown",
          detail: "Capability is evaluated with each authenticated caller"
        },
        resourceGraphProvider: {
          status: "unknown",
          detail: "Capability is evaluated with each authenticated caller"
        }
      };
  const app = createApplication({
    config,
    resolvedCloud,
    capabilities,
    ...(credential ? { credential } : {})
  });

  if (config.authMode === "none") {
    console.warn(
      "WARNING: AUTH_MODE=none is enabled. Requests are unauthenticated and use DefaultAzureCredential."
    );
  }
  if (!resolvedCloud.discovery.succeeded) {
    console.warn(
      `Cloud endpoint discovery failed; using the configured profile: ${resolvedCloud.discovery.error ?? "unknown error"}`
    );
  }
  if (capabilities.resourceManager.status !== "available") {
    console.warn(`Azure capability probe did not succeed: ${capabilities.resourceManager.detail}`);
  }

  app.listen(config.port, config.host, () => {
    console.log(
      `mcp-scanazure listening on http://${config.host}:${config.port} for ${resolvedCloud.profile.name}`
    );
  });
}

main().catch((error: unknown) => {
  console.error("Server startup failed", error);
  process.exitCode = 1;
});
