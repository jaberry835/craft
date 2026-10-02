import type { TokenCredential } from "@azure/core-auth";
import { toDefaultScope, type CloudProfile } from "../cloud/profile.js";

const FORBIDDEN_PATH =
  /\/(?:listkeys|listsecrets|appsettings|connectionstrings|secrets)(?:\/|$)/i;

export class ArmReadClient {
  readonly #credential: TokenCredential;
  readonly #cloud: CloudProfile;
  readonly #fetcher: typeof fetch;

  constructor(
    credential: TokenCredential,
    cloud: CloudProfile,
    fetcher: typeof fetch = fetch
  ) {
    this.#credential = credential;
    this.#cloud = cloud;
    this.#fetcher = fetcher;
  }

  async get<T extends Record<string, unknown>>(
    resourcePath: string,
    apiVersion: string
  ): Promise<T> {
    if (!resourcePath.startsWith("/subscriptions/")) {
      throw new Error("ARM resource path must begin with /subscriptions/");
    }
    if (FORBIDDEN_PATH.test(resourcePath)) {
      throw new Error("The requested ARM path may expose secrets and is forbidden");
    }

    const token = await this.#credential.getToken(
      toDefaultScope(this.#cloud.resourceManagerAudience)
    );
    if (!token) {
      throw new Error("Azure credential returned no access token");
    }
    const endpoint = new URL(resourcePath, `${this.#cloud.resourceManagerEndpoint}/`);
    endpoint.searchParams.set("api-version", apiVersion);
    if (endpoint.origin !== new URL(this.#cloud.resourceManagerEndpoint).origin) {
      throw new Error("ARM request resolved outside the configured Resource Manager endpoint");
    }

    const response = await this.#fetcher(endpoint, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token.token}`
      },
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
      throw new Error(`ARM GET failed with HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
}
