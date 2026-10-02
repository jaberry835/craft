import type { TokenCredential } from "@azure/core-auth";
import type { CloudProfile } from "../cloud/profile.js";
import {
  ReadOnlyDataPlaneClient,
  type DataPlaneStatus
} from "../azure/readOnlyDataPlane.js";

export type IdentityCheckId =
  | "conditionalAccess"
  | "securityDefaults"
  | "mfaRegistration"
  | "directoryRoles"
  | "pimEligibility"
  | "guests"
  | "authenticationMethods";

export interface IdentityPostureCheck {
  id: IdentityCheckId;
  status: DataPlaneStatus;
  requiredPermissions: string[];
  nistControls: string[];
  summary: Record<string, unknown>;
  data: Array<Record<string, unknown>>;
  notes: string[];
}

export interface IdentityPosture {
  checks: IdentityPostureCheck[];
}

const DEFINITIONS: Array<{
  id: IdentityCheckId;
  path: string;
  permissions: string[];
  controls: string[];
}> = [
  {
    id: "conditionalAccess",
    path: "/v1.0/identity/conditionalAccess/policies",
    permissions: ["Policy.Read.All"],
    controls: ["AC-2", "AC-7", "IA-2"]
  },
  {
    id: "securityDefaults",
    path: "/v1.0/policies/identitySecurityDefaultsEnforcementPolicy",
    permissions: ["Policy.Read.All"],
    controls: ["IA-2"]
  },
  {
    id: "mfaRegistration",
    path: "/v1.0/reports/authenticationMethods/userRegistrationDetails",
    permissions: ["AuditLog.Read.All"],
    controls: ["IA-2(1)", "IA-2(2)"]
  },
  {
    id: "directoryRoles",
    path: "/v1.0/roleManagement/directory/roleAssignments?$expand=principal,roleDefinition",
    permissions: ["RoleManagement.Read.Directory"],
    controls: ["AC-2", "AC-6"]
  },
  {
    id: "pimEligibility",
    path: "/v1.0/roleManagement/directory/roleEligibilitySchedules?$expand=principal,roleDefinition",
    permissions: ["RoleEligibilitySchedule.Read.Directory"],
    controls: ["AC-2(7)", "AC-6"]
  },
  {
    id: "guests",
    path: "/v1.0/users?$filter=userType%20eq%20%27Guest%27&$count=true&$select=id,accountEnabled,createdDateTime",
    permissions: ["User.Read.All"],
    controls: ["AC-2"]
  },
  {
    id: "authenticationMethods",
    path: "/v1.0/policies/authenticationMethodsPolicy",
    permissions: ["Policy.Read.AuthenticationMethod"],
    controls: ["IA-2", "IA-5"]
  }
];

export async function collectIdentityPosture(
  credential: TokenCredential,
  cloud: CloudProfile,
  fetcher: typeof fetch = fetch
): Promise<IdentityPosture> {
  if (!cloud.graphEndpoint) {
    return {
      checks: DEFINITIONS.map((definition) => unavailableCheck(
        definition,
        "Microsoft Graph endpoint is not configured for this cloud"
      ))
    };
  }
  const client = new ReadOnlyDataPlaneClient(
    credential,
    cloud.graphEndpoint,
    cloud.graphEndpoint,
    fetcher
  );
  const checks = await Promise.all(DEFINITIONS.map(async (definition) => {
    if (definition.id === "securityDefaults" || definition.id === "authenticationMethods") {
      const result = await client.get(definition.path);
      const data = result.data ? [sanitizeGraphRecord(result.data)] : [];
      return check(definition, result.status, data, result.notes);
    }
    const result = await client.getAll(definition.path, definition.id === "guests"
      ? { ConsistencyLevel: "eventual" }
      : {});
    const data = result.data.map(sanitizeGraphRecord);
    if (definition.id === "guests" && result.status === "available") {
      const authorization = await client.get("/v1.0/policies/authorizationPolicy");
      if (authorization.data) {
        data.push({ kind: "authorizationPolicy", ...sanitizeGraphRecord(authorization.data) });
      }
      if (authorization.status !== "available") {
        result.notes.push(`Authorization policy: ${authorization.notes.join("; ")}`);
        result.status = result.data.length > 0 ? "partial" : authorization.status;
      }
    }
    return check(
      definition,
      result.status,
      data,
      result.notes
    );
  }));
  return { checks };
}

function check(
  definition: typeof DEFINITIONS[number],
  status: DataPlaneStatus,
  data: Array<Record<string, unknown>>,
  notes: string[]
): IdentityPostureCheck {
  const summary: Record<string, unknown> = { count: data.length };
  if (definition.id === "conditionalAccess") {
    summary.enabled = data.filter((item) => item.state === "enabled").length;
    summary.requireMfa = data.filter(requiresMfa).length;
    summary.blocksLegacyAuthentication = data.filter(blocksLegacyAuthentication).length;
  } else if (definition.id === "securityDefaults") {
    summary.enabled = data[0]?.isEnabled ?? null;
  } else if (definition.id === "mfaRegistration") {
    summary.registered = data.filter((item) => item.isMfaRegistered === true).length;
    summary.notRegistered = data.filter((item) => item.isMfaRegistered === false).length;
  } else if (definition.id === "guests") {
    const guests = data.filter((item) => item.kind !== "authorizationPolicy");
    summary.count = guests.length;
    summary.enabled = guests.filter((item) => item.accountEnabled === true).length;
    summary.authorizationPolicyVisible = data.some((item) => item.kind === "authorizationPolicy");
  } else if (definition.id === "directoryRoles") {
    summary.globalAdministrators = data.filter((item) =>
      String(object(item.roleDefinition).displayName ?? "").toLowerCase()
        === "global administrator"
    ).length;
  }
  return {
    id: definition.id,
    status,
    requiredPermissions: definition.permissions,
    nistControls: definition.controls,
    summary,
    data,
    notes
  };
}

function unavailableCheck(
  definition: typeof DEFINITIONS[number],
  note: string
): IdentityPostureCheck {
  return check(definition, "unavailable", [], [note]);
}

function sanitizeGraphRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    key !== "@odata.context" && key !== "@odata.nextLink"
  ));
}

function requiresMfa(item: Record<string, unknown>): boolean {
  const grant = object(item.grantControls);
  return array(grant.builtInControls).some((value) => String(value).toLowerCase() === "mfa");
}

function blocksLegacyAuthentication(item: Record<string, unknown>): boolean {
  const conditions = object(item.conditions);
  const clients = array(conditions.clientAppTypes).map((value) => String(value).toLowerCase());
  const grant = object(item.grantControls);
  return clients.some((value) => value === "exchangeactivesync" || value === "other")
    && String(grant.operator ?? "").toUpperCase() === "OR"
    && array(grant.builtInControls).some((value) => String(value).toLowerCase() === "block");
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
