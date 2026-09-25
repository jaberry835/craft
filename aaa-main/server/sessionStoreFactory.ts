import type { ChatSessionStore, ChatSessionStoreFactory } from './chatSessionStore.js';
import { CosmosChatSessionStore } from './cosmosChatSessionStore.js';
import {
  createCosmosContainer,
  type CosmosContainerBinding
} from './cosmosContainerFactory.js';
import { StorageUnavailableError } from './httpErrors.js';
import { JsonSessionStore } from './sessionStore.js';
import {
  resolveStorageConfig,
  type CosmosSessionConfig,
  type StorageStatus
} from './storageConfig.js';

export interface SessionPersistence {
  sessionStoreFactory: ChatSessionStoreFactory;
  storageStatus: StorageStatus;
}

export interface SessionPersistenceOptions {
  environment?: NodeJS.ProcessEnv;
  createContainer?: (config: CosmosSessionConfig) => CosmosContainerBinding;
}

export function createSessionPersistence(
  dataRoot: string,
  options: SessionPersistenceOptions = {}
): SessionPersistence {
  const resolved = resolveStorageConfig(options.environment);
  if (resolved.status.sessions.backend === 'local') {
    return {
      sessionStoreFactory: createLocalSessionStoreFactory(dataRoot),
      storageStatus: resolved.status
    };
  }
  if (!resolved.cosmos) {
    return {
      sessionStoreFactory: () => new UnavailableChatSessionStore(
        `Cosmos DB chat session storage is configured but unavailable. `
        + `Missing or invalid environment variables: ${
          [...resolved.status.sessions.missing, ...resolved.status.sessions.invalid].join(', ')
        }.`
      ),
      storageStatus: resolved.status
    };
  }

  try {
    const binding = (options.createContainer ?? createCosmosContainer)(resolved.cosmos);
    return {
      sessionStoreFactory: (projectId) =>
        new CosmosChatSessionStore(
          binding,
          projectId,
          resolved.cosmos!.schemaMode,
          resolved.cosmos!.ownerId
        ),
      storageStatus: resolved.status
    };
  } catch {
    return {
      sessionStoreFactory: () => new UnavailableChatSessionStore(
        'Cosmos DB chat session storage is configured but could not be initialized.'
      ),
      storageStatus: {
        ...resolved.status,
        sessions: { ...resolved.status.sessions, ready: false, active: false }
      }
    };
  }
}

export function createLocalSessionStoreFactory(dataRoot: string): ChatSessionStoreFactory {
  return (projectId) => new JsonSessionStore(dataRoot, projectId);
}

class UnavailableChatSessionStore implements ChatSessionStore {
  constructor(private readonly message: string) {}

  list(): Promise<never> {
    return this.unavailable();
  }

  create(): Promise<never> {
    return this.unavailable();
  }

  get(): Promise<never> {
    return this.unavailable();
  }

  rename(): Promise<never> {
    return this.unavailable();
  }

  delete(): Promise<never> {
    return this.unavailable();
  }

  append(): Promise<never> {
    return this.unavailable();
  }

  saveRun(): Promise<never> {
    return this.unavailable();
  }

  saveCompaction(): Promise<never> {
    return this.unavailable();
  }

  private unavailable(): Promise<never> {
    return Promise.reject(new StorageUnavailableError(this.message));
  }
}
