import { readFile } from "node:fs/promises";
import { z } from "zod";

const url = z.url().transform(stripTrailingSlash);

const cloudProfileSchema = z.object({
  name: z.string().min(1),
  resourceManagerEndpoint: url,
  resourceManagerAudience: url,
  authorityHost: url,
  portalUrl: url,
  graphEndpoint: url.optional(),
  keyVaultAudience: url.optional(),
  dnsSuffixes: z
    .object({
      keyVault: z.string().min(1).optional(),
      storage: z.string().min(1).optional(),
      sqlServer: z.string().min(1).optional(),
      webApp: z.string().min(1).optional()
    })
    .default({})
});

const metadataSchema = z
  .object({
    authentication: z
      .object({
        loginEndpoint: z.url().optional(),
        audiences: z.array(z.url()).optional()
      })
      .optional(),
    portal: z.url().optional(),
    graph: z.url().optional(),
    suffixes: z
      .object({
        keyVaultDns: z.string().optional(),
        storage: z.string().optional(),
        sqlServerHostname: z.string().optional(),
        webSites: z.string().optional()
      })
      .optional()
  })
  .passthrough();

export type CloudProfile = z.infer<typeof cloudProfileSchema>;

export interface CloudProfileOverrides {
  resourceManagerEndpoint?: string;
  resourceManagerAudience?: string;
  authorityHost?: string;
  portalUrl?: string;
  graphEndpoint?: string;
  keyVaultAudience?: string;
}

export interface ResolvedCloud {
  profile: CloudProfile;
  discovery: {
    attempted: boolean;
    succeeded: boolean;
    error?: string;
  };
}

export async function loadCloudProfile(path: string): Promise<CloudProfile> {
  const raw = await readFile(path, "utf8");
  return cloudProfileSchema.parse(JSON.parse(raw) as unknown);
}

export async function resolveCloudProfile(
  path: string,
  overrides: CloudProfileOverrides,
  fetcher: typeof fetch = fetch
): Promise<ResolvedCloud> {
  const fromFile = await loadCloudProfile(path);
  const base = cloudProfileSchema.parse({ ...fromFile, ...definedValues(overrides) });
  const metadataUrl = new URL("/metadata/endpoints", `${base.resourceManagerEndpoint}/`);
  metadataUrl.searchParams.set("api-version", "2022-09-01");

  try {
    const response = await fetcher(metadataUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const metadata = metadataSchema.parse(await response.json());
    const discoveredAudience = metadata.authentication?.audiences?.[0];
    const discovered = cloudProfileSchema.parse({
      ...base,
      resourceManagerAudience: discoveredAudience ?? base.resourceManagerAudience,
      authorityHost: metadata.authentication?.loginEndpoint ?? base.authorityHost,
      portalUrl: metadata.portal ?? base.portalUrl,
      graphEndpoint: base.graphEndpoint ?? metadata.graph,
      dnsSuffixes: {
        ...base.dnsSuffixes,
        keyVault: metadata.suffixes?.keyVaultDns ?? base.dnsSuffixes.keyVault,
        storage: metadata.suffixes?.storage ?? base.dnsSuffixes.storage,
        sqlServer: metadata.suffixes?.sqlServerHostname ?? base.dnsSuffixes.sqlServer,
        webApp: metadata.suffixes?.webSites ?? base.dnsSuffixes.webApp
      },
      ...definedValues(overrides)
    });
    return { profile: discovered, discovery: { attempted: true, succeeded: true } };
  } catch (error) {
    return {
      profile: base,
      discovery: {
        attempted: true,
        succeeded: false,
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

export function toDefaultScope(audience: string): string {
  return `${stripTrailingSlash(audience)}/.default`;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function definedValues<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
