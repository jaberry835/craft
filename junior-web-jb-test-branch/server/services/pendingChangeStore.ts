import type { PendingChange } from '../types.js';

export interface PendingChangeStore {
  list(): Promise<PendingChange[]>;
  get(changeId: string): Promise<PendingChange | undefined>;
  findByPath(path: string): Promise<PendingChange | undefined>;
  save(change: PendingChange): Promise<void>;
  delete(changeId: string): Promise<void>;
  clear(): Promise<void>;
}