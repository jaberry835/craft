import type { TokenCredential } from "@azure/core-auth";
import { toDefaultScope, type CloudProfile } from "../cloud/profile.js";

const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_PAGE_SIZE = 1_000;

export interface ResourceGraphQuery {
  subscriptions: string[];
  query: string;
  pageSize?: number;
  skipToken?: string;
}

export interface ResourceGraphPage<T extends Record<string, unknown>> {
  data: T[];
  count: number;
  totalRecords: number;
  nextPageToken: string | null;
  resultTruncated: boolean;
  incompleteReason: string | null;
}

interface ResourceGraphResponse {
  totalRecords?: number;
  count?: number;
  resultTruncated?: boolean;
  "$skipToken"?: string;
  data?: unknown;
}

export interface ResourceGraphClientOptions {
  credential: TokenCredential;
  cloud: CloudProfile;
  apiVersion: string;
  maxRetries: number;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class ResourceGraphClient {
  readonly #credential: TokenCredential;
  readonly #cloud: CloudProfile;
  readonly #apiVersion: string;
  readonly #maxRetries: number;
  readonly #fetcher: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: ResourceGraphClientOptions) {
    this.#credential = options.credential;
    this.#cloud = options.cloud;
    this.#apiVersion = options.apiVersion;
    this.#maxRetries = options.maxRetries;
    this.#fetcher = options.fetcher ?? fetch;
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async query<T extends Record<string, unknown>>(
    request: ResourceGraphQuery
  ): Promise<ResourceGraphPage<T>> {
    validateRequest(request);
    const token = await this.#credential.getToken(
      toDefaultScope(this.#cloud.resourceManagerAudience)
    );
    if (!token) {
      throw new Error("Azure credential returned no access token");
    }

    const endpoint = new URL(
      "/providers/Microsoft.ResourceGraph/resources",
      `${this.#cloud.resourceManagerEndpoint}/`
    );
    endpoint.searchParams.set("api-version", this.#apiVersion);
    const pageSize = Math.min(request.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    const body = {
      subscriptions: request.subscriptions,
      query: request.query,
      options: {
        "$top": pageSize,
        resultFormat: "objectArray",
        allowPartialScopes: true,
        ...(request.skipToken ? { "$skipToken": request.skipToken } : {})
      }
    };

    const response = await this.#sendWithRetry(endpoint, token.token, body);
    const result = (await response.json()) as ResourceGraphResponse;
    if (!Array.isArray(result.data)) {
      throw new Error("Azure Resource Graph returned data in an unexpected format");
    }

    const count = typeof result.count === "number" ? result.count : result.data.length;
    const totalRecords =
      typeof result.totalRecords === "number" ? result.totalRecords : count;
    const resultTruncated = result.resultTruncated === true;
    const nextPageToken = result["$skipToken"] ?? null;

    return {
      data: result.data as T[],
      count,
      totalRecords,
      nextPageToken,
      resultTruncated,
      incompleteReason:
        resultTruncated && !nextPageToken
          ? "Resource Graph truncated the result without a continuation token. Avoid KQL take/limit/sample and project at least one scalar column."
          : null
    };
  }

  async queryAll<T extends Record<string, unknown>>(
    request: Omit<ResourceGraphQuery, "skipToken">,
    maximumRows = 100_000
  ): Promise<{ data: T[]; complete: boolean; incompleteReason: string | null }> {
    const data: T[] = [];
    let skipToken: string | undefined;

    do {
      const page = await this.query<T>({ ...request, ...(skipToken ? { skipToken } : {}) });
      data.push(...page.data);
      if (page.incompleteReason) {
        return { data, complete: false, incompleteReason: page.incompleteReason };
      }
      if (data.length >= maximumRows && page.nextPageToken) {
        return {
          data: data.slice(0, maximumRows),
          complete: false,
          incompleteReason: `Stopped after the configured maximum of ${maximumRows} rows`
        };
      }
      skipToken = page.nextPageToken ?? undefined;
    } while (skipToken);

    return { data, complete: true, incompleteReason: null };
  }

  async #sendWithRetry(
    endpoint: URL,
    token: string,
    body: object
  ): Promise<Response> {
    let lastResponse: Response | undefined;
    let lastNetworkError: unknown;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.#fetcher(endpoint, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000)
        });
      } catch (error) {
        lastNetworkError = error;
        if (attempt === this.#maxRetries) {
          throw new Error(
            `Azure Resource Graph request failed after ${attempt + 1} attempts: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        await this.#sleep(Math.min(500 * 2 ** attempt, 10_000));
        continue;
      }
      lastResponse = response;

      if (response.ok) {
        return response;
      }
      if (!TRANSIENT_STATUS_CODES.has(response.status) || attempt === this.#maxRetries) {
        throw await createResourceGraphError(response);
      }

      await this.#sleep(retryDelayMilliseconds(response, attempt));
    }

    if (lastResponse) {
      throw await createResourceGraphError(lastResponse);
    }
    throw new Error(
      `Azure Resource Graph request failed: ${lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError)}`
    );
  }
}

function validateRequest(request: ResourceGraphQuery): void {
  if (request.subscriptions.length === 0) {
    throw new Error("At least one subscription ID is required");
  }
  if (request.subscriptions.length > 1_000) {
    throw new Error("Resource Graph accepts at most 1000 subscriptions per request");
  }
  for (const subscriptionId of request.subscriptions) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscriptionId)) {
      throw new Error(`Invalid subscription ID: ${subscriptionId}`);
    }
  }
  if (!request.query.trim()) {
    throw new Error("Resource Graph query must not be empty");
  }
  if (request.query.length > 32_768) {
    throw new Error("Resource Graph query exceeds the 32768-character limit");
  }
  if (request.pageSize !== undefined && (request.pageSize < 1 || request.pageSize > MAX_PAGE_SIZE)) {
    throw new Error(`pageSize must be between 1 and ${MAX_PAGE_SIZE}`);
  }
}

function retryDelayMilliseconds(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, 30_000);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(date - Date.now(), 0), 30_000);
    }
  }

  return Math.min(500 * 2 ** attempt, 10_000);
}

async function createResourceGraphError(response: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    detail = [body.error?.code, body.error?.message].filter(Boolean).join(": ");
  } catch {
    detail = response.statusText;
  }
  return new Error(
    `Azure Resource Graph request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`
  );
}
