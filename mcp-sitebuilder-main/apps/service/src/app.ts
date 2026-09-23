import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import helmet from 'helmet';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { SiteBuilderApplication } from '@mcp-sitebuilder/application';
import { SiteManifestSchema } from '@mcp-sitebuilder/contracts';
import { createSiteBuilderMcp, mcpServerProfile } from './mcp.js';
import { openApiDocument } from './openapi.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function serviceHome(sites: Awaited<ReturnType<SiteBuilderApplication['listSites']>>): string {
  const cards = sites
    .map(
      (site) =>
        `<article><div class="mark">${escapeHtml(site.classification.replace('_', ' '))}</div><h2><a href="${escapeHtml(site.url)}">${escapeHtml(site.displayName)}</a></h2><p>${escapeHtml(site.description ?? 'Published documentation site')}</p><small>${escapeHtml(site.siteId)} · ${escapeHtml(site.themeId)} · ${escapeHtml(site.updatedAt)}</small></article>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP Site Builder</title><style>:root{font-family:Inter,system-ui,sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}body{margin:0}.classification{background:#237804;color:#fff;text-align:center;padding:.4rem;font-weight:800;letter-spacing:.12em}.hero{background:#162033;color:#fff;padding:3rem 1.25rem}.hero div,main{max-width:1100px;margin:auto}.hero h1{font-size:clamp(2rem,5vw,3.5rem);margin:.2rem 0}.hero p{color:#c8d7ee;max-width:70ch}main{padding:2rem 1.25rem}.status{display:flex;flex-wrap:wrap;gap:.75rem;margin:1rem 0 2rem}.status a{background:#fff;border:1px solid #d8dee9;border-radius:999px;padding:.5rem .8rem;color:#005ea8;text-decoration:none}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem}article{background:#fff;border:1px solid #dfe4ec;border-radius:12px;padding:1.25rem;box-shadow:0 8px 24px rgba(30,45,70,.06)}article h2{margin:.4rem 0}.mark{font-size:.7rem;font-weight:800;color:#237804;letter-spacing:.08em}small{color:#667085}a{color:#005ea8}</style></head><body><div class="classification">UNCLASSIFIED</div><header class="hero"><div><strong>REST + MCP</strong><h1>MCP Site Builder</h1><p>Submit Markdown or text manifests through REST or MCP, then publish folder-based static documentation sites.</p></div></header><main><nav class="status"><a href="/docs/">Swagger API</a><a href="/openapi.json">OpenAPI JSON</a><a href="/mcp-info">MCP tools &amp; governance</a><a href="/healthz">Health</a><a href="/readyz">Readiness</a><a href="/api/v1/sites">Sites API</a></nav><h2>Locally published sites</h2><section class="grid">${cards || '<article><h2>No sites in memory</h2><p>Publish a site with <code>POST /api/v1/sites</code>. The local in-memory catalog resets when the service restarts.</p></article>'}</section></main></body></html>`;
}

function mcpInfoPage(): string {
  const tools = mcpServerProfile.tools
    .map((tool) => {
      const annotations = Object.entries(tool.annotations)
        .map(
          ([name, value]) =>
            `<span class="badge ${value ? 'yes' : 'no'}">${escapeHtml(name)}: ${String(value)}</span>`,
        )
        .join('');
      const governance = tool.governance.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
      return `<article><div class="eyebrow">${escapeHtml(tool.name)}</div><h2>${escapeHtml(tool.title)}</h2><p>${escapeHtml(tool.description)}</p><div class="badges">${annotations}</div><h3>Service controls</h3><ul>${governance}</ul></article>`;
    })
    .join('');
  const controls = mcpServerProfile.governance
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP tools and governance</title><style>:root{font-family:Inter,system-ui,sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}body{margin:0}.classification{background:#237804;color:#fff;text-align:center;padding:.4rem;font-weight:800;letter-spacing:.12em}header,main{max-width:1150px;margin:auto;padding:2rem 1.25rem}header{padding-top:3rem}h1{font-size:clamp(2rem,5vw,3.25rem);margin:.25rem 0}.summary{color:#475467;max-width:78ch}.endpoint{background:#101827;color:#eaf1ff;padding:1rem;border-radius:.6rem;overflow:auto}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:1rem}article,.governance{background:#fff;border:1px solid #dfe4ec;border-radius:12px;padding:1.25rem;box-shadow:0 8px 24px rgba(30,45,70,.05)}article h2{margin:.2rem 0}.eyebrow{font-family:Consolas,monospace;color:#005ea8;font-size:.8rem}.badges{display:flex;flex-wrap:wrap;gap:.4rem}.badge{font-size:.72rem;border-radius:999px;padding:.25rem .55rem;background:#eaf6ec;color:#176b2c}.badge.no{background:#f4f4f5;color:#52525b}a{color:#005ea8}.back{display:inline-block;margin-bottom:1rem}</style></head><body><div class="classification">UNCLASSIFIED</div><header><a class="back" href="/">← Service home</a><div class="eyebrow">MCP ${escapeHtml(mcpServerProfile.protocolVersion)}</div><h1>Tools and governance</h1><p class="summary">MCP standardizes machine discovery through initialization and <code>tools/list</code>; it does not mandate a human-facing UI or a governance schema. This page presents the standard tool metadata plus service-specific controls.</p><pre class="endpoint"><code>${escapeHtml(mcpServerProfile.transport)}  POST ${escapeHtml(mcpServerProfile.endpoint)}</code></pre><p>${escapeHtml(mcpServerProfile.discovery)}</p><p>For interactive protocol testing, use the official <a href="https://github.com/modelcontextprotocol/inspector" target="_blank" rel="noopener noreferrer">MCP Inspector</a>.</p></header><main><section class="governance"><h2>Server governance posture</h2><ul>${controls}</ul></section><h2>Available tools</h2><section class="grid">${tools}</section></main></body></html>`;
}

function allowedHosts(): string[] {
  return [
    '127.0.0.1',
    'localhost',
    process.env.WEBSITE_HOSTNAME,
    ...(process.env.ALLOWED_HOSTS?.split(',') ?? []),
  ].filter((value): value is string => Boolean(value?.trim()));
}

export function createApp(application: SiteBuilderApplication) {
  const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: allowedHosts() });
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(
    pinoHttp({
      logger,
      genReqId(request, response) {
        const supplied = request.headers['x-request-id'];
        const requestId = typeof supplied === 'string' ? supplied : randomUUID();
        response.setHeader('x-request-id', requestId);
        return requestId;
      },
    }),
  );
  app.use('/api', ((request, response, next) => {
    if (request.is('application/json')) return next();
    if (request.method === 'GET' || request.method === 'DELETE') return next();
    response.status(415).json({
      type: 'https://mcp-sitebuilder/errors/unsupported-media-type',
      title: 'Unsupported media type',
      status: 415,
      detail: 'Use application/json. Multipart upload will be added in a subsequent slice.',
    });
  }) satisfies RequestHandler);

  app.get('/healthz', (_request, response) => response.json({ ok: true }));
  app.get('/readyz', (_request, response) => response.json({ ready: true }));
  app.get('/openapi.json', (_request, response) => response.json(openApiDocument));
  app.get('/mcp-info.json', (_request, response) => response.json(mcpServerProfile));
  app.get('/mcp-info', (_request, response) => response.type('html').send(mcpInfoPage()));
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customSiteTitle: 'MCP Site Builder API',
      swaggerOptions: {
        displayRequestDuration: true,
        persistAuthorization: false,
        tryItOutEnabled: true,
      },
    }),
  );
  app.get('/', async (_request, response, next) => {
    try {
      response.type('html').send(serviceHome(await application.listSites()));
    } catch (error) {
      next(error);
    }
  });
  app.get('/favicon.ico', (_request, response) => response.status(204).end());

  app.get('/sites/*path', async (request, response, next) => {
    try {
      const rawPath = request.params.path;
      const relativePath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
      const file = await application.readPublishedFile(`sites/${relativePath}`);
      if (!file) {
        response.status(404).end();
        return;
      }
      response.setHeader('content-type', file.contentType);
      response.setHeader('cache-control', file.cacheControl);
      response.send(file.content);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/v1/sites', async (request, response, next) => {
    try {
      const manifest = SiteManifestSchema.parse(request.body);
      const operation = await application.publish(manifest);
      response.status(202).location(`/api/v1/operations/${operation.operationId}`).json(operation);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/v1/operations/:operationId', async (request, response, next) => {
    try {
      const operationId = z.uuid().parse(request.params.operationId);
      const operation = await application.getOperation(operationId);
      if (!operation) {
        response.status(404).json({
          type: 'https://mcp-sitebuilder/errors/not-found',
          title: 'Operation not found',
          status: 404,
          detail: `Operation ${operationId} was not found.`,
        });
        return;
      }
      response.json(operation);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/v1/sites', async (_request, response, next) => {
    try {
      response.json({ sites: await application.listSites() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/v1/sites/:siteId', async (request, response, next) => {
    try {
      const site = await application.getSite(request.params.siteId);
      if (!site) {
        response.status(404).json({
          type: 'https://mcp-sitebuilder/errors/not-found',
          title: 'Site not found',
          status: 404,
          detail: `Site ${request.params.siteId} was not found.`,
        });
        return;
      }
      response.json(site);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/v1/sites/:siteId', async (request, response, next) => {
    try {
      const deleted = await application.deleteSite(request.params.siteId);
      response.status(deleted ? 204 : 404).end();
    } catch (error) {
      next(error);
    }
  });

  const mcpHandler = createMcpHandler(() => createSiteBuilderMcp(application));
  const nodeHandler = toNodeHandler(mcpHandler);
  app.all('/mcp', (request, response) => void nodeHandler(request, response, request.body));

  const errors: ErrorRequestHandler = (error, request, response, _next) => {
    void _next;
    request.log.error({ err: error }, 'request failed');
    if (error instanceof z.ZodError) {
      response.status(400).json({
        type: 'https://mcp-sitebuilder/errors/validation',
        title: 'Validation failed',
        status: 400,
        detail: 'The request did not match the site manifest contract.',
        requestId: request.id,
        errors: error.issues,
      });
      return;
    }
    response.status(500).json({
      type: 'https://mcp-sitebuilder/errors/internal',
      title: 'Internal server error',
      status: 500,
      detail: 'The service could not complete the request.',
      requestId: request.id,
    });
  };
  app.use(errors);
  return app;
}
