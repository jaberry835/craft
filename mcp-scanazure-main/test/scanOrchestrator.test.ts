import { describe, expect, it } from "vitest";
import type { ArmReadClient } from "../src/azure/arm.js";
import type { ResourceGraphClient } from "../src/azure/resourceGraph.js";
import { localCallerIdentity } from "../src/scan/identity.js";
import { ScanManager, type ScanSectionRunner } from "../src/scan/orchestrator.js";
import { InMemoryScanStore } from "../src/scan/store.js";

describe("scan orchestration", () => {
  it("transitions through running to completed with bounded concurrency", async () => {
    let active = 0;
    let maximumActive = 0;
    const runner = (name: string): ScanSectionRunner => async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { data: [{ name }], itemCount: 1 };
    };
    const manager = createManager({
      first: runner("first"),
      second: runner("second"),
      third: runner("third")
    }, 2);
    const record = manager.start(localCallerIdentity(), subscriptionId);
    expect(["queued", "running"]).toContain(record.state);

    await manager.waitFor(record.scanId);

    const result = manager.get(localCallerIdentity(), record.scanId);
    expect(result?.state).toBe("completed");
    expect(Object.values(result?.sections ?? {}).every((section) => section.state === "completed"))
      .toBe(true);
    expect(maximumActive).toBe(2);
  });

  it("keeps successful sections when another collector fails", async () => {
    const manager = createManager({
      inventory: async () => ({ data: [{ id: "one" }], itemCount: 1 }),
      network: async () => {
        throw new Error("network table unavailable");
      },
      policy: async () => ({
        data: [],
        itemCount: 0,
        partial: true,
        notes: ["policy states incomplete"]
      })
    });
    const caller = localCallerIdentity();
    const record = manager.start(caller, subscriptionId);

    await manager.waitFor(record.scanId);

    const result = manager.get(caller, record.scanId);
    expect(result?.state).toBe("partial");
    expect(result?.sections.inventory?.state).toBe("completed");
    expect(result?.sections.network).toMatchObject({
      state: "failed",
      errors: [{ code: "CollectorFailed", message: "network table unavailable" }]
    });
    expect(result?.sections.policy?.state).toBe("partial");
  });
});

const subscriptionId = "11111111-1111-1111-1111-111111111111";

function createManager(
  sectionRunners: Record<string, ScanSectionRunner>,
  concurrency = 3
): ScanManager {
  return new ScanManager({
    store: new InMemoryScanStore({
      ttlMilliseconds: 60_000,
      maximumScans: 10,
      maximumScansPerCaller: 5,
      maximumBytes: 1_000_000
    }),
    resourceGraph: {} as ResourceGraphClient,
    arm: {} as ArmReadClient,
    listSubscriptions: async () => [],
    nistInitiativeIds: new Set(),
    nistNamePatterns: [],
    concurrency,
    sectionRunners
  });
}
