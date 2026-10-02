import type { TokenCredential } from "@azure/core-auth";
import { toDefaultScope } from "../cloud/profile.js";

export type DataPlaneStatus = "available" | "partial" | "denied" | "unavailable";

export interface DataPlaneResult<T> {
  status: DataPlaneStatus;
  data: T;
  notes: string[];
}

export class ReadOnlyDataPlaneClient {
  readonly #credential: TokenCredential;
  readonly #audience: string;
  readonly #baseUrl: URL;
  readonly #fetcher: typeof fetch;

  constructor(
    credential: TokenCredential,
    audience: string,
    baseUrl: string,
    fetcher: typeof fetch = fetch
  ) {
    this.#credential = credential;
    this.#audience = audience;
    this.#baseUrl = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
    this.#fetcher = fetcher;
  }

  async getAll<T extends Record<string, unknown>>(
    path: string,
    headers: Record<string, string> = {}
  ): Promise<DataPlaneResult<T[]>> {
    let token;
    try {
      token = await this.#credential.getToken(toDefaultScope(this.#audience));
    } catch (error) {
      return unavailable(`Token acquisition failed: ${message(error)}`);
    }
    if (!token) return unavailable("Azure credential returned no access token");

    const values: T[] = [];
    let next: URL | null;
    try {
      next = this.#resolve(path);
    } catch (error) {
      return unavailable(`Invalid request URL: ${message(error)}`);
    }
    const visited = new Set<string>();
    while (next) {
      if (visited.has(next.href)) {
        return incomplete("Continuation URL repeated a previously requested page", values);
      }
      visited.add(next.href);
      let response: Response;
      try {
        response = await this.#fetcher(next, {
          headers: {
            Accept: "application/json",
            Authorization: ["Bearer", token.token].join(" "),
            ...headers
          },
          signal: AbortSignal.timeout(30_000)
        });
      } catch (error) {
        return incomplete(`Request failed: ${message(error)}`, values);
      }
      if (response.status === 401 || response.status === 403) {
        const detail = await responseErrorDetail(response);
        return {
          status: values.length > 0 ? "partial" : "denied",
          data: values,
          notes: [
            `HTTP ${response.status}${detail}: the caller lacks permission for this check`
          ]
        };
      }
      if (!response.ok) {
        return incomplete(
          `HTTP ${response.status}${await responseErrorDetail(response)}`,
          values
        );
      }
      let body: {
        value?: T[];
        "@odata.nextLink"?: string;
        nextLink?: string;
      };
      try {
        body = await response.json() as typeof body;
      } catch (error) {
        return incomplete(`Invalid JSON response: ${message(error)}`, values);
      }
      values.push(...(Array.isArray(body.value) ? body.value : []));
      const link = body["@odata.nextLink"] ?? body.nextLink;
      try {
        next = link ? this.#resolve(link) : null;
      } catch (error) {
        return incomplete(`Invalid continuation URL: ${message(error)}`, values);
      }
    }
    return { status: "available", data: values, notes: [] };
  }

  async get<T extends Record<string, unknown>>(
    path: string,
    headers: Record<string, string> = {}
  ): Promise<DataPlaneResult<T | null>> {
    let token;
    try {
      token = await this.#credential.getToken(toDefaultScope(this.#audience));
    } catch (error) {
      return unavailableValue(`Token acquisition failed: ${message(error)}`, null);
    }
    if (!token) return unavailableValue("Azure credential returned no access token", null);
    let response: Response;
    try {
      response = await this.#fetcher(this.#resolve(path), {
        headers: {
          Accept: "application/json",
          Authorization: ["Bearer", token.token].join(" "),
          ...headers
        },
        signal: AbortSignal.timeout(30_000)
      });
    } catch (error) {
      return unavailableValue(`Request failed: ${message(error)}`, null);
    }
    if (response.status === 401 || response.status === 403) {
      const detail = await responseErrorDetail(response);
      return {
        status: "denied",
        data: null,
        notes: [
          `HTTP ${response.status}${detail}: the caller lacks permission for this check`
        ]
      };
    }
    if (!response.ok) {
      return unavailableValue(
        `HTTP ${response.status}${await responseErrorDetail(response)}`,
        null
      );
    }
    try {
      return {
        status: "available",
        data: await response.json() as T,
        notes: []
      };
    } catch (error) {
      return unavailableValue(`Invalid JSON response: ${message(error)}`, null);
    }
  }

  #resolve(path: string): URL {
    const value = new URL(path, this.#baseUrl);
    if (value.origin !== this.#baseUrl.origin) {
      throw new Error("Continuation URL resolved outside the configured endpoint");
    }
    if (value.protocol !== "https:") {
      throw new Error("Data-plane endpoints must use HTTPS");
    }
    return value;
  }
}

function unavailable<T>(note: string, data: T[] = []): DataPlaneResult<T[]> {
  return { status: "unavailable", data, notes: [note] };
}

function incomplete<T>(note: string, data: T[]): DataPlaneResult<T[]> {
  return {
    status: data.length > 0 ? "partial" : "unavailable",
    data,
    notes: [note]
  };
}

function unavailableValue<T>(note: string, data: T): DataPlaneResult<T> {
  return { status: "unavailable", data, notes: [note] };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function responseErrorDetail(response: Response): Promise<string> {
  try {
    const body = await response.json() as {
      error?: string | { code?: string };
      code?: string;
    };
    const code =
      typeof body.error === "string"
        ? body.error
        : body.error?.code ?? body.code;
    return code ? ` (${code})` : "";
  } catch {
    return "";
  }
}
