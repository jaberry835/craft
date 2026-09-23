export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'MCP Site Builder API',
    version: '0.1.0',
    description:
      'Build and publish folder-based static documentation sites from Markdown and plain text. Publishing is asynchronous: submit a site, then poll the returned operation URL until it succeeds or fails. The MCP endpoint is protocol-based and is not represented by this REST specification.',
  },
  servers: [{ url: '/', description: 'Current service' }],
  tags: [
    { name: 'System', description: 'Service health and readiness' },
    { name: 'Sites', description: 'Publish and manage generated sites' },
    { name: 'Operations', description: 'Track asynchronous publication' },
  ],
  paths: {
    '/healthz': {
      get: {
        tags: ['System'],
        summary: 'Liveness check',
        operationId: 'getHealth',
        responses: {
          '200': {
            description: 'The service process is running.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } },
            },
          },
        },
      },
    },
    '/readyz': {
      get: {
        tags: ['System'],
        summary: 'Readiness check',
        operationId: 'getReadiness',
        responses: {
          '200': {
            description: 'The service is ready to receive requests.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ReadinessResponse' } },
            },
          },
        },
      },
    },
    '/api/v1/sites': {
      get: {
        tags: ['Sites'],
        summary: 'List published sites',
        operationId: 'listSites',
        responses: {
          '200': {
            description: 'Current master catalog entries.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['sites'],
                  properties: {
                    sites: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/SiteCatalogEntry' },
                    },
                  },
                },
              },
            },
          },
          '500': { $ref: '#/components/responses/InternalError' },
        },
      },
      post: {
        tags: ['Sites'],
        summary: 'Queue a site publication',
        description:
          'Validates and stages a complete named site. Document paths become the generated folder hierarchy and menu. Reusing a site ID atomically replaces its current version after generation succeeds.',
        operationId: 'publishSite',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SiteManifest' },
              examples: {
                nestedDocumentation: {
                  summary: 'Two-page nested documentation site',
                  value: {
                    siteId: 'example-site',
                    displayName: 'Example Documentation',
                    description: 'A small documentation site.',
                    themeId: 'clarity',
                    classification: 'UNCLASSIFIED',
                    documents: [
                      {
                        path: 'index.md',
                        content:
                          '# Welcome\n\nRead the [setup guide](guides/setup.md) or visit [Microsoft Learn](https://learn.microsoft.com/).',
                      },
                      {
                        path: 'guides/setup.md',
                        content: '# Setup\n\nFollow these steps to configure the service.',
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        responses: {
          '202': {
            description: 'Publication was accepted and queued.',
            headers: {
              Location: {
                description: 'Relative operation status URL.',
                schema: { type: 'string' },
              },
              'x-request-id': { $ref: '#/components/headers/RequestId' },
            },
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PublishOperation' } },
            },
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '415': { $ref: '#/components/responses/UnsupportedMediaType' },
          '500': { $ref: '#/components/responses/InternalError' },
        },
      },
    },
    '/api/v1/sites/{siteId}': {
      parameters: [{ $ref: '#/components/parameters/SiteId' }],
      get: {
        tags: ['Sites'],
        summary: 'Get a published site',
        operationId: 'getSite',
        responses: {
          '200': {
            description: 'The current catalog entry.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SiteCatalogEntry' },
              },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' },
        },
      },
      delete: {
        tags: ['Sites'],
        summary: 'Delete a published site',
        description:
          'Removes the site from the catalog and deletes its stable pointer and versioned output.',
        operationId: 'deleteSite',
        responses: {
          '204': { description: 'The site was deleted.' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' },
        },
      },
    },
    '/api/v1/operations/{operationId}': {
      get: {
        tags: ['Operations'],
        summary: 'Get publication status',
        operationId: 'getPublishOperation',
        parameters: [{ $ref: '#/components/parameters/OperationId' }],
        responses: {
          '200': {
            description: 'Current durable operation state.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PublishOperation' } },
            },
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' },
        },
      },
    },
  },
  components: {
    headers: {
      RequestId: {
        description: 'Correlation identifier generated or propagated by the service.',
        schema: { type: 'string', format: 'uuid' },
      },
    },
    parameters: {
      SiteId: {
        name: 'siteId',
        in: 'path',
        required: true,
        description: 'Lowercase stable site identifier.',
        schema: {
          type: 'string',
          minLength: 3,
          maxLength: 63,
          pattern: '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$',
        },
      },
      OperationId: {
        name: 'operationId',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
    },
    responses: {
      ValidationError: {
        description: 'Request validation failed.',
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/ProblemDetails' },
          },
          'application/json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
        },
      },
      NotFound: {
        description: 'The requested site or operation does not exist.',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
        },
      },
      UnsupportedMediaType: {
        description: 'The endpoint requires an application/json request.',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
        },
      },
      InternalError: {
        description: 'The service could not complete the request.',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
        },
      },
    },
    schemas: {
      HealthResponse: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean', const: true } },
      },
      ReadinessResponse: {
        type: 'object',
        required: ['ready'],
        properties: { ready: { type: 'boolean', const: true } },
      },
      ThemeId: { type: 'string', enum: ['clarity', 'slate', 'paper'], default: 'clarity' },
      Classification: {
        type: 'string',
        enum: ['UNCLASSIFIED', 'CUI', 'CONFIDENTIAL', 'SECRET', 'TOP_SECRET'],
        default: 'UNCLASSIFIED',
      },
      SourceDocument: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: {
            type: 'string',
            minLength: 1,
            maxLength: 240,
            pattern: '^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+\\.(?:[mM][dD]|[tT][xX][tT])$',
            examples: ['index.md', 'notes/readme.txt'],
            description:
              'Safe relative Markdown or text path. The folder structure becomes the navigation hierarchy.',
          },
          content: {
            type: 'string',
            maxLength: 1000000,
            description:
              'UTF-8 Markdown or plain text. Markdown links to submitted .md or .txt files are converted to generated .html links; HTTP/HTTPS links remain external.',
          },
        },
      },
      SiteManifest: {
        type: 'object',
        additionalProperties: false,
        required: ['siteId', 'displayName', 'documents'],
        properties: {
          siteId: {
            type: 'string',
            minLength: 3,
            maxLength: 63,
            pattern: '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$',
          },
          displayName: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
          themeId: { $ref: '#/components/schemas/ThemeId' },
          classification: { $ref: '#/components/schemas/Classification' },
          documents: {
            type: 'array',
            minItems: 1,
            maxItems: 200,
            items: { $ref: '#/components/schemas/SourceDocument' },
          },
        },
      },
      OperationStatus: {
        type: 'string',
        enum: ['queued', 'building', 'publishing', 'succeeded', 'failed'],
      },
      PublishOperation: {
        type: 'object',
        required: ['operationId', 'siteId', 'status', 'createdAt', 'updatedAt'],
        properties: {
          operationId: { type: 'string', format: 'uuid' },
          siteId: { type: 'string' },
          status: { $ref: '#/components/schemas/OperationStatus' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          version: { type: 'string' },
          siteUrl: { type: 'string', format: 'uri' },
          error: { type: 'string' },
        },
      },
      SiteCatalogEntry: {
        type: 'object',
        required: [
          'siteId',
          'displayName',
          'classification',
          'themeId',
          'version',
          'url',
          'updatedAt',
        ],
        properties: {
          siteId: { type: 'string' },
          displayName: { type: 'string' },
          description: { type: 'string' },
          classification: { $ref: '#/components/schemas/Classification' },
          themeId: { $ref: '#/components/schemas/ThemeId' },
          version: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      ProblemDetails: {
        type: 'object',
        required: ['type', 'title', 'status', 'detail'],
        properties: {
          type: { type: 'string', format: 'uri-reference' },
          title: { type: 'string' },
          status: { type: 'integer', minimum: 400, maximum: 599 },
          detail: { type: 'string' },
          requestId: { type: 'string' },
          errors: { type: ['array', 'object'] },
        },
      },
    },
  },
} as const;
