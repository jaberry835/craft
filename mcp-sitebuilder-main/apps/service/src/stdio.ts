import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { SiteBuilderApplication } from '@mcp-sitebuilder/application';
import { MemorySiteBuilderStore } from '@mcp-sitebuilder/azure-adapters';
import { createSiteBuilderMcp } from './mcp.js';

const application = new SiteBuilderApplication(new MemorySiteBuilderStore());
await application.initialize();
serveStdio(() => createSiteBuilderMcp(application));
