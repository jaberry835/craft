import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadCloudProfile,
  resolveCloudProfile,
  toDefaultScope
} from "../src/cloud/profile.js";

const profilePath = resolve(process.cwd(), "cloud-profiles", "azurecloud.json");

describe("cloud profiles", () => {
  it("loads the Commercial test profile", async () => {
    const profile = await loadCloudProfile(profilePath);

    expect(profile.name).toBe("AzureCloud");
    expect(profile.resourceManagerEndpoint).not.toMatch(/\/$/);
    expect(toDefaultScope(profile.resourceManagerAudience)).toMatch(/\/\.default$/);
  });

  it("uses discovered endpoints while preserving explicit overrides", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          authentication: {
            loginEndpoint: "https://login.discovered.test/",
            audiences: ["https://management.discovered.test/"]
          },
          portal: "https://portal.discovered.test/",
          graph: "https://graph.discovered.test/",
          suffixes: {
            keyVaultDns: "vault.discovered.test"
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await resolveCloudProfile(
      profilePath,
      { portalUrl: "https://portal.override.test" },
      fetcher
    );

    expect(result.discovery.succeeded).toBe(true);
    expect(result.profile.authorityHost).toBe("https://login.discovered.test");
    expect(result.profile.resourceManagerAudience).toBe(
      "https://management.discovered.test"
    );
    expect(result.profile.portalUrl).toBe("https://portal.override.test");
    expect(result.profile.graphEndpoint).toBe("https://graph.microsoft.com");
    expect(result.profile.dnsSuffixes.keyVault).toBe("vault.discovered.test");
  });

  it("falls back to the file when discovery is unavailable", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));

    const result = await resolveCloudProfile(profilePath, {}, fetcher);

    expect(result.discovery).toMatchObject({
      attempted: true,
      succeeded: false,
      error: "offline"
    });
    expect(result.profile.name).toBe("AzureCloud");
  });
});
