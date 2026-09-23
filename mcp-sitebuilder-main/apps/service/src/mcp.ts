import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { SiteBuilderApplication } from '@mcp-sitebuilder/application';
import {
  CreateSiteDraftSchema,
  PublishOperationSchema,
  SiteCatalogEntrySchema,
  SiteDraftSummarySchema,
  SiteIdSchema,
  SiteManifestSchema,
  UpsertSiteFilesSchema,
} from '@mcp-sitebuilder/contracts';

const operationIdInputSchema = z.object({
  operationId: z.uuid().describe('Operation ID returned by publish_site.'),
});
const siteIdInputSchema = z.object({ siteId: SiteIdSchema });
const siteListOutputSchema = z.object({ sites: z.array(SiteCatalogEntrySchema) });
const deleteSiteOutputSchema = z.object({ siteId: SiteIdSchema, deleted: z.boolean() });

export const mcpToolProfiles = {
  create_site_draft: {
    name: 'create_site_draft',
    title: 'Create site draft',
    description: 'Start a durable empty site draft. Folders are implicit in later file paths.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    governance: ['Stores metadata only', 'Does not publish public content'],
  },
  upsert_site_files: {
    name: 'upsert_site_files',
    title: 'Add or replace draft files',
    description:
      'Add or replace one or many .md/.txt files in a draft. Nested paths create folders implicitly.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    governance: ['Validates all paths and aggregate limits', 'Does not publish public content'],
  },
  get_site_draft: {
    name: 'get_site_draft',
    title: 'Get site draft',
    description: 'Get draft metadata and file paths without returning file content.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    governance: ['Returns file names and byte counts only', 'Returns no staged content'],
  },
  publish_site_draft: {
    name: 'publish_site_draft',
    title: 'Publish site draft',
    description:
      'Queue publication of a completed draft. Poll get_publish_status with the returned operationId.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    governance: ['Snapshots the draft before queueing', 'Uses immutable-version-first publication'],
  },
  publish_site: {
    name: 'publish_site',
    title: 'Publish documentation site',
    description:
      'One-shot publish for a small complete site. For iterative or large sites use the draft tools.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    governance: [
      'Validates paths and size limits',
      'Sanitizes Markdown and escapes plain text',
      'Queues durable asynchronous work',
    ],
  },
  get_publish_status: {
    name: 'get_publish_status',
    title: 'Get publish status',
    description:
      'Poll a publish operation. Stop at succeeded or failed; succeeded includes siteUrl and failed includes error.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    governance: ['Read-only operation record access', 'Returns no staged document content'],
  },
  list_sites: {
    name: 'list_sites',
    title: 'List published sites',
    description: 'List current published sites. Use get_site when only one known siteId is needed.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    governance: ['Read-only catalog access', 'Returns current successful publications only'],
  },
  get_site: {
    name: 'get_site',
    title: 'Get published site',
    description: 'Get one published site and its stable URL by siteId. Returns an error if absent.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    governance: ['Read-only catalog access', 'Stable site identifiers only'],
  },
  delete_site: {
    name: 'delete_site',
    title: 'Delete published site',
    description:
      'Permanently remove a site and its catalog entry. Call only when deletion is explicitly requested.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    governance: [
      'Client should require human confirmation',
      'Catalog entry is removed before version cleanup',
    ],
  },
} as const;

export const mcpServerProfile = {
  name: 'mcp-sitebuilder',
  version: '0.1.0',
  endpoint: '/mcp',
  transport: 'Streamable HTTP',
  protocolVersion: '2026-07-28',
  discovery:
    'Connect and use the standard tools/list request. A browser GET is not an MCP discovery request.',
  tools: Object.values(mcpToolProfiles),
  governance: [
    'REST and MCP invoke the same SiteBuilderApplication use cases.',
    'Caller-provided CSS, JavaScript, npm packages, and executable templates are rejected.',
    'Every generated page includes a controlled classification marking that defaults to UNCLASSIFIED.',
    'Publication uploads an immutable version before changing stable pointers or the catalog.',
    'The deployment restricts the MCP and REST ingress to the configured caller network.',
    'Tool annotations are hints; MCP clients must treat them as untrusted and apply their own consent policy.',
  ],
} as const;

function result(value: unknown, summary: string) {
  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function createSiteBuilderMcp(application: SiteBuilderApplication): McpServer {
  const server = new McpServer(
    { name: 'mcp-sitebuilder', version: '0.1.0' },
    {
      instructions:
        'For iterative sites: create_site_draft, call upsert_site_files with one or many files as needed, optionally verify with get_site_draft, then publish_site_draft and poll get_publish_status. Folder paths are implicit. Use publish_site only for a small one-shot site.',
    },
  );

  server.registerTool(
    'create_site_draft',
    {
      title: mcpToolProfiles.create_site_draft.title,
      description: mcpToolProfiles.create_site_draft.description,
      inputSchema: CreateSiteDraftSchema,
      outputSchema: SiteDraftSummarySchema,
      annotations: mcpToolProfiles.create_site_draft.annotations,
    },
    async (input) => {
      const draft = await application.createDraft(input);
      return result(draft, `Created draft ${draft.siteId}.`);
    },
  );

  server.registerTool(
    'upsert_site_files',
    {
      title: mcpToolProfiles.upsert_site_files.title,
      description: mcpToolProfiles.upsert_site_files.description,
      inputSchema: UpsertSiteFilesSchema,
      outputSchema: SiteDraftSummarySchema,
      annotations: mcpToolProfiles.upsert_site_files.annotations,
    },
    async (input) => {
      const draft = await application.upsertDraftFiles(input);
      return result(draft, `Draft ${draft.siteId} now has ${draft.fileCount} file(s).`);
    },
  );

  server.registerTool(
    'get_site_draft',
    {
      title: mcpToolProfiles.get_site_draft.title,
      description: mcpToolProfiles.get_site_draft.description,
      inputSchema: siteIdInputSchema,
      outputSchema: SiteDraftSummarySchema,
      annotations: mcpToolProfiles.get_site_draft.annotations,
    },
    async ({ siteId }) => {
      const draft = await application.getDraft(siteId);
      if (!draft) {
        return {
          content: [{ type: 'text', text: `Draft ${siteId} was not found.` }],
          isError: true,
        };
      }
      return result(draft, `Draft ${siteId} has ${draft.fileCount} file(s).`);
    },
  );

  server.registerTool(
    'publish_site_draft',
    {
      title: mcpToolProfiles.publish_site_draft.title,
      description: mcpToolProfiles.publish_site_draft.description,
      inputSchema: siteIdInputSchema,
      outputSchema: PublishOperationSchema,
      annotations: mcpToolProfiles.publish_site_draft.annotations,
    },
    async ({ siteId }) => {
      const operation = await application.publishDraft(siteId);
      return result(operation, `Queued draft ${siteId} as operation ${operation.operationId}.`);
    },
  );

  server.registerTool(
    'publish_site',
    {
      title: mcpToolProfiles.publish_site.title,
      description: mcpToolProfiles.publish_site.description,
      inputSchema: SiteManifestSchema,
      outputSchema: PublishOperationSchema,
      annotations: mcpToolProfiles.publish_site.annotations,
    },
    async (input) => {
      const operation = await application.publish(input);
      return result(operation, `Queued ${operation.siteId} as operation ${operation.operationId}.`);
    },
  );

  server.registerTool(
    'get_publish_status',
    {
      title: mcpToolProfiles.get_publish_status.title,
      description: mcpToolProfiles.get_publish_status.description,
      inputSchema: operationIdInputSchema,
      outputSchema: PublishOperationSchema,
      annotations: mcpToolProfiles.get_publish_status.annotations,
    },
    async ({ operationId }) => {
      const operation = await application.getOperation(operationId);
      if (!operation) {
        return {
          content: [{ type: 'text', text: `Operation ${operationId} was not found.` }],
          isError: true,
        };
      }
      return result(operation, `Operation ${operationId} is ${operation.status}.`);
    },
  );

  server.registerTool(
    'list_sites',
    {
      title: mcpToolProfiles.list_sites.title,
      description: mcpToolProfiles.list_sites.description,
      inputSchema: z.object({}),
      outputSchema: siteListOutputSchema,
      annotations: mcpToolProfiles.list_sites.annotations,
    },
    async () => {
      const sites = await application.listSites();
      return result({ sites }, `${sites.length} site(s) are currently published.`);
    },
  );

  server.registerTool(
    'get_site',
    {
      title: mcpToolProfiles.get_site.title,
      description: mcpToolProfiles.get_site.description,
      inputSchema: siteIdInputSchema,
      outputSchema: SiteCatalogEntrySchema,
      annotations: mcpToolProfiles.get_site.annotations,
    },
    async ({ siteId }) => {
      const site = await application.getSite(siteId);
      if (!site)
        return {
          content: [{ type: 'text', text: `Site ${siteId} was not found.` }],
          isError: true,
        };
      return result(site, `${site.displayName} is available at ${site.url}.`);
    },
  );

  server.registerTool(
    'delete_site',
    {
      title: mcpToolProfiles.delete_site.title,
      description: mcpToolProfiles.delete_site.description,
      inputSchema: siteIdInputSchema,
      outputSchema: deleteSiteOutputSchema,
      annotations: mcpToolProfiles.delete_site.annotations,
    },
    async ({ siteId }) => {
      const deleted = await application.deleteSite(siteId);
      return result(
        { siteId, deleted },
        deleted ? `Deleted ${siteId}.` : `Site ${siteId} did not exist.`,
      );
    },
  );

  return server;
}
