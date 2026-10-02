import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults unauthenticated mode to loopback", () => {
    const config = loadConfig({});

    expect(config.authMode).toBe("none");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3001);
  });

  it("rejects an unauthenticated non-loopback listener without an override", () => {
    expect(() => loadConfig({ AUTH_MODE: "none", HOST: "0.0.0.0" })).toThrow(
      "ALLOW_UNAUTHENTICATED_REMOTE"
    );
  });

  it("blocks development authentication modes on App Service", () => {
    expect(() =>
      loadConfig({
        AUTH_MODE: "none",
        WEBSITE_SITE_NAME: "scanner-app"
      })
    ).toThrow("blocked on App Service");
    expect(() =>
      loadConfig({
        AUTH_MODE: "arm-token",
        WEBSITE_SITE_NAME: "scanner-app",
        AZURE_TENANT_ID: "tenant-one",
        ENTRA_SERVER_CLIENT_ID: "server-one",
        ENTRA_ALLOWED_CLIENT_IDS: "spa-one",
        ENTRA_RESOURCE_URI: "https://scanner.example.test"
      })
    ).toThrow("development mode");
  });

  it("parses the CORS origin allow-list", () => {
    const config = loadConfig({
      CORS_ALLOWED_ORIGINS: "https://app.example.test, https://second.example.test"
    });

    expect(config.corsAllowedOrigins).toEqual(
      new Set(["https://app.example.test", "https://second.example.test"])
    );
  });

  it("parses configurable NIST detection and portal link settings", () => {
    const config = loadConfig({
      NIST_INITIATIVE_IDS: "initiative-one,initiative-two",
      NIST_NAME_PATTERNS: "NIST Custom R5,NIST Air Gap",
      PORTAL_DEFENDER_REGULATORY_PATH: "/custom/defender",
      PORTAL_POLICY_COMPLIANCE_PATH_TEMPLATE: "/custom/policy/{assignmentId}"
    });

    expect(config.nistInitiativeIds).toEqual(
      new Set(["initiative-one", "initiative-two"])
    );
    expect(config.nistNamePatterns).toEqual(["NIST Custom R5", "NIST Air Gap"]);
    expect(config.portalLinkTemplates).toMatchObject({
      defenderRegulatory: "/custom/defender",
      policyCompliance: "/custom/policy/{assignmentId}"
    });
  });

  it("parses bounded in-memory scan settings", () => {
    const config = loadConfig({
      SCAN_CACHE_TTL_MINUTES: "15",
      SCAN_MAX_SCANS: "12",
      SCAN_MAX_SCANS_PER_CALLER: "3",
      SCAN_MAX_MEMORY_MB: "64",
      SCAN_CONCURRENCY: "2"
    });

    expect(config.scan).toEqual({
      ttlMilliseconds: 15 * 60_000,
      maximumScans: 12,
      maximumScansPerCaller: 3,
      maximumBytes: 64 * 1_024 * 1_024,
      concurrency: 2
    });
  });

  it("parses MCP rate limits", () => {
    const config = loadConfig({
      MCP_RATE_LIMIT_WINDOW_SECONDS: "30",
      MCP_RATE_LIMIT_MAX_REQUESTS: "50"
    });

    expect(config.rateLimit).toEqual({
      windowMilliseconds: 30_000,
      maximumRequests: 50
    });
  });

  it("requires complete single-tenant Entra settings in authenticated modes", () => {
    expect(() => loadConfig({ AUTH_MODE: "obo" })).toThrow("AZURE_TENANT_ID");
    expect(() =>
      loadConfig({
        AUTH_MODE: "obo",
        AZURE_TENANT_ID: "tenant-one"
      })
    ).toThrow("ENTRA_SERVER_CLIENT_ID");
    expect(() =>
      loadConfig({
        AUTH_MODE: "obo",
        AZURE_TENANT_ID: "tenant-one",
        ENTRA_SERVER_CLIENT_ID: "server-one"
      })
    ).toThrow("ENTRA_ALLOWED_CLIENT_IDS");
  });

  it("parses authenticated Entra settings and defaults to a remote listener", () => {
    const config = loadConfig({
      AUTH_MODE: "obo",
      AZURE_TENANT_ID: "tenant-one",
      ENTRA_SERVER_CLIENT_ID: "server-one",
      ENTRA_ALLOWED_CLIENT_IDS: "spa-one,SPA-TWO",
      ENTRA_RESOURCE_URI: "https://scanner.example.test"
    });

    expect(config.host).toBe("0.0.0.0");
    expect(config.entra).toMatchObject({
      serverClientId: "server-one",
      allowedClientIds: new Set(["spa-one", "spa-two"]),
      resourceUri: "https://scanner.example.test"
    });
  });
});
