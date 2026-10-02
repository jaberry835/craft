import type { AccessToken, TokenCredential } from "@azure/core-auth";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  EntraRequestAuthenticator,
  protectedResourceMetadata
} from "../src/auth/entra.js";
import { loadCloudProfile, type CloudProfile } from "../src/cloud/profile.js";
import { loadConfig } from "../src/config.js";

let cloud: CloudProfile;

beforeAll(async () => {
  cloud = await loadCloudProfile(
    resolve(process.cwd(), "cloud-profiles", "azurecloud.json")
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Entra request authentication", () => {
  it("validates tenant, caller, and authorized client claims", async () => {
    const authenticator = new EntraRequestAuthenticator(oboConfig(), cloud, {
      verifyToken: async (_token, audience) => {
        expect(audience).toBe("server-client");
        return {
          tid: "tenant-one",
          oid: "object-one",
          azp: "spa-client",
          ver: "2.0",
          exp: Math.floor(Date.now() / 1_000) + 3_600
        };
      }
    });

    const result = await authenticator.authenticateAuthorizationHeader(
      "Bearer inbound-token"
    );

    expect(result.caller).toMatchObject({
      key: "entra:tenant-one:object-one",
      tenantId: "tenant-one",
      objectId: "object-one",
      authMode: "obo"
    });
  });

  it("rejects missing bearer tokens and unapproved client applications", async () => {
    const authenticator = new EntraRequestAuthenticator(oboConfig(), cloud, {
      verifyToken: async () => ({
        tid: "tenant-one",
        oid: "object-one",
        azp: "unapproved-client",
        ver: "2.0",
        exp: Math.floor(Date.now() / 1_000) + 3_600
      })
    });

    await expect(
      authenticator.authenticateAuthorizationHeader(undefined)
    ).rejects.toBeInstanceOf(AuthenticationError);
    await expect(
      authenticator.authenticateAuthorizationHeader("Bearer inbound-token")
    ).rejects.toThrow("client application is not allowed");
  });

  it("exchanges and caches an OBO token without exposing the client secret", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:jwt-bearer"
      );
      expect(body.get("requested_token_use")).toBe("on_behalf_of");
      expect(body.get("assertion")).toBe("inbound-token");
      expect(body.get("client_secret")).toBe("test-secret");
      expect(body.get("scope")).toBe("https://management.azure.com/.default");
      return new Response(
        JSON.stringify({ access_token: "arm-token", expires_in: 3_600 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const authenticator = new EntraRequestAuthenticator(oboConfig(), cloud, {
      verifyToken: validClaims
    });
    const authenticated = await authenticator.authenticateAuthorizationHeader(
      "Bearer inbound-token"
    );

    const first = await authenticated.credential.getToken(
      "https://management.azure.com/.default"
    );
    const second = await authenticated.credential.getToken(
      "https://management.azure.com/.default"
    );

    expect(first?.token).toBe("arm-token");
    expect(second?.token).toBe("arm-token");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses a managed identity token as the federated client assertion", async () => {
    const assertionCredential: TokenCredential = {
      async getToken(scope): Promise<AccessToken> {
        expect(scope).toBe("api://AzureADTokenExchange/.default");
        return {
          token: "managed-identity-assertion",
          expiresOnTimestamp: Date.now() + 60_000
        };
      }
    };
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_assertion")).toBe("managed-identity-assertion");
      expect(body.get("client_secret")).toBeNull();
      return new Response(
        JSON.stringify({ access_token: "arm-token", expires_in: 3_600 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const config = oboConfig({ ENTRA_CLIENT_SECRET: undefined });
    const authenticator = new EntraRequestAuthenticator(config, cloud, {
      verifyToken: validClaims,
      clientAssertionCredential: assertionCredential
    });
    const authenticated = await authenticator.authenticateAuthorizationHeader(
      "Bearer inbound-token"
    );

    await authenticated.credential.getToken(
      "https://management.azure.com/.default"
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("publishes OAuth protected-resource metadata for the configured cloud", () => {
    expect(protectedResourceMetadata(oboConfig(), cloud)).toEqual({
      resource: "https://scanner.example.test",
      authorization_servers: [
        "https://login.microsoftonline.com/tenant-one/v2.0"
      ],
      bearer_methods_supported: ["header"],
      scopes_supported: ["api://server-client/access_as_user"]
    });
  });
});

function oboConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    AUTH_MODE: "obo",
    AZURE_TENANT_ID: "tenant-one",
    ENTRA_SERVER_CLIENT_ID: "server-client",
    ENTRA_ALLOWED_CLIENT_IDS: "spa-client",
    ENTRA_CLIENT_SECRET: "test-secret",
    ENTRA_RESOURCE_URI: "https://scanner.example.test",
    ...overrides
  });
}

async function validClaims() {
  return {
    tid: "tenant-one",
    oid: "object-one",
    azp: "spa-client",
    ver: "2.0",
    exp: Math.floor(Date.now() / 1_000) + 3_600
  };
}
