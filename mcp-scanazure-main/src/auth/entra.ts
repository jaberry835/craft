import type { AccessToken, GetTokenOptions, TokenCredential } from "@azure/core-auth";
import { ManagedIdentityCredential } from "@azure/identity";
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload
} from "jose";
import type { Request } from "express";
import type { CloudProfile } from "../cloud/profile.js";
import { toDefaultScope } from "../cloud/profile.js";
import type { AppConfig } from "../config.js";
import { entraCallerIdentity, type CallerIdentity } from "../scan/identity.js";

const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const OBO_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const TOKEN_EXCHANGE_SCOPE = "api://AzureADTokenExchange/.default";

export interface AuthenticatedRequest {
  caller: CallerIdentity;
  credential: TokenCredential;
}

export class AuthenticationError extends Error {
  readonly statusCode = 401;

  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

interface VerifiedToken {
  payload: JWTPayload;
  token: string;
}

type TokenVerifier = (
  token: string,
  audience: string | string[]
) => Promise<JWTPayload>;

export class EntraRequestAuthenticator {
  readonly #config: AppConfig;
  readonly #cloud: CloudProfile;
  readonly #verifyToken: TokenVerifier;
  readonly #clientAssertionCredential: TokenCredential | null;

  constructor(
    config: AppConfig,
    cloud: CloudProfile,
    options: {
      verifyToken?: TokenVerifier;
      clientAssertionCredential?: TokenCredential;
    } = {}
  ) {
    if (!config.entra || !config.tenantId || config.authMode === "none") {
      throw new Error("Entra authentication configuration is incomplete");
    }
    this.#config = config;
    this.#cloud = cloud;
    this.#verifyToken = options.verifyToken ?? createTokenVerifier(config, cloud);
    this.#clientAssertionCredential =
      options.clientAssertionCredential ??
      (config.entra.clientSecret
        ? null
        : new ManagedIdentityCredential(
            config.managedIdentityClientId
              ? { clientId: config.managedIdentityClientId }
              : undefined
          ));
  }

  async authenticate(request: Request): Promise<AuthenticatedRequest> {
    return this.authenticateAuthorizationHeader(request.headers.authorization);
  }

  async authenticateAuthorizationHeader(
    authorization: string | undefined
  ): Promise<AuthenticatedRequest> {
    const token = bearerToken(authorization);
    const expectedAudience =
      this.#config.authMode === "arm-token"
        ? [
            this.#cloud.resourceManagerAudience,
            `${this.#cloud.resourceManagerAudience}/`
          ]
        : this.#config.entra!.serverClientId;
    const verified: VerifiedToken = {
      payload: await this.#verifyToken(token, expectedAudience),
      token
    };
    const claims = validateClaims(
      verified.payload,
      this.#config.tenantId!,
      this.#config.entra!.allowedClientIds
    );
    const caller = entraCallerIdentity(
      this.#config.authMode as "obo" | "arm-token",
      claims.tenantId,
      claims.objectId
    );

    if (this.#config.authMode === "arm-token") {
      return {
        caller,
        credential: new StaticArmTokenCredential(
          token,
          claims.expiresOnTimestamp,
          this.#cloud.resourceManagerAudience
        )
      };
    }

    return {
      caller,
      credential: new OnBehalfOfTokenCredential({
        tenantId: claims.tenantId,
        clientId: this.#config.entra!.serverClientId,
        userAssertion: token,
        authorityHost: this.#cloud.authorityHost,
        ...(this.#config.entra!.clientSecret
          ? { clientSecret: this.#config.entra!.clientSecret }
          : {}),
        ...(this.#clientAssertionCredential
          ? { clientAssertionCredential: this.#clientAssertionCredential }
          : {})
      })
    };
  }
}

export function protectedResourceMetadata(
  config: AppConfig,
  cloud: CloudProfile
): Record<string, unknown> {
  if (!config.entra || !config.tenantId) {
    throw new Error("Protected-resource metadata requires Entra configuration");
  }
  return {
    resource: config.entra.resourceUri,
    authorization_servers: [
      `${cloud.authorityHost}/${encodeURIComponent(config.tenantId)}/v2.0`
    ],
    bearer_methods_supported: ["header"],
    scopes_supported: [`api://${config.entra.serverClientId}/access_as_user`]
  };
}

function createTokenVerifier(config: AppConfig, cloud: CloudProfile): TokenVerifier {
  const tenantId = config.tenantId!;
  const issuer = `${cloud.authorityHost}/${tenantId}/v2.0`;
  const jwks = createRemoteJWKSet(
    new URL(`${cloud.authorityHost}/${tenantId}/discovery/v2.0/keys`)
  );
  return async (token, audience) => {
    try {
      const result = await jwtVerify(token, jwks, {
        algorithms: ["RS256"],
        audience,
        issuer
      });
      return result.payload;
    } catch (error) {
      if (error instanceof joseErrors.JOSEError) {
        throw new AuthenticationError(`Bearer token validation failed: ${error.code}`);
      }
      throw error;
    }
  };
}

function validateClaims(
  payload: JWTPayload,
  tenantId: string,
  allowedClientIds: ReadonlySet<string>
): {
  tenantId: string;
  objectId: string;
  expiresOnTimestamp: number;
} {
  const tokenTenantId = stringClaim(payload, "tid");
  const objectId = stringClaim(payload, "oid");
  const authorizedParty = stringClaim(payload, "azp");
  if (tokenTenantId.toLowerCase() !== tenantId.toLowerCase()) {
    throw new AuthenticationError("Bearer token tenant is not allowed");
  }
  if (!allowedClientIds.has(authorizedParty.toLowerCase())) {
    throw new AuthenticationError("Bearer token client application is not allowed");
  }
  if (payload.ver !== "2.0") {
    throw new AuthenticationError("Only Entra v2 access tokens are supported");
  }
  if (typeof payload.exp !== "number") {
    throw new AuthenticationError("Bearer token has no expiration");
  }
  return {
    tenantId: tokenTenantId,
    objectId,
    expiresOnTimestamp: payload.exp * 1_000
  };
}

function stringClaim(payload: JWTPayload, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new AuthenticationError(`Bearer token is missing the ${name} claim`);
  }
  return value;
}

function bearerToken(authorization: string | undefined): string {
  const match = /^Bearer +(.+)$/i.exec(authorization ?? "");
  if (!match?.[1]) {
    throw new AuthenticationError("A Bearer token is required");
  }
  return match[1];
}

class StaticArmTokenCredential implements TokenCredential {
  constructor(
    private readonly token: string,
    private readonly expiresOnTimestamp: number,
    private readonly audience: string
  ) {}

  async getToken(
    scopes: string | string[],
    _options?: GetTokenOptions
  ): Promise<AccessToken> {
    const requested = Array.isArray(scopes) ? scopes : [scopes];
    if (
      requested.length !== 1 ||
      requested[0] !== toDefaultScope(this.audience)
    ) {
      throw new Error("AUTH_MODE=arm-token can only access Azure Resource Manager");
    }
    return { token: this.token, expiresOnTimestamp: this.expiresOnTimestamp };
  }
}

interface OnBehalfOfOptions {
  tenantId: string;
  clientId: string;
  userAssertion: string;
  authorityHost: string;
  clientSecret?: string;
  clientAssertionCredential?: TokenCredential;
}

export class OnBehalfOfTokenCredential implements TokenCredential {
  readonly #options: OnBehalfOfOptions;
  readonly #cache = new Map<string, AccessToken>();

  constructor(options: OnBehalfOfOptions) {
    if (!options.clientSecret && !options.clientAssertionCredential) {
      throw new Error("OBO requires a client secret or managed identity assertion");
    }
    this.#options = options;
  }

  async getToken(
    scopes: string | string[],
    _options?: GetTokenOptions
  ): Promise<AccessToken> {
    const scope = normalizeScope(scopes);
    const cached = this.#cache.get(scope);
    if (cached && cached.expiresOnTimestamp > Date.now() + 60_000) {
      return cached;
    }

    const body = new URLSearchParams({
      client_id: this.#options.clientId,
      grant_type: OBO_GRANT_TYPE,
      requested_token_use: "on_behalf_of",
      assertion: this.#options.userAssertion,
      scope
    });
    if (this.#options.clientSecret) {
      body.set("client_secret", this.#options.clientSecret);
    } else {
      const assertion = await this.#options.clientAssertionCredential!.getToken(
        TOKEN_EXCHANGE_SCOPE
      );
      if (!assertion) {
        throw new Error("Managed identity returned no client assertion");
      }
      body.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
      body.set("client_assertion", assertion.token);
    }

    const endpoint = `${this.#options.authorityHost}/${encodeURIComponent(
      this.#options.tenantId
    )}/oauth2/v2.0/token`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body,
      signal: AbortSignal.timeout(15_000)
    });
    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !payload.access_token) {
      throw new Error(
        `Entra OBO token exchange failed: ${payload.error ?? `HTTP ${response.status}`}${
          payload.error_description ? ` - ${payload.error_description}` : ""
        }`
      );
    }
    const token = {
      token: payload.access_token,
      expiresOnTimestamp: Date.now() + (payload.expires_in ?? 3_600) * 1_000
    };
    this.#cache.set(scope, token);
    return token;
  }
}

function normalizeScope(scopes: string | string[]): string {
  const values = Array.isArray(scopes) ? scopes : [scopes];
  if (values.length === 0 || values.some((value) => !value.trim())) {
    throw new Error("At least one non-empty downstream scope is required");
  }
  return values.join(" ");
}
