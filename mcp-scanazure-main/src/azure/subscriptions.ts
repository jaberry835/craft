import type { TokenCredential } from "@azure/core-auth";
import { toDefaultScope, type CloudProfile } from "../cloud/profile.js";

export interface AzureSubscription {
  subscriptionId: string;
  displayName: string;
  state: string;
  tenantId: string | null;
}

interface SubscriptionListResponse {
  value?: Array<{
    subscriptionId?: string;
    displayName?: string;
    state?: string;
    tenantId?: string;
  }>;
  nextLink?: string;
}

export interface ListSubscriptionsOptions {
  credential: TokenCredential;
  cloud: CloudProfile;
  apiVersion: string;
  fetcher?: typeof fetch;
}

export async function listSubscriptions(
  options: ListSubscriptionsOptions
): Promise<AzureSubscription[]> {
  const fetcher = options.fetcher ?? fetch;
  const token = await options.credential.getToken(toDefaultScope(options.cloud.resourceManagerAudience));
  if (!token) {
    throw new Error("Azure credential returned no access token");
  }

  const endpoint = new URL("/subscriptions", `${options.cloud.resourceManagerEndpoint}/`);
  endpoint.searchParams.set("api-version", options.apiVersion);
  const expectedOrigin = endpoint.origin;
  const subscriptions: AzureSubscription[] = [];
  let nextUrl: URL | undefined = endpoint;
  let pageCount = 0;

  while (nextUrl) {
    if (nextUrl.origin !== expectedOrigin) {
      throw new Error("Azure returned a nextLink outside the Resource Manager endpoint");
    }
    if (++pageCount > 1_000) {
      throw new Error("Subscription pagination exceeded 1000 pages");
    }

    const response = await fetcher(nextUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token.token}`
      }
    });
    if (!response.ok) {
      throw new Error(`Azure subscriptions request failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as SubscriptionListResponse;
    for (const item of body.value ?? []) {
      if (!item.subscriptionId) {
        continue;
      }
      subscriptions.push({
        subscriptionId: item.subscriptionId,
        displayName: item.displayName ?? item.subscriptionId,
        state: item.state ?? "Unknown",
        tenantId: item.tenantId ?? null
      });
    }

    nextUrl = body.nextLink ? new URL(body.nextLink, endpoint) : undefined;
  }

  return subscriptions;
}
