import './telemetry.js';
import { SiteBuilderApplication, startBoundedWorker } from '@mcp-sitebuilder/application';
import { AzureSiteBuilderStore, MemorySiteBuilderStore } from '@mcp-sitebuilder/azure-adapters';
import { createApp } from './app.js';

function createStore() {
  if (process.env.STORAGE_BACKEND === 'memory' || !process.env.AZURE_STORAGE_ACCOUNT_NAME) {
    return new MemorySiteBuilderStore();
  }
  return new AzureSiteBuilderStore();
}

const application = new SiteBuilderApplication(createStore());
await application.initialize();
const worker = startBoundedWorker(application, {
  intervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 1_000),
  onError: (error) => console.error('Worker cycle failed.', error),
});
const app = createApp(application);
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? (process.env.WEBSITE_INSTANCE_ID ? '0.0.0.0' : '127.0.0.1');
const server = app.listen(port, host, () => {
  console.log(`MCP Site Builder listening at http://${host}:${port}`);
});
server.requestTimeout = 120_000;
server.headersTimeout = 125_000;

const shutdown = async (): Promise<void> => {
  await worker.stop();
  server.close();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
