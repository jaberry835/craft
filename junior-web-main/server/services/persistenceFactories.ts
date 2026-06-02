import type { WorkspaceSummary } from '../types.js';
import { CosmosChatSessionStore } from './cosmosChatSessionStore.js';
import { CosmosPendingChangeStore } from './cosmosPendingChangeStore.js';
import { CosmosWorkspaceStateStore } from './cosmosWorkspaceStateStore.js';
import { CosmosWorkspaceMetadataStore } from './cosmosWorkspaceMetadataStore.js';
import { createOptionalCosmosContainer } from './cosmosContainerFactory.js';
import { FallbackChatSessionStore } from './fallbackChatSessionStore.js';
import { FallbackPendingChangeStore } from './fallbackPendingChangeStore.js';
import { FallbackWorkspaceMetadataStore } from './fallbackWorkspaceMetadataStore.js';
import { FallbackWorkspaceSecretStore } from './fallbackWorkspaceSecretStore.js';
import { FallbackWorkspaceStateStore } from './fallbackWorkspaceStateStore.js';
import { createOptionalKeyVaultSecretClient } from './keyVaultSecretClientFactory.js';
import type { ChatSessionStore } from './chatSessionStore.js';
import { InMemoryPendingChangeStore } from './inMemoryPendingChangeStore.js';
import { KeyVaultWorkspaceSecretStore } from './keyVaultWorkspaceSecretStore.js';
import { LocalChatSessionStore } from './localChatSessionStore.js';
import { LocalWorkspaceMetadataStore } from './localWorkspaceMetadataStore.js';
import { LocalWorkspaceSecretStore } from './localWorkspaceSecretStore.js';
import { LocalWorkspaceStateStore } from './localWorkspaceStateStore.js';
import type { PendingChangeStore } from './pendingChangeStore.js';
import type { WorkspaceMetadataStore } from './workspaceMetadataStore.js';
import type { WorkspaceSecretStore } from './workspaceSecretStore.js';
import type { WorkspaceStateStore } from './workspaceStateStore.js';
import type { WorkspaceStorage } from './workspaceStorage.js';

export function createWorkspaceMetadataStore(workspacesRoot: string): WorkspaceMetadataStore {
  const local = new LocalWorkspaceMetadataStore(workspacesRoot);
  const cosmos = createOptionalCosmosContainer({
    label: 'workspace-metadata-store',
    containerEnvVar: 'COSMOS_DB_WORKSPACE_CONTAINER',
    defaultContainerId: 'Workspaces'
  });

  return cosmos
    ? new FallbackWorkspaceMetadataStore(new CosmosWorkspaceMetadataStore(cosmos), local)
    : local;
}

export function createChatSessionStore(workspace: WorkspaceSummary): ChatSessionStore {
  const local = new LocalChatSessionStore(workspace.rootPath);
  const cosmos = createOptionalCosmosContainer({
    label: 'chat-session-store',
    containerEnvVar: 'COSMOS_DB_CHAT_CONTAINER',
    defaultContainerId: 'ChatSessions'
  });

  return cosmos
    ? new FallbackChatSessionStore(new CosmosChatSessionStore(cosmos, workspace), local)
    : local;
}

export function createPendingChangeStore(workspace: WorkspaceSummary): PendingChangeStore {
  const local = new InMemoryPendingChangeStore();
  const cosmos = createOptionalCosmosContainer({
    label: 'pending-change-store',
    containerEnvVar: 'COSMOS_DB_PENDING_CHANGE_CONTAINER',
    defaultContainerId: 'PendingChanges'
  });

  return cosmos
    ? new FallbackPendingChangeStore(new CosmosPendingChangeStore(cosmos, workspace), local)
    : local;
}

export function createWorkspaceStateStore(workspace: WorkspaceSummary, storage: WorkspaceStorage): WorkspaceStateStore {
  const configContainerEnvVar = process.env.COSMOS_DB_WORKSPACE_CONFIG_CONTAINER
    ? 'COSMOS_DB_WORKSPACE_CONFIG_CONTAINER'
    : 'COSMOS_DB_WORKSPACE_STATE_CONTAINER';
  const local = new LocalWorkspaceStateStore(storage);
  const cosmos = createOptionalCosmosContainer({
    label: 'workspace-config-store',
    containerEnvVar: configContainerEnvVar,
    defaultContainerId: 'WorkspaceConfig'
  });

  return cosmos
    ? new FallbackWorkspaceStateStore(new CosmosWorkspaceStateStore(cosmos, workspace), local)
    : local;
}

export function createWorkspaceSecretStore(workspace: WorkspaceSummary): WorkspaceSecretStore {
  const local = new LocalWorkspaceSecretStore(workspace.rootPath);
  const keyVault = createOptionalKeyVaultSecretClient('workspace-secret-store');

  return keyVault
    ? new FallbackWorkspaceSecretStore(new KeyVaultWorkspaceSecretStore(keyVault, workspace), local)
    : local;
}