import type { AccessToken, TokenCredential } from "@azure/core-auth";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listSubscriptions } from "../src/azure/subscriptions.js";
import { loadCloudProfile } from "../src/cloud/profile.js";

const profilePath = resolve(process.cwd(), "cloud-profiles", "azurecloud.json");

class FakeCredential implements TokenCredential {
  public readonly scopes: Array<string | string[]> = [];

  async getToken(scopes: string | string[]): Promise<AccessToken> {
    this.scopes.push(scopes);
    return { token: "test-token", expiresOnTimestamp: Date.now() + 60_000 };
  }
}

describe("listSubscriptions", () => {
  it("authenticates, follows same-origin pages, and normalizes results", async () => {
    const cloud = await loadCloudProfile(profilePath);
    const credential = new FakeCredential();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                subscriptionId: "sub-1",
                displayName: "One",
                state: "Enabled",
                tenantId: "tenant-1"
              }
            ],
            nextLink: `${cloud.resourceManagerEndpoint}/subscriptions?page=2`
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [{ subscriptionId: "sub-2", state: "Disabled" }]
          }),
          { status: 200 }
        )
      );

    const result = await listSubscriptions({
      credential,
      cloud,
      apiVersion: "test-version",
      fetcher
    });

    expect(credential.scopes).toEqual([`${cloud.resourceManagerAudience}/.default`]);
    expect(result).toEqual([
      {
        subscriptionId: "sub-1",
        displayName: "One",
        state: "Enabled",
        tenantId: "tenant-1"
      },
      {
        subscriptionId: "sub-2",
        displayName: "sub-2",
        state: "Disabled",
        tenantId: null
      }
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer test-token"
    });
  });

  it("refuses to send the Azure token to a cross-origin nextLink", async () => {
    const cloud = await loadCloudProfile(profilePath);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          value: [],
          nextLink: "https://malicious.example.test/steal-token"
        }),
        { status: 200 }
      )
    );

    await expect(
      listSubscriptions({
        credential: new FakeCredential(),
        cloud,
        apiVersion: "test-version",
        fetcher
      })
    ).rejects.toThrow("outside the Resource Manager endpoint");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
