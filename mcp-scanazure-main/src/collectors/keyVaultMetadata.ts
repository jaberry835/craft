import type { TokenCredential } from "@azure/core-auth";
import type { ResourceGraphClient } from "../azure/resourceGraph.js";
import type { CloudProfile } from "../cloud/profile.js";
import {
  ReadOnlyDataPlaneClient,
  type DataPlaneStatus
} from "../azure/readOnlyDataPlane.js";

export type KeyVaultItemType = "secret" | "key" | "certificate";

export interface KeyVaultItemMetadata {
  vaultId: string;
  vaultName: string;
  vaultUri: string;
  itemType: KeyVaultItemType;
  id: string;
  name: string;
  enabled: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
  notBefore: string | null;
  expiresAt: string | null;
  daysUntilExpiry: number | null;
  tags: Record<string, string>;
  contentType: string | null;
  keyType: string | null;
  keyOperations: string[];
  rotationPolicy: Record<string, unknown> | null;
  rotationPolicyStatus: DataPlaneStatus | null;
  rotationPolicyNotes: string[];
  certificatePolicy: Record<string, unknown> | null;
  certificatePolicyStatus: DataPlaneStatus | null;
  certificatePolicyNotes: string[];
}

export interface KeyVaultCheck {
  vaultId: string;
  vaultName: string;
  vaultUri: string | null;
  itemType: KeyVaultItemType;
  status: DataPlaneStatus;
  count: number;
  notes: string[];
}

export interface KeyVaultMetadataResult {
  items: KeyVaultItemMetadata[];
  checks: KeyVaultCheck[];
}

export async function collectKeyVaultItemMetadata(
  graph: ResourceGraphClient,
  credential: TokenCredential,
  cloud: CloudProfile,
  subscriptionId: string,
  options: {
    apiVersion?: string;
    fetcher?: typeof fetch;
  } = {}
): Promise<KeyVaultMetadataResult> {
  const apiVersion = options.apiVersion ?? "7.4";
  const fetcher = options.fetcher ?? fetch;
  const result = await graph.queryAll({
    subscriptions: [subscriptionId],
    query: `
Resources
| where type =~ 'microsoft.keyvault/vaults'
| project id, name, properties
| order by id asc`,
    pageSize: 1_000
  });
  const vaults = result.data.map((row) => {
    const properties = object(row.properties);
    const name = text(row.name) ?? "";
    return {
      id: text(row.id) ?? "",
      name,
      uri: text(properties.vaultUri) ?? (
        cloud.dnsSuffixes.keyVault && name
          ? `https://${name}.${cloud.dnsSuffixes.keyVault}`
          : null
      )
    };
  }).filter((vault) => vault.id && vault.name);
  const collected = await Promise.all(vaults.map((vault) =>
    collectVault(vault, credential, cloud, apiVersion, fetcher)
  ));
  return {
    items: collected.flatMap((value) => value.items)
      .sort((a, b) => `${a.vaultId}:${a.itemType}:${a.name}`.localeCompare(
        `${b.vaultId}:${b.itemType}:${b.name}`
      )),
    checks: collected.flatMap((value) => value.checks)
  };
}

async function collectVault(
  vault: { id: string; name: string; uri: string | null },
  credential: TokenCredential,
  cloud: CloudProfile,
  apiVersion: string,
  fetcher: typeof fetch
): Promise<KeyVaultMetadataResult> {
  const types: Array<{ type: KeyVaultItemType; path: string }> = [
    { type: "secret", path: `/secrets?api-version=${encodeURIComponent(apiVersion)}` },
    { type: "key", path: `/keys?api-version=${encodeURIComponent(apiVersion)}` },
    { type: "certificate", path: `/certificates?api-version=${encodeURIComponent(apiVersion)}` }
  ];
  if (!vault.uri || !cloud.keyVaultAudience) {
    const note = !cloud.keyVaultAudience
      ? "Key Vault audience is not configured for this cloud"
      : "Vault data-plane URI could not be determined";
    return {
      items: [],
      checks: types.map(({ type }) => vaultCheck(vault, type, "unavailable", 0, [note]))
    };
  }
  let client: ReadOnlyDataPlaneClient;
  try {
    validateVaultUri(vault.uri, cloud);
    client = new ReadOnlyDataPlaneClient(
      credential,
      cloud.keyVaultAudience,
      vault.uri,
      fetcher
    );
  } catch (error) {
    return {
      items: [],
      checks: types.map(({ type }) =>
        vaultCheck(vault, type, "unavailable", 0, [message(error)])
      )
    };
  }

  const results = await Promise.all(types.map(async ({ type, path }) => {
    const response = await client.getAll(path);
    const items = response.data.map((row) => normalizeItem(vault, type, row));
    if (type === "key" && response.status === "available") {
      const rotationStatuses: DataPlaneStatus[] = [];
      await Promise.all(items.map(async (item) => {
        const rotation = await client.get(
          `/keys/${encodeURIComponent(item.name)}/rotationpolicy?api-version=${encodeURIComponent(apiVersion)}`
        );
        rotationStatuses.push(rotation.status);
        if (rotation.status === "available" && rotation.data) {
          item.rotationPolicy = sanitizeRotationPolicy(rotation.data);
        }
        item.rotationPolicyStatus = rotation.status;
        item.rotationPolicyNotes = rotation.notes;
        if (rotation.status !== "available") {
          response.notes.push(`Rotation policy for ${item.name}: ${rotation.notes.join("; ")}`);
        }
      }));
      if (rotationStatuses.some((status) => status === "denied")) {
        response.status = items.length > 0 ? "partial" : "denied";
      } else if (rotationStatuses.some((status) => status === "unavailable")) {
        response.status = items.length > 0 ? "partial" : "unavailable";
      }
    }
    if (type === "certificate" && response.status === "available") {
      const policyStatuses: DataPlaneStatus[] = [];
      await Promise.all(items.map(async (item) => {
        const policy = await client.get(
          `/certificates/${encodeURIComponent(item.name)}/policy?api-version=${encodeURIComponent(apiVersion)}`
        );
        policyStatuses.push(policy.status);
        if (policy.status === "available" && policy.data) {
          item.certificatePolicy = sanitizeCertificatePolicy(policy.data);
        }
        item.certificatePolicyStatus = policy.status;
        item.certificatePolicyNotes = policy.notes;
        if (policy.status !== "available") {
          response.notes.push(`Certificate policy for ${item.name}: ${policy.notes.join("; ")}`);
        }
      }));
      if (policyStatuses.some((status) => status !== "available")) {
        response.status = items.length > 0 ? "partial"
          : policyStatuses.some((status) => status === "denied") ? "denied" : "unavailable";
      }
    }
    return {
      items,
      check: vaultCheck(vault, type, response.status, items.length, response.notes)
    };
  }));
  return {
    items: results.flatMap((value) => value.items),
    checks: results.map((value) => value.check)
  };
}

function normalizeItem(
  vault: { id: string; name: string; uri: string | null },
  itemType: KeyVaultItemType,
  row: Record<string, unknown>
): KeyVaultItemMetadata {
  const attributes = object(row.attributes);
  const id = text(row.id) ?? text(row.kid) ?? "";
  const expiresAt = epochDate(attributes.exp);
  return {
    vaultId: vault.id,
    vaultName: vault.name,
    vaultUri: vault.uri!,
    itemType,
    id,
    name: itemName(id, itemType),
    enabled: typeof attributes.enabled === "boolean" ? attributes.enabled : null,
    createdAt: epochDate(attributes.created),
    updatedAt: epochDate(attributes.updated),
    notBefore: epochDate(attributes.nbf),
    expiresAt,
    daysUntilExpiry: expiresAt
      ? Math.ceil((Date.parse(expiresAt) - Date.now()) / 86_400_000)
      : null,
    tags: stringRecord(row.tags),
    contentType: text(row.contentType),
    keyType: text(row.kty),
    keyOperations: stringArray(row.key_ops),
    rotationPolicy: null,
    rotationPolicyStatus: itemType === "key" ? "unavailable" : null,
    rotationPolicyNotes: [],
    certificatePolicy: null,
    certificatePolicyStatus: itemType === "certificate" ? "unavailable" : null,
    certificatePolicyNotes: []
  };
}

function itemName(id: string, itemType: KeyVaultItemType): string {
  const segment = itemType === "certificate" ? "certificates" : `${itemType}s`;
  let path = id;
  try {
    path = new URL(id).pathname;
  } catch {
    // Keep metadata collection best effort when a service returns a non-URL ID.
  }
  const parts = path.split("/").filter(Boolean);
  const index = parts.findIndex((part) => part.toLowerCase() === segment);
  return decodeURIComponent(index >= 0 ? parts[index + 1] ?? "" : parts.at(-1) ?? "");
}

function sanitizeRotationPolicy(value: Record<string, unknown>): Record<string, unknown> {
  return {
    id: text(value.id),
    lifetimeActions: Array.isArray(value.lifetimeActions) ? value.lifetimeActions : [],
    attributes: object(value.attributes)
  };
}

function sanitizeCertificatePolicy(
  value: Record<string, unknown>
): Record<string, unknown> {
  const issuer = object(value.issuer);
  const x509 = object(value.x509_props ?? value.x509CertificateProperties);
  return {
    issuer: text(issuer.name),
    subject: text(x509.subject),
    validityInMonths:
      typeof x509.validity_months === "number"
        ? x509.validity_months
        : typeof x509.validityInMonths === "number"
          ? x509.validityInMonths
          : null,
    keyUsage: stringArray(x509.key_usage ?? x509.keyUsage),
    enhancedKeyUsage: stringArray(x509.ekus ?? x509.enhancedKeyUsage),
    lifetimeActions: Array.isArray(value.lifetime_actions)
      ? value.lifetime_actions
      : Array.isArray(value.lifetimeActions)
        ? value.lifetimeActions
        : [],
    attributes: object(value.attributes)
  };
}

function vaultCheck(
  vault: { id: string; name: string; uri: string | null },
  itemType: KeyVaultItemType,
  status: DataPlaneStatus,
  count: number,
  notes: string[]
): KeyVaultCheck {
  return {
    vaultId: vault.id,
    vaultName: vault.name,
    vaultUri: vault.uri,
    itemType,
    status,
    count,
    notes: [...new Set(notes)]
  };
}

function validateVaultUri(value: string, cloud: CloudProfile): void {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Vault URI must use HTTPS");
  const suffix = cloud.dnsSuffixes.keyVault?.replace(/^\./, "").toLowerCase();
  if (!suffix || !(url.hostname.toLowerCase() === suffix
    || url.hostname.toLowerCase().endsWith(`.${suffix}`))) {
    throw new Error("Vault URI is outside the configured Key Vault DNS suffix");
  }
}

function epochDate(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1_000).toISOString()
    : null;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value))
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
