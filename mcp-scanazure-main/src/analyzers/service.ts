import type {
  AnalyzableResource,
  FindingSeverity,
  FindingStatus,
  SecurityFinding
} from "./generic.js";

export interface ServiceResource extends AnalyzableResource {
  id: string;
  name: string;
}

interface Check {
  checkId: string;
  title: string;
  severity: FindingSeverity;
  status: FindingStatus;
  evidence: Record<string, unknown>;
  nistControls: string[];
}

export function analyzeServiceConfiguration(
  resource: ServiceResource
): SecurityFinding[] {
  const type = resource.type.toLowerCase();
  const properties = resource.properties ?? {};
  const checks: Check[] = [];

  if (type === "microsoft.compute/virtualmachines") {
    checks.push(
      boolCheck(
        "compute.vm.encryption-at-host",
        "VM encryption at host is enabled",
        "high",
        get(properties, "securityProfile.encryptionAtHost"),
        ["SC-28"]
      ),
      presenceCheck(
        "compute.vm.managed-identity",
        "VM has a managed identity",
        "medium",
        stringValue(resource.identity?.type),
        ["AC-2", "IA-2"]
      ),
      boolCheck(
        "compute.vm.boot-diagnostics",
        "VM boot diagnostics is enabled",
        "low",
        get(properties, "diagnosticsProfile.bootDiagnostics.enabled"),
        ["AU-2", "SI-4"]
      )
    );
  }

  if (type === "microsoft.compute/disks") {
    checks.push(
      stringNotEqualsCheck(
        "compute.disk.public-network-access",
        "Managed disk public network access is disabled",
        "high",
        properties.publicNetworkAccess,
        "Enabled",
        ["SC-7"]
      ),
      presenceCheck(
        "compute.disk.encryption",
        "Managed disk encryption configuration is present",
        "high",
        properties.encryption,
        ["SC-28"]
      )
    );
  }

  if (type === "microsoft.containerservice/managedclusters") {
    checks.push(
      boolCheck(
        "aks.private-cluster",
        "AKS private cluster is enabled",
        "high",
        get(properties, "apiServerAccessProfile.enablePrivateCluster"),
        ["SC-7"]
      ),
      boolCheck(
        "aks.local-accounts-disabled",
        "AKS local accounts are disabled",
        "high",
        properties.disableLocalAccounts,
        ["AC-2", "IA-2"]
      ),
      presenceCheck(
        "aks.network-policy",
        "AKS network policy is configured",
        "high",
        get(properties, "networkProfile.networkPolicy"),
        ["AC-4", "SC-7"]
      ),
      presenceCheck(
        "aks.entra-integration",
        "AKS Entra integration is configured",
        "high",
        properties.aadProfile,
        ["AC-2", "IA-2"]
      )
    );
  }

  if (type === "microsoft.containerregistry/registries") {
    checks.push(
      boolFalseCheck(
        "acr.admin-disabled",
        "Container Registry admin user is disabled",
        "high",
        properties.adminUserEnabled,
        ["AC-2", "IA-5"]
      ),
      boolFalseCheck(
        "acr.anonymous-pull-disabled",
        "Anonymous image pull is disabled",
        "high",
        properties.anonymousPullEnabled,
        ["AC-3"]
      )
    );
  }

  if (type === "microsoft.web/sites") {
    checks.push(
      boolCheck(
        "appservice.https-only",
        "App Service HTTPS-only is enabled",
        "high",
        properties.httpsOnly,
        ["SC-8"]
      ),
      boolCheck(
        "appservice.client-cert",
        "App Service requires client certificates",
        "medium",
        properties.clientCertEnabled,
        ["IA-2", "SC-8"]
      )
    );
  }

  if (type === "microsoft.keyvault/vaults") {
    checks.push(
      boolCheck(
        "keyvault.purge-protection",
        "Key Vault purge protection is enabled",
        "high",
        properties.enablePurgeProtection,
        ["CP-9", "SC-12"]
      ),
      boolCheck(
        "keyvault.soft-delete",
        "Key Vault soft delete is enabled",
        "high",
        properties.enableSoftDelete,
        ["CP-9"]
      ),
      boolCheck(
        "keyvault.rbac",
        "Key Vault uses Azure RBAC",
        "medium",
        properties.enableRbacAuthorization,
        ["AC-2", "AC-3"]
      )
    );
  }

  if (type === "microsoft.storage/storageaccounts") {
    checks.push(
      boolFalseCheck(
        "storage.blob-public-access-disabled",
        "Storage blob public access is disabled",
        "high",
        properties.allowBlobPublicAccess,
        ["AC-3", "SC-7"]
      ),
      boolFalseCheck(
        "storage.shared-key-disabled",
        "Storage shared-key authorization is disabled",
        "high",
        properties.allowSharedKeyAccess,
        ["IA-2", "IA-5"]
      ),
      boolCheck(
        "storage.https-only",
        "Storage requires HTTPS traffic",
        "high",
        properties.supportsHttpsTrafficOnly,
        ["SC-8"]
      ),
      stringAtLeastTls12(
        "storage.minimum-tls",
        "Storage minimum TLS version is 1.2 or newer",
        properties.minimumTlsVersion
      )
    );
  }

  if (type === "microsoft.sql/servers") {
    checks.push(
      boolCheck(
        "sql.entra-only-auth",
        "SQL server requires Entra-only authentication",
        "high",
        get(properties, "administrators.azureADOnlyAuthentication"),
        ["IA-2", "IA-5"]
      ),
      stringEqualsCheck(
        "sql.public-network-access",
        "SQL public network access is disabled",
        "high",
        properties.publicNetworkAccess,
        "Disabled",
        ["SC-7"]
      )
    );
  }

  if (
    type.includes("microsoft.dbforpostgresql/") ||
    type.includes("microsoft.dbformysql/")
  ) {
    checks.push(
      stringEqualsCheck(
        "database.public-network-access",
        "Database public network access is disabled",
        "high",
        properties.publicNetworkAccess,
        "Disabled",
        ["SC-7"]
      )
    );
  }

  if (type === "microsoft.documentdb/databaseaccounts") {
    checks.push(
      boolCheck(
        "cosmos.local-auth-disabled",
        "Cosmos DB local authentication is disabled",
        "high",
        properties.disableLocalAuth,
        ["IA-2", "IA-5"]
      ),
      stringEqualsCheck(
        "cosmos.public-network-access",
        "Cosmos DB public network access is disabled",
        "high",
        properties.publicNetworkAccess,
        "Disabled",
        ["SC-7"]
      )
    );
  }

  if (
    type === "microsoft.servicebus/namespaces" ||
    type === "microsoft.eventhub/namespaces"
  ) {
    checks.push(
      boolCheck(
        "messaging.local-auth-disabled",
        "Messaging local authentication is disabled",
        "high",
        properties.disableLocalAuth,
        ["IA-2", "IA-5"]
      ),
      stringEqualsCheck(
        "messaging.public-network-access",
        "Messaging public network access is disabled",
        "high",
        properties.publicNetworkAccess,
        "Disabled",
        ["SC-7"]
      )
    );
  }

  if (
    type === "microsoft.cognitiveservices/accounts" ||
    type === "microsoft.search/searchservices"
  ) {
    checks.push(
      boolCheck(
        "ai.local-auth-disabled",
        "AI service local authentication is disabled",
        "high",
        properties.disableLocalAuth,
        ["IA-2", "IA-5"]
      ),
      stringEqualsCheck(
        "ai.public-network-access",
        "AI service public network access is disabled",
        "high",
        properties.publicNetworkAccess,
        "Disabled",
        ["SC-7"]
      )
    );
  }

  if (
    type === "microsoft.recoveryservices/vaults" ||
    type === "microsoft.dataprotection/backupvaults"
  ) {
    checks.push(
      presenceCheck(
        "backup.redundancy",
        "Backup vault storage redundancy is configured",
        "medium",
        properties.redundancySettings ?? properties.storageType,
        ["CP-6", "CP-9"]
      ),
      boolCheck(
        "backup.soft-delete",
        "Backup vault soft delete is enabled",
        "high",
        backupSoftDeleteStatus(properties),
        ["CP-9"]
      )
    );
  }

  return checks.map((check) => check);
}

function boolCheck(
  checkId: string,
  title: string,
  severity: FindingSeverity,
  value: unknown,
  nistControls: string[]
): Check {
  return check(checkId, title, severity, statusForBoolean(value, true), { value }, nistControls);
}

function boolFalseCheck(
  checkId: string,
  title: string,
  severity: FindingSeverity,
  value: unknown,
  nistControls: string[]
): Check {
  return check(checkId, title, severity, statusForBoolean(value, false), { value }, nistControls);
}

function presenceCheck(
  checkId: string,
  title: string,
  severity: FindingSeverity,
  value: unknown,
  nistControls: string[]
): Check {
  return check(
    checkId,
    title,
    severity,
    value === undefined || value === null || value === "" ? "unknown" : "pass",
    { value: value ?? null },
    nistControls
  );
}

function stringEqualsCheck(
  checkId: string,
  title: string,
  severity: FindingSeverity,
  value: unknown,
  expected: string,
  nistControls: string[]
): Check {
  const parsed = stringValue(value);
  return check(
    checkId,
    title,
    severity,
    parsed === undefined
      ? "unknown"
      : parsed.toLowerCase() === expected.toLowerCase()
        ? "pass"
        : "fail",
    { value: parsed ?? null, expected },
    nistControls
  );
}

function stringNotEqualsCheck(
  checkId: string,
  title: string,
  severity: FindingSeverity,
  value: unknown,
  disallowed: string,
  nistControls: string[]
): Check {
  const parsed = stringValue(value);
  return check(
    checkId,
    title,
    severity,
    parsed === undefined
      ? "unknown"
      : parsed.toLowerCase() === disallowed.toLowerCase()
        ? "fail"
        : "pass",
    { value: parsed ?? null, disallowed },
    nistControls
  );
}

function stringAtLeastTls12(checkId: string, title: string, value: unknown): Check {
  const parsed = stringValue(value);
  const version = parsed?.match(/\d+(?:\.\d+)?/)?.[0];
  return check(
    checkId,
    title,
    "high",
    version === undefined ? "unknown" : Number(version) >= 1.2 ? "pass" : "fail",
    { value: parsed ?? null },
    ["SC-8", "SC-13"]
  );
}

function check(
  checkId: string,
  title: string,
  severity: FindingSeverity,
  status: FindingStatus,
  evidence: Record<string, unknown>,
  nistControls: string[]
): Check {
  return { checkId, title, severity, status, evidence, nistControls };
}

function statusForBoolean(value: unknown, expected: boolean): FindingStatus {
  if (typeof value !== "boolean") {
    return "unknown";
  }
  return value === expected ? "pass" : "fail";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function get(value: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function backupSoftDeleteStatus(properties: Record<string, unknown>): boolean | undefined {
  const legacy = stringValue(properties.softDeleteFeatureState);
  const modern = stringValue(
    get(properties, "securitySettings.softDeleteSettings.state")
  );
  if (!legacy && !modern) {
    return undefined;
  }
  return legacy === "Enabled" || modern === "AlwaysOn";
}
