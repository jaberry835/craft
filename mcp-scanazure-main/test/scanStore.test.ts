import { describe, expect, it } from "vitest";
import { localCallerIdentity, entraCallerIdentity } from "../src/scan/identity.js";
import { InMemoryScanStore } from "../src/scan/store.js";

describe("in-memory scan store", () => {
  it("strictly isolates scans by caller key", () => {
    const store = createStore();
    const first = entraCallerIdentity("obo", "tenant-one", "object-one");
    const second = entraCallerIdentity("obo", "tenant-one", "object-two");
    const record = store.create(first.key, "subscription", ["inventory"]);

    expect(store.get(first.key, record.scanId)?.scanId).toBe(record.scanId);
    expect(store.get(second.key, record.scanId)).toBeNull();
    expect(record.callerKey).not.toBe(second.key);
    store.dispose();
  });

  it("expires and aborts scans at TTL cleanup", () => {
    let now = Date.parse("2026-09-29T00:00:00Z");
    const store = createStore({ ttlMilliseconds: 1_000, now: () => now });
    const record = store.create(localCallerIdentity().key, "subscription", ["inventory"]);
    now += 1_001;

    store.cleanup(now);

    expect(record.abortController.signal.aborted).toBe(true);
    expect(store.get(localCallerIdentity().key, record.scanId)).toBeNull();
    store.dispose();
  });

  it("evicts the oldest finished scan and protects active scans", () => {
    const store = createStore({ maximumScansPerCaller: 1, maximumScans: 2 });
    const caller = localCallerIdentity();
    const first = store.create(caller.key, "one", ["inventory"]);
    store.mutate(first.scanId, (record) => {
      record.state = "completed";
    });
    const second = store.create(caller.key, "two", ["inventory"]);

    expect(store.get(caller.key, first.scanId)).toBeNull();
    expect(store.get(caller.key, second.scanId)).not.toBeNull();
    expect(() => store.create(caller.key, "three", ["inventory"]))
      .toThrow("Maximum active scans");
    store.dispose();
  });

  it("enforces the configured memory limit", () => {
    const store = createStore({ maximumBytes: 16 });
    const caller = localCallerIdentity();
    const record = store.create(caller.key, "one", ["inventory"]);

    expect(() => store.storeSection(
      record.scanId,
      "inventory",
      { resources: ["value larger than sixteen bytes"] },
      "completed",
      [],
      [],
      1
    )).toThrow("memory limit");
    expect(store.totalBytes).toBe(0);
    store.dispose();
  });

  it("uses the size delta when replacing section data", () => {
    const store = createStore({ maximumBytes: 30 });
    const record = store.create("caller", "subscription", ["inventory"]);
    store.storeSection(
      record.scanId,
      "inventory",
      { value: "1234567890" },
      "completed",
      [],
      [],
      1
    );

    expect(() =>
      store.storeSection(
        record.scanId,
        "inventory",
        { value: "12345678901" },
        "completed",
        [],
        [],
        1
      )
    ).not.toThrow();
    store.dispose();
  });
});

function createStore(overrides: Partial<ConstructorParameters<typeof InMemoryScanStore>[0]> = {}) {
  return new InMemoryScanStore({
    ttlMilliseconds: 60_000,
    maximumScans: 10,
    maximumScansPerCaller: 5,
    maximumBytes: 1_000_000,
    ...overrides
  });
}
