import { randomUUID } from "node:crypto";

export type ScanState = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
export type ScanSectionState = "pending" | "running" | "completed" | "partial" | "failed" | "cancelled";

export interface ScanError {
  code: string;
  message: string;
}

export interface ScanSection {
  name: string;
  state: ScanSectionState;
  startedAt: string | null;
  completedAt: string | null;
  itemCount: number;
  notes: string[];
  errors: ScanError[];
  data: unknown;
  bytes: number;
}

export interface ScanRecord {
  scanId: string;
  callerKey: string;
  subscriptionId: string;
  state: ScanState;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
  sections: Record<string, ScanSection>;
  errors: ScanError[];
  bytes: number;
  abortController: AbortController;
}

export interface ScanStoreOptions {
  ttlMilliseconds: number;
  maximumScans: number;
  maximumScansPerCaller: number;
  maximumBytes: number;
  now?: () => number;
}

export class InMemoryScanStore {
  readonly #options: ScanStoreOptions;
  readonly #records = new Map<string, ScanRecord>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: ScanStoreOptions) {
    this.#options = options;
  }

  create(callerKey: string, subscriptionId: string, sectionNames: string[]): ScanRecord {
    this.cleanup();
    this.#makeCapacity(callerKey);
    const now = this.#now();
    const scanId = randomUUID();
    const sections = Object.fromEntries(sectionNames.map((name) => [name, {
      name,
      state: "pending" as const,
      startedAt: null,
      completedAt: null,
      itemCount: 0,
      notes: [],
      errors: [],
      data: null,
      bytes: 0
    }]));
    const record: ScanRecord = {
      scanId,
      callerKey,
      subscriptionId,
      state: "queued",
      createdAt: iso(now),
      startedAt: null,
      completedAt: null,
      expiresAt: iso(now + this.#options.ttlMilliseconds),
      sections,
      errors: [],
      bytes: 0,
      abortController: new AbortController()
    };
    this.#records.set(scanId, record);
    const timer = setTimeout(() => this.#remove(scanId, true), this.#options.ttlMilliseconds);
    timer.unref?.();
    this.#timers.set(scanId, timer);
    return record;
  }

  get(callerKey: string, scanId: string): ScanRecord | null {
    this.cleanup();
    const record = this.#records.get(scanId);
    return record?.callerKey === callerKey ? record : null;
  }

  mutate(scanId: string, action: (record: ScanRecord) => void): boolean {
    const record = this.#records.get(scanId);
    if (!record) return false;
    action(record);
    return true;
  }

  storeSection(
    scanId: string,
    sectionName: string,
    data: unknown,
    state: "completed" | "partial",
    notes: string[],
    errors: ScanError[],
    itemCount: number
  ): void {
    const record = this.#records.get(scanId);
    const section = record?.sections[sectionName];
    if (!record || !section) return;
    const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
    const additionalBytes = Math.max(0, bytes - section.bytes);
    this.#evictForBytes(additionalBytes, scanId);
    if (this.totalBytes + additionalBytes > this.#options.maximumBytes) {
      throw new Error("Scan memory limit exceeded");
    }
    record.bytes -= section.bytes;
    section.data = data;
    section.bytes = bytes;
    record.bytes += bytes;
    section.state = state;
    section.notes = notes;
    section.errors = errors;
    section.itemCount = itemCount;
    section.completedAt = iso(this.#now());
  }

  cleanup(now = this.#now()): void {
    for (const record of this.#records.values()) {
      if (Date.parse(record.expiresAt) <= now) this.#remove(record.scanId, true);
    }
  }

  dispose(): void {
    for (const record of this.#records.values()) record.abortController.abort();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#records.clear();
  }

  get size(): number {
    return this.#records.size;
  }

  get totalBytes(): number {
    let total = 0;
    for (const record of this.#records.values()) total += record.bytes;
    return total;
  }

  #makeCapacity(callerKey: string): void {
    const callerRecords = [...this.#records.values()].filter((record) => record.callerKey === callerKey);
    while (callerRecords.length >= this.#options.maximumScansPerCaller) {
      const victim = oldestEvictable(callerRecords);
      if (!victim) throw new Error("Maximum active scans reached for this caller");
      this.#remove(victim.scanId, false);
      callerRecords.splice(callerRecords.indexOf(victim), 1);
    }
    while (this.#records.size >= this.#options.maximumScans) {
      const victim = oldestEvictable([...this.#records.values()]);
      if (!victim) throw new Error("Maximum active scans reached");
      this.#remove(victim.scanId, false);
    }
  }

  #evictForBytes(requiredBytes: number, protectedScanId: string): void {
    while (this.totalBytes + requiredBytes > this.#options.maximumBytes) {
      const victim = oldestEvictable(
        [...this.#records.values()].filter((record) => record.scanId !== protectedScanId)
      );
      if (!victim) return;
      this.#remove(victim.scanId, false);
    }
  }

  #remove(scanId: string, expired: boolean): void {
    const record = this.#records.get(scanId);
    if (!record) return;
    if (expired) record.abortController.abort("Scan TTL expired");
    const timer = this.#timers.get(scanId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(scanId);
    this.#records.delete(scanId);
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}

function oldestEvictable(records: ScanRecord[]): ScanRecord | null {
  return records
    .filter((record) => record.state !== "running" && record.state !== "queued")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0] ?? null;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}
