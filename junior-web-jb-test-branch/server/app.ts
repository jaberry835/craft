import express from 'express';
import cors from 'cors';
import type { AgentConfigStore } from './services/agentConfigStore.js';
import { AdminConnectivityService } from './services/adminConnectivityService.js';
import type { PendingChange, RequestIdentity, WorkspaceCreateRequest, WorkspaceTemplateImportRequest, WorkspaceUpdateRequest } from './types.js';
import { LocalWorkspaceManager } from './services/localWorkspaceManager.js';
import type { WorkspaceRuntime } from './services/workspaceRegistry.js';

function writeJsonLine(response: express.Response, payload: Record<string, unknown>): void {
  response.write(`${JSON.stringify(payload)}\n`);
}

export interface WorkbenchAppDependencies {
  agentConfigStore: AgentConfigStore;
  workspaceManager: LocalWorkspaceManager;
}

export function createWorkbenchApp(dependencies: WorkbenchAppDependencies): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  const requestIdentity = (_request: express.Request): RequestIdentity => ({ userId: 'admin', displayName: 'Admin' });
  const currentWorkspace = (request: express.Request) => dependencies.workspaceManager.getDefault(requestIdentity(request).userId);
  const workspaceFromParams = (request: express.Request) => dependencies.workspaceManager.resolve(
    requestIdentity(request).userId,
    Array.isArray(request.params.workspaceId)
      ? request.params.workspaceId[0]
      : request.params.workspaceId
  );
  const listChanges = async (workspace: WorkspaceRuntime): Promise<PendingChange[]> => workspace.changeManager.list();
  const adminConnectivityService = new AdminConnectivityService(dependencies.agentConfigStore, dependencies.workspaceManager);

  const registerWorkspaceRoutes = (basePath: string, resolveWorkspace: (request: express.Request) => WorkspaceRuntime) => {
    app.get(`${basePath}/tree`, async (request, response, next) => {
      try {
        response.json(await resolveWorkspace(request).storage.listTree());
      } catch (error) {
        next(error);
      }
    });

    app.get(`${basePath}/index`, (request, response) => {
      response.json(resolveWorkspace(request).workspaceIndexer.getIndex());
    });

    app.get(`${basePath}/agents`, (request, response) => {
      response.json(resolveWorkspace(request).configStore.listRuntimeAgents());
    });

    app.get(`${basePath}/settings/agents`, (request, response) => {
      response.json(resolveWorkspace(request).configStore.listPersistedAgents());
    });

    app.post(`${basePath}/settings/agents`, async (request, response, next) => {
      try {
        response.json(await resolveWorkspace(request).configStore.createAgent(request.body));
      } catch (error) {
        next(error);
      }
    });

    app.put(`${basePath}/settings/agents/:id`, async (request, response, next) => {
      try {
        response.json(await resolveWorkspace(request).configStore.updateAgent(request.params.id, request.body));
      } catch (error) {
        next(error);
      }
    });

    app.delete(`${basePath}/settings/agents/:id`, async (request, response, next) => {
      try {
        response.json(await resolveWorkspace(request).configStore.deleteAgent(request.params.id));
      } catch (error) {
        next(error);
      }
    });

    app.get(`${basePath}/shared/agent-templates`, (request, response) => {
      response.json(dependencies.agentConfigStore.listSharedAgentTemplatesForWorkspace(resolveWorkspace(request)));
    });

    app.get(`${basePath}/shared/connections`, (request, response) => {
      response.json(dependencies.agentConfigStore.listSharedConnectionsForWorkspace(resolveWorkspace(request)));
    });

    app.get(`${basePath}/shared/mcp-catalog`, (request, response) => {
      response.json(dependencies.agentConfigStore.listSharedMcpCatalogForWorkspace(resolveWorkspace(request)));
    });

    app.get(`${basePath}/settings/agent-connections`, (request, response) => {
      response.json(resolveWorkspace(request).configStore.listPersistedConnections());
    });

    app.post(`${basePath}/settings/agent-connections`, async (request, response, next) => {
      try {
        response.json(await resolveWorkspace(request).configStore.saveConnection(request.body));
      } catch (error) {
        next(error);
      }
    });

    app.delete(`${basePath}/settings/agent-connections/:id`, async (request, response, next) => {
      try {
        response.json(await resolveWorkspace(request).configStore.deleteConnection(request.params.id));
      } catch (error) {
        next(error);
      }
    });

    app.get(`${basePath}/settings/mcp-servers`, (request, response) => {
      response.json(resolveWorkspace(request).configStore.listPersistedMcpServers());
    });

    app.post(`${basePath}/settings/mcp-servers`, async (request, response, next) => {
      try {
        response.json(await resolveWorkspace(request).configStore.saveMcpServer(request.body));
      } catch (error) {
        next(error);
      }
    });

    app.delete(`${basePath}/settings/mcp-servers/:id`, async (request, response, next) => {
      try {
        response.json(await resolveWorkspace(request).configStore.deleteMcpServer(request.params.id));
      } catch (error) {
        next(error);
      }
    });

    app.post(`${basePath}/settings/template-import`, async (request, response, next) => {
      try {
        const body = request.body as WorkspaceTemplateImportRequest;
        const templateId = body.templateId?.trim();
        if (!templateId) {
          response.status(400).json({ error: 'templateId is required.' });
          return;
        }

        const template = dependencies.agentConfigStore.getWorkspaceTemplate(templateId);
        if (!template) {
          response.status(404).json({ error: `Workspace template not found: ${templateId}` });
          return;
        }

        response.json(await resolveWorkspace(request).configStore.importTemplateSelection(template, body));
      } catch (error) {
        next(error);
      }
    });

    app.post(`${basePath}/index/refresh`, async (request, response, next) => {
      try {
        response.json(await resolveWorkspace(request).workspaceIndexer.refresh());
      } catch (error) {
        next(error);
      }
    });

    app.get(`${basePath}/search`, (request, response) => {
      response.json(resolveWorkspace(request).workspaceIndexer.search(String(request.query.q ?? '')));
    });

    app.get(`${basePath}/files`, async (request, response, next) => {
      try {
        const filePath = String(request.query.path ?? 'package/index.md');
        response.json(await resolveWorkspace(request).storage.readTextFile(filePath));
      } catch (error) {
        next(error);
      }
    });

    app.put(`${basePath}/files`, async (request, response, next) => {
      try {
        const { path: filePath, content } = request.body as { path?: string; content?: string };

        if (!filePath || typeof content !== 'string') {
          response.status(400).json({ error: 'path and content are required.' });
          return;
        }

        const workspace = resolveWorkspace(request);
        const file = await workspace.storage.writeTextFile(filePath, content);
        await workspace.workspaceIndexer.refresh();
        response.json(file);
      } catch (error) {
        next(error);
      }
    });

    app.post(`${basePath}/directories`, async (request, response, next) => {
      try {
        const { path: directoryPath } = request.body as { path?: string };

        if (!directoryPath?.trim()) {
          response.status(400).json({ error: 'path is required.' });
          return;
        }

        const workspace = resolveWorkspace(request);
        const directory = await workspace.storage.createDirectory(directoryPath.trim());
        await workspace.workspaceIndexer.refresh();
        response.json(directory);
      } catch (error) {
        next(error);
      }
    });

    app.delete(`${basePath}/paths`, async (request, response, next) => {
      try {
        const targetPath = String(request.query.path ?? '').trim();

        if (!targetPath) {
          response.status(400).json({ error: 'path is required.' });
          return;
        }

        const workspace = resolveWorkspace(request);
        const deleted = await workspace.storage.deletePath(targetPath);
        await workspace.workspaceIndexer.refresh();
        response.json(deleted);
      } catch (error) {
        next(error);
      }
    });

    app.get(`${basePath}/chat/sessions`, async (request, response, next) => {
      try {
        response.json(await resolveWorkspace(request).agent.listSessions());
      } catch (error) {
        next(error);
      }
    });

    app.post(`${basePath}/chat/sessions`, async (request, response, next) => {
      try {
        const { agentId } = request.body as { agentId?: string };
        response.json(await resolveWorkspace(request).agent.createSession(agentId));
      } catch (error) {
        next(error);
      }
    });

    app.get(`${basePath}/agent/messages`, async (request, response, next) => {
      try {
        const sessionId = String(request.query.sessionId ?? '').trim() || undefined;
        response.json(await resolveWorkspace(request).agent.getMessages(sessionId));
      } catch (error) {
        next(error);
      }
    });

    app.post(`${basePath}/agent/messages`, async (request, response, next) => {
      try {
        const { content, agentId, autoApproveChanges, sessionId } = request.body as { content?: string; agentId?: string; autoApproveChanges?: boolean; sessionId?: string };

        if (!content?.trim()) {
          response.status(400).json({ error: 'content is required.' });
          return;
        }

        response.json(await resolveWorkspace(request).agent.sendMessage(content.trim(), agentId, { autoApproveChanges: Boolean(autoApproveChanges) }, sessionId));
      } catch (error) {
        next(error);
      }
    });

    app.post(`${basePath}/agent/messages/stream`, async (request, response) => {
      const { content, agentId, autoApproveChanges, sessionId } = request.body as { content?: string; agentId?: string; autoApproveChanges?: boolean; sessionId?: string };

      if (!content?.trim()) {
        response.status(400).json({ error: 'content is required.' });
        return;
      }

      response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.flushHeaders();

      try {
        const result = await resolveWorkspace(request).agent.sendMessageStream(
          content.trim(),
          agentId,
          { autoApproveChanges: Boolean(autoApproveChanges) },
          sessionId,
          {
            onReasoning: (text) => {
              writeJsonLine(response, { type: 'reasoning', text });
            },
            onAssistantText: (text) => {
              writeJsonLine(response, { type: 'assistant_text', text });
            }
          }
        );

        writeJsonLine(response, { type: 'completed', response: result });
        response.end();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeJsonLine(response, { type: 'error', message });
        response.end();
      }
    });

    app.get(`${basePath}/changes`, async (request, response, next) => {
      try {
        response.json(await listChanges(resolveWorkspace(request)));
      } catch (error) {
        next(error);
      }
    });

    app.post(`${basePath}/changes/:id/approve`, async (request, response, next) => {
      try {
        const workspace = resolveWorkspace(request);
        const change = await workspace.changeManager.approve(request.params.id);
        await workspace.workspaceIndexer.refresh();
        response.json(change);
      } catch (error) {
        next(error);
      }
    });

    app.post(`${basePath}/changes/:id/undo`, async (request, response, next) => {
      try {
        response.json(await resolveWorkspace(request).changeManager.undo(request.params.id));
      } catch (error) {
        next(error);
      }
    });
  };

  app.get('/api/health', (request, response) => {
    const workspace = currentWorkspace(request);
    response.json({
      ok: true,
      workspaceId: workspace.id,
      workspaceRoot: workspace.rootPath,
      workspaceCount: dependencies.workspaceManager.list(requestIdentity(request).userId).length
    });
  });

  app.get('/api/workspaces', (request, response) => {
    response.json(dependencies.workspaceManager.list(requestIdentity(request).userId));
  });

  app.post('/api/workspaces', async (request, response, next) => {
    try {
      const body = request.body as WorkspaceCreateRequest;
      const template = body.templateId
        ? dependencies.agentConfigStore.listWorkspaceTemplates().find((candidate) => candidate.id === body.templateId)
        : undefined;

      if (body.templateId && !template) {
        response.status(400).json({ error: `Workspace template not found: ${body.templateId}` });
        return;
      }

      const identity = requestIdentity(request);
      const workspace = await dependencies.workspaceManager.createWorkspace({
        ...body,
        templateId: template?.id,
        templateName: template?.name
      }, identity.userId);

      if (template) {
        await dependencies.workspaceManager.resolve(identity.userId, workspace.id).configStore.applyTemplate(template);
      }

      response.json(workspace);
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/workspaces/:workspaceId', async (request, response, next) => {
    try {
      const body = request.body as WorkspaceUpdateRequest;
      const template = body.templateId
        ? dependencies.agentConfigStore.listWorkspaceTemplates().find((candidate) => candidate.id === body.templateId)
        : body.templateId === ''
          ? null
          : undefined;

      if (body.templateId && body.templateId.trim() && !template) {
        response.status(400).json({ error: `Workspace template not found: ${body.templateId}` });
        return;
      }

      const identity = requestIdentity(request);
      const workspace = await dependencies.workspaceManager.updateWorkspace(request.params.workspaceId, {
        ...body,
        templateId: template === null ? undefined : template?.id,
        templateName: template === null ? undefined : template?.name
      }, identity.userId);

      if (template) {
        await dependencies.workspaceManager.resolve(identity.userId, workspace.id).configStore.applyTemplate(template);
      }

      response.json(workspace);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/agents', (_request, response) => {
    response.json(dependencies.agentConfigStore.listAgents());
  });

  app.get('/api/admin/agent-templates', (_request, response) => {
    response.json(dependencies.agentConfigStore.listAgentTemplates());
  });

  app.get('/api/admin/mcp-catalog', (_request, response) => {
    response.json(dependencies.agentConfigStore.listMcpCatalog());
  });

  app.get('/api/admin/workspace-templates', (_request, response) => {
    response.json(dependencies.agentConfigStore.listWorkspaceTemplates());
  });

  app.get('/api/admin/connectivity', async (_request, response, next) => {
    try {
      response.json(await adminConnectivityService.getReport());
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/connectivity/tests/:target', async (request, response, next) => {
    try {
      const target = request.params.target === 'cosmos' || request.params.target === 'storage'
        ? request.params.target
        : undefined;
      if (!target) {
        response.status(400).json({ error: `Unsupported connectivity test target: ${request.params.target}` });
        return;
      }

      response.json(await adminConnectivityService.runTest(target, requestIdentity(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/agents', async (request, response, next) => {
    try {
      response.json(await dependencies.agentConfigStore.createAgent(request.body));
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/agents/:id', async (request, response, next) => {
    try {
      response.json(await dependencies.agentConfigStore.updateAgent(request.params.id, request.body));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/agents/:id', async (request, response, next) => {
    try {
      response.json(await dependencies.agentConfigStore.deleteAgent(request.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/agent-connections', (_request, response) => {
    response.json(dependencies.agentConfigStore.listConnections());
  });

  app.post('/api/agent-connections', async (request, response, next) => {
    try {
      response.json(await dependencies.agentConfigStore.saveConnection(request.body));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/agent-connections/:id', async (request, response, next) => {
    try {
      response.json(await dependencies.agentConfigStore.deleteConnection(request.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/mcp-servers', (_request, response) => {
    response.json(dependencies.agentConfigStore.listMcpServers());
  });

  app.post('/api/mcp-servers', async (request, response, next) => {
    try {
      response.json(await dependencies.agentConfigStore.saveMcpServer(request.body));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/mcp-servers/:id', async (request, response, next) => {
    try {
      response.json(await dependencies.agentConfigStore.deleteMcpServer(request.params.id));
    } catch (error) {
      next(error);
    }
  });

  registerWorkspaceRoutes('/api/workspaces/current', currentWorkspace);
  registerWorkspaceRoutes('/api/workspaces/:workspaceId', workspaceFromParams);

  app.get('/api/chat/sessions', async (request, response, next) => {
    try {
      response.json(await currentWorkspace(request).agent.listSessions());
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/chat/sessions', async (request, response, next) => {
    try {
      const { agentId } = request.body as { agentId?: string };
      response.json(await currentWorkspace(request).agent.createSession(agentId));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/agent/messages', async (request, response, next) => {
    try {
      const sessionId = String(request.query.sessionId ?? '').trim() || undefined;
      response.json(await currentWorkspace(request).agent.getMessages(sessionId));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/agent/messages', async (request, response, next) => {
    try {
      const { content, agentId, autoApproveChanges, sessionId } = request.body as { content?: string; agentId?: string; autoApproveChanges?: boolean; sessionId?: string };

      if (!content?.trim()) {
        response.status(400).json({ error: 'content is required.' });
        return;
      }

      response.json(await currentWorkspace(request).agent.sendMessage(content.trim(), agentId, { autoApproveChanges: Boolean(autoApproveChanges) }, sessionId));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/changes', async (request, response, next) => {
    try {
      response.json(await listChanges(currentWorkspace(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/changes/:id/approve', async (request, response, next) => {
    try {
      const workspace = currentWorkspace(request);
      const change = await workspace.changeManager.approve(request.params.id);
      await workspace.workspaceIndexer.refresh();
      response.json(change);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/changes/:id/undo', async (request, response, next) => {
    try {
      response.json(await currentWorkspace(request).changeManager.undo(request.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    void next;
    const message = error instanceof Error ? error.message : 'Unknown server error.';
    console.error(`[api] ${message}`);
    response.status(500).json({ error: message });
  });

  return app;
}