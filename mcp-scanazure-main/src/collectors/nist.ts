import { analyzeGenericConfiguration } from "../analyzers/generic.js";
import type { ArmReadClient } from "../azure/arm.js";
import type { ResourceGraphClient } from "../azure/resourceGraph.js";
import { collectNetworkInventory } from "./network.js";
import { collectServiceFindings, SERVICE_CATEGORIES } from "./serviceFindings.js";
import {
  controlFamily,
  familyName,
  matchesConfiguredNist,
  NIST_STANDARD,
  normalizeControlId
} from "../nist/mapping.js";
import type { IdentityPosture } from "./identity.js";
import type { KeyVaultMetadataResult } from "./keyVaultMetadata.js";

export interface NistSourceAccess {
  defender: "available" | "unavailable";
  policy: "available" | "unavailable";
  genericFindings?: "available" | "unavailable";
  networkFindings?: "available" | "partial" | "unavailable";
  serviceFindings?: "available" | "partial" | "unavailable";
  identityPosture?: "available" | "partial" | "unavailable";
  keyVaultMetadata?: "available" | "partial" | "unavailable";
  notes: string[];
}

export interface NistAssessment {
  id: string;
  controlId: string;
  title: string | null;
  state: string;
  assessmentKey: string | null;
  resourceId: string | null;
  severity: string | null;
  source: "defender";
}

export interface NistControl {
  id: string;
  family: string;
  familyName: string;
  title: string | null;
  state: string;
  passedAssessments: number;
  failedAssessments: number;
  skippedAssessments: number;
  assessments: NistAssessment[];
  failedResources: string[];
}

export interface NistStatus {
  standard: string;
  enabled: boolean | null;
  availability: "available" | "partial" | "unavailable";
  source: "defender" | "policy" | "both" | "none" | "unknown";
  defender: {
    available: boolean;
    enabled: boolean | null;
    standards: Array<Record<string, unknown>>;
  };
  policy: {
    available: boolean;
    enabled: boolean | null;
    assignments: Array<Record<string, unknown>>;
  };
  assignmentScopes: string[];
  lastEvaluated: string | null;
  controlSummary: Record<string, number>;
  access: NistSourceAccess;
}

export interface NistMatchOptions {
  initiativeIds: ReadonlySet<string>;
  namePatterns: string[];
}

export interface Phase8aEvidenceSources {
  identityPosture?: () => Promise<IdentityPosture>;
  keyVaultMetadata?: () => Promise<KeyVaultMetadataResult>;
  keyVaultExpiryWarningDays?: number;
}

interface RegulatoryData {
  available: boolean;
  complete: boolean;
  rows: Array<Record<string, unknown>>;
  notes: string[];
}

interface PolicyData {
  available: boolean;
  complete: boolean;
  assignments: Array<Record<string, unknown>>;
  states: Array<Record<string, unknown>>;
  notes: string[];
}

export async function collectNistStatus(
  graph: ResourceGraphClient,
  subscriptionId: string,
  options: NistMatchOptions
): Promise<NistStatus> {
  const [regulatory, policy] = await Promise.all([
    queryRegulatory(graph, subscriptionId),
    queryPolicy(graph, subscriptionId)
  ]);
  const standards = regulatory.rows
    .filter((row) => isType(row, "regulatorycompliancestandards"))
    .filter((row) => rowMatches(row, options));
  const assignments = policy.assignments.filter((row) => assignmentMatches(row, options));
  const inferredAssignments = policy.states.filter((row) => assignmentMatches(row, options));
  const policyMatches = dedupeRows([...assignments, ...inferredAssignments]);
  const defenderEnabled = standards.length > 0 ? true : regulatory.complete ? false : null;
  const policyEnabled = policyMatches.length > 0 ? true : policy.complete ? false : null;
  const enabled = defenderEnabled === true || policyEnabled === true
    ? true
    : defenderEnabled === false && policyEnabled === false ? false : null;
  const controls = buildControls(regulatory.rows, standards, options);
  const controlSummary = countBy(controls, (control) => control.state);
  const sources = [
    defenderEnabled === true ? "defender" : null,
    policyEnabled === true ? "policy" : null
  ].filter(Boolean);
  return {
    standard: NIST_STANDARD,
    enabled,
    availability: regulatory.complete && policy.complete
      ? "available"
      : regulatory.available || policy.available ? "partial" : "unavailable",
    source: sources.length === 2 ? "both" : sources[0] as "defender" | "policy" | undefined
      ?? (enabled === false ? "none" : "unknown"),
    defender: {
      available: regulatory.available,
      enabled: defenderEnabled,
      standards: standards.map(summarizeStandard)
    },
    policy: {
      available: policy.available,
      enabled: policyEnabled,
      assignments: policyMatches.map(summarizeAssignment)
    },
    assignmentScopes: [...new Set(policyMatches.map(assignmentScope).filter((value): value is string => Boolean(value)))].sort(),
    lastEvaluated: latestTimestamp(regulatory.rows),
    controlSummary,
    access: {
      defender: regulatory.available ? "available" : "unavailable",
      policy: policy.available ? "available" : "unavailable",
      notes: [...regulatory.notes, ...policy.notes]
    }
  };
}

export async function collectNistControls(
  graph: ResourceGraphClient,
  subscriptionId: string,
  options: NistMatchOptions
): Promise<{ controls: NistControl[]; status: NistStatus }> {
  const [regulatory, policy] = await Promise.all([
    queryRegulatory(graph, subscriptionId),
    queryPolicy(graph, subscriptionId)
  ]);
  const standards = regulatory.rows
    .filter((row) => isType(row, "regulatorycompliancestandards"))
    .filter((row) => rowMatches(row, options));
  const controls = buildControls(regulatory.rows, standards, options);
  const status = await statusFromData(regulatory, policy, options, controls);
  const unresolvedResources = controls.reduce(
    (count, control) =>
      count + control.assessments.filter((assessment) => !assessment.resourceId).length,
    0
  );
  const missingAssessmentDetails = controls.reduce((count, control) => {
    const expected =
      control.passedAssessments + control.failedAssessments + control.skippedAssessments;
    return count + Math.max(0, expected - control.assessments.length);
  }, 0);
  if (unresolvedResources > 0) {
    status.access.notes.push(
      `${unresolvedResources} Defender regulatory assessment rows had no visible resource-level result`
    );
  }
  if (missingAssessmentDetails > 0) {
    status.access.notes.push(
      `${missingAssessmentDetails} summarized Defender assessments had no visible assessment-detail row`
    );
  }
  if (status.access.notes.length && status.availability === "available") {
    status.availability = "partial";
  }
  return { controls, status };
}

export async function buildNistEvidence(
  graph: ResourceGraphClient,
  arm: ArmReadClient,
  subscriptionId: string,
  options: NistMatchOptions,
  phase8a: Phase8aEvidenceSources = {}
): Promise<{
  status: NistStatus;
  controls: Array<Record<string, unknown>>;
  access: NistSourceAccess;
}> {
  const [{ controls: defenderControls, status }, policy, generic, network, service, identity, keyVault] = await Promise.all([
    collectNistControls(graph, subscriptionId, options),
    queryPolicy(graph, subscriptionId),
    collectGenericEvidence(graph, subscriptionId),
    safely("network findings", () => collectNetworkInventory(graph, subscriptionId)),
    safely("service findings", () => collectServiceFindings(graph, arm, subscriptionId, [...SERVICE_CATEGORIES])),
    phase8a.identityPosture
      ? safely("identity posture", phase8a.identityPosture)
      : Promise.resolve({ value: null, error: null }),
    phase8a.keyVaultMetadata
      ? safely("Key Vault metadata", phase8a.keyVaultMetadata)
      : Promise.resolve({ value: null, error: null })
  ]);
  const evidence = new Map<string, {
    id: string; family: string; familyName: string; title: string | null;
    defenderStatus: string | null; failedAssessments: number;
    evidence: Array<Record<string, unknown>>; gaps: Array<Record<string, unknown>>;
    failedResources: string[];
  }>();
  for (const control of defenderControls) {
    evidence.set(control.id, {
      id: control.id, family: control.family, familyName: control.familyName,
      title: control.title, defenderStatus: control.state,
      failedAssessments: control.failedAssessments, evidence: [], gaps: [],
      failedResources: [...control.failedResources]
    });
  }
  const findings = [
    ...generic.value,
    ...(network.value?.findings ?? []).map((finding) => ({ ...finding, status: "fail" })),
    ...(service.value?.findings ?? [])
  ];
  const seen = new Set<string>();
  for (const finding of findings) {
    for (const rawControl of finding.nistControls) {
      const controlId = normalizeControlId(rawControl);
      if (!controlId) continue;
      const resourceId = "resourceId" in finding && typeof finding.resourceId === "string"
        ? finding.resourceId : "";
      const key = `${controlId}|${finding.checkId}|${resourceId}|${finding.status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const control = ensureEvidenceControl(evidence, controlId);
      const target = finding.status === "fail" || finding.status === "unknown"
        ? control.gaps : control.evidence;
      target.push({
        checkId: finding.checkId,
        title: finding.title,
        status: finding.status,
        resourceId: resourceId || null,
        severity: finding.severity,
        source: "source" in finding ? finding.source : "resourceGraph"
      });
      if (finding.status === "fail" && resourceId) control.failedResources.push(resourceId);
    }
  }
  let mappedPolicyStates = 0;
  let matchingPolicyStates = 0;
  for (const row of policy.states) {
    if (!assignmentMatches(row, options)) continue;
    matchingPolicyStates++;
    const properties = object(row.properties);
    const controlId = normalizeControlId(
      text(row.policyDefinitionReferenceId)
      ?? text(properties.policyDefinitionReferenceId)
      ?? text(row.policyDefinitionName)
      ?? text(properties.policyDefinitionName)
      ?? ""
    );
    if (!controlId) continue;
    mappedPolicyStates++;
    const state = normalizedState(text(row.complianceState) ?? text(properties.complianceState));
    const control = ensureEvidenceControl(evidence, controlId);
    const item = {
      checkId: `policy:${text(row.policyDefinitionId) ?? text(properties.policyDefinitionId) ?? "unknown"}`,
      title: text(row.policyDefinitionName) ?? text(properties.policyDefinitionName),
      status: state === "compliant" ? "pass" : state === "noncompliant" ? "fail" : "unknown",
      resourceId: text(row.resourceId) ?? text(properties.resourceId),
      source: "policy"
    };
    (item.status === "pass" ? control.evidence : control.gaps).push(item);
    if (item.status === "fail" && item.resourceId) control.failedResources.push(item.resourceId);
  }
  if (identity.value) addIdentityEvidence(evidence, identity.value);
  if (keyVault.value) {
    addKeyVaultEvidence(
      evidence,
      keyVault.value,
      phase8a.keyVaultExpiryWarningDays ?? 30
    );
  }
  const notes = [...status.access.notes];
  if (!policy.available) notes.push(...policy.notes);
  if (matchingPolicyStates > mappedPolicyStates) {
    notes.push(`${matchingPolicyStates - mappedPolicyStates} NIST policy state rows could not be mapped to a control ID`);
  }
  if (generic.error) notes.push(generic.error);
  if (network.error) notes.push(network.error);
  if (network.value && !network.value.summary.complete) {
    notes.push(...network.value.summary.incompleteReasons);
  }
  if (service.error) notes.push(service.error);
  if (service.value && (!service.value.complete || service.value.errors.length)) {
    notes.push(...service.value.incompleteReasons, ...service.value.errors.map((error) => `${error.source}: ${error.message}`));
  }
  if (identity.error) notes.push(identity.error);
  if (identity.value) {
    notes.push(...identity.value.checks.flatMap((check) =>
      check.status === "available" ? [] : check.notes.map((note) => `Identity ${check.id}: ${note}`)
    ));
  }
  if (keyVault.error) notes.push(keyVault.error);
  if (keyVault.value) {
    notes.push(...keyVault.value.checks.flatMap((check) =>
      check.status === "available" ? [] : check.notes.map((note) =>
        `Key Vault ${check.vaultName}/${check.itemType}: ${note}`
      )
    ));
  }
  const access: NistSourceAccess = {
    ...status.access,
    genericFindings: generic.error ? "unavailable" : "available",
    networkFindings: network.error ? "unavailable"
      : network.value && !network.value.summary.complete ? "partial" : "available",
    serviceFindings: service.error ? "unavailable"
      : service.value && (!service.value.complete || service.value.errors.length) ? "partial" : "available",
    ...(phase8a.identityPosture
      ? {
          identityPosture: identity.error || !identity.value ? "unavailable" as const
            : identity.value.checks.every((check) => check.status === "available")
              ? "available" as const
              : identity.value.checks.some((check) =>
                  check.status === "available" || check.status === "partial"
                )
                ? "partial" as const : "unavailable" as const
        }
      : {}),
    ...(phase8a.keyVaultMetadata
      ? {
          keyVaultMetadata: keyVault.error || !keyVault.value ? "unavailable" as const
            : keyVault.value.checks.every((check) => check.status === "available")
              ? "available" as const
              : keyVault.value.checks.some((check) =>
                  check.status === "available" || check.status === "partial"
                )
                ? "partial" as const : "unavailable" as const
        }
      : {}),
    notes: [...new Set(notes)]
  };
  return {
    status,
    controls: [...evidence.values()].map((control) => ({
      ...control,
      failedResources: [...new Set(control.failedResources)].sort(),
      evidence: aggregateFindings(control.evidence),
      gaps: aggregateFindings(control.gaps)
    })).sort((a, b) => a.id.localeCompare(b.id)),
    access
  };
}

function addIdentityEvidence(
  evidence: Map<string, {
    id: string; family: string; familyName: string; title: string | null;
    defenderStatus: string | null; failedAssessments: number;
    evidence: Array<Record<string, unknown>>; gaps: Array<Record<string, unknown>>;
    failedResources: string[];
  }>,
  posture: IdentityPosture
): void {
  for (const check of posture.checks) {
    for (const rawControl of check.nistControls) {
      const controlId = normalizeControlId(rawControl);
      if (!controlId) continue;
      const control = ensureEvidenceControl(evidence, controlId);
      if (check.status !== "available") {
        control.gaps.push({
          checkId: `identity.${check.id}`,
          status: "unknown",
          source: "microsoftGraph",
          evidenceGap: "identity data not accessible",
          accessStatus: check.status,
          requiredPermissions: check.requiredPermissions
        });
        if (check.status !== "partial") continue;
      }
      const status = identityEvidenceStatus(check.id, check.summary);
      (status === "fail" ? control.gaps : control.evidence).push({
        checkId: `identity.${check.id}`,
        status,
        source: "microsoftGraph",
        summary: check.summary
      });
    }
  }
}

function identityEvidenceStatus(
  id: string,
  summary: Record<string, unknown>
): "pass" | "fail" | "observed" {
  if (id === "securityDefaults" && typeof summary.enabled === "boolean") {
    return summary.enabled ? "pass" : "fail";
  }
  if (id === "mfaRegistration" && typeof summary.notRegistered === "number") {
    return summary.notRegistered === 0 ? "pass" : "fail";
  }
  return "observed";
}

function addKeyVaultEvidence(
  evidence: Map<string, {
    id: string; family: string; familyName: string; title: string | null;
    defenderStatus: string | null; failedAssessments: number;
    evidence: Array<Record<string, unknown>>; gaps: Array<Record<string, unknown>>;
    failedResources: string[];
  }>,
  metadata: KeyVaultMetadataResult,
  expiryWarningDays: number
): void {
  for (const check of metadata.checks.filter((value) => value.status !== "available")) {
    const controls = check.itemType === "certificate" ? ["SC-17"] : ["IA-5", "SC-12"];
    for (const controlId of controls) {
      ensureEvidenceControl(evidence, controlId).gaps.push({
        checkId: `keyvault.${check.itemType}-metadata`,
        status: "unknown",
        source: "keyVaultDataPlane",
        resourceId: check.vaultId,
        evidenceGap: check.status === "partial"
          ? "Key Vault item metadata is only partially accessible"
          : "Key Vault item metadata not accessible",
        accessStatus: check.status
      });
    }
  }
  for (const item of metadata.items) {
    const controls = item.itemType === "certificate" ? ["SC-17"] : ["IA-5", "SC-12"];
    const expiryStatus = item.daysUntilExpiry === null
      ? "unknown"
      : item.daysUntilExpiry < 0
        ? "fail"
        : item.daysUntilExpiry <= expiryWarningDays ? "fail" : "pass";
    for (const controlId of controls) {
      const control = ensureEvidenceControl(evidence, controlId);
      (expiryStatus === "pass" ? control.evidence : control.gaps).push({
        checkId: `keyvault.${item.itemType}-expiry`,
        status: expiryStatus,
        source: "keyVaultDataPlane",
        resourceId: item.vaultId,
        itemName: item.name,
        expiresAt: item.expiresAt,
        daysUntilExpiry: item.daysUntilExpiry,
        ...(item.expiresAt === null ? { evidenceGap: "expiry is not configured" } : {})
      });
    }
    if (item.itemType === "key") {
      const hasRotation = Array.isArray(item.rotationPolicy?.lifetimeActions)
        && item.rotationPolicy.lifetimeActions.length > 0;
      const control = ensureEvidenceControl(evidence, "SC-12");
      (hasRotation ? control.evidence : control.gaps).push({
        checkId: "keyvault.key-rotation-policy",
        status: hasRotation ? "pass" : "unknown",
        source: "keyVaultDataPlane",
        resourceId: item.vaultId,
        itemName: item.name,
        ...(!hasRotation ? { evidenceGap: "rotation policy not visible or not configured" } : {})
      });
    }
    if (item.itemType === "certificate") {
      const lifetimeActions = item.certificatePolicy?.lifetimeActions;
      const hasAutoRenew = Array.isArray(lifetimeActions) && lifetimeActions.some((action) => {
        const actionRecord = object(action);
        const actionType = text(object(actionRecord.action).action_type)
          ?? text(object(actionRecord.action).actionType);
        return actionType?.toLowerCase() === "autorenew";
      });
      const control = ensureEvidenceControl(evidence, "SC-17");
      (hasAutoRenew ? control.evidence : control.gaps).push({
        checkId: "keyvault.certificate-auto-renew",
        status: hasAutoRenew ? "pass" : "unknown",
        source: "keyVaultDataPlane",
        resourceId: item.vaultId,
        itemName: item.name,
        ...(!hasAutoRenew
          ? { evidenceGap: "certificate auto-renew policy not visible or not configured" }
          : {})
      });
    }
  }
}

async function queryRegulatory(graph: ResourceGraphClient, subscriptionId: string): Promise<RegulatoryData> {
  try {
    const result = await graph.queryAll({
      subscriptions: [subscriptionId],
      query: `
SecurityResources
| where type in~ (
    'microsoft.security/regulatorycompliancestandards',
    'microsoft.security/regulatorycompliancestandards/regulatorycompliancecontrols',
    'microsoft.security/regulatorycompliancestandards/regulatorycompliancecontrols/regulatorycomplianceassessments',
    'microsoft.security/assessments')
| project id, name, type=tolower(type), subscriptionId, properties
| order by type asc, id asc`,
      pageSize: 1_000
    });
    return {
      available: true,
      complete: result.complete,
      rows: result.data.map(object),
      notes: result.complete ? [] : [result.incompleteReason ?? "Defender regulatory compliance query was incomplete"]
    };
  } catch (error) {
    return { available: false, complete: false, rows: [], notes: [`Defender regulatory compliance unavailable: ${message(error)}`] };
  }
}

async function queryPolicy(graph: ResourceGraphClient, subscriptionId: string): Promise<PolicyData> {
  const notes: string[] = [];
  let assignmentAvailable = false;
  let stateAvailable = false;
  let assignments: Array<Record<string, unknown>> = [];
  let states: Array<Record<string, unknown>> = [];
  await Promise.all([
    graph.queryAll({
      subscriptions: [subscriptionId],
      query: `
PolicyResources
| where type =~ 'microsoft.authorization/policyassignments'
| project id, name, properties
| order by id asc`, pageSize: 1_000
    }).then((result) => {
      assignmentAvailable = true;
      assignments = result.data.map(object);
      if (!result.complete) notes.push(result.incompleteReason ?? "Policy assignment query was incomplete");
    }).catch((error) => notes.push(`Policy assignments unavailable: ${message(error)}`)),
    graph.queryAll({
      subscriptions: [subscriptionId],
      query: `
PolicyResources
| where type =~ 'microsoft.policyinsights/policystates'
| project id, properties,
    assignmentId=tostring(properties.policyAssignmentId),
    assignmentName=tostring(properties.policyAssignmentName),
    assignmentScope=tostring(properties.policyAssignmentScope),
    policyDefinitionId=tostring(properties.policyDefinitionId),
    policySetDefinitionId=tostring(properties.policySetDefinitionId),
    policyDefinitionName=tostring(properties.policyDefinitionName),
    policyDefinitionReferenceId=tostring(properties.policyDefinitionReferenceId),
    complianceState=tostring(properties.complianceState),
    resourceId=tostring(properties.resourceId),
    timestamp=tostring(properties.timestamp)
| order by assignmentId asc, id asc`, pageSize: 1_000
    }).then((result) => {
      stateAvailable = true;
      states = result.data.map(object);
      if (!result.complete) notes.push(result.incompleteReason ?? "Policy state query was incomplete");
    }).catch((error) => notes.push(`Policy states unavailable: ${message(error)}`))
  ]);
  return {
    available: assignmentAvailable || stateAvailable,
    complete: assignmentAvailable && stateAvailable && notes.length === 0,
    assignments,
    states,
    notes
  };
}

async function statusFromData(
  regulatory: RegulatoryData,
  policy: PolicyData,
  options: NistMatchOptions,
  controls: NistControl[]
): Promise<NistStatus> {
  const standards = regulatory.rows.filter((row) => isType(row, "regulatorycompliancestandards") && rowMatches(row, options));
  const matches = dedupeRows([
    ...policy.assignments.filter((row) => assignmentMatches(row, options)),
    ...policy.states.filter((row) => assignmentMatches(row, options))
  ]);
  const defenderEnabled = standards.length > 0 ? true : regulatory.complete ? false : null;
  const policyEnabled = matches.length > 0 ? true : policy.complete ? false : null;
  const enabled = defenderEnabled === true || policyEnabled === true ? true
    : defenderEnabled === false && policyEnabled === false ? false : null;
  const active = [defenderEnabled ? "defender" : null, policyEnabled ? "policy" : null].filter(Boolean);
  return {
    standard: NIST_STANDARD, enabled,
    availability: regulatory.complete && policy.complete ? "available" : regulatory.available || policy.available ? "partial" : "unavailable",
    source: active.length === 2 ? "both" : active[0] as "defender" | "policy" | undefined ?? (enabled === false ? "none" : "unknown"),
    defender: { available: regulatory.available, enabled: defenderEnabled, standards: standards.map(summarizeStandard) },
    policy: { available: policy.available, enabled: policyEnabled, assignments: matches.map(summarizeAssignment) },
    assignmentScopes: [...new Set(matches.map(assignmentScope).filter((value): value is string => Boolean(value)))].sort(),
    lastEvaluated: latestTimestamp(regulatory.rows),
    controlSummary: countBy(controls, (control) => control.state),
    access: {
      defender: regulatory.available ? "available" : "unavailable",
      policy: policy.available ? "available" : "unavailable",
      notes: [...regulatory.notes, ...policy.notes]
    }
  };
}

function buildControls(
  rows: Array<Record<string, unknown>>,
  standards: Array<Record<string, unknown>>,
  options: NistMatchOptions
): NistControl[] {
  const standardIds = standards.map((row) => text(row.id)?.toLowerCase()).filter(Boolean) as string[];
  const controlRows = rows.filter((row) =>
    isType(row, "regulatorycompliancecontrols") &&
    (standardIds.some((id) => text(row.id)?.toLowerCase().startsWith(`${id}/`)) || rowMatches(row, options))
  );
  const genericAssessments = rows.filter((row) => isType(row, "microsoft.security/assessments"));
  return controlRows.flatMap((row): NistControl[] => {
    const properties = object(row.properties);
    const id = controlIdFromRow(row);
    if (!id) return [];
    const childRows = rows.filter((candidate) =>
      isType(candidate, "regulatorycomplianceassessments") &&
      text(candidate.id)?.toLowerCase().startsWith(`${text(row.id)?.toLowerCase()}/`)
    );
    const assessments = childRows.flatMap((assessment): NistAssessment[] => {
      const assessmentProperties = object(assessment.properties);
      const key = text(assessmentProperties.assessmentId) ?? text(assessment.name);
      const matchingResources = genericAssessments.filter((candidate) => {
        const candidateProperties = object(candidate.properties);
        return key && (text(candidate.name)?.toLowerCase() === key.toLowerCase()
          || text(candidateProperties.assessmentKey)?.toLowerCase() === key.toLowerCase());
      });
      const base = {
        id: text(assessment.id) ?? key ?? `${id}:assessment`,
        controlId: id,
        title: text(assessmentProperties.description) ?? text(assessmentProperties.displayName),
        state: normalizedState(text(assessmentProperties.state) ?? text(assessmentProperties.status)),
        assessmentKey: key,
        severity: text(object(assessmentProperties.metadata).severity),
        source: "defender" as const
      };
      return matchingResources.length
        ? matchingResources.map((resource) => ({
            ...base,
            resourceId: text(object(object(resource.properties).resourceDetails).id)
              ?? text(object(resource.properties).resourceId)
          }))
        : [{ ...base, resourceId: text(assessmentProperties.resourceId) }];
    });
    const state = normalizedState(text(properties.state));
    const failedResources = assessments
      .filter((assessment) => assessment.state === "failed" || assessment.state === "unhealthy")
      .map((assessment) => assessment.resourceId)
      .filter((value): value is string => Boolean(value));
    return [{
      id,
      family: controlFamily(id),
      familyName: familyName(controlFamily(id)),
      title: text(properties.description) ?? text(properties.displayName),
      state,
      passedAssessments: integer(properties.passedAssessments) ?? assessments.filter((item) => item.state === "passed" || item.state === "healthy").length,
      failedAssessments: integer(properties.failedAssessments) ?? assessments.filter((item) => item.state === "failed" || item.state === "unhealthy").length,
      skippedAssessments: integer(properties.skippedAssessments) ?? assessments.filter((item) => item.state === "skipped").length,
      assessments,
      failedResources: [...new Set(failedResources)].sort()
    }];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

async function collectGenericEvidence(graph: ResourceGraphClient, subscriptionId: string) {
  return safely("generic findings", async () => {
    const result = await graph.queryAll({
      subscriptions: [subscriptionId],
      query: `
Resources
| project id, name, type=tolower(type), tags, identity, properties
| order by id asc`, pageSize: 1_000
    });
    if (!result.complete) throw new Error(result.incompleteReason ?? "Generic resource query was incomplete");
    return result.data.flatMap((resource) => {
      const type = text(resource.type);
      if (!type) return [];
      return analyzeGenericConfiguration({
        type,
        tags: object(resource.tags),
        identity: object(resource.identity),
        properties: object(resource.properties)
      }).map((finding) => ({
        ...finding,
        resourceId: text(resource.id) ?? ""
      }));
    });
  }, []);
}

async function safely<T>(label: string, action: () => Promise<T>, fallback?: T): Promise<{ value: T; error: string | null }> {
  try {
    return { value: await action(), error: null };
  } catch (error) {
    return { value: fallback as T, error: `${label} unavailable: ${message(error)}` };
  }
}

function ensureEvidenceControl(
  values: Map<string, {
    id: string; family: string; familyName: string; title: string | null;
    defenderStatus: string | null; failedAssessments: number;
    evidence: Array<Record<string, unknown>>; gaps: Array<Record<string, unknown>>;
    failedResources: string[];
  }>,
  id: string
) {
  let value = values.get(id);
  if (!value) {
    const family = controlFamily(id);
    value = {
      id, family, familyName: familyName(family), title: null,
      defenderStatus: null, failedAssessments: 0, evidence: [], gaps: [], failedResources: []
    };
    values.set(id, value);
  }
  return value;
}

function aggregateFindings(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const item of items) {
    const key = `${String(item.checkId)}|${String(item.status)}|${String(item.source)}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const evidenceGaps = [...new Set(group.map((item) => item.evidenceGap)
      .filter((value): value is string => typeof value === "string"))];
    const permissions = [...new Set(group.flatMap((item) =>
      Array.isArray(item.requiredPermissions)
        ? item.requiredPermissions.filter((value): value is string => typeof value === "string")
        : []
    ))].sort();
    return {
      checkId: group[0]?.checkId,
      title: group[0]?.title,
      status: group[0]?.status,
      source: group[0]?.source,
      resourceCount: new Set(group.map((item) => item.resourceId).filter(Boolean)).size,
      resources: [...new Set(group.map((item) => item.resourceId)
        .filter((value): value is string => typeof value === "string"))].sort(),
      ...(evidenceGaps.length === 1 ? { evidenceGap: evidenceGaps[0] }
        : evidenceGaps.length > 1 ? { evidenceGaps } : {}),
      ...(permissions.length ? { requiredPermissions: permissions } : {}),
      details: group.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) =>
        !["checkId", "title", "status", "source", "resourceId", "requiredPermissions"].includes(key)
      )))
    };
  }).sort((a, b) => String(a.checkId).localeCompare(String(b.checkId)));
}

function rowMatches(row: Record<string, unknown>, options: NistMatchOptions): boolean {
  const properties = object(row.properties);
  return matchesConfiguredNist([
    text(row.id), text(row.name), text(properties.displayName),
    text(properties.standardName), text(properties.name)
  ], options.initiativeIds, options.namePatterns);
}
function assignmentMatches(row: Record<string, unknown>, options: NistMatchOptions): boolean {
  const properties = object(row.properties);
  return matchesConfiguredNist([
    text(row.policyDefinitionId), text(properties.policyDefinitionId),
    text(row.policySetDefinitionId), text(properties.policySetDefinitionId),
    text(row.assignmentName), text(properties.displayName), text(row.name)
  ], options.initiativeIds, options.namePatterns);
}
function controlIdFromRow(row: Record<string, unknown>): string | null {
  const properties = object(row.properties);
  const id = text(properties.controlId) ?? text(row.name)
    ?? segmentAfter(text(row.id), "regulatoryComplianceControls") ?? "";
  return normalizeControlId(id);
}
function summarizeStandard(row: Record<string, unknown>): Record<string, unknown> {
  const properties = object(row.properties);
  return {
    id: text(row.id), name: text(row.name),
    displayName: text(properties.displayName),
    state: normalizedState(text(properties.state)),
    passedControls: integer(properties.passedControls),
    failedControls: integer(properties.failedControls),
    skippedControls: integer(properties.skippedControls),
    unsupportedControls: integer(properties.unsupportedControls)
  };
}
function summarizeAssignment(row: Record<string, unknown>): Record<string, unknown> {
  const properties = object(row.properties);
  return {
    id: text(row.id) ?? text(row.assignmentId),
    name: text(row.name) ?? text(row.assignmentName),
    displayName: text(properties.displayName),
    policyDefinitionId: text(row.policyDefinitionId) ?? text(properties.policyDefinitionId),
    policySetDefinitionId: text(row.policySetDefinitionId) ?? text(properties.policySetDefinitionId),
    scope: assignmentScope(row)
  };
}
function assignmentScope(row: Record<string, unknown>): string | null {
  const properties = object(row.properties);
  return text(row.assignmentScope) ?? text(properties.scope) ?? parentScope(text(row.id));
}
function latestTimestamp(rows: Array<Record<string, unknown>>): string | null {
  const values = rows.flatMap((row) => {
    const properties = object(row.properties);
    return [text(properties.timestamp), text(properties.lastEvaluated), text(properties.assessmentDate)].filter((value): value is string => Boolean(value));
  }).sort();
  return values.at(-1) ?? null;
}
function dedupeRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const values = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const properties = object(row.properties);
    const key = text(row.id) ?? text(row.assignmentId) ?? text(properties.policyDefinitionId) ?? JSON.stringify(row);
    values.set(key.toLowerCase(), row);
  }
  return [...values.values()];
}
function isType(row: Record<string, unknown>, suffix: string): boolean {
  return (text(row.type) ?? "").toLowerCase().endsWith(suffix.toLowerCase());
}
function normalizedState(value: string | null): string {
  return (value ?? "unknown").replace(/\s+/g, "").toLowerCase();
}
function segmentAfter(id: string | null, segment: string): string | null {
  if (!id) return null;
  const parts = id.split("/");
  const index = parts.findIndex((part) => part.toLowerCase() === segment.toLowerCase());
  return index >= 0 ? parts[index + 1] ?? null : null;
}
function parentScope(id: string | null): string | null {
  if (!id) return null;
  const marker = id.toLowerCase().lastIndexOf("/providers/microsoft.authorization/");
  return marker > 0 ? id.slice(0, marker) : null;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}
function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}
function countBy<T>(values: T[], selector: (value: T) => string): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = selector(value);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
