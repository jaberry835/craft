import type { TokenCredential } from "@azure/core-auth";
import { toDefaultScope, type CloudProfile } from "./profile.js";

export interface CapabilityStatus {
  status: "available" | "unavailable" | "unknown";
  detail: string;
}

export interface CloudCapabilities {
  resourceManager: CapabilityStatus;
  resourceGraphProvider: CapabilityStatus;
}

export async function probeCloudCapabilities(
  credential: TokenCredential,
  cloud: CloudProfile,
  fetcher: typeof fetch = fetch
): Promise<CloudCapabilities> {
  try {
    const token = await credential.getToken(toDefaultScope(cloud.resourceManagerAudience));
    if (!token) {
      return unavailable("Azure credential returned no access token");
    }

    const endpoint = new URL(
      "/providers/Microsoft.ResourceGraph",
      `${cloud.resourceManagerEndpoint}/`
    );
    endpoint.searchParams.set("api-version", "2021-04-01");
    const response = await fetcher(endpoint, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token.token}`
      },
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      return {
        resourceManager: {
          status: response.status === 401 || response.status === 403 ? "unavailable" : "available",
          detail: `Resource Manager returned HTTP ${response.status}`
        },
        resourceGraphProvider: {
          status: "unavailable",
          detail: `Provider probe returned HTTP ${response.status}`
        }
      };
    }

    const body = (await response.json()) as {
      namespace?: string;
      registrationState?: string;
    };
    return {
      resourceManager: { status: "available", detail: "Authenticated ARM request succeeded" },
      resourceGraphProvider: {
        status: body.namespace === "Microsoft.ResourceGraph" ? "available" : "unknown",
        detail: body.registrationState
          ? `Provider registration state: ${body.registrationState}`
          : "Resource Graph provider metadata is available"
      }
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

function unavailable(detail: string): CloudCapabilities {
  return {
    resourceManager: { status: "unavailable", detail },
    resourceGraphProvider: { status: "unknown", detail: "ARM access is unavailable" }
  };
}
