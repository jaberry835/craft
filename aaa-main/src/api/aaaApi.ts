import type {
  AppendMessageRequest,
  BrowserCaptureRequest,
  BrowserCaptureResult,
  BrowserLaunchRequest,
  BrowserNavigateRequest,
  BrowserSessionStatus,
  ChatStreamEvent,
  ChatStreamRequest,
  ChatSession,
  ChatSessionSummary,
  CapabilityTestResult,
  CustomizationItem,
  CustomizationEditor,
  CreateProjectRequest,
  CreateSessionRequest,
  CreateTextFileRequest,
  FileTreeNode,
  ProjectSummary,
  ProjectsResponse,
  ProjectTextFile,
  ProjectPathResult,
  PublicationStatus,
  ModelConnectionStatus,
  ProjectCustomizations,
  ProjectWorkflowSummary,
  SaveCustomizationRequest,
  SetCustomizationEnabledRequest,
  RenameProjectPathRequest,
  RenameSessionRequest,
  StorageStatus,
  UploadedProjectFile,
  UploadProjectFileRequest,
  WriteTextFileRequest
} from '../types/api.js';

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export class ApiUnavailableError extends Error {
  constructor(message = 'Could not connect to the local AAA API. Start the full workbench with npm run dev.') {
    super(message);
    this.name = 'ApiUnavailableError';
  }
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function requestJson<T>(url: string, init?: RequestInit, unavailableRetries = 0): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers }
    });
  } catch (error) {
    if (unavailableRetries > 0) {
      await wait(350);
      return requestJson<T>(url, init, unavailableRetries - 1);
    }
    throw new ApiUnavailableError(error instanceof Error
      ? `Could not connect to the local AAA API. Start the full workbench with npm run dev. (${error.message})`
      : undefined);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText, code: 'request_failed' })) as {
      error?: string;
      code?: string;
    };
    throw new ApiRequestError(response.status, payload.code ?? 'request_failed', payload.error ?? response.statusText);
  }
  return response.json() as Promise<T>;
}

export async function parseNdjsonStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatStreamEvent) => void | Promise<void>
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flushBuffer = async (force = false) => {
    const lines = buffer.split('\n');
    buffer = force ? '' : lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        await onEvent(JSON.parse(trimmed) as ChatStreamEvent);
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    await flushBuffer(done);
    if (done) {
      break;
    }
  }
}

async function requestStream(
  url: string,
  init: RequestInit,
  onEvent: (event: ChatStreamEvent) => void | Promise<void>
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers }
    });
  } catch (error) {
    if (init.signal?.aborted) {
      throw error;
    }
    throw new ApiUnavailableError(error instanceof Error ? error.message : undefined);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({
      error: response.statusText,
      code: 'request_failed'
    })) as { error?: string; code?: string };
    throw new ApiRequestError(
      response.status,
      payload.code ?? 'request_failed',
      payload.error ?? response.statusText
    );
  }
  if (!response.body) {
    throw new Error('Streaming is not available in this browser session.');
  }
  let terminal = false;
  await parseNdjsonStream(response.body, (event) => {
    if (event.type === 'completed' || event.type === 'error') terminal = true;
    return onEvent(event);
  });
  if (!terminal && !init.signal?.aborted) {
    throw new Error('The response stream ended before the agent finished. Reload the session to see any saved progress.');
  }
}

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;
const sessionPath = (projectId: string, sessionId?: string) =>
  `${projectPath(projectId)}/sessions${sessionId ? `/${encodeURIComponent(sessionId)}` : ''}`;

export const aaaApi = {
  listProjects: () => requestJson<ProjectsResponse>('/api/projects', undefined, 6),
  createProject: (request: CreateProjectRequest) =>
    requestJson<ProjectSummary>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(request)
    }),
  selectProject: (projectId: string) =>
    requestJson<ProjectSummary>('/api/projects/active', {
      method: 'PUT',
      body: JSON.stringify({ projectId })
    }),
  getModelStatus: () => requestJson<ModelConnectionStatus>('/api/model/status'),
  getStorageStatus: () => requestJson<StorageStatus>('/api/storage/status'),
  getProject: (projectId: string) => requestJson<ProjectSummary>(projectPath(projectId)),
  getCustomizations: (projectId: string) =>
    requestJson<ProjectCustomizations>(`${projectPath(projectId)}/customizations`),
  getCustomization: (projectId: string, itemId: string) =>
    requestJson<CustomizationEditor>(
      `${projectPath(projectId)}/customizations/${encodeURIComponent(itemId)}`
    ),
  createCustomization: (projectId: string, request: SaveCustomizationRequest) =>
    requestJson<CustomizationEditor>(`${projectPath(projectId)}/customizations`, {
      method: 'POST',
      body: JSON.stringify(request)
    }),
  updateCustomization: (projectId: string, itemId: string, request: SaveCustomizationRequest) =>
    requestJson<CustomizationEditor>(
      `${projectPath(projectId)}/customizations/${encodeURIComponent(itemId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(request)
      }
    ),
  setCustomizationEnabled: (
    projectId: string,
    itemId: string,
    request: SetCustomizationEnabledRequest
  ) =>
    requestJson<CustomizationItem>(
      `${projectPath(projectId)}/customizations/${encodeURIComponent(itemId)}/enabled`,
      {
        method: 'PUT',
        body: JSON.stringify(request)
      }
    ),
  testCapability: (projectId: string, itemId: string) =>
    requestJson<CapabilityTestResult>(
      `${projectPath(projectId)}/customizations/${encodeURIComponent(itemId)}/test`,
      { method: 'POST' }
    ),
  getWorkflow: (projectId: string) => requestJson<ProjectWorkflowSummary>(`${projectPath(projectId)}/workflow`),
  getFileTree: (projectId: string, includeHidden = false) =>
    requestJson<FileTreeNode[]>(`${projectPath(projectId)}/tree${includeHidden ? '?hidden=true' : ''}`),
  readTextFile: (projectId: string, filePath: string) =>
    requestJson<ProjectTextFile>(`${projectPath(projectId)}/files?path=${encodeURIComponent(filePath)}`),
  writeTextFile: (projectId: string, request: WriteTextFileRequest) =>
    requestJson<ProjectTextFile>(`${projectPath(projectId)}/files`, {
      method: 'PUT',
      body: JSON.stringify(request)
    }),
  createTextFile: (projectId: string, request: CreateTextFileRequest) =>
    requestJson<ProjectTextFile>(`${projectPath(projectId)}/files`, {
      method: 'POST',
      body: JSON.stringify(request)
    }),
  uploadFile: (projectId: string, request: UploadProjectFileRequest) =>
    requestJson<UploadedProjectFile>(`${projectPath(projectId)}/uploads`, {
      method: 'POST',
      body: JSON.stringify(request)
    }),
  renamePath: (projectId: string, request: RenameProjectPathRequest) =>
    requestJson<ProjectPathResult>(`${projectPath(projectId)}/paths`, {
      method: 'PATCH',
      body: JSON.stringify(request)
    }),
  deletePath: (projectId: string, filePath: string) =>
    requestJson<ProjectPathResult>(`${projectPath(projectId)}/paths?path=${encodeURIComponent(filePath)}`, {
      method: 'DELETE'
    }),
  imageUrl: (projectId: string, filePath: string) =>
    `${projectPath(projectId)}/images?path=${encodeURIComponent(filePath)}`,
  getPublicationStatus: (projectId: string, filePath: string) =>
    requestJson<PublicationStatus>(
      `${projectPath(projectId)}/publication-status?path=${encodeURIComponent(filePath)}`
    ),
  markReviewed: (projectId: string, filePath: string) =>
    requestJson<PublicationStatus>(`${projectPath(projectId)}/publication-status`, {
      method: 'PUT',
      body: JSON.stringify({ path: filePath })
    }),
  publishedMarkdownUrl: (projectId: string, filePath: string) =>
    `${projectPath(projectId)}/published?path=${encodeURIComponent(filePath)}`,
  getBrowserStatus: (projectId: string) =>
    requestJson<BrowserSessionStatus>(`${projectPath(projectId)}/browser`),
  launchBrowser: (projectId: string, request: BrowserLaunchRequest) =>
    requestJson<BrowserSessionStatus>(`${projectPath(projectId)}/browser/launch`, {
      method: 'POST',
      body: JSON.stringify(request)
    }),
  navigateBrowser: (projectId: string, request: BrowserNavigateRequest) =>
    requestJson<BrowserSessionStatus>(`${projectPath(projectId)}/browser/navigate`, {
      method: 'POST',
      body: JSON.stringify(request)
    }),
  captureBrowser: (projectId: string, request: BrowserCaptureRequest) =>
    requestJson<BrowserCaptureResult>(`${projectPath(projectId)}/browser/capture`, {
      method: 'POST',
      body: JSON.stringify(request)
    }),
  closeBrowser: (projectId: string) =>
    requestJson<BrowserSessionStatus>(`${projectPath(projectId)}/browser`, { method: 'DELETE' }),
  listSessions: (projectId: string) => requestJson<ChatSessionSummary[]>(sessionPath(projectId)),
  createSession: (projectId: string, request: CreateSessionRequest = {}) =>
    requestJson<ChatSession>(sessionPath(projectId), { method: 'POST', body: JSON.stringify(request) }),
  getSession: (projectId: string, sessionId: string) =>
    requestJson<ChatSession>(sessionPath(projectId, sessionId)),
  renameSession: (projectId: string, sessionId: string, request: RenameSessionRequest) =>
    requestJson<ChatSession>(sessionPath(projectId, sessionId), { method: 'PATCH', body: JSON.stringify(request) }),
  deleteSession: (projectId: string, sessionId: string) =>
    requestJson<{ deleted: true; id: string }>(sessionPath(projectId, sessionId), { method: 'DELETE' }),
  appendMessage: (projectId: string, sessionId: string, request: AppendMessageRequest) =>
    requestJson<ChatSession>(`${sessionPath(projectId, sessionId)}/messages`, {
      method: 'POST',
      body: JSON.stringify(request)
    }),
  streamChat: (
    projectId: string,
    sessionId: string,
    request: ChatStreamRequest,
    onEvent: (event: ChatStreamEvent) => void | Promise<void>,
    signal?: AbortSignal
  ) => requestStream(`${sessionPath(projectId, sessionId)}/chat/stream`, {
    method: 'POST',
    body: JSON.stringify(request),
    signal
  }, onEvent)
};
