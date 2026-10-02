import type { AccessToken, TokenCredential } from "@azure/core-auth";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ResourceGraphClient } from "../src/azure/resourceGraph.js";
import { loadCloudProfile } from "../src/cloud/profile.js";
import {
  collectNetworkEndpoints,
  collectNetworkInventory
} from "../src/collectors/network.js";

const subscriptionId = "11111111-1111-1111-1111-111111111111";

class FakeCredential implements TokenCredential {
  async getToken(_scopes: string | string[]): Promise<AccessToken> {
    return { token: "test", expiresOnTimestamp: Date.now() + 60_000 };
  }
}

describe("network collectors", () => {
  it("builds topology counts, endpoints, and NSG findings", async () => {
    const client = await clientWithRows([
      {
        id: "/vnet/one",
        name: "vnet-one",
        type: "microsoft.network/virtualnetworks",
        location: "eastus",
        resourceGroup: "rg-one",
        subscriptionId,
        properties: {
          subnets: [{ name: "one" }, { name: "two" }],
          virtualNetworkPeerings: [{ name: "peer" }]
        }
      },
      {
        id: "/nsg/one",
        name: "nsg-one",
        type: "microsoft.network/networksecuritygroups",
        location: "eastus",
        resourceGroup: "rg-one",
        subscriptionId,
        properties: {
          securityRules: [
            {
              name: "allow-rdp",
              properties: {
                direction: "Inbound",
                access: "Allow",
                sourceAddressPrefix: "Internet",
                destinationPortRange: "3389",
                priority: 100
              }
            }
          ]
        }
      },
      {
        id: "/pip/one",
        name: "pip-one",
        type: "microsoft.network/publicipaddresses",
        location: "eastus",
        resourceGroup: "rg-one",
        subscriptionId,
        properties: {
          ipAddress: "203.0.113.10",
          dnsSettings: { fqdn: "service.example.test" },
          ipConfiguration: { id: "/nic/configuration" }
        }
      },
      {
        id: "/pe/one",
        name: "pe-one",
        type: "microsoft.network/privateendpoints",
        location: "eastus",
        resourceGroup: "rg-one",
        subscriptionId,
        properties: {
          privateLinkServiceConnections: [
            { properties: { privateLinkServiceId: "/storage/one" } }
          ],
          customDnsConfigs: [
            {
              fqdn: "store.private.example.test",
              ipAddresses: ["10.0.0.4"]
            }
          ]
        }
      }
    ]);

    const inventory = await collectNetworkInventory(client, subscriptionId);

    expect(inventory.summary).toMatchObject({
      totalResources: 4,
      vnetCount: 1,
      subnetCount: 2,
      peeringCount: 1,
      nsgCount: 1,
      publicIpCount: 1,
      privateEndpointCount: 1,
      publicEndpointCount: 2,
      privateEndpointAddressCount: 2,
      highSeverityFindingCount: 1
    });
    expect(inventory.findings[0]?.checkId).toBe(
      "network.nsg.management-port-from-internet"
    );
    expect(inventory.endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "203.0.113.10", exposure: "public" }),
        expect.objectContaining({
          value: "store.private.example.test",
          exposure: "private",
          associatedResourceId: "/storage/one"
        })
      ])
    );
  });

  it("classifies public PaaS hostnames with ACLs as restricted", async () => {
    const client = await clientWithRows([
      {
        id: "/storage/one",
        name: "storage-one",
        type: "microsoft.storage/storageaccounts",
        location: "eastus",
        resourceGroup: "rg-one",
        subscriptionId,
        properties: {
          publicNetworkAccess: "Enabled",
          primaryEndpoints: {
            blob: "https://storage.blob.example.test/",
            file: "https://storage.file.example.test/"
          },
          networkAcls: { defaultAction: "Deny" }
        }
      }
    ]);

    const result = await collectNetworkEndpoints(client, subscriptionId);

    expect(result.endpoints).toEqual([
      expect.objectContaining({
        value: "storage.blob.example.test",
        exposure: "restricted"
      }),
      expect.objectContaining({
        value: "storage.file.example.test",
        exposure: "restricted"
      })
    ]);
  });
});

async function clientWithRows(
  data: Array<Record<string, unknown>>
): Promise<ResourceGraphClient> {
  const cloud = await loadCloudProfile(
    resolve(process.cwd(), "cloud-profiles", "azurecloud.json")
  );
  return new ResourceGraphClient({
    credential: new FakeCredential(),
    cloud,
    apiVersion: "2022-10-01",
    maxRetries: 0,
    fetcher: vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          totalRecords: data.length,
          count: data.length,
          resultTruncated: false,
          data
        }),
        { status: 200 }
      )
    )
  });
}
