import express from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AppendMessageRequest,
  AgentRun,
  ChatMessageDisplayPart,
  ChatStreamEvent,
  ChatStreamRequest,
  CreateSessionRequest,
  CreateProjectRequest,
  CreateTextFileRequest,
  RenameProjectPathRequest,
  RenameSessionRequest,
  SaveCustomizationRequest,
  SetCustomizationEnabledRequest,
  WriteTextFileRequest
} from '../src/types/api.js';
import { AaaAgentLoop } from './aaaAgentLoop.js';
import { HttpError } from './httpErrors.js';
import type { ModelChatClient, ModelChatMessage } from './modelTypes.js';
import { ProjectFileService } from './projectFileService.js';
import { ProjectCustomizationService } from './projectCustomizationService.js';
import { ProjectRegistry } from './projectRegistry.js';
import type { ModelConnectionConfig } from './services/modelConnectionConfig.js';
import type { ChatSessionStoreFactory } from './chatSessionStore.js';
import { createSessionPersistence } from './sessionStoreFactory.js';
import type { StorageStatus } from './storageConfig.js';

export interface AaaAppDependencies {
  registry: ProjectRegistry;
  dataRoot: string;
  clientDistPath?: string;
  modelConfig?: ModelConnectionConfig;
  modelClient?: ModelChatClient;
  sessionStoreFactory?: ChatSessionStoreFactory;
  storageStatus?: StorageStatus;
}

const writeJsonLine = (response: express.Response, event: ChatStreamEvent): boolean =>
  response.write(`${JSON.stringify(event)}\n`);

export function createAaaApp({
  registry,
  dataRoot,
  clientDistPath,
  modelConfig,
  modelClient,
  sessionStoreFactory,
  storageStatus
}: AaaAppDependencies): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const localPersistence = sessionStoreFactory && storageStatus
    ? undefined
    : createSessionPersistence(dataRoot, { environment: {} });
  const createSessionStore = sessionStoreFactory ?? localPersistence!.sessionStoreFactory;
  const effectiveStorageStatus = storageStatus ?? localPersistence!.storageStatus;

  const projectId = (request: express.Request): string => {
    const id = String(request.params.projectId);
    registry.assertProjectId(id);
    registry.get(id);
    return id;
  };
  const sessionStore = (request: express.Request) => createSessionStore(projectId(request));
  const fileService = (request: express.Request) => new ProjectFileService(registry.root(projectId(request)));

  app.get('/api/projects', (_request, response) => response.json(registry.list()));
  app.post('/api/projects', async (request, response) => {
    response.status(201).json(await registry.create((request.body ?? {}) as CreateProjectRequest));
  });
  app.put('/api/projects/active', async (request, response) => {
    response.json(await registry.select(String((request.body as { projectId?: string } | undefined)?.projectId ?? '')));
  });
  app.get('/api/storage/status', (_request, response) => response.json(effectiveStorageStatus));
  app.get('/api/model/status', (_request, response) => {
    if (!modelConfig) {
      response.json({
        id: 'unconfigured',
        name: 'AAA model',
        provider: 'azure-openai',
        ready: false,
        missing: ['model configuration'],
        authMode: 'entra',
        endpointKind: 'auto'
      });
      return;
    }
    response.json(modelConfig.status());
  });
  app.get('/api/projects/:projectId', (request, response) => response.json(registry.get(projectId(request))));
  app.get('/api/projects/:projectId/customizations', async (request, response) => {
    const id = projectId(request);
    response.json(await new ProjectCustomizationService(id, registry.root(id)).list());
  });
  app.post('/api/projects/:projectId/customizations', async (request, response) => {
    const id = projectId(request);
    response.status(201).json(await new ProjectCustomizationService(id, registry.root(id))
      .create((request.body ?? {}) as SaveCustomizationRequest));
  });
  app.get('/api/projects/:projectId/customizations/:itemId', async (request, response) => {
    const id = projectId(request);
    response.json(await new ProjectCustomizationService(id, registry.root(id))
      .getEditor(String(request.params.itemId)));
  });
  app.put('/api/projects/:projectId/customizations/:itemId', async (request, response) => {
    const id = projectId(request);
    response.json(await new ProjectCustomizationService(id, registry.root(id))
      .update(String(request.params.itemId), (request.body ?? {}) as SaveCustomizationRequest));
  });
  app.put('/api/projects/:projectId/customizations/:itemId/enabled', async (request, response) => {
    const id = projectId(request);
    const body = (request.body ?? {}) as SetCustomizationEnabledRequest;
    response.json(await new ProjectCustomizationService(id, registry.root(id))
      .setEnabled(String(request.params.itemId), body.enabled));
  });
  app.get('/api/projects/:projectId/tree', async (request, response) =>
    response.json(await fileService(request).listTree()));
  app.get('/api/projects/:projectId/files', async (request, response) =>
    response.json(await fileService(request).readTextFile(String(request.query.path ?? ''))));
  app.put('/api/projects/:projectId/files', async (request, response) => {
    const body = (request.body ?? {}) as WriteTextFileRequest;
    response.json(await fileService(request).writeTextFile(body.path, body.content, body.updatedAt));
  });
  app.post('/api/projects/:projectId/files', async (request, response) => {
    const body = (request.body ?? {}) as CreateTextFileRequest;
    response.status(201).json(await fileService(request).createTextFile(body.path, body.content));
  });
  app.patch('/api/projects/:projectId/paths', async (request, response) => {
    const body = (request.body ?? {}) as RenameProjectPathRequest;
    response.json(await fileService(request).renamePath(body.path, body.newPath));
  });
  app.delete('/api/projects/:projectId/paths', async (request, response) =>
    response.json(await fileService(request).deletePath(String(request.query.path ?? ''))));
  app.get('/api/projects/:projectId/published', async (request, response) => {
    const html = await fileService(request).renderPublishedMarkdown(String(request.query.path ?? ''));
    response.type('html').send(html);
  });

  app.get('/api/projects/:projectId/sessions', async (request, response) =>
    response.json(await sessionStore(request).list()));
  app.post('/api/projects/:projectId/sessions', async (request, response) => {
    const session = await sessionStore(request).create((request.body ?? {}) as CreateSessionRequest);
    response.status(201).json(session);
  });
  app.get('/api/projects/:projectId/sessions/:sessionId', async (request, response) =>
    response.json(await sessionStore(request).get(String(request.params.sessionId))));
  app.patch('/api/projects/:projectId/sessions/:sessionId', async (request, response) => {
    const body = (request.body ?? {}) as RenameSessionRequest;
    response.json(await sessionStore(request).rename(String(request.params.sessionId), body.title));
  });
  app.delete('/api/projects/:projectId/sessions/:sessionId', async (request, response) => {
    const id = String(request.params.sessionId);
    await sessionStore(request).delete(id);
    response.json({ deleted: true, id });
  });
  app.post('/api/projects/:projectId/sessions/:sessionId/messages', async (request, response) => {
    response.status(201).json(await sessionStore(request).append(
      String(request.params.sessionId),
      (request.body ?? {}) as AppendMessageRequest
    ));
  });
  app.post('/api/projects/:projectId/sessions/:sessionId/chat/stream', async (request, response) => {
    const body = (request.body ?? {}) as ChatStreamRequest;
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) {
      response.status(400).json({ error: 'A non-empty message is required.', code: 'content_required' });
      return;
    }
    if (!modelConfig || !modelClient) {
      response.status(503).json({ error: 'The model connection is not configured.', code: 'model_unavailable' });
      return;
    }

    const store = sessionStore(request);
    const project = registry.get(projectId(request));
    const connection = modelConfig.resolve();
    const session = await store.append(String(request.params.sessionId), { role: 'user', content });
    const userMessage = session.messages.at(-1);
    if (!userMessage) {
      throw new Error('The user message could not be persisted.');
    }
    const run: AgentRun = {
      id: randomUUID(),
      status: 'running',
      startedAt: new Date().toISOString(),
      userMessageId: userMessage.id,
      modelConnectionId: connection.definition.id,
      reasoning: '',
      toolEvents: [],
      changedFiles: []
    };
    await store.saveRun(session.id, run);
    const messages: ModelChatMessage[] = [
      {
        role: 'system',
        content: [
          `You are the AAA authorization workbench assistant for project "${project.name}".`,
          'Help the user inspect and develop an A&A security package using the persisted project conversation.',
          'Prioritize traceable control responses, evidence, validation status, and explicit human review before publication.',
          'You can inspect and modify project files with the provided tools.',
          'Use tools when the user asks about project contents or requests a file change; do not merely describe an action you can perform.',
          'Project paths must be relative. Keep the final answer concise and identify files that changed.',
          'Do not claim to have retrieved cloud evidence because cloud evidence tools are not enabled yet.'
        ].join(' ')
      },
      ...session.messages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    ];

    response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();

    const abortController = new AbortController();
    let finished = false;
    const abort = () => {
      if (!finished) {
        abortController.abort(new DOMException('Client disconnected.', 'AbortError'));
      }
    };
    request.once('aborted', abort);
    response.once('close', abort);

    let streamedText = '';
    let streamedReasoning = '';
    const streamedToolEvents: AgentRun['toolEvents'] = [];
    try {
      const result = await new AaaAgentLoop(modelClient, fileService(request)).run(
        connection,
        messages,
        abortController.signal,
        {
          onAssistantText: (text) => {
            streamedText += text;
            writeJsonLine(response, { type: 'assistant_text', text });
          },
          onReasoning: (text) => {
            streamedReasoning += text;
            writeJsonLine(response, { type: 'reasoning', text });
          },
          onToolEvent: (event) => {
            streamedToolEvents.push(event);
            writeJsonLine(response, { type: 'tool_event', event });
          }
        }
      );
      const display: ChatMessageDisplayPart[] = [
        ...(result.reasoning ? [{ kind: 'reasoning' as const, text: result.reasoning }] : []),
        ...(result.toolEvents.length > 0
          ? [{ kind: 'working' as const, title: 'Agent steps', events: result.toolEvents }]
          : [])
      ];
      const updated = await store.append(String(request.params.sessionId), {
        role: 'assistant',
        content: result.content,
        display
      });
      const message = updated.messages.at(-1);
      if (!message) {
        throw new Error('The assistant message could not be persisted.');
      }
      await store.saveRun(session.id, {
        ...run,
        status: 'completed',
        completedAt: new Date().toISOString(),
        assistantMessageId: message.id,
        reasoning: result.reasoning,
        toolEvents: result.toolEvents,
        changedFiles: result.changedFiles,
        assistantText: result.content
      });
      writeJsonLine(response, {
        type: 'completed',
        response: { sessionId: session.id, message },
        changedFiles: result.changedFiles
      });
      finished = true;
      response.end();
    } catch (error) {
      const aborted = abortController.signal.aborted
        || (error instanceof Error && error.name === 'AbortError');
      const safeError = aborted ? 'Request aborted.' : 'Model response failed.';
      try {
        await store.saveRun(session.id, {
          ...run,
          status: aborted ? 'aborted' : 'failed',
          completedAt: new Date().toISOString(),
          reasoning: streamedReasoning,
          toolEvents: streamedToolEvents,
          changedFiles: Array.from(new Set(streamedToolEvents
            .filter((event) => event.type === 'create' || event.type === 'edit')
            .map((event) => event.filePath)
            .filter((filePath): filePath is string => Boolean(filePath)))),
          ...(streamedText ? { assistantText: streamedText } : {}),
          error: safeError
        });
      } catch (persistenceError) {
        console.error(`[agent-run] Could not persist ${aborted ? 'aborted' : 'failed'} run ${run.id}: ${
          persistenceError instanceof Error ? persistenceError.message : String(persistenceError)
        }`);
      }
      if (!response.destroyed && !response.writableEnded) {
        writeJsonLine(response, {
          type: 'error',
          message: safeError
        });
        finished = true;
        response.end();
      }
    } finally {
      finished = true;
      request.off('aborted', abort);
      response.off('close', abort);
    }
  });

  if (clientDistPath && fs.existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath, { index: false }));
    const clientIndex = fs.readFileSync(path.join(clientDistPath, 'index.html'), 'utf8');
    app.get(/^(?!\/api(?:\/|$)).*/, (_request, response) => response.type('html').send(clientIndex));
  }

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    void _next;
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === 'ENOENT') {
      response.status(404).json({ error: 'The requested resource was not found.', code: 'not_found' });
      return;
    }
    const message = error instanceof Error ? error.message : 'Unknown server error.';
    console.error(`[api] ${message}`);
    response.status(500).json({ error: 'Internal server error.', code: 'internal_error' });
  });
  return app;
}
