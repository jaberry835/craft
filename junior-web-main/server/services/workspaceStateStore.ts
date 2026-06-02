export interface WorkspaceStateStore {
  readJson<T>(key: string, fallback: T): Promise<T>;
  writeJson<T>(key: string, value: T): Promise<void>;
}