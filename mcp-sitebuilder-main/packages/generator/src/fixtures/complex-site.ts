import type { SiteManifestInput } from '@mcp-sitebuilder/contracts';

export const complexSiteFixture = {
  siteId: 'platform-handbook',
  displayName: 'Platform Engineering Handbook',
  description: 'A multi-section handbook used to verify menus, rich Markdown, and link routing.',
  themeId: 'slate',
  classification: 'UNCLASSIFIED',
  documents: [
    {
      path: 'index.md',
      content: `---
title: Platform Handbook
---
# Platform Engineering Handbook

This handbook covers the service architecture, operator workflows, and API contract.

## Start here

- [Architecture overview](architecture/overview.md)
- [Getting started](guides/getting-started.md)
- [Operations runbook](guides/advanced/operations.md)
- [API reference](reference/api.md)

Read the [Model Context Protocol documentation](https://modelcontextprotocol.io/docs) and the [Azure Storage documentation](https://learn.microsoft.com/azure/storage/) for external background.
`,
    },
    {
      path: 'architecture/overview.md',
      content: `# Architecture overview

The system separates adapters from the application core.

| Layer | Responsibility | Details |
| --- | --- | --- |
| REST and MCP | Transport adapters | [API component](components/api.md) |
| Application | Publishing rules | [Security decisions](../decisions/security.md) |
| Storage | Durable state | [Storage component](components/storage.md) |

> Publishing uploads an immutable version before changing a stable pointer.

Return to the [home page](/index.md#start-here).
`,
    },
    {
      path: 'architecture/components/api.md',
      content: `# API and MCP component

The API accepts JSON manifests and returns an operation identifier.

1. Validate the request.
2. Stage immutable input.
3. Enqueue an operation.
4. Poll [operation status](../../reference/api.md#operation-status).

The remote protocol follows the [MCP server guide](https://modelcontextprotocol.io/docs/develop/build-server).
`,
    },
    {
      path: 'architecture/components/storage.md',
      content: `# Storage component

Storage contains versioned output and durable operation records.

- [Blob Storage](https://learn.microsoft.com/azure/storage/blobs/storage-blobs-overview)
- [Queue Storage](https://learn.microsoft.com/azure/storage/queues/storage-queues-introduction)
- [Failure recovery](../../guides/advanced/operations.md#failure-recovery)

\`$web/sites/{siteId}/versions/{version}\` is immutable after publication.
`,
    },
    {
      path: 'decisions/security.md',
      content: `# Security decisions

- [x] Reject path traversal.
- [x] Remove raw HTML.
- [x] Preserve safe HTTPS links.
- [ ] Add caller identity in a future release.

Raw HTML is not trusted:

<script>globalThis.compromised = true</script>

A malicious [script link](javascript:alert('blocked')) must not survive sanitization.

See the [operations security checks](../guides/advanced/operations.md#security-checks).
`,
    },
    {
      path: 'guides/getting-started.md',
      content: `---
title: Getting started
---
# Getting started

Create a manifest containing Markdown files with safe relative paths.

\`\`\`json
{
  "siteId": "example-site",
  "documents": [{ "path": "index.md", "content": "# Hello" }]
}
\`\`\`

Continue to [configuration](configuration.md), then review the [API](../reference/api.md).
`,
    },
    {
      path: 'guides/configuration.md',
      content: `# Configuration

Choose one bundled theme:

- \`clarity\`
- \`slate\`
- \`paper\`

Classification defaults to **UNCLASSIFIED**.

Next: [deployment](deployment.md) or [advanced operations](advanced/operations.md).
`,
    },
    {
      path: 'guides/deployment.md',
      content: `# Deployment

The deployment target is Azure App Service and Azure Storage.

See [App Service documentation](https://learn.microsoft.com/azure/app-service/) for runtime guidance.

After deployment, use the [health endpoints](../reference/api.md#health-endpoints) and follow the [operations runbook](advanced/operations.md).
`,
    },
    {
      path: 'guides/advanced/operations.md',
      content: `# Operations runbook

## Health checks

Call the endpoints documented in the [API reference](../../reference/api.md#health-endpoints).

## Failure recovery

1. Inspect the operation record.
2. Correct the source manifest.
3. Submit a new publication.
4. Confirm the previous stable site remained available.

## Security checks

Review the [security decision](../../decisions/security.md) and the external [OWASP Markdown guidance](https://owasp.org/www-community/attacks/xss/).

Contact [platform operations](mailto:platform@example.test) when escalation is required.
`,
    },
    {
      path: 'reference/api.md',
      content: `# API reference

## Publish a site

\`POST /api/v1/sites\`

## Operation status

\`GET /api/v1/operations/{operationId}\`

Statuses progress through \`queued\`, \`building\`, \`publishing\`, and \`succeeded\` or \`failed\`.

## Health endpoints

- \`GET /healthz\`
- \`GET /readyz\`

See the [error catalog](errors.md) and [getting started guide](../guides/getting-started.md).
`,
    },
    {
      path: 'reference/errors.md',
      content: `# Error catalog

| HTTP status | Meaning | Recovery |
| ---: | --- | --- |
| 400 | Invalid manifest | Correct paths or content limits |
| 404 | Missing site or operation | Verify the identifier |
| 500 | Internal failure | Follow [failure recovery](../guides/advanced/operations.md#failure-recovery) |

External status reference: [MDN HTTP response status codes](https://developer.mozilla.org/docs/Web/HTTP/Reference/Status).
`,
    },
    {
      path: 'reference/glossary.md',
      content: `# Glossary

**Stable pointer**
: The current URL switched only after a version upload succeeds.

**Version prefix**
: An immutable directory containing one complete generated site.

**MCP**
: [Model Context Protocol](https://modelcontextprotocol.io/).

Return to the [architecture overview](../architecture/overview.md).
`,
    },
  ],
} satisfies SiteManifestInput;
