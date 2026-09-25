import 'dotenv/config';
import path from 'node:path';
import { createAaaApp } from './app.js';
import { loadAppAuthConfig } from './appAuth.js';
import { errorDetail, log } from './logger.js';
import { ProjectRegistry } from './projectRegistry.js';
import { AzureOpenAiChatClient } from './services/azureOpenAiChatClient.js';
import { ModelConnectionConfig } from './services/modelConnectionConfig.js';
import { createSessionPersistence } from './sessionStoreFactory.js';

process.on('unhandledRejection', (reason) => {
  log.error('process', 'Unhandled promise rejection.', { error: reason });
});
process.on('uncaughtException', (error) => {
  log.error('process', 'Uncaught exception; the server will exit.', { error });
  process.exit(1);
});

const repositoryRoot = process.env.AAA_ROOT
  ? path.resolve(process.env.AAA_ROOT)
  : process.cwd();
const dataRoot = path.join(repositoryRoot, 'data');
const templateRoot = process.env.AAA_PROJECT_TEMPLATE
  ? path.resolve(process.env.AAA_PROJECT_TEMPLATE)
  : path.join(repositoryRoot, 'templates', 'default-project');

async function startupStep<T>(description: string, action: () => Promise<T> | T): Promise<T> {
  try {
    return await action();
  } catch (error) {
    log.error('startup', `Could not ${description}. AAA cannot start.`, { error: errorDetail(error) });
    process.exit(1);
  }
}

const registry = await startupStep('load the project registry (config/projects.json)', () =>
  ProjectRegistry.load(path.join(repositoryRoot, 'config', 'projects.json'), {
    statePath: path.join(dataRoot, 'projects.json'),
    managedRoot: path.join(dataRoot, 'workspaces'),
    templateRoot
  }));
const modelConfig = await startupStep('load the model connection (config/agent-connections.json)', () =>
  ModelConnectionConfig.load(path.join(repositoryRoot, 'config', 'agent-connections.json')));
const sessionPersistence = await startupStep('configure session storage', () => createSessionPersistence(dataRoot));
const authConfig = await startupStep('configure app sign-in (AAA_AUTH_MODE)', () => loadAppAuthConfig(process.env));
const host = process.env.AAA_HOST?.trim() || '127.0.0.1';
const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
if (!loopback && authConfig.mode !== 'entra') {
  log.error('startup', `Refusing to listen on ${host} without sign-in. Set AAA_AUTH_MODE=entra, or use AAA_HOST=127.0.0.1.`);
  process.exit(1);
}
log.info('startup', authConfig.mode === 'entra' ? 'Microsoft Entra sign-in is required.' : 'App sign-in is off (local mode).', {
  ...(authConfig.mode === 'entra'
    ? { tenant: authConfig.tenantId, clientId: authConfig.clientId, authority: authConfig.authorityHost, roles: authConfig.allowedRoles.join(',') || 'any' }
    : {}),
  host
});

const model = modelConfig.status();
if (model.ready) {
  log.info('startup', 'Model connection configured.', {
    endpointHost: model.endpointHost,
    deployment: model.deployment,
    endpointKind: model.endpointKind,
    api: model.api,
    auth: model.authMode,
    contextWindow: model.contextWindow
  });
} else {
  log.warn('startup', 'Model connection is not ready; chat will be unavailable until it is configured.', {
    missing: model.missing.join(', ')
  });
}
const sessions = sessionPersistence.storageStatus.sessions;
if (!sessions.ready) {
  log.warn('startup', 'Session storage is not ready.', {
    backend: sessions.backend,
    missing: sessions.missing.join(', '),
    invalid: sessions.invalid.join(', ')
  });
} else {
  log.info('startup', 'Session storage configured.', { backend: sessions.backend, endpointHost: sessions.endpointHost });
}

const app = createAaaApp({
  registry,
  dataRoot,
  clientDistPath: path.join(repositoryRoot, 'dist', 'client'),
  modelConfig,
  modelClient: new AzureOpenAiChatClient(),
  auth: { config: authConfig },
  ...sessionPersistence
});
const port = Number(process.env.PORT ?? 8787);

const server = app.listen(port, host, () => {
  console.log(`AAA local API listening on http://${host.includes(':') ? `[${host}]` : host}:${port}`);
});
server.on('error', (error) => {
  log.error('startup', `Could not listen on port ${port}.`, {
    error: (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? 'The port is already in use; stop the other process or set PORT.'
      : error
  });
  process.exit(1);
});
