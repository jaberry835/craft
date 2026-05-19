export type PersistenceBackend = 'local' | 'cosmos' | 'blob' | 'key-vault';

export interface PersistenceModeStatus {
  scope: string;
  configured: PersistenceBackend;
  effective: PersistenceBackend;
  fallbackActive: boolean;
  reason?: string;
}

const statuses = new Map<string, PersistenceModeStatus>();

export function updatePersistenceMode(status: PersistenceModeStatus): void {
  statuses.set(status.scope, status);
}

export function listPersistenceModes(): PersistenceModeStatus[] {
  return [...statuses.values()];
}
