import type { AccessToken, TokenCredential } from "@azure/core-auth";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { probeCloudCapabilities } from "../src/cloud/capabilities.js";
import { loadCloudProfile } from "../src/cloud/profile.js";

class FakeCredential implements TokenCredential {
  async getToken(_scopes: string | string[]): Promise<AccessToken> {
    return { token: "test-token", expiresOnTimestamp: Date.now() + 60_000 };
  }
}

describe("probeCloudCapabilities", () => {
  it("detects the Resource Graph provider", async () => {
    const cloud = await loadCloudProfile(
      resolve(process.cwd(), "cloud-profiles", "azurecloud.json")
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          namespace: "Microsoft.ResourceGraph",
          registrationState: "Registered"
        }),
        { status: 200 }
      )
    );

    const capabilities = await probeCloudCapabilities(
      new FakeCredential(),
      cloud,
      fetcher
    );

    expect(capabilities).toEqual({
      resourceManager: {
        status: "available",
        detail: "Authenticated ARM request succeeded"
      },
      resourceGraphProvider: {
        status: "available",
        detail: "Provider registration state: Registered"
      }
    });
  });

  it("degrades without preventing startup", async () => {
    const cloud = await loadCloudProfile(
      resolve(process.cwd(), "cloud-profiles", "azurecloud.json")
    );
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("air gap offline"));

    const capabilities = await probeCloudCapabilities(
      new FakeCredential(),
      cloud,
      fetcher
    );

    expect(capabilities.resourceManager).toEqual({
      status: "unavailable",
      detail: "air gap offline"
    });
    expect(capabilities.resourceGraphProvider.status).toBe("unknown");
  });
});
