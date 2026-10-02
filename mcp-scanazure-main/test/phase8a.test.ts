import type { AccessToken, TokenCredential } from "@azure/core-auth";
import { describe, expect, it, vi } from "vitest";
import type { ResourceGraphClient } from "../src/azure/resourceGraph.js";
import type { CloudProfile } from "../src/cloud/profile.js";
import { collectIdentityPosture } from "../src/collectors/identity.js";
import { collectKeyVaultItemMetadata } from "../src/collectors/keyVaultMetadata.js";

const subscriptionId = "11111111-1111-1111-1111-111111111111";
const cloud: CloudProfile = {
  name: "AirGap",
  resourceManagerEndpoint: "https://management.example.invalid",
  resourceManagerAudience: "https://management.example.invalid",
  authorityHost: "https://login.example.invalid",
  portalUrl: "https://portal.example.invalid",
  graphEndpoint: "https://graph.example.invalid",
  keyVaultAudience: "https://vault.example.invalid",
  dnsSuffixes: { keyVault: "vault.example.invalid" }
};

class Credential implements TokenCredential {
  readonly getToken = vi.fn(async (_scope: string | string[]): Promise<AccessToken> => ({
    token: "test-token",
    expiresOnTimestamp: Date.now() + 60_000
  }));
}

describe("Phase 8a collectors", () => {
  it("runs Graph checks independently and preserves denied semantics", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("$skiptoken=two")) return json({ value: [] });
      if (url.includes("conditionalAccess")) {
        return json({
          value: [{
            id: "ca-one",
            state: "enabled",
            grantControls: { operator: "OR", builtInControls: ["mfa"] },
            conditions: { clientAppTypes: ["browser"] }
          }],
          "@odata.nextLink": "https://graph.example.invalid/v1.0/identity/conditionalAccess/policies?$skiptoken=two"
        });
      }
      if (url.includes("userRegistrationDetails")) return json({}, 403);
      if (url.includes("identitySecurityDefaults")) return json({ isEnabled: true });
      return json({ value: [] });
    });

    const result = await collectIdentityPosture(new Credential(), cloud, fetcher as typeof fetch);

    expect(result.checks).toHaveLength(7);
    expect(result.checks.find((item) => item.id === "conditionalAccess")).toMatchObject({
      status: "available",
      summary: { enabled: 1, requireMfa: 1 }
    });
    expect(result.checks.find((item) => item.id === "mfaRegistration")).toMatchObject({
      status: "denied",
      requiredPermissions: ["AuditLog.Read.All"]
    });
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "https://graph.example.invalid" }),
      expect.anything()
    );
  });

  it("returns unavailable checks when Graph is not configured", async () => {
    const result = await collectIdentityPosture(
      new Credential(),
      { ...cloud, graphEndpoint: undefined }
    );
    expect(result.checks.every((item) => item.status === "unavailable")).toBe(true);
  });

  it("collects only Key Vault metadata and reports each denied vault check", async () => {
    const graph = {
      queryAll: vi.fn(async () => ({
        complete: true,
        incompleteReason: null,
        data: [{
          id: `/subscriptions/${subscriptionId}/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/vault-one`,
          name: "vault-one",
          properties: { vaultUri: "https://vault-one.vault.example.invalid/" }
        }]
      }))
    } as unknown as ResourceGraphClient;
    const requested: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/secrets?")) {
        return json({
          value: [{
            id: "https://vault-one.vault.example.invalid/secrets/secret-one",
            contentType: "text/plain",
            attributes: { enabled: true, exp: 2_000_000_000, created: 1_700_000_000 },
            tags: { owner: "security" }
          }]
        });
      }
      if (url.includes("/keys?")) {
        return json({
          value: [{
            kid: "https://vault-one.vault.example.invalid/keys/key-one",
            kty: "RSA",
            key_ops: ["sign"],
            attributes: { enabled: true, exp: 2_000_000_000 }
          }]
        });
      }
      if (url.includes("/rotationpolicy?")) {
        return json({ lifetimeActions: [{ trigger: { timeAfterCreate: "P30D" } }] });
      }
      if (url.includes("/certificates?")) {
        return json({
          value: [{
            id: "https://vault-one.vault.example.invalid/certificates/cert-one",
            attributes: { enabled: true, exp: 2_000_000_000 }
          }]
        });
      }
      if (url.includes("/certificates/cert-one/policy?")) {
        return json({
          issuer: { name: "Self" },
          x509_props: {
            subject: "CN=example.test",
            validity_months: 12,
            key_usage: ["digitalSignature"]
          },
          lifetime_actions: [{
            trigger: { lifetime_percentage: 80 },
            action: { action_type: "AutoRenew" }
          }]
        });
      }
      return json({}, 403);
    });

    const result = await collectKeyVaultItemMetadata(
      graph,
      new Credential(),
      cloud,
      subscriptionId,
      { fetcher: fetcher as typeof fetch }
    );

    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        itemType: "secret",
        name: "secret-one",
        contentType: "text/plain"
      }),
      expect.objectContaining({
        itemType: "key",
        name: "key-one",
        keyType: "RSA",
        rotationPolicyStatus: "available"
      }),
      expect.objectContaining({
        itemType: "certificate",
        name: "cert-one",
        certificatePolicyStatus: "available",
        certificatePolicy: expect.objectContaining({
          issuer: "Self",
          subject: "CN=example.test",
          validityInMonths: 12
        })
      })
    ]));
    expect(result.checks.find((item) => item.itemType === "certificate")?.status).toBe("available");
    expect(requested.some((url) => /\/secrets\/[^?]+/.test(url))).toBe(false);
    expect(requested.some((url) => /\/keys\/key-one\?(?!.*rotationpolicy)/.test(url))).toBe(false);
    expect(requested.some((url) => /\/certificates\/cert-one\?(?!.*policy)/.test(url))).toBe(false);
  });

  it("rejects a vault URI outside the configured DNS suffix without fetching it", async () => {
    const graph = {
      queryAll: vi.fn(async () => ({
        complete: true,
        incompleteReason: null,
        data: [{
          id: `/subscriptions/${subscriptionId}/providers/Microsoft.KeyVault/vaults/bad`,
          name: "bad",
          properties: { vaultUri: "https://attacker.example.test/" }
        }]
      }))
    } as unknown as ResourceGraphClient;
    const fetcher = vi.fn();

    const result = await collectKeyVaultItemMetadata(
      graph,
      new Credential(),
      cloud,
      subscriptionId,
      { fetcher: fetcher as typeof fetch }
    );

    expect(result.checks.every((item) => item.status === "unavailable")).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports partial access when metadata is visible but rotation policy is denied", async () => {
    const graph = {
      queryAll: vi.fn(async () => ({
        complete: true,
        incompleteReason: null,
        data: [{
          id: `/subscriptions/${subscriptionId}/providers/Microsoft.KeyVault/vaults/vault-one`,
          name: "vault-one",
          properties: { vaultUri: "https://vault-one.vault.example.invalid/" }
        }]
      }))
    } as unknown as ResourceGraphClient;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/keys?")) {
        return json({
          value: [{
            kid: "https://vault-one.vault.example.invalid/keys/key-one",
            attributes: { enabled: true }
          }]
        });
      }
      if (url.includes("/rotationpolicy?")) return json({}, 403);
      return json({ value: [] });
    });

    const result = await collectKeyVaultItemMetadata(
      graph,
      new Credential(),
      cloud,
      subscriptionId,
      { fetcher: fetcher as typeof fetch }
    );

    expect(result.checks.find((item) => item.itemType === "key")?.status).toBe("partial");
    expect(result.items.find((item) => item.itemType === "key")).toMatchObject({
      name: "key-one",
      rotationPolicyStatus: "denied"
    });
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
