import express from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  AppendMessageRequest,
  AgentRun,
  BrowserCaptureRequest,
  BrowserLaunchRequest,
  BrowserNavigateRequest,
  ChatMessageDisplayPart,
  ChatStreamEvent,
  ChatStreamRequest,
  ChatSession,
  CompactSessionRequest,
  CreateSessionRequest,
  CreateProjectRequest,
  CreateTextFileRequest,
  ModelDiagnosticsReport,
  RenameProjectPathRequest,
  RenameSessionRequest,
  RunUsage,
  SaveCustomizationRequest,
  SetCustomizationEnabledRequest,
  UploadProjectFileRequest,
  WriteTextFileRequest
} from '../src/types/api.js';
import { AaaAgentLoop } from './aaaAgentLoop.js';
import { AgentRunError, HttpError } from './httpErrors.js';
import type { ModelChatClient, ModelChatMessage } from './modelTypes.js';
import { ProjectFileService } from './projectFileService.js';
import { ProjectCustomizationService } from './projectCustomizationService.js';
import { ProjectRegistry } from './projectRegistry.js';
import { ProjectWorkflowService } from './projectWorkflowService.js';
import { McpHttpClient, McpToolbox } from './services/mcpHttpClient.js';
import { BrowserCaptureService } from './services/browserCaptureService.js';
import type { ModelConnectionConfig } from './services/modelConnectionConfig.js';
import type { ChatSessionStoreFactory } from './chatSessionStore.js';
import { compactSession, summaryPromptSection, uncompactedMessages } from './sessionCompaction.js';
import { log } from './logger.js';
import { createEntraTokenVerifier, installAppAuth, loadAppAuthConfig, type AppAuthConfig, type TokenVerifier } from './appAuth.js';
import { describeShape } from './services/azureOpenAiChatClient.js';
import { probeModelConnection } from './services/modelProbe.js';
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
  /** Fetch implementation for project MCP servers; injectable for tests. */
  mcpFetch?: typeof globalThis.fetch;
  /** Fetch implementation for model diagnostics; injectable for tests. */
  modelFetch?: typeof globalThis.fetch;
  /** Optional Microsoft Entra sign-in; off unless `config.mode` is `entra`. */
  auth?: { config: AppAuthConfig; verifier?: TokenVerifier };
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
  storageStatus,
  mcpFetch = globalThis.fetch,
  modelFetch,
  auth
}: AaaAppDependencies): express.Express {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  const authConfig = auth?.config ?? loadAppAuthConfig({});
  installAppAuth(
    app,
    authConfig,
    auth?.verifier ?? (authConfig.mode === 'entra' ? createEntraTokenVerifier(authConfig) : undefined)
  );
  const localPersistence = sessionStoreFactory && storageStatus
    ? undefined
    : createSessionPersistence(dataRoot, { environment: {} });
  const createSessionStore = sessionStoreFactory ?? localPersistence!.sessionStoreFactory;
  const effectiveStorageStatus = storageStatus ?? localPersistence!.storageStatus;
  const browserCapture = new BrowserCaptureService(dataRoot);

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
  app.delete('/api/projects/:projectId', async (request, response) => {
    const id = projectId(request);
    await browserCapture.close(id);
    const projects = await registry.delete(id);
    await rm(path.join(dataRoot, 'projects', id), { recursive: true, force: true });
    await rm(path.join(dataRoot, 'browser-profiles', id), { recursive: true, force: true });
    response.json(projects);
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
        endpointKind: 'auto',
        api: 'auto',
        adaptive: true,
        autoCompact: false,
        compactThreshold: 0.8
      });
      return;
    }
    response.json(modelConfig.status());
  });
  app.post('/api/model/diagnostics', async (_request, response) => {
    if (!modelConfig) {
      response.status(503).json({ error: 'The model connection is not configured.', code: 'model_unavailable' });
      return;
    }
    const status = modelConfig.status();
    if (!status.ready) {
      response.status(409).json({
        error: `The model connection is not ready. Missing: ${status.missing.join(', ')}.`,
        code: 'model_not_ready'
      });
      return;
    }
    const abortController = new AbortController();
    const abort = () => abortController.abort(new DOMException('Client disconnected.', 'AbortError'));
    response.once('close', abort);
    try {
      const report = await probeModelConnection(modelConfig.resolve(), {
        fetchImpl: modelFetch,
        signal: abortController.signal
      });
      const failures = report.results.flatMap((result) => result.checks
        .filter((check) => !check.ok)
        .map((check) => `${result.api}/${check.scenario}: ${check.detail}`));
      if (failures.length > 0) {
        log.error('model', 'Diagnostics found failing checks.', { endpointHost: status.endpointHost, failures: failures.join(' | ') });
      } else {
        log.info('model', 'Diagnostics passed.', { endpointHost: status.endpointHost, recommended: report.recommended?.api });
      }
      const body: ModelDiagnosticsReport = {
        testedAt: new Date().toISOString(),
        status,
        results: report.results.map((result) => ({
          api: result.api,
          url: result.url,
          ok: result.ok,
          checks: result.checks,
          ...(result.learned ? { adaptedTo: describeShape(result.learned) } : {}),
          notes: result.notes
        })),
        ...(report.recommended ? { recommended: report.recommended } : {})
      };
      response.json(body);
    } finally {
      response.off('close', abort);
    }
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
  app.post('/api/projects/:projectId/customizations/:itemId/test', async (request, response) => {
    const id = projectId(request);
    response.json(await new ProjectWorkflowService(id, registry.root(id))
      .testCapability(String(request.params.itemId), mcpFetch));
  });
  app.get('/api/projects/:projectId/workflow', async (request, response) => {
    const id = projectId(request);
    response.json(await new ProjectWorkflowService(id, registry.root(id)).summary());
  });
  app.get('/api/projects/:projectId/tree', async (request, response) =>
    response.json(await fileService(request).listTree({ includeHidden: request.query.hidden === 'true' })));
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
  app.post('/api/projects/:projectId/uploads', async (request, response) => {
    const body = (request.body ?? {}) as UploadProjectFileRequest;
    response.status(201).json(await fileService(request).uploadFile(body.path, body.contentBase64));
  });
  app.patch('/api/projects/:projectId/paths', async (request, response) => {
    const body = (request.body ?? {}) as RenameProjectPathRequest;
    response.json(await fileService(request).renamePath(body.path, body.newPath));
  });
  app.delete('/api/projects/:projectId/paths', async (request, response) =>
    response.json(await fileService(request).deletePath(String(request.query.path ?? ''))));
  app.get('/api/projects/:projectId/images', async (request, response) => {
    const image = await fileService(request).readImage(String(request.query.path ?? ''));
    response
      .set('Content-Security-Policy', "default-src 'none'; sandbox")
      .set('X-Content-Type-Options', 'nosniff')
      .type(image.contentType)
      .send(image.content);
  });
  app.get('/api/projects/:projectId/publication-status', async (request, response) =>
    response.json(await fileService(request).publicationStatus(String(request.query.path ?? ''))));
  app.put('/api/projects/:projectId/publication-status', async (request, response) =>
    response.json(await fileService(request).markReviewed(
      String((request.body as { path?: string } | undefined)?.path ?? '')
    )));
  app.get('/api/projects/:projectId/published', async (request, response) => {
    const html = await fileService(request).renderPublishedMarkdown(String(request.query.path ?? ''));
    response.type('html').send(html);
  });
  app.get('/api/projects/:projectId/browser', (request, response) =>
    response.json(browserCapture.status(projectId(request))));
  app.post('/api/projects/:projectId/browser/launch', async (request, response) => {
    const id = projectId(request);
    response.json(await browserCapture.launch(id, (request.body ?? {}) as BrowserLaunchRequest));
  });
  app.post('/api/projects/:projectId/browser/navigate', async (request, response) => {
    const id = projectId(request);
    response.json(await browserCapture.navigate(id, (request.body ?? {}) as BrowserNavigateRequest));
  });
  app.post('/api/projects/:projectId/browser/capture', async (request, response) => {
    const id = projectId(request);
    response.status(201).json(await browserCapture.capture(
      id,
      new ProjectFileService(registry.root(id)),
      (request.body ?? {}) as BrowserCaptureRequest
    ));
  });
  app.delete('/api/projects/:projectId/browser', async (request, response) =>
    response.json(await browserCapture.close(projectId(request))));

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
  app.post('/api/projects/:projectId/sessions/:sessionId/compact', async (request, response) => {
    if (!modelConfig || !modelClient) {
      response.status(503).json({ error: 'The model connection is not configured.', code: 'model_unavailable' });
      return;
    }
    const store = sessionStore(request);
    const body = (request.body ?? {}) as CompactSessionRequest;
    const session = await store.get(String(request.params.sessionId));
    let compaction;
    try {
      compaction = await compactSession({
        session,
        connection: modelConfig.resolve(),
        modelClient,
        trigger: 'manual',
        focus: typeof body.focus === 'string' ? body.focus : undefined
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      log.error('compaction', 'Manual compaction failed; the conversation was not changed.', { session: session.id, error });
      response.status(502).json({
        error: error instanceof AgentRunError ? error.message : 'Compaction failed because the model request did not complete.',
        code: 'compaction_failed'
      });
      return;
    }
    response.json(await store.saveCompaction(session.id, compaction));
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
    const workflow = await new ProjectWorkflowService(project.id, project.rootPath).load();
    const expanded = ProjectWorkflowService.expandCommand(workflow, content);
    const agent = ProjectWorkflowService.resolveAgent(
      workflow,
      expanded.agentId ?? (typeof body.agentId === 'string' ? body.agentId : undefined)
    );
    const toolSelection = ProjectWorkflowService.selectTools(workflow, agent);
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
      changedFiles: [],
      ...(request.identity ? { requestedBy: { userId: request.identity.userId, displayName: request.identity.displayName } } : {})
    };
    await store.saveRun(session.id, run);
    const systemPrompt = ProjectWorkflowService.systemPrompt({
      projectName: project.name,
      agent,
      skills: workflow.skills,
      tools: toolSelection,
      instructions: workflow.instructions
    });
    const modelMessages = (state: ChatSession): ModelChatMessage[] => [
      { role: 'system', content: systemPrompt + summaryPromptSection(state) },
      ...uncompactedMessages(state).map((message) => ({
        role: message.role,
        content: message.id === userMessage.id ? expanded.content : message.content
      }))
    ];
    const messages = modelMessages(session);

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
    let streamedUsage: RunUsage | undefined;
    const streamedToolEvents: AgentRun['toolEvents'] = [];
    const autoCompact = modelConfig.status().autoCompact;
    try {
      const result = await new AaaAgentLoop(modelClient, fileService(request), {
        tools: toolSelection.builtIns,
        skills: workflow.skills,
        mcp: toolSelection.mcpServers.length > 0
          ? new McpToolbox(toolSelection.mcpServers.map((server) => new McpHttpClient(server, mcpFetch)))
          : undefined,
        mcpFilter: toolSelection.allowMcpTool,
        browserCapture,
        projectId: project.id,
        notices: toolSelection.unavailableMcpServers.map((server) => ({
          type: 'mcp' as const,
          label: 'MCP server unavailable',
          detail: `MCP server ${server.name} is enabled but cannot be used: ${server.reason ?? 'unsupported configuration'}`
        })),
        onContextPressure: autoCompact
          ? async () => {
            const earlier = uncompactedMessages(session).at(-2);
            if (!earlier) return undefined;
            writeJsonLine(response, { type: 'status', message: 'Compacting earlier conversation to fit the context window…' });
            try {
              const compaction = await compactSession({
                session,
                connection,
                modelClient,
                trigger: 'auto',
                throughMessageId: earlier.id,
                signal: abortController.signal
              });
              const compacted = await store.saveCompaction(session.id, compaction);
              writeJsonLine(response, { type: 'compaction', compaction });
              return { messages: modelMessages(compacted), usage: compaction.usage };
            } catch (error) {
              if (abortController.signal.aborted) throw error;
              const detail = error instanceof AgentRunError || error instanceof HttpError
                ? error.message
                : 'the model request did not complete';
              log.error('compaction', 'Automatic compaction failed; continuing with the full conversation.', {
                session: session.id,
                error
              });
              writeJsonLine(response, { type: 'status', message: `Automatic compaction skipped: ${detail}` });
              return undefined;
            }
          }
          : undefined
      }).run(
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
          },
          onUsage: (usage) => {
            streamedUsage = usage;
            writeJsonLine(response, { type: 'usage', usage });
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
        assistantText: result.content,
        usage: result.usage
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
      const safeError = aborted
        ? 'Request aborted.'
        : error instanceof AgentRunError
          ? error.message
          : 'Model response failed.';
      if (aborted) {
        log.info('agent-run', 'Run stopped.', { run: run.id, session: session.id, project: project.id });
      } else {
        log.error('agent-run', 'Run failed.', {
          run: run.id,
          session: session.id,
          project: project.id,
          user: request.identity?.username ?? request.identity?.userId,
          agent: agent?.name ?? 'default',
          command: expanded.command ? `/${expanded.command.id}` : undefined,
          toolSteps: streamedToolEvents.length,
          requests: streamedUsage?.requests,
          error: error instanceof AgentRunError ? error.message : error
        });
      }
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
          ...(streamedUsage ? { usage: streamedUsage } : {}),
          error: safeError
        });
      } catch (persistenceError) {
        log.error('agent-run', `Could not persist the ${aborted ? 'aborted' : 'failed'} run.`, {
          run: run.id,
          session: session.id,
          error: persistenceError
        });
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

  app.use((error: unknown, request: express.Request, response: express.Response, _next: express.NextFunction) => {
    void _next;
    if (error instanceof HttpError) {
      const level = error.statusCode >= 500 ? 'error' : 'info';
      log[level]('api', `${request.method} ${request.path} returned ${error.statusCode}.`, { code: error.code, error: error.message });
      response.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === 'ENOENT') {
      log.info('api', `${request.method} ${request.path} returned 404.`, { error: nodeError.message });
      response.status(404).json({ error: 'The requested resource was not found.', code: 'not_found' });
      return;
    }
    log.error('api', `${request.method} ${request.path} failed with an unexpected error.`, { error });
    response.status(500).json({ error: 'Internal server error.', code: 'internal_error' });
  });
  return app;
}
