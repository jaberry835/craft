import type { AccessToken, TokenCredential } from "@azure/core-auth";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ResourceGraphClient } from "../src/azure/resourceGraph.js";
import { loadCloudProfile } from "../src/cloud/profile.js";

const subscriptionId = "11111111-1111-1111-1111-111111111111";

class FakeCredential implements TokenCredential {
  async getToken(_scopes: string | string[]): Promise<AccessToken> {
    return { token: "arg-token", expiresOnTimestamp: Date.now() + 60_000 };
  }
}

describe("ResourceGraphClient", () => {
  it("sends object-array queries and continuation tokens", async () => {
    const cloud = await loadCloudProfile(
      resolve(process.cwd(), "cloud-profiles", "azurecloud.json")
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          totalRecords: 2,
          count: 1,
          resultTruncated: false,
          "$skipToken": "next-page",
          data: [{ id: "resource-1" }]
        }),
        { status: 200 }
      )
    );
    const client = new ResourceGraphClient({
      credential: new FakeCredential(),
      cloud,
      apiVersion: "2022-10-01",
      maxRetries: 0,
      fetcher
    });

    const result = await client.query<{ id: string }>({
      subscriptions: [subscriptionId],
      query: "Resources | project id | order by id asc",
      pageSize: 1,
      skipToken: "current-page"
    });

    expect(result).toMatchObject({
      data: [{ id: "resource-1" }],
      totalRecords: 2,
      nextPageToken: "next-page"
    });
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      options: Record<string, unknown>;
    };
    expect(request.options).toEqual({
      "$top": 1,
      "$skipToken": "current-page",
      resultFormat: "objectArray",
      allowPartialScopes: true
    });
  });

  it("retries throttled responses using Retry-After", async () => {
    const cloud = await loadCloudProfile(
      resolve(process.cwd(), "cloud-profiles", "azurecloud.json")
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "TooManyRequests" } }), {
          status: 429,
          headers: { "Retry-After": "0" }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ totalRecords: 0, count: 0, data: [] }),
          { status: 200 }
        )
      );
    const sleep = vi.fn(async () => undefined);
    const client = new ResourceGraphClient({
      credential: new FakeCredential(),
      cloud,
      apiVersion: "2022-10-01",
      maxRetries: 1,
      fetcher,
      sleep
    });

    await client.query({
      subscriptions: [subscriptionId],
      query: "Resources | project id | order by id asc"
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it("reports truncation when Azure cannot return a skip token", async () => {
    const cloud = await loadCloudProfile(
      resolve(process.cwd(), "cloud-profiles", "azurecloud.json")
    );
    const client = new ResourceGraphClient({
      credential: new FakeCredential(),
      cloud,
      apiVersion: "2022-10-01",
      maxRetries: 0,
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            totalRecords: 20,
            count: 10,
            resultTruncated: true,
            data: [{ id: "resource-1" }]
          }),
          { status: 200 }
        )
      )
    });

    const result = await client.query({
      subscriptions: [subscriptionId],
      query: "Resources | take 10"
    });

    expect(result.nextPageToken).toBeNull();
    expect(result.incompleteReason).toContain("truncated");
  });

  it("rejects malformed subscription IDs before sending a request", async () => {
    const cloud = await loadCloudProfile(
      resolve(process.cwd(), "cloud-profiles", "azurecloud.json")
    );
    const fetcher = vi.fn<typeof fetch>();
    const client = new ResourceGraphClient({
      credential: new FakeCredential(),
      cloud,
      apiVersion: "2022-10-01",
      maxRetries: 0,
      fetcher
    });

    await expect(
      client.query({ subscriptions: ["not-a-guid"], query: "Resources" })
    ).rejects.toThrow("Invalid subscription ID");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
