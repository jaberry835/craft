import type { AccessToken, TokenCredential } from "@azure/core-auth";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArmReadClient } from "../src/azure/arm.js";
import { loadCloudProfile } from "../src/cloud/profile.js";

class FakeCredential implements TokenCredential {
  async getToken(_scopes: string | string[]): Promise<AccessToken> {
    return { token: "test-token", expiresOnTimestamp: Date.now() + 60_000 };
  }
}

describe("ArmReadClient", () => {
  it("performs an authenticated same-cloud GET", async () => {
    const cloud = await loadCloudProfile(
      resolve(process.cwd(), "cloud-profiles", "azurecloud.json")
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ properties: { minTlsVersion: "1.2" } }), {
        status: 200
      })
    );
    const client = new ArmReadClient(new FakeCredential(), cloud, fetcher);

    const result = await client.get(
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg/providers/Microsoft.Web/sites/app/config/web",
      "2023-12-01"
    );

    expect(result).toMatchObject({ properties: { minTlsVersion: "1.2" } });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer test-token"
    });
  });

  it("rejects secret-bearing ARM paths", async () => {
    const cloud = await loadCloudProfile(
      resolve(process.cwd(), "cloud-profiles", "azurecloud.json")
    );
    const fetcher = vi.fn<typeof fetch>();
    const client = new ArmReadClient(new FakeCredential(), cloud, fetcher);

    await expect(
      client.get(
        "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg/providers/Microsoft.Web/sites/app/config/appsettings",
        "2023-12-01"
      )
    ).rejects.toThrow("may expose secrets");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
