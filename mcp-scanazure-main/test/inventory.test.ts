import type { AccessToken, TokenCredential } from "@azure/core-auth";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ResourceGraphClient } from "../src/azure/resourceGraph.js";
import { loadCloudProfile } from "../src/cloud/profile.js";
import {
  getResourceConfiguration,
  inventoryResources,
  listResourceGroups
} from "../src/collectors/inventory.js";

const subscriptionId = "11111111-1111-1111-1111-111111111111";

class FakeCredential implements TokenCredential {
  async getToken(_scopes: string | string[]): Promise<AccessToken> {
    return { token: "test", expiresOnTimestamp: Date.now() + 60_000 };
  }
}

describe("inventory collectors", () => {
  it("lists resource groups with Resource Graph paging", async () => {
    const client = await clientWithFetcher(
      vi.fn<typeof fetch>().mockResolvedValue(
        graphResponse([
          {
            id: `/subscriptions/${subscriptionId}/resourceGroups/rg-one`,
            name: "rg-one",
            location: "eastus",
            subscriptionId,
            tags: {},
            provisioningState: "Succeeded"
          }
        ])
      )
    );

    const result = await listResourceGroups(client, subscriptionId, 100);

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.name).toBe("rg-one");
  });

  it("returns a filtered inventory and complete summaries", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("| summarize")) {
        const key = body.query.includes("tolower(type)")
          ? "microsoft.storage/storageaccounts"
          : body.query.includes("tostring(location)")
            ? "eastus"
            : "rg-one";
        return graphResponse([{ key, count: 1 }]);
      }
      return graphResponse([
        {
          id: `/subscriptions/${subscriptionId}/resourceGroups/rg-one/providers/Microsoft.Storage/storageAccounts/storeone`,
          name: "storeone",
          type: "microsoft.storage/storageaccounts",
          location: "eastus",
          resourceGroup: "rg-one",
          subscriptionId,
          tags: {},
          publicNetworkAccess: "Disabled",
          allowSharedKeyAccess: 1
        }
      ]);
    });
    const client = await clientWithFetcher(fetcher);

    const result = await inventoryResources(
      client,
      subscriptionId,
      { resourceGroup: "rg'one" },
      100
    );

    expect(result.data[0]).toMatchObject({
      name: "storeone",
      category: "storage",
      allowSharedKeyAccess: true
    });
    expect(result.summary).toMatchObject({
      total: 1,
      byType: { "microsoft.storage/storageaccounts": 1 },
      byLocation: { eastus: 1 },
      byResourceGroup: { "rg-one": 1 },
      complete: true
    });
    const requestBodies = fetcher.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)) as { query: string }
    );
    expect(requestBodies.every((body) => body.query.includes("rg''one"))).toBe(true);
  });

  it("returns redacted configuration with generic findings", async () => {
    const resourceId = `/subscriptions/${subscriptionId}/resourceGroups/rg-one/providers/Microsoft.Storage/storageAccounts/storeone`;
    const client = await clientWithFetcher(
      vi.fn<typeof fetch>().mockResolvedValue(
        graphResponse([
          {
            id: resourceId,
            name: "storeone",
            type: "microsoft.storage/storageaccounts",
            location: "eastus",
            resourceGroup: "rg-one",
            subscriptionId,
            tags: {},
            properties: {
              publicNetworkAccess: "Enabled",
              minimumTlsVersion: "TLS1_0",
              allowSharedKeyAccess: true,
              connectionString: "must-not-leak"
            }
          }
        ])
      )
    );

    const result = await getResourceConfiguration(client, resourceId);

    expect(result).not.toBeNull();
    expect(
      (result?.resource.properties as Record<string, unknown>).connectionString
    ).toBe("[REDACTED]");
    expect(result?.findings.some((finding) => finding.status === "fail")).toBe(true);
  });
});

async function clientWithFetcher(fetcher: typeof fetch): Promise<ResourceGraphClient> {
  const cloud = await loadCloudProfile(
    resolve(process.cwd(), "cloud-profiles", "azurecloud.json")
  );
  return new ResourceGraphClient({
    credential: new FakeCredential(),
    cloud,
    apiVersion: "2022-10-01",
    maxRetries: 0,
    fetcher
  });
}

function graphResponse(data: Array<Record<string, unknown>>): Response {
  return new Response(
    JSON.stringify({
      totalRecords: data.length,
      count: data.length,
      resultTruncated: false,
      data
    }),
    { status: 200 }
  );
}
