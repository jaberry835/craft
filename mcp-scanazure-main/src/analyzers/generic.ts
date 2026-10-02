export type FindingStatus = "pass" | "fail" | "notApplicable" | "unknown";
export type FindingSeverity = "low" | "medium" | "high";

export interface SecurityFinding {
  checkId: string;
  title: string;
  severity: FindingSeverity;
  status: FindingStatus;
  evidence: Record<string, unknown>;
  nistControls: string[];
}

export interface AnalyzableResource {
  type: string;
  tags?: Record<string, unknown> | null;
  identity?: Record<string, unknown> | null;
  properties?: Record<string, unknown> | null;
}

export function analyzeGenericConfiguration(
  resource: AnalyzableResource
): SecurityFinding[] {
  const properties = resource.properties ?? {};
  const publicNetworkAccess = stringValue(properties.publicNetworkAccess);
  const minimumTlsVersion =
    stringValue(properties.minimumTlsVersion) ??
    stringValue(properties.minTlsVersion) ??
    stringValue(objectValue(properties.siteConfig)?.minTlsVersion);
  const httpsOnly = booleanValue(properties.httpsOnly);
  const disableLocalAuth = booleanValue(properties.disableLocalAuth);
  const allowSharedKeyAccess = booleanValue(properties.allowSharedKeyAccess);
  const identityType = stringValue(resource.identity?.type);
  const privateEndpoints = arrayValue(properties.privateEndpointConnections);
  const encryption = objectValue(properties.encryption);

  return [
    finding(
      "generic.public-network-access",
      "Public network access is restricted",
      "high",
      publicNetworkAccess === undefined
        ? "unknown"
        : /^disabled$/i.test(publicNetworkAccess)
          ? "pass"
          : "fail",
      { publicNetworkAccess: publicNetworkAccess ?? null },
      ["SC-7"]
    ),
    finding(
      "generic.minimum-tls-version",
      "Minimum TLS version is 1.2 or newer",
      "high",
      tlsStatus(minimumTlsVersion),
      { minimumTlsVersion: minimumTlsVersion ?? null },
      ["SC-8", "SC-13"]
    ),
    finding(
      "generic.https-only",
      "HTTPS-only transport is enabled",
      "high",
      httpsOnly === undefined ? "unknown" : httpsOnly ? "pass" : "fail",
      { httpsOnly: httpsOnly ?? null },
      ["SC-8"]
    ),
    finding(
      "generic.local-auth-disabled",
      "Local or shared-key authentication is disabled",
      "high",
      localAuthStatus(disableLocalAuth, allowSharedKeyAccess),
      {
        disableLocalAuth: disableLocalAuth ?? null,
        allowSharedKeyAccess: allowSharedKeyAccess ?? null
      },
      ["IA-2", "IA-5"]
    ),
    finding(
      "generic.managed-identity",
      "Managed identity is configured",
      "medium",
      identityType === undefined
        ? "unknown"
        : /systemassigned|userassigned/i.test(identityType)
          ? "pass"
          : "fail",
      { identityType: identityType ?? null },
      ["AC-2", "IA-2"]
    ),
    finding(
      "generic.encryption-at-rest",
      "Encryption at rest is explicitly configured",
      "high",
      encryptionStatus(properties, encryption),
      {
        encryptionConfigured: encryption !== undefined,
        encryptionEnabled:
          booleanValue(encryption?.enabled) ??
          booleanValue(properties.enableInfrastructureEncryption) ??
          booleanValue(properties.encryptionAtHost) ??
          null,
        keySource: stringValue(encryption?.keySource) ?? null
      },
      ["SC-12", "SC-13", "SC-28"]
    ),
    finding(
      "generic.private-endpoint",
      "Private connectivity is used when public access is enabled",
      "medium",
      privateEndpointStatus(publicNetworkAccess, privateEndpoints),
      {
        publicNetworkAccess: publicNetworkAccess ?? null,
        privateEndpointConnectionCount: privateEndpoints?.length ?? null
      },
      ["SC-7"]
    ),
    tagFinding(resource.tags ?? {})
  ];
}

function finding(
  checkId: string,
  title: string,
  severity: FindingSeverity,
  status: FindingStatus,
  evidence: Record<string, unknown>,
  nistControls: string[]
): SecurityFinding {
  return { checkId, title, severity, status, evidence, nistControls };
}

function tlsStatus(value: string | undefined): FindingStatus {
  if (value === undefined) {
    return "unknown";
  }
  const match = value.match(/\d+(?:\.\d+)?/);
  if (!match) {
    return "unknown";
  }
  return Number(match[0]) >= 1.2 ? "pass" : "fail";
}

function localAuthStatus(
  disableLocalAuth: boolean | undefined,
  allowSharedKeyAccess: boolean | undefined
): FindingStatus {
  if (disableLocalAuth === undefined && allowSharedKeyAccess === undefined) {
    return "unknown";
  }
  if (disableLocalAuth === false || allowSharedKeyAccess === true) {
    return "fail";
  }
  return "pass";
}

function privateEndpointStatus(
  publicNetworkAccess: string | undefined,
  privateEndpoints: unknown[] | undefined
): FindingStatus {
  if (publicNetworkAccess && /^disabled$/i.test(publicNetworkAccess)) {
    return "pass";
  }
  if (privateEndpoints && privateEndpoints.length > 0) {
    return "pass";
  }
  if (publicNetworkAccess && /^enabled$/i.test(publicNetworkAccess)) {
    return "fail";
  }
  return "unknown";
}

function encryptionStatus(
  properties: Record<string, unknown>,
  encryption: Record<string, unknown> | undefined
): FindingStatus {
  const explicitValues = [
    booleanValue(encryption?.enabled),
    booleanValue(properties.enableInfrastructureEncryption),
    booleanValue(properties.encryptionAtHost)
  ].filter((value): value is boolean => value !== undefined);
  if (explicitValues.includes(false)) {
    return "fail";
  }
  if (
    explicitValues.includes(true) ||
    stringValue(encryption?.keySource) !== undefined ||
    hasEnabledEncryptionService(encryption?.services)
  ) {
    return "pass";
  }
  return "unknown";
}

function hasEnabledEncryptionService(value: unknown): boolean {
  const services = objectValue(value);
  if (!services) {
    return false;
  }
  return Object.values(services).some(
    (service) => booleanValue(objectValue(service)?.enabled) === true
  );
}

function tagFinding(tags: Record<string, unknown>): SecurityFinding {
  const normalized = new Set(Object.keys(tags).map((key) => key.toLowerCase()));
  const missing = [
    !normalized.has("owner") ? "owner" : null,
    !normalized.has("environment") && !normalized.has("env") ? "environment" : null,
    !normalized.has("dataclassification") && !normalized.has("data-classification")
      ? "dataClassification"
      : null
  ].filter((value): value is string => value !== null);

  return finding(
    "generic.governance-tags",
    "Governance metadata tags are present",
    "low",
    missing.length === 0 ? "pass" : "fail",
    { missingTags: missing },
    ["CM-8"]
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
