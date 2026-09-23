import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { SiteBuilderApplication } from '@mcp-sitebuilder/application';
import { MemorySiteBuilderStore } from '@mcp-sitebuilder/azure-adapters';
import type { PublishOperation } from '@mcp-sitebuilder/contracts';
import { createApp } from './app.js';

describe('REST API', () => {
  it('serves a useful landing page instead of a root 404', async () => {
    const application = new SiteBuilderApplication(new MemorySiteBuilderStore());
    await application.initialize();
    const response = await request(createApp(application))
      .get('/')
      .set('host', 'localhost')
      .expect(200);

    expect(response.text).toContain('MCP Site Builder');
    expect(response.text).toContain('UNCLASSIFIED');
    expect(response.text).toContain('/api/v1/sites');
    expect(response.text).toContain('/docs/');
    expect(response.text).toContain('/mcp-info');
  });

  it('documents the MCP endpoint, tools, annotations, and governance posture', async () => {
    const application = new SiteBuilderApplication(new MemorySiteBuilderStore());
    await application.initialize();
    const app = createApp(application);

    const page = await request(app).get('/mcp-info').set('host', 'localhost').expect(200);
    expect(page.text).toContain('POST /mcp');
    expect(page.text).toContain('publish_site');
    expect(page.text).toContain('destructiveHint: true');
    expect(page.text).toContain('Server governance posture');

    const profile = await request(app).get('/mcp-info.json').set('host', 'localhost').expect(200);
    const profileBody = profile.body as {
      protocolVersion: string;
      tools: Array<{ name: string }>;
    };
    expect(profileBody.protocolVersion).toBe('2026-07-28');
    expect(profileBody.tools).toHaveLength(9);
    expect(profileBody.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'create_site_draft',
        'upsert_site_files',
        'get_site_draft',
        'publish_site_draft',
      ]),
    );
  });

  it('serves the OpenAPI contract and interactive Swagger page', async () => {
    const application = new SiteBuilderApplication(new MemorySiteBuilderStore());
    await application.initialize();
    const app = createApp(application);

    const specification = await request(app)
      .get('/openapi.json')
      .set('host', 'localhost')
      .expect('content-type', /json/u)
      .expect(200);
    const specificationBody = specification.body as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
    };
    expect(specificationBody).toMatchObject({
      openapi: '3.1.0',
      info: { title: 'MCP Site Builder API', version: '0.1.0' },
    });
    expect(specificationBody.paths).toHaveProperty('/api/v1/sites');
    expect(specificationBody.paths).toHaveProperty('/api/v1/operations/{operationId}');

    const swagger = await request(app)
      .get('/docs/')
      .set('host', 'localhost')
      .expect('content-type', /html/u)
      .expect(200);
    expect(swagger.text).toContain('<title>MCP Site Builder API</title>');
    expect(swagger.text).toContain('<div id="swagger-ui"></div>');
  });

  it('accepts a site and exposes durable operation status', async () => {
    const application = new SiteBuilderApplication(new MemorySiteBuilderStore());
    await application.initialize();
    const app = createApp(application);

    const accepted = await request(app)
      .post('/api/v1/sites')
      .set('host', 'localhost')
      .send({
        siteId: 'api-sample',
        displayName: 'API Sample',
        documents: [{ path: 'index.md', content: '# Hello' }],
      })
      .expect(202);

    const queued = accepted.body as PublishOperation;
    expect(queued.status).toBe('queued');
    await application.processNext();
    const status = await request(app)
      .get(`/api/v1/operations/${queued.operationId}`)
      .set('host', 'localhost')
      .expect(200);
    expect((status.body as PublishOperation).status).toBe('succeeded');
  });

  it('returns problem details for unsafe paths', async () => {
    const application = new SiteBuilderApplication(new MemorySiteBuilderStore());
    await application.initialize();
    await request(createApp(application))
      .post('/api/v1/sites')
      .set('host', 'localhost')
      .send({
        siteId: 'api-sample',
        displayName: 'API Sample',
        documents: [{ path: '../secret.md', content: '# No' }],
      })
      .expect(400);
  });
});
