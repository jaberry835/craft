import type { ArmReadClient } from "../azure/arm.js";
import type { TokenCredential } from "@azure/core-auth";
import type { CloudProfile } from "../cloud/profile.js";
import type { ResourceGraphClient } from "../azure/resourceGraph.js";
import type { AzureSubscription } from "../azure/subscriptions.js";
import {
  inventoryResources,
  listResourceGroups
} from "../collectors/inventory.js";
import {
  collectNetworkEndpoints,
  collectNetworkInventory
} from "../collectors/network.js";
import {
  collectPolicyAssignments,
  collectPolicyCompliance,
  collectRoleAssignments,
  collectSecurityPosture,
  collectTenantContext
} from "../collectors/governance.js";
import {
  collectServiceFindings,
  SERVICE_CATEGORIES
} from "../collectors/serviceFindings.js";
import {
  buildNistEvidence,
  collectNistControls,
  collectNistStatus
} from "../collectors/nist.js";
import { collectIdentityPosture } from "../collectors/identity.js";
import { collectKeyVaultItemMetadata } from "../collectors/keyVaultMetadata.js";
import type { CallerIdentity } from "./identity.js";
import {
  InMemoryScanStore,
  type ScanError,
  type ScanRecord
} from "./store.js";

export interface ScanSectionResult {
  data: unknown;
  itemCount: number;
  partial?: boolean;
  notes?: string[];
  errors?: ScanError[];
}

export type ScanSectionRunner = (
  subscriptionId: string,
  signal: AbortSignal
) => Promise<ScanSectionResult>;

export interface ScanManagerDependencies {
  store: InMemoryScanStore;
  resourceGraph: ResourceGraphClient;
  arm: ArmReadClient;
  credential?: TokenCredential;
  cloud?: CloudProfile;
  listSubscriptions: () => Promise<AzureSubscription[]>;
  nistInitiativeIds: ReadonlySet<string>;
  nistNamePatterns: string[];
  keyVaultApiVersion?: string;
  keyVaultExpiryWarningDays?: number;
  concurrency: number;
  sectionRunners?: Record<string, ScanSectionRunner>;
}

export interface ScanProgress {
  scanId: string;
  completedSections: number;
  totalSections: number;
  section: string;
  state: string;
}

export class ScanManager {
  readonly #store: InMemoryScanStore;
  readonly #runners: Record<string, ScanSectionRunner>;
  readonly #concurrency: number;
  readonly #running = new Map<string, Promise<void>>();

  constructor(dependencies: ScanManagerDependencies) {
    this.#store = dependencies.store;
    this.#concurrency = dependencies.concurrency;
    this.#runners = dependencies.sectionRunners ?? createSectionRunners(dependencies);
  }

  start(
    caller: CallerIdentity,
    subscriptionId: string,
    onProgress?: (progress: ScanProgress) => void | Promise<void>
  ): ScanRecord {
    const record = this.#store.create(caller.key, subscriptionId, Object.keys(this.#runners));
    const promise = this.#run(record.scanId, onProgress).finally(() => {
      this.#running.delete(record.scanId);
    });
    this.#running.set(record.scanId, promise);
    return record;
  }

  get(caller: CallerIdentity, scanId: string): ScanRecord | null {
    return this.#store.get(caller.key, scanId);
  }

  async waitFor(scanId: string): Promise<void> {
    await this.#running.get(scanId);
  }

  async #run(
    scanId: string,
    onProgress?: (progress: ScanProgress) => void | Promise<void>
  ): Promise<void> {
    const initial = this.#record(scanId);
    if (!initial) return;
    this.#store.mutate(scanId, (record) => {
      record.state = "running";
      record.startedAt = new Date().toISOString();
    });
    const names = Object.keys(this.#runners);
    let next = 0;
    let completed = 0;
    const worker = async () => {
      while (next < names.length) {
        const name = names[next++];
        if (!name) return;
        const record = this.#record(scanId);
        if (!record || record.abortController.signal.aborted) return;
        const section = record.sections[name];
        if (!section) continue;
        section.state = "running";
        section.startedAt = new Date().toISOString();
        try {
          const result = await this.#runners[name]!(
            record.subscriptionId,
            record.abortController.signal
          );
          if (record.abortController.signal.aborted || !this.#record(scanId)) return;
          this.#store.storeSection(
            scanId,
            name,
            result.data,
            result.partial || result.errors?.length ? "partial" : "completed",
            result.notes ?? [],
            result.errors ?? [],
            result.itemCount
          );
        } catch (error) {
          if (record.abortController.signal.aborted || !this.#record(scanId)) return;
          const message = error instanceof Error ? error.message : String(error);
          this.#store.mutate(scanId, (current) => {
            const failed = current.sections[name];
            if (!failed) return;
            failed.state = "failed";
            failed.completedAt = new Date().toISOString();
            failed.errors = [{ code: "CollectorFailed", message }];
            current.errors.push({ code: `${name}.CollectorFailed`, message });
          });
        }
        completed++;
        if (onProgress) {
          try {
            await onProgress({
              scanId,
              completedSections: completed,
              totalSections: names.length,
              section: name,
              state: this.#record(scanId)?.sections[name]?.state ?? "cancelled"
            });
          } catch {
            // Progress delivery is optional. Polling remains authoritative.
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.#concurrency, names.length) }, () => worker())
    );
    this.#store.mutate(scanId, (record) => {
      if (record.abortController.signal.aborted) {
        record.state = "cancelled";
        for (const section of Object.values(record.sections)) {
          if (section.state === "pending" || section.state === "running") {
            section.state = "cancelled";
            section.completedAt = new Date().toISOString();
          }
        }
      } else {
        const states = Object.values(record.sections).map((section) => section.state);
        const failed = states.filter((state) => state === "failed").length;
        const partial = states.filter((state) => state === "partial").length;
        const succeeded = states.filter((state) => state === "completed" || state === "partial").length;
        record.state = failed === states.length
          ? "failed"
          : failed > 0 || partial > 0 || succeeded < states.length ? "partial" : "completed";
      }
      record.completedAt = new Date().toISOString();
    });
  }

  #record(scanId: string): ScanRecord | null {
    // Internal orchestration deliberately bypasses caller lookup but never returns data.
    let found: ScanRecord | null = null;
    this.#store.mutate(scanId, (record) => {
      found = record;
    });
    return found;
  }
}

function createSectionRunners(
  dependencies: ScanManagerDependencies
): Record<string, ScanSectionRunner> {
  const graph = dependencies.resourceGraph;
  const arm = dependencies.arm;
  const matchOptions = {
    initiativeIds: dependencies.nistInitiativeIds,
    namePatterns: dependencies.nistNamePatterns
  };
  const phase8a = dependencies.credential && dependencies.cloud
    ? {
        identityPosture: () =>
          collectIdentityPosture(dependencies.credential!, dependencies.cloud!),
        keyVaultMetadata: (subscriptionId: string) =>
          collectKeyVaultItemMetadata(
            graph,
            dependencies.credential!,
            dependencies.cloud!,
            subscriptionId,
            { apiVersion: dependencies.keyVaultApiVersion }
          )
      }
    : null;
  return {
    resourceGroups: async (subscriptionId, signal) => {
      const values = [];
      let token: string | undefined;
      let partial = false;
      const notes: string[] = [];
      do {
        throwIfAborted(signal);
        const page = await listResourceGroups(graph, subscriptionId, 1_000, token);
        values.push(...page.data);
        token = page.nextPageToken ?? undefined;
        if (page.incompleteReason) {
          partial = true;
          notes.push(page.incompleteReason);
          break;
        }
      } while (token);
      return { data: values, itemCount: values.length, partial, notes };
    },
    inventory: async (subscriptionId, signal) => {
      const resources = [];
      let token: string | undefined;
      let summary: unknown = null;
      const notes: string[] = [];
      do {
        throwIfAborted(signal);
        const page = await inventoryResources(graph, subscriptionId, {}, 1_000, token);
        resources.push(...page.data);
        summary ??= page.summary;
        token = page.nextPageToken ?? undefined;
        if (page.incompleteReason) {
          notes.push(page.incompleteReason);
          break;
        }
      } while (token);
      return {
        data: { summary, resources },
        itemCount: resources.length,
        partial: notes.length > 0,
        notes
      };
    },
    network: async (subscriptionId, signal) => {
      throwIfAborted(signal);
      const value = await collectNetworkInventory(graph, subscriptionId);
      return {
        data: value,
        itemCount: value.resources.length,
        partial: !value.summary.complete,
        notes: value.summary.incompleteReasons
      };
    },
    endpoints: async (subscriptionId, signal) => {
      throwIfAborted(signal);
      const value = await collectNetworkEndpoints(graph, subscriptionId);
      return {
        data: value,
        itemCount: value.endpoints.length,
        partial: !value.complete,
        notes: value.incompleteReasons
      };
    },
    serviceFindings: async (subscriptionId, signal) => {
      throwIfAborted(signal);
      const value = await collectServiceFindings(graph, arm, subscriptionId, [...SERVICE_CATEGORIES]);
      return {
        data: value,
        itemCount: value.findings.length,
        partial: !value.complete || value.errors.length > 0,
        notes: value.incompleteReasons,
        errors: value.errors.map((error) => ({ code: error.code, message: error.message }))
      };
    },
    policyAssignments: async (subscriptionId, signal) => {
      throwIfAborted(signal);
      const value = await collectPolicyAssignments(graph, subscriptionId);
      return accessResult(value.assignments, value.access);
    },
    policyCompliance: async (subscriptionId, signal) => {
      throwIfAborted(signal);
      const value = await collectPolicyCompliance(graph, subscriptionId);
      return {
        data: value,
        itemCount: value.resources.length,
        partial: !value.access.complete,
        notes: value.access.notes
      };
    },
    securityPosture: async (subscriptionId, signal) => {
      throwIfAborted(signal);
      const value = await collectSecurityPosture(graph, subscriptionId);
      return {
        data: value,
        itemCount: value.unhealthyAssessments.length,
        partial: !value.access.complete,
        notes: value.access.notes
      };
    },
    roleAssignments: async (subscriptionId, signal) => {
      throwIfAborted(signal);
      const value = await collectRoleAssignments(graph, subscriptionId);
      return accessResult(value.assignments, value.access);
    },
    tenantContext: async (_subscriptionId, signal) => {
      throwIfAborted(signal);
      const subscriptions = await dependencies.listSubscriptions();
      const value = await collectTenantContext(graph, subscriptions);
      return {
        data: value,
        itemCount:
          value.managementGroups.length + value.subscriptions.length
          + value.policyAssignments.length + value.roleAssignments.length,
        partial: !value.access.complete,
        notes: value.access.notes
      };
    },
    ...(phase8a
      ? {
          keyVaultMetadata: async (subscriptionId: string, signal: AbortSignal) => {
            throwIfAborted(signal);
            const value = await phase8a.keyVaultMetadata(subscriptionId);
            return {
              data: value,
              itemCount: value.items.length,
              partial: value.checks.some((check) => check.status !== "available"),
              notes: value.checks.flatMap((check) => check.notes.map((note) =>
                `${check.vaultName}/${check.itemType}: ${note}`
              ))
            };
          },
          identityPosture: async (_subscriptionId: string, signal: AbortSignal) => {
            throwIfAborted(signal);
            const value = await phase8a.identityPosture();
            return {
              data: value,
              itemCount: value.checks.reduce((count, check) => count + check.data.length, 0),
              partial: value.checks.some((check) => check.status !== "available"),
              notes: value.checks.flatMap((check) => check.notes.map((note) =>
                `${check.id}: ${note}`
              ))
            };
          }
        }
      : {}),
    nistStatus: async (subscriptionId, signal) => {
      throwIfAborted(signal);
      const value = await collectNistStatus(graph, subscriptionId, matchOptions);
      return {
        data: value,
        itemCount: 1,
        partial: value.availability !== "available" || value.access.notes.length > 0,
        notes: value.access.notes
      };
    },
    nistControls: async (subscriptionId, signal) => {
      throwIfAborted(signal);
      const value = await collectNistControls(graph, subscriptionId, matchOptions);
      return {
        data: value,
        itemCount: value.controls.length,
        partial: value.status.availability !== "available" || value.status.access.notes.length > 0,
        notes: value.status.access.notes
      };
    },
    nistEvidence: async (subscriptionId, signal) => {
      throwIfAborted(signal);
      const value = await buildNistEvidence(
        graph,
        arm,
        subscriptionId,
        matchOptions,
        phase8a
          ? {
              identityPosture: phase8a.identityPosture,
              keyVaultMetadata: () => phase8a.keyVaultMetadata(subscriptionId),
              keyVaultExpiryWarningDays:
                dependencies.keyVaultExpiryWarningDays
            }
          : {}
      );
      return {
        data: value,
        itemCount: value.controls.length,
        partial: value.access.notes.length > 0,
        notes: value.access.notes
      };
    }
  };
}

function accessResult(
  data: unknown[],
  access: { complete: boolean; notes: string[] }
): ScanSectionResult {
  return {
    data,
    itemCount: data.length,
    partial: !access.complete,
    notes: access.notes
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Scan cancelled");
}
