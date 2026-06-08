import type { ChangeEvent, SyntheticEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Database,
  FileText,
  Folder,
  MessageSquare,
  Moon,
  Send,
  Settings,
  ShieldCheck,
  Upload,
  Plus,
  Save,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Sparkles,
  Square,
  Sun,
  Trash2,
  X
} from 'lucide-react';
import { AuthRequiredError, RequestError, workbenchApi } from './api/workbenchApi';
import { PremiumJuniorWorkbenchIcon } from './components/PremiumWorkbenchIcons';
import type { AdminConnectivityReport, AgentAiSettings, AgentConnectionSaveRequest, AgentConnectionType, AgentDefinition, AgentGroundingSource, AgentModelConnectionStatus, AgentResponse, AgentTemplateDefinition, AuthConfig, AuthDiagnostics, AzureAiSearchGroundingSource, AzureAuthMode, AzureCloud, AzureOpenAiEndpointKind, ChatMessage, ChatMessageDisplayPart, ChatSessionSummary, ClassificationBarSettings, ConnectivityCheck, ConnectivitySection, McpCatalogEntry, McpCustomHeader, McpServerAuthMode, McpServerStatus, ReasoningEffort, RequestIdentitySummary, WorkspaceFile, WorkspaceIndex, WorkspaceSummary, WorkspaceTemplateDefinition, WorkspaceTreeNode } from './types/workbench';
import './App.css';

const defaultCustomAgentPrompt = `You are a domain-expert assistant.

## Role
Describe what this agent specializes in.

## Domain knowledge
List the key concepts, docs, and naming conventions to prefer.

## Behavior
- Prefer grounded knowledge when available.
- Keep answers concise and cite relevant workspace or search context.
- Build or update workspace files directly when the task is clear.`;
const themeStorageKey = 'jr-workbench-theme';

type ThemeMode = 'light' | 'dark';
type MarkdownViewMode = 'edit' | 'preview' | 'split';
type PreviewFileType = 'markdown' | 'svg';
type AuthBootstrapState = 'loading' | 'authorized' | 'signin-required' | 'access-denied';

interface LiveAssistantTurn {
  id: string;
  content: string;
  reasoning: string;
}

const defaultReasoningEffort: ReasoningEffort = 'medium';
const defaultAdminDevIdentity = {
  userId: 'admin',
  displayName: 'Admin',
  tenantId: '',
  roles: 'Junior.Admin,Junior.User'
};
const defaultUserDevIdentity = {
  userId: 'user-1',
  displayName: 'Local User',
  tenantId: '',
  roles: 'Junior.User'
};

const panelRailWidth = 54;
const splitterWidth = 10;
const minEditorPaneWidth = 360;
const minSidebarPaneWidth = 190;
const minChatPaneWidth = 280;
const defaultChatPaneRatio = 0.5;
const maxChatPaneRatio = 0.5;

function getInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'light';
  }

  const storedTheme = window.localStorage.getItem(themeStorageKey);
  if (storedTheme === 'light' || storedTheme === 'dark') {
    return storedTheme;
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function linesFromList(values?: string[]): string {
  return values?.join('\n') ?? '';
}

function listFromLines(value: string): string[] | undefined {
  const items = value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function linesFromHeaders(headers?: Array<{ name: string }>): string {
  return headers?.map((header) => `${header.name}:`).join('\n') ?? '';
}

function headersFromLines(value: string): McpCustomHeader[] | undefined {
  const headers = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.indexOf(':');
      if (separatorIndex === -1) {
        return { name: line };
      }

      const name = line.slice(0, separatorIndex).trim();
      const headerValue = line.slice(separatorIndex + 1).trim();
      return headerValue ? { name, value: headerValue } : { name };
    })
    .filter((header) => header.name);

  return headers.length > 0 ? headers : undefined;
}

function toggleSelection(current: string[], value: string): string[] {
  return current.includes(value)
    ? current.filter((candidate) => candidate !== value)
    : [...current, value];
}

function numberDraft(value?: number): string {
  return value === undefined ? '' : String(value);
}

function resolveAgentAiSettingsDraft(
  temperatureDraft: string,
  maxTokensDraft: string,
  reasoningEffort: ReasoningEffort
): AgentAiSettings {
  const temperatureValue = temperatureDraft.trim();
  const maxTokensValue = maxTokensDraft.trim();

  let temperature: number | undefined;
  if (temperatureValue) {
    temperature = Number(temperatureValue);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new Error('Temperature must be a number between 0.0 and 2.0.');
    }
  }

  let maxTokens: number | undefined;
  if (maxTokensValue) {
    maxTokens = Number(maxTokensValue);
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw new Error('Max output tokens must be a positive integer.');
    }
  }

  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    reasoningEffort
  };
}

function flattenFiles(nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] {
  return nodes.flatMap((node) => node.type === 'file' ? [node] : flattenFiles(node.children ?? []));
}

function findTreeNode(nodes: WorkspaceTreeNode[], targetPath: string | null | undefined): WorkspaceTreeNode | undefined {
  if (!targetPath) {
    return undefined;
  }

  for (const node of nodes) {
    if (node.path === targetPath) {
      return node;
    }

    const childMatch = findTreeNode(node.children ?? [], targetPath);
    if (childMatch) {
      return childMatch;
    }
  }

  return undefined;
}

function languageForPath(path: string): string {
  if (path.endsWith('.md')) {
    return 'markdown';
  }
  if (path.endsWith('.svg')) {
    return 'xml';
  }
  if (path.endsWith('.json')) {
    return 'json';
  }
  return 'plaintext';
}

function isMarkdownPath(path?: string | null): boolean {
  if (!path) {
    return false;
  }

  return path.endsWith('.md') || path.endsWith('.markdown');
}

function isSvgPath(path?: string | null): boolean {
  if (!path) {
    return false;
  }

  return path.endsWith('.svg');
}

const uploadableExtensions = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv', '.svg']);

function normalizeUploadPath(fileName: string): string {
  return `uploads/${fileName.replaceAll('\\', '/').split('/').pop() ?? fileName}`;
}

function isUploadableDocument(fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  const extension = normalized.includes('.') ? normalized.slice(normalized.lastIndexOf('.')) : '';
  return uploadableExtensions.has(extension);
}

function renderPlainText(text: string) {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph, index) => <p key={`${paragraph}-${index}`}>{paragraph}</p>);
}

function renderStreamingText(text: string, className = 'message-stream-text') {
  return <div className={className}>{text}</div>;
}

function normalizeReasoningStreamText(text: string) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '');
}

function mergeStreamedReasoning(message: ChatMessage, streamedReasoning: string): ChatMessage {
  const normalizedReasoning = streamedReasoning.trim();

  if (!normalizedReasoning || message.display?.some((part) => part.kind === 'reasoning')) {
    return message;
  }

  return {
    ...message,
    display: [
      ...(message.display ?? []),
      {
        kind: 'reasoning',
        text: normalizedReasoning
      }
    ]
  };
}

function hasAdminRole(identity: RequestIdentitySummary | null): boolean {
  if (!identity) {
    return false;
  }

  return identity.roles.some((role) => role === 'admin' || role === 'Junior.Admin');
}

function hasWorkbenchRole(identity: RequestIdentitySummary | null): boolean {
  if (!identity) {
    return false;
  }

  return identity.roles.some((role) => role === 'admin' || role === 'Junior.Admin' || role === 'Junior.User');
}

function authModeLabel(identity: RequestIdentitySummary | null): string {
  if (!identity) {
    return 'loading';
  }

  switch (identity.authSource) {
    case 'trusted-header':
      return 'trusted-header';
    case 'token':
      return 'entra-msal';
    default:
      return 'local-fallback';
  }
}

function identityInitials(identity: RequestIdentitySummary | null): string {
  if (!identity) {
    return '--';
  }

  const source = identity.displayName.trim() || identity.userId.trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '--';
  }

  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('');
}

function isLocalDevHost(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

function buildAuthActionUrl(path: string | null | undefined, redirectParam: 'post_login_redirect_uri' | 'post_logout_redirect_uri', redirectTarget?: string): string | null {
  if (!path) {
    return null;
  }

  if (typeof window === 'undefined') {
    return path;
  }

  const url = new URL(path, window.location.origin);
  if (!url.searchParams.has(redirectParam)) {
    url.searchParams.set(redirectParam, redirectTarget ?? window.location.href);
  }

  return url.toString();
}

function renderMessageDisplayPart(
  part: ChatMessageDisplayPart,
  messageId: string,
  onToggleDetail: (event: SyntheticEvent<HTMLDetailsElement>) => void
) {
  if (part.kind === 'reasoning') {
    return (
      <details key={`${messageId}-reasoning`} className="message-detail message-reasoning" onToggle={onToggleDetail}>
        <summary className="message-detail-toggle" title="Reasoning">
          <Sparkles size={12} />
          <span>Reasoning</span>
          <ChevronDown size={12} className="message-detail-chevron" />
        </summary>
        <div className="message-detail-panel message-reasoning-panel">
          <div className="message-reasoning-panel-header">
            <Sparkles size={13} />
            <strong>Reasoning</strong>
          </div>
          <div className="message-reasoning-body">
            {renderPlainText(part.text)}
          </div>
        </div>
      </details>
    );
  }

  return (
    <details key={`${messageId}-working`} className="message-detail message-working" onToggle={onToggleDetail}>
      <summary className="message-detail-toggle" title={part.title}>
        <Sparkles size={12} />
        <span>Steps</span>
        <small>{part.events.length}</small>
        <ChevronDown size={12} className="message-detail-chevron" />
      </summary>
      <div className="message-detail-panel message-working-panel">
        <div className="message-working-panel-header">
          <Sparkles size={13} />
          <strong>{part.title}</strong>
          <small>{part.events.length} step{part.events.length === 1 ? '' : 's'}</small>
        </div>
        <div className="message-working-events">
          {part.events.map((event) => (
            <div key={event.id} className="message-working-event">
              <Sparkles size={14} />
              <div>
                <span>{event.label}</span>
                {event.detail && <small>{event.detail}</small>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function LiveReasoningBody({ reasoning }: { reasoning: string }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = bodyRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [reasoning]);

  return (
    <div ref={bodyRef} className="message-reasoning-body live-scroll">
      {reasoning.trim()
        ? renderStreamingText(reasoning, 'message-stream-text reasoning-stream-text')
        : <p className="muted">No reasoning emitted yet.</p>}
    </div>
  );
}

function renderLiveReasoning(
  reasoning: string,
  messageId: string,
  onToggleDetail: (event: SyntheticEvent<HTMLDetailsElement>) => void
) {
  return (
    <details key={`${messageId}-live-reasoning`} className="message-detail message-reasoning live" onToggle={onToggleDetail} open>
      <summary className="message-detail-toggle message-reasoning-summary" aria-label="Live reasoning">
        <Sparkles size={12} />
        <span>Reasoning</span>
        <small>Live</small>
        <ChevronDown size={12} className="message-detail-chevron" />
      </summary>
      <div className="message-detail-panel message-reasoning-panel">
        <div className="message-reasoning-panel-header live">
          <Sparkles size={13} />
          <strong>Live reasoning</strong>
        </div>
        <LiveReasoningBody reasoning={reasoning} />
      </div>
    </details>
  );
}

function connectivityTone(status: ConnectivitySection['status'] | ConnectivityCheck['status']): 'ready' | 'missing' {
  return status === 'ok' ? 'ready' : 'missing';
}

function classificationTextColor(color: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(color.trim());
  if (!match) {
    return '#ffffff';
  }

  const hex = match[1];
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * red) + (0.587 * green) + (0.114 * blue);
  return luminance > 170 ? '#111827' : '#ffffff';
}

function resolveAzureOpenAiEndpointKind(endpoint: string, endpointKind: AzureOpenAiEndpointKind): Exclude<AzureOpenAiEndpointKind, 'auto'> | 'unresolved' {
  if (endpointKind !== 'auto') {
    return endpointKind;
  }

  const trimmed = endpoint.trim();
  if (!trimmed) {
    return 'unresolved';
  }

  if (/\/api\/projects\//i.test(trimmed)) {
    return 'foundry-project';
  }

  if (/\/openai\/v1(?:\/|$)/i.test(trimmed) || /\/(chat\/completions|responses)$/i.test(trimmed)) {
    return 'openai-v1';
  }

  return 'azure-openai-legacy';
}

function azureOpenAiEndpointKindLabel(endpoint: string, endpointKind: AzureOpenAiEndpointKind): string {
  const resolved = resolveAzureOpenAiEndpointKind(endpoint, endpointKind);
  switch (resolved) {
    case 'foundry-project':
      return 'Foundry project';
    case 'openai-v1':
      return 'OpenAI-compatible v1';
    case 'azure-openai-legacy':
      return 'Azure OpenAI legacy';
    default:
      return 'Auto';
  }
}

function suggestedCredentialScope(endpoint: string, cloud: AzureCloud, endpointKind: AzureOpenAiEndpointKind): string {
  const resolved = resolveAzureOpenAiEndpointKind(endpoint, endpointKind);
  if (resolved === 'foundry-project' || resolved === 'openai-v1') {
    return 'https://ai.azure.com/.default';
  }

  if (cloud === 'usgovernment') {
    return 'https://cognitiveservices.azure.us/.default';
  }

  if (cloud === 'china') {
    return 'https://cognitiveservices.azure.cn/.default';
  }

  return 'https://cognitiveservices.azure.com/.default';
}

function endpointHost(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return 'Not set';
  }

  try {
    return new URL(trimmed).host;
  } catch {
    return trimmed;
  }
}

function connectorListSummary(connection: AgentModelConnectionStatus): string {
  const readiness = connection.configured ? 'ready' : `missing ${connection.missing.join(', ') || 'settings'}`;
  if (connection.type === 'azure-openai') {
    return `Azure OpenAI • ${connection.authMode === 'entra' ? 'Entra ID' : 'API key'} • ${azureOpenAiEndpointKindLabel(connection.endpoint ?? '', connection.endpointKind ?? 'auto')} • ${readiness}`;
  }

  return `Azure AI Search • ${connection.authMode === 'entra' ? 'Entra ID' : 'API key'} • ${readiness}`;
}

function azureOpenAiRoleHint(endpoint: string, authMode: AzureAuthMode): string | null {
  if (authMode !== 'entra' || !/\/api\/projects\//i.test(endpoint)) {
    return null;
  }

  return 'Foundry project endpoints need Foundry RBAC on the project scope. A PermissionDenied error for AIServices/agents/write means the identity reached the service but is missing Foundry User or a broader Foundry role.';
}

function TreeNode({ node, selectedPath, onSelect }: { node: WorkspaceTreeNode; selectedPath?: string; onSelect: (path: string) => void }) {
  const [open, setOpen] = useState(true);

  if (node.type === 'directory') {
    return (
      <li>
        <button className={node.path === selectedPath ? 'tree-row selected' : 'tree-row'} type="button" onClick={() => { onSelect(node.path); setOpen((value) => !value); }} title={node.path}>
          <ChevronRight className={open ? 'chevron open' : 'chevron'} size={15} />
          <Folder size={15} />
          <span>{node.name}</span>
        </button>
        {open && node.children && (
          <ul className="tree-children">
            {node.children.map((child) => <TreeNode key={child.path} node={child} selectedPath={selectedPath} onSelect={onSelect} />)}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li>
      <button className={node.path === selectedPath ? 'tree-row selected' : 'tree-row'} type="button" onClick={() => onSelect(node.path)} title={node.path}>
        <span className="chevron-spacer" />
        <FileText size={15} />
        <span>{node.name}</span>
      </button>
    </li>
  );
}

function App() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('current');
  const [chatSessions, setChatSessions] = useState<ChatSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [tree, setTree] = useState<WorkspaceTreeNode[]>([]);
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<WorkspaceFile | null>(null);
  const [editorValue, setEditorValue] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [workspaceIndex, setWorkspaceIndex] = useState<WorkspaceIndex | null>(null);
  const [workspaceTemplates, setWorkspaceTemplates] = useState<WorkspaceTemplateDefinition[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [workspaceAgents, setWorkspaceAgents] = useState<AgentDefinition[]>([]);
  const [workspaceSettingsAgents, setWorkspaceSettingsAgents] = useState<AgentDefinition[]>([]);
  const [workspaceSharedAgentTemplates, setWorkspaceSharedAgentTemplates] = useState<AgentTemplateDefinition[]>([]);
  const [workspaceSharedMcpCatalog, setWorkspaceSharedMcpCatalog] = useState<McpCatalogEntry[]>([]);
  const [agentTemplates, setAgentTemplates] = useState<AgentTemplateDefinition[]>([]);
  const [connections, setConnections] = useState<AgentModelConnectionStatus[]>([]);
  const [workspaceSettingsConnections, setWorkspaceSettingsConnections] = useState<AgentModelConnectionStatus[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [workspaceSettingsMcpServers, setWorkspaceSettingsMcpServers] = useState<McpServerStatus[]>([]);
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalogEntry[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>();
  const [selectedWorkspaceAgentId, setSelectedWorkspaceAgentId] = useState<string | undefined>();
  const [activeScreen, setActiveScreen] = useState<'workbench' | 'admin' | 'workspace-settings'>('workbench');
  const [configView, setConfigView] = useState<'workspace' | 'connectors' | 'mcp' | 'agents' | 'workspace-templates' | 'connectivity' | 'classification'>('connectors');
  const [classificationBar, setClassificationBar] = useState<ClassificationBarSettings>({ text: '', color: '#7f1d1d' });
  const [classificationTextDraft, setClassificationTextDraft] = useState('');
  const [classificationColorDraft, setClassificationColorDraft] = useState('#7f1d1d');
  const [adminConnectivity, setAdminConnectivity] = useState<AdminConnectivityReport | null>(null);
  const [adminConnectivityBusy, setAdminConnectivityBusy] = useState(false);
  const [connectivityTestTarget, setConnectivityTestTarget] = useState<'cosmos' | 'storage' | null>(null);
  const [workspaceTemplateDraft, setWorkspaceTemplateDraft] = useState('');
  const [workspaceTemplateAgentImportIds, setWorkspaceTemplateAgentImportIds] = useState<string[]>([]);
  const [workspaceTemplateMcpImportIds, setWorkspaceTemplateMcpImportIds] = useState<string[]>([]);
  const [workspaceTemplateConnectionImportIds, setWorkspaceTemplateConnectionImportIds] = useState<string[]>([]);
  const [selectedConnectorId, setSelectedConnectorId] = useState<string>('new');
  const [connectorTypeDraft, setConnectorTypeDraft] = useState<AgentConnectionType>('azure-openai');
  const [connectorNameDraft, setConnectorNameDraft] = useState('Azure OpenAI');
  const [connectorAuthDraft, setConnectorAuthDraft] = useState<AzureAuthMode>('entra');
  const [connectorCloudDraft, setConnectorCloudDraft] = useState<AzureCloud>('public');
  const [connectorEndpointKindDraft, setConnectorEndpointKindDraft] = useState<AzureOpenAiEndpointKind>('auto');
  const [connectorEndpointDraft, setConnectorEndpointDraft] = useState('');
  const [connectorCredentialScopeDraft, setConnectorCredentialScopeDraft] = useState('');
  const [connectorApiKeyDraft, setConnectorApiKeyDraft] = useState('');
  const [connectorDeploymentDraft, setConnectorDeploymentDraft] = useState('');
  const [connectorApiVersionDraft, setConnectorApiVersionDraft] = useState('2025-01-01-preview');
  const [connectorIndexesDraft, setConnectorIndexesDraft] = useState('');
  const [connectorSemanticDraft, setConnectorSemanticDraft] = useState('default');
  const [connectorTopDraft, setConnectorTopDraft] = useState(5);
  const [connectorQueryTypeDraft, setConnectorQueryTypeDraft] = useState<'simple' | 'full' | 'semantic'>('semantic');
  const [selectedMcpServerId, setSelectedMcpServerId] = useState<string>('new');
  const [selectedMcpCatalogId, setSelectedMcpCatalogId] = useState<string>('');
  const [mcpServerNameDraft, setMcpServerNameDraft] = useState('Remote MCP Server');
  const [mcpServerEndpointDraft, setMcpServerEndpointDraft] = useState('');
  const [mcpServerAuthDraft, setMcpServerAuthDraft] = useState<McpServerAuthMode>('none');
  const [mcpServerBearerTokenDraft, setMcpServerBearerTokenDraft] = useState('');
  const [mcpServerApiKeyDraft, setMcpServerApiKeyDraft] = useState('');
  const [mcpServerAudienceDraft, setMcpServerAudienceDraft] = useState('');
  const [mcpServerHeadersDraft, setMcpServerHeadersDraft] = useState('');
  const [customAgentMode, setCustomAgentMode] = useState<'edit' | 'create'>('edit');
  const [selectedAgentTemplateId, setSelectedAgentTemplateId] = useState<string>('');
  const [customAgentNameDraft, setCustomAgentNameDraft] = useState('');
  const [customAgentDescriptionDraft, setCustomAgentDescriptionDraft] = useState('');
  const [customAgentModelDraft, setCustomAgentModelDraft] = useState('');
  const [customAgentReasoningEffortDraft, setCustomAgentReasoningEffortDraft] = useState<ReasoningEffort>(defaultReasoningEffort);
  const [customAgentTemperatureDraft, setCustomAgentTemperatureDraft] = useState('');
  const [customAgentMaxTokensDraft, setCustomAgentMaxTokensDraft] = useState('');
  const [customAgentSearchConnectorDraft, setCustomAgentSearchConnectorDraft] = useState('');
  const [customAgentMcpServerIdsDraft, setCustomAgentMcpServerIdsDraft] = useState<string[]>([]);
  const [agentInstructionsDraft, setAgentInstructionsDraft] = useState('');
  const [searchEnabledDraft, setSearchEnabledDraft] = useState(false);
  const [searchIndexDraft, setSearchIndexDraft] = useState('');
  const [searchSemanticConfigDraft, setSearchSemanticConfigDraft] = useState('default');
  const [prompt, setPrompt] = useState('');
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialTheme);
  const [workspaceCreateMenuOpen, setWorkspaceCreateMenuOpen] = useState(false);
  const autoApproveChanges = true;

  const [markdownViewMode, setMarkdownViewMode] = useState<MarkdownViewMode>('edit');
  const [lastEditModeByPreviewType, setLastEditModeByPreviewType] = useState<Record<PreviewFileType, boolean>>({
    markdown: false,
    svg: false
  });
  const [markdownViewMenuOpen, setMarkdownViewMenuOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [chatPaneWidth, setChatPaneWidth] = useState(() => {
    if (typeof window === 'undefined') {
      return 360;
    }

    const estimatedRightPaneWidth = Math.max(
      minChatPaneWidth,
      window.innerWidth - 240 - splitterWidth - splitterWidth
    );

    return Math.max(minChatPaneWidth, Math.round(estimatedRightPaneWidth * defaultChatPaneRatio));
  });
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isChatPaneCollapsed, setIsChatPaneCollapsed] = useState(false);
  const [isChatDetailsExpanded, setIsChatDetailsExpanded] = useState(true);
  const [isResizingSidebarPane, setIsResizingSidebarPane] = useState(false);
  const [isResizingChatPane, setIsResizingChatPane] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [busy, setBusy] = useState(false);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [authBootstrapState, setAuthBootstrapState] = useState<AuthBootstrapState>('loading');
  const [authDiagnostics, setAuthDiagnostics] = useState<AuthDiagnostics | null>(null);
  const [isIdentityMenuOpen, setIsIdentityMenuOpen] = useState(false);
  const [currentIdentity, setCurrentIdentity] = useState<RequestIdentitySummary | null>(null);
  const [devIdentityUserIdDraft, setDevIdentityUserIdDraft] = useState(() => workbenchApi.getStoredLocalDevIdentity()?.userId ?? '');
  const [devIdentityDisplayNameDraft, setDevIdentityDisplayNameDraft] = useState(() => workbenchApi.getStoredLocalDevIdentity()?.displayName ?? '');
  const [devIdentityTenantIdDraft, setDevIdentityTenantIdDraft] = useState(() => workbenchApi.getStoredLocalDevIdentity()?.tenantId ?? '');
  const [devIdentityRolesDraft, setDevIdentityRolesDraft] = useState(() => (workbenchApi.getStoredLocalDevIdentity()?.roles ?? []).join(', '));
  const [liveAssistantTurn, setLiveAssistantTurn] = useState<LiveAssistantTurn | null>(null);
  const activeStreamAbortRef = useRef<AbortController | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const workbenchGridRef = useRef<HTMLElement | null>(null);
  const markdownViewMenuRef = useRef<HTMLDivElement | null>(null);
  const workspaceCreateMenuRef = useRef<HTMLDivElement | null>(null);
  const identityMenuRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const hasInitializedChatPaneWidth = useRef(false);
  const previousChatSessionKeyRef = useRef('');
  const previousSessionHadMessagesRef = useRef(false);
  const pendingScrollMessageIdRef = useRef<string | null>(null);
  const [chatTailSpacerHeight, setChatTailSpacerHeight] = useState(0);
  const [svgPreviewUrl, setSvgPreviewUrl] = useState<string | null>(null);
  const [svgPreviewInvalid, setSvgPreviewInvalid] = useState(false);
  const isAdminIdentity = hasAdminRole(currentIdentity);
  const canAccessWorkbench = hasWorkbenchRole(currentIdentity);
  const showDevIdentityTools = isLocalDevHost() && authConfig?.identityMode === 'trusted-header';
  const signInUrl = buildAuthActionUrl(authConfig?.signInPath, 'post_login_redirect_uri');
  const signOutUrl = buildAuthActionUrl(
    authConfig?.signOutPath,
    'post_logout_redirect_uri',
    typeof window === 'undefined' ? '/' : `${window.location.origin}/`
  );

  const beginSignIn = useCallback(() => {
    if (authConfig?.identityMode === 'entra-msal') {
      void workbenchApi.signIn().catch((error) => setStatus(error instanceof Error ? error.message : 'Failed to start Microsoft Entra sign-in.'));
      return;
    }

    if (signInUrl) {
      window.location.assign(signInUrl);
    }
  }, [authConfig?.identityMode, signInUrl]);

  const beginSignOut = useCallback(() => {
    setIsIdentityMenuOpen(false);
    if (authConfig?.identityMode === 'entra-msal') {
      void workbenchApi.signOut().catch((error) => setStatus(error instanceof Error ? error.message : 'Failed to sign out of Microsoft Entra.'));
      return;
    }

    if (signOutUrl) {
      window.location.assign(signOutUrl);
    }
  }, [authConfig?.identityMode, signOutUrl]);

  const scrollDetailIntoView = useCallback((event: SyntheticEvent<HTMLDetailsElement>) => {
    const detail = event.currentTarget;
    if (!detail.open) {
      return;
    }

    requestAnimationFrame(() => {
      detail.scrollIntoView({ block: 'end', behavior: 'smooth' });
    });
  }, []);

  useEffect(() => {
    if (!isIdentityMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!identityMenuRef.current?.contains(event.target as Node)) {
        setIsIdentityMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isIdentityMenuOpen]);

  const files = useMemo(() => flattenFiles(tree), [tree]);
  const isMarkdownFile = isMarkdownPath(currentFile?.path);
  const isSvgFile = isSvgPath(currentFile?.path);
  const supportsPreviewMode = isMarkdownFile || isSvgFile;
  const currentPreviewFileType: PreviewFileType | null = isMarkdownFile ? 'markdown' : isSvgFile ? 'svg' : null;
  const previewModeLabel = isMarkdownFile ? 'Markdown' : 'SVG';
  const isWorkspaceSettings = activeScreen === 'workspace-settings';
  const editableAgents = isWorkspaceSettings ? workspaceSettingsAgents : agents;
  const editableConnections = isWorkspaceSettings ? workspaceSettingsConnections : connections;
  const editableMcpServers = isWorkspaceSettings ? workspaceSettingsMcpServers : mcpServers;
  const allConnections = useMemo(() => {
    const next = [...workspaceSettingsConnections];
    for (const connection of connections) {
      if (!next.some((candidate) => candidate.id === connection.id)) {
        next.push(connection);
      }
    }
    return next;
  }, [connections, workspaceSettingsConnections]);
  const selectedConfigAgent = editableAgents.find((agent) => agent.id === selectedAgentId) ?? editableAgents[0];
  const selectedWorkspaceAgent = workspaceAgents.find((agent) => agent.id === selectedWorkspaceAgentId) ?? workspaceAgents[0] ?? selectedConfigAgent;
  const selectedConnection = allConnections.find((connection) => connection.id === selectedWorkspaceAgent?.modelConnectionId);
  const selectedChatSession = chatSessions.find((session) => session.id === selectedSessionId) ?? chatSessions[0];
  const selectedSearchSource = selectedConfigAgent?.groundingSources.find((source): source is AzureAiSearchGroundingSource => source.type === 'azure-ai-search');
  const modelConnections = useMemo(() => editableConnections.filter((connection) => connection.type === 'azure-openai'), [editableConnections]);
  const searchConnections = useMemo(() => editableConnections.filter((connection) => connection.type === 'azure-ai-search'), [editableConnections]);
  const selectedConnector = editableConnections.find((connection) => connection.id === selectedConnectorId);
  const connectorResolvedScope = connectorTypeDraft === 'azure-openai' && connectorAuthDraft === 'entra'
    ? connectorCredentialScopeDraft.trim() || suggestedCredentialScope(connectorEndpointDraft, connectorCloudDraft, connectorEndpointKindDraft)
    : 'Not used';
  const connectorRoleHint = connectorTypeDraft === 'azure-openai'
    ? azureOpenAiRoleHint(connectorEndpointDraft.trim(), connectorAuthDraft)
    : null;
  const selectedMcpServer = editableMcpServers.find((server) => server.id === selectedMcpServerId);
  const selectedWorkspaceNode = useMemo(() => files.find((node) => node.path === selectedWorkspacePath) ?? findTreeNode(tree, selectedWorkspacePath), [files, selectedWorkspacePath, tree]);
  const activeWorkspace = useMemo(() => {
    if (selectedWorkspaceId === 'current') {
      return workspaces[0];
    }

    return workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0];
  }, [selectedWorkspaceId, workspaces]);
  const activeWorkspaceId = selectedWorkspaceId === 'current' ? activeWorkspace?.id ?? 'current' : selectedWorkspaceId;
  const selectedWorkspaceTemplate = useMemo(
    () => workspaceTemplates.find((template) => template.id === workspaceTemplateDraft) ?? workspaceTemplates.find((template) => template.id === activeWorkspace?.templateId),
    [activeWorkspace?.templateId, workspaceTemplateDraft, workspaceTemplates]
  );
  const draftWorkspaceAgentTemplates = useMemo(
    () => (selectedWorkspaceTemplate?.agentTemplateIds ?? []).map((id) => agentTemplates.find((template) => template.id === id)).filter(Boolean),
    [agentTemplates, selectedWorkspaceTemplate]
  );
  const draftWorkspaceMcpCatalog = useMemo(
    () => (selectedWorkspaceTemplate?.mcpCatalogIds ?? []).map((id) => mcpCatalog.find((entry) => entry.id === id)).filter(Boolean),
    [mcpCatalog, selectedWorkspaceTemplate]
  );
  const draftWorkspaceConnections = useMemo(
    () => (selectedWorkspaceTemplate?.connectorIds ?? []).map((id) => connections.find((connection) => connection.id === id)).filter(Boolean),
    [connections, selectedWorkspaceTemplate]
  );

  const refreshChatSessions = useCallback(async (preferredSessionId?: string) => {
    const nextSessions = await workbenchApi.getChatSessions(activeWorkspaceId);
    setChatSessions(nextSessions);
    setSelectedSessionId((current) => {
      if (preferredSessionId && nextSessions.some((session) => session.id === preferredSessionId)) {
        return preferredSessionId;
      }

      if (current && nextSessions.some((session) => session.id === current)) {
        return current;
      }

      return nextSessions[0]?.id ?? '';
    });
  }, [activeWorkspaceId]);

  const refreshWorkspace = useCallback(async (selectPath?: string) => {
    const [nextTree, nextIndex] = await Promise.all([
      workbenchApi.getTree(activeWorkspaceId),
      workbenchApi.refreshIndex(activeWorkspaceId)
    ]);
    setTree(nextTree);
    setWorkspaceIndex(nextIndex);
    const fallbackFilePath = flattenFiles(nextTree)[0]?.path;
    const targetPath = selectPath ?? fallbackFilePath;
    const targetNode = findTreeNode(nextTree, targetPath);
    setSelectedWorkspacePath(targetNode?.path ?? null);

    if (targetNode?.type === 'file') {
      const file = await workbenchApi.getFile(targetNode.path, activeWorkspaceId);
      setCurrentFile(file);
      setEditorValue(file.content);
    } else if (!targetNode && fallbackFilePath) {
      const file = await workbenchApi.getFile(fallbackFilePath, activeWorkspaceId);
      setCurrentFile(file);
      setEditorValue(file.content);
    } else {
      setCurrentFile(null);
      setEditorValue('');
    }
  }, [activeWorkspaceId]);

  const refreshWorkspaceSettingsConfig = useCallback(async () => {
    const [nextAgents, nextConnections, nextMcpServers] = await Promise.all([
      workbenchApi.getWorkspaceSettingsAgents(activeWorkspaceId),
      workbenchApi.getWorkspaceAgentConnections(activeWorkspaceId),
      workbenchApi.getWorkspaceMcpServers(activeWorkspaceId)
    ]);
    setWorkspaceSettingsAgents(nextAgents);
    setWorkspaceSettingsConnections(nextConnections);
    setWorkspaceSettingsMcpServers(nextMcpServers);
    setSelectedAgentId((current) => nextAgents.some((agent) => agent.id === current) ? current : nextAgents[0]?.id);
    setSelectedConnectorId((current) => nextConnections.some((connection) => connection.id === current) ? current : 'new');
    setSelectedMcpServerId((current) => nextMcpServers.some((server) => server.id === current) ? current : 'new');
  }, [activeWorkspaceId]);

  const refreshAdminConnectivity = useCallback(async () => {
    setAdminConnectivityBusy(true);
    try {
      setAdminConnectivity(await workbenchApi.getAdminConnectivity());
    } finally {
      setAdminConnectivityBusy(false);
    }
  }, []);

  const applyDevIdentityDraft = useCallback((draft: { userId: string; displayName: string; tenantId: string; roles: string }) => {
    const userId = draft.userId.trim();
    const displayName = draft.displayName.trim() || userId;
    const tenantId = draft.tenantId.trim();
    const roles = draft.roles.split(',').map((role) => role.trim()).filter(Boolean);

    if (!userId) {
      setStatus('User ID is required to simulate a trusted-header identity.');
      return;
    }

    workbenchApi.saveStoredLocalDevIdentity({
      userId,
      displayName,
      tenantId: tenantId || undefined,
      roles: roles.length > 0 ? roles : ['Junior.User']
    });

    window.location.reload();
  }, []);

  const clearDevIdentityDraft = useCallback(() => {
    workbenchApi.clearStoredLocalDevIdentity();
    window.location.reload();
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let nextAuthConfig: AuthConfig | null = null;
      let identityAuthorized = false;

      try {
        nextAuthConfig = await workbenchApi.getAuthConfig();
        if (cancelled) {
          return;
        }

        setAuthConfig(nextAuthConfig);

        await workbenchApi.configureAuth(nextAuthConfig);

        if (cancelled) {
          return;
        }

        if (nextAuthConfig.identityMode === 'trusted-header' && isLocalDevHost() && !workbenchApi.getStoredLocalDevIdentity()) {
          setCurrentIdentity(null);
          setAuthBootstrapState('signin-required');
          setStatus('Trusted-header auth is enabled. Configure upstream Entra auth or apply a local dev identity to continue.');
          return;
        }

        let identity = await workbenchApi.getCurrentIdentity();
        if (cancelled) {
          return;
        }

        if (nextAuthConfig.identityMode === 'entra-msal' && !hasWorkbenchRole(identity)) {
          identity = await workbenchApi.getCurrentIdentity(true);
          if (cancelled) {
            return;
          }
        }

        setCurrentIdentity(identity);

        if (!hasWorkbenchRole(identity)) {
          setAuthBootstrapState('access-denied');
          setStatus('This account is signed in but does not have Junior access.');
          return;
        }

        identityAuthorized = true;
        setAuthBootstrapState('authorized');

        const nextWorkspaces = await workbenchApi.getWorkspaces();
        if (cancelled) {
          return;
        }

        if (nextWorkspaces.length === 0) {
          const createdWorkspace = await workbenchApi.createWorkspace({
            name: `${identity.displayName.trim() || 'My'} Workspace`,
            description: 'Personal workspace'
          });

          if (cancelled) {
            return;
          }

          setWorkspaces([createdWorkspace]);
          setSelectedWorkspaceId(createdWorkspace.id);
          setStatus(`Created workspace ${createdWorkspace.name}`);
          return;
        }

        setWorkspaces(nextWorkspaces);

        const workbenchLoads: Array<Promise<unknown>> = [
          refreshChatSessions(),
          refreshWorkspace(),
          workbenchApi.getWorkspaceAgents(activeWorkspaceId).then((nextAgents) => {
            setWorkspaceAgents(nextAgents);
            setSelectedWorkspaceAgentId((current) => nextAgents.some((agent) => agent.id === current) ? current : nextAgents[0]?.id);
          }),
          workbenchApi.getWorkspaceSharedAgentTemplates(activeWorkspaceId).then(setWorkspaceSharedAgentTemplates),
          workbenchApi.getWorkspaceSharedMcpCatalog(activeWorkspaceId).then(setWorkspaceSharedMcpCatalog),
          refreshWorkspaceSettingsConfig()
        ];

        if (hasAdminRole(identity)) {
          workbenchLoads.push(
            workbenchApi.getWorkspaceTemplates().then(setWorkspaceTemplates),
            workbenchApi.getClassificationBar().then(setClassificationBar),
            workbenchApi.getAgents().then((nextAgents) => {
              setAgents(nextAgents);
              setSelectedAgentId((current) => current ?? nextAgents[0]?.id);
            }),
            workbenchApi.getAgentTemplates().then(setAgentTemplates),
            workbenchApi.getAgentConnections().then(setConnections),
            workbenchApi.getMcpServers().then(setMcpServers),
            workbenchApi.getMcpCatalog().then(setMcpCatalog)
          );
        } else {
          setWorkspaceTemplates([]);
          setClassificationBar({ text: '', color: '#7f1d1d' });
          setAgents([]);
          setAgentTemplates([]);
          setConnections([]);
          setMcpServers([]);
          setMcpCatalog([]);
          setSelectedAgentId(undefined);
        }

        await Promise.all(workbenchLoads);
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (error instanceof RequestError && error.status === 401 && nextAuthConfig?.authRequired) {
          setCurrentIdentity(null);
          setAuthBootstrapState('signin-required');
          setStatus(`${nextAuthConfig.providerName ?? 'Sign-in'} is required before Junior Workbench can load.`);
          return;
        }

        if (error instanceof AuthRequiredError) {
          setCurrentIdentity(null);
          setAuthBootstrapState('signin-required');
          setStatus('Microsoft Entra sign-in is required before Junior Workbench can load.');
          return;
        }

        if (error instanceof RequestError && error.status === 403) {
          setAuthBootstrapState('access-denied');
          setStatus(error.message);
          return;
        }

        if (identityAuthorized) {
          setAuthBootstrapState('authorized');
        } else {
          setAuthBootstrapState('access-denied');
        }
        setStatus(error instanceof Error ? error.message : 'Failed to load the workbench');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeWorkspace?.templateId, activeWorkspaceId, refreshChatSessions, refreshWorkspace, refreshWorkspaceSettingsConfig]);

  useEffect(() => {
    if (authBootstrapState !== 'access-denied') {
      setAuthDiagnostics(null);
      return;
    }

    void workbenchApi.getAuthDiagnostics()
      .then(setAuthDiagnostics)
      .catch(() => setAuthDiagnostics(null));
  }, [authBootstrapState]);

  useEffect(() => {
    if (authBootstrapState !== 'authorized') {
      return;
    }

    if (activeScreen === 'admin' && !isAdminIdentity) {
      setActiveScreen('workbench');
    }
  }, [activeScreen, authBootstrapState, isAdminIdentity]);

  useEffect(() => {
    if (authBootstrapState !== 'authorized') {
      return;
    }

    if (activeScreen !== 'admin' || configView !== 'connectivity') {
      return;
    }

    void refreshAdminConnectivity().catch((error) => setStatus(error.message));
  }, [activeScreen, authBootstrapState, configView, refreshAdminConnectivity]);

  useEffect(() => {
    setClassificationTextDraft(classificationBar.text);
    setClassificationColorDraft(classificationBar.color);
  }, [classificationBar]);

  useEffect(() => {
    if (authBootstrapState !== 'authorized') {
      setMessages([]);
      return;
    }

    void workbenchApi.getMessages(activeWorkspaceId, selectedSessionId || undefined)
      .then(setMessages)
      .catch((error) => setStatus(error.message));
  }, [activeWorkspaceId, authBootstrapState, selectedSessionId]);

  useEffect(() => {
    setWorkspaceTemplateDraft(activeWorkspace?.templateId ?? '');
  }, [activeWorkspace?.templateId]);

  useEffect(() => {
    setWorkspaceTemplateAgentImportIds(selectedWorkspaceTemplate?.agentTemplateIds ?? []);
    setWorkspaceTemplateMcpImportIds(selectedWorkspaceTemplate?.mcpCatalogIds ?? []);
    setWorkspaceTemplateConnectionImportIds(selectedWorkspaceTemplate?.connectorIds ?? []);
  }, [selectedWorkspaceTemplate]);

  useEffect(() => {
    if (!selectedConfigAgent) {
      return;
    }

    setAgentInstructionsDraft(selectedConfigAgent.instructions);
    setCustomAgentNameDraft(selectedConfigAgent.name);
    setCustomAgentDescriptionDraft(selectedConfigAgent.description);
    setCustomAgentModelDraft(selectedConfigAgent.modelConnectionId);
    setCustomAgentReasoningEffortDraft(selectedConfigAgent.aiSettings?.reasoningEffort ?? selectedConfigAgent.reasoningEffort ?? defaultReasoningEffort);
    setCustomAgentTemperatureDraft(numberDraft(selectedConfigAgent.aiSettings?.temperature));
    setCustomAgentMaxTokensDraft(numberDraft(selectedConfigAgent.aiSettings?.maxTokens));
    setCustomAgentSearchConnectorDraft(selectedSearchSource?.connectorId ?? searchConnections[0]?.id ?? '');
    setCustomAgentMcpServerIdsDraft(selectedConfigAgent.mcpServerIds ?? []);
    setSearchEnabledDraft(selectedSearchSource?.enabled ?? false);
    setSearchIndexDraft(selectedSearchSource?.indexName ?? '');
    setSearchSemanticConfigDraft(selectedSearchSource?.semanticConfiguration ?? 'default');
  }, [selectedConfigAgent, selectedSearchSource, searchConnections]);

  useEffect(() => {
    if (!selectedConnector) {
      setConnectorTypeDraft('azure-openai');
      setConnectorNameDraft('Azure OpenAI');
      setConnectorAuthDraft('entra');
      setConnectorCloudDraft('public');
      setConnectorEndpointKindDraft('auto');
      setConnectorEndpointDraft('');
      setConnectorCredentialScopeDraft('');
      setConnectorApiKeyDraft('');
      setConnectorDeploymentDraft('');
      setConnectorApiVersionDraft('2025-01-01-preview');
      setConnectorIndexesDraft('');
      setConnectorSemanticDraft('default');
      setConnectorTopDraft(5);
      setConnectorQueryTypeDraft('semantic');
      return;
    }

    setConnectorTypeDraft(selectedConnector.type);
    setConnectorNameDraft(selectedConnector.name);
    setConnectorAuthDraft(selectedConnector.authMode);
    setConnectorCloudDraft(selectedConnector.cloud);
    setConnectorEndpointKindDraft(selectedConnector.endpointKind ?? 'auto');
    setConnectorEndpointDraft(selectedConnector.endpoint ?? '');
    setConnectorCredentialScopeDraft(selectedConnector.credentialScope ?? '');
    setConnectorApiKeyDraft('');
    setConnectorDeploymentDraft(selectedConnector.deployment ?? '');
    setConnectorApiVersionDraft(selectedConnector.apiVersion ?? selectedConnector.defaultApiVersion ?? '2025-01-01-preview');
    setConnectorIndexesDraft(linesFromList(selectedConnector.indexNames));
    setConnectorSemanticDraft(linesFromList(selectedConnector.semanticConfigurations) || 'default');
    setConnectorTopDraft(selectedConnector.top ?? 5);
    setConnectorQueryTypeDraft(selectedConnector.queryType ?? 'semantic');
  }, [selectedConnector]);

  useEffect(() => {
    if (!selectedMcpServer) {
      setMcpServerNameDraft('Remote MCP Server');
      setMcpServerEndpointDraft('');
      setMcpServerAuthDraft('none');
      setMcpServerBearerTokenDraft('');
      setMcpServerApiKeyDraft('');
      setMcpServerAudienceDraft('');
      setMcpServerHeadersDraft('');
      return;
    }

    setMcpServerNameDraft(selectedMcpServer.name);
    setMcpServerEndpointDraft(selectedMcpServer.endpoint ?? '');
    setMcpServerAuthDraft(selectedMcpServer.authMode);
    setMcpServerBearerTokenDraft('');
    setMcpServerApiKeyDraft('');
    setMcpServerAudienceDraft(selectedMcpServer.audience ?? '');
    setMcpServerHeadersDraft(linesFromHeaders(selectedMcpServer.customHeaders));
  }, [selectedMcpServer]);

  useEffect(() => {
    window.localStorage.setItem(themeStorageKey, themeMode);
    document.documentElement.style.colorScheme = themeMode;
  }, [themeMode]);

  useEffect(() => {
    setMarkdownViewMenuOpen(false);

    if (!currentPreviewFileType) {
      setMarkdownViewMode('edit');
      return;
    }

    setMarkdownViewMode(lastEditModeByPreviewType[currentPreviewFileType] ? 'edit' : 'preview');
  }, [currentFile?.path, currentPreviewFileType, lastEditModeByPreviewType]);

  useEffect(() => {
    if (!currentPreviewFileType) {
      return;
    }

    setLastEditModeByPreviewType((current) => {
      const nextIsEdit = markdownViewMode === 'edit';
      if (current[currentPreviewFileType] === nextIsEdit) {
        return current;
      }

      return {
        ...current,
        [currentPreviewFileType]: nextIsEdit
      };
    });
  }, [markdownViewMode, currentPreviewFileType]);

  useEffect(() => {
    if (!isSvgFile || !editorValue.trim()) {
      setSvgPreviewUrl(null);
      setSvgPreviewInvalid(false);
      return;
    }

    const blob = new Blob([editorValue], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    setSvgPreviewUrl(url);
    setSvgPreviewInvalid(false);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [editorValue, isSvgFile]);

  useEffect(() => {
    if (!markdownViewMenuOpen) {
      return undefined;
    }

    function handlePointerDown(event: PointerEvent) {
      if (markdownViewMenuOpen && markdownViewMenuRef.current && !markdownViewMenuRef.current.contains(event.target as Node)) {
        setMarkdownViewMenuOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [markdownViewMenuOpen]);

  useEffect(() => {
    if (!workspaceCreateMenuOpen) {
      return undefined;
    }

    function handlePointerDown(event: PointerEvent) {
      if (workspaceCreateMenuRef.current && !workspaceCreateMenuRef.current.contains(event.target as Node)) {
        setWorkspaceCreateMenuOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [workspaceCreateMenuOpen]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container) {
      return;
    }

    const measure = () => {
      const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
      const anchorId = lastUserMessage?.id ?? messages[messages.length - 1]?.id ?? null;
      if (!anchorId) {
        setChatTailSpacerHeight(0);
        return;
      }

      const anchor = container.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`);
      if (!anchor) {
        setChatTailSpacerHeight(0);
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const anchorTopInContent = anchorRect.top - containerRect.top + container.scrollTop;

      const tailSpacer = container.querySelector<HTMLElement>('.messages-tail-spacer');
      const tailSpacerHeight = tailSpacer?.offsetHeight ?? 0;
      const turnHeight = container.scrollHeight - tailSpacerHeight - anchorTopInContent;
      const desired = Math.max(0, container.clientHeight - turnHeight);
      setChatTailSpacerHeight((current) => (Math.abs(current - desired) > 1 ? desired : current));
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(container);
    Array.from(container.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [messages, liveAssistantTurn]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container) {
      return;
    }

    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
    const anchorId = lastUserMessage?.id ?? null;

    requestAnimationFrame(() => {
      if (anchorId) {
        const anchor = container.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`);
        if (anchor) {
          const containerRect = container.getBoundingClientRect();
          const anchorRect = anchor.getBoundingClientRect();
          const anchorTopInContent = anchorRect.top - containerRect.top + container.scrollTop;
          const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
          container.scrollTop = Math.min(anchorTopInContent, maxScroll);
          return;
        }
      }
      container.scrollTop = container.scrollHeight;
    });

    if (!busy && !liveAssistantTurn) {
      pendingScrollMessageIdRef.current = null;
    }
  }, [messages, liveAssistantTurn, busy, chatTailSpacerHeight]);

  useEffect(() => {
    const chatSessionKey = `${activeWorkspaceId}:${selectedSessionId || 'latest'}`;
    const hasMessages = messages.length > 0;
    const sessionChanged = previousChatSessionKeyRef.current !== chatSessionKey;

    if (sessionChanged) {
      setIsChatDetailsExpanded(!hasMessages);
      previousChatSessionKeyRef.current = chatSessionKey;
      previousSessionHadMessagesRef.current = hasMessages;
      return;
    }

    if (!previousSessionHadMessagesRef.current && hasMessages) {
      setIsChatDetailsExpanded(false);
    }

    if (previousSessionHadMessagesRef.current && !hasMessages) {
      setIsChatDetailsExpanded(true);
    }

    previousSessionHadMessagesRef.current = hasMessages;
  }, [activeWorkspaceId, messages.length, selectedSessionId]);

  useEffect(() => {
    if (hasInitializedChatPaneWidth.current) {
      return;
    }

    const gridRect = workbenchGridRef.current?.getBoundingClientRect();

    if (!gridRect) {
      return;
    }

    setChatPaneWidth(clampChatPaneWidth(defaultChatPaneWidth(gridRect.width)));
    hasInitializedChatPaneWidth.current = true;
  // Intentional one-time sizing initialization guarded by hasInitializedChatPaneWidth.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSidebarCollapsed, sidebarWidth]);

  useEffect(() => {
    if (!isResizingSidebarPane) {
      return undefined;
    }

    function handlePointerMove(event: PointerEvent) {
      const gridRect = workbenchGridRef.current?.getBoundingClientRect();

      if (!gridRect) {
        return;
      }

      setSidebarWidth(clampSidebarWidth(event.clientX - gridRect.left));
    }

    function handlePointerUp() {
      setIsResizingSidebarPane(false);
    }

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  // Pointer-resize handlers intentionally depend on resize mode toggles, not helper function identities.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isResizingSidebarPane, isChatPaneCollapsed, chatPaneWidth]);

  useEffect(() => {
    if (!isResizingChatPane) {
      return undefined;
    }

    function handlePointerMove(event: PointerEvent) {
      const gridRect = workbenchGridRef.current?.getBoundingClientRect();

      if (!gridRect) {
        return;
      }

      setChatPaneWidth(clampChatPaneWidth(gridRect.right - event.clientX));
    }

    function handlePointerUp() {
      setIsResizingChatPane(false);
    }

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  // Pointer-resize handlers intentionally depend on resize mode toggles, not helper function identities.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isResizingChatPane, isSidebarCollapsed, sidebarWidth]);

  function clampSidebarWidth(nextWidth: number): number {
    const gridRect = workbenchGridRef.current?.getBoundingClientRect();

    if (!gridRect) {
      return nextWidth;
    }

    const leftSplitterWidth = splitterWidth;
    const rightSplitterWidth = isChatPaneCollapsed ? 0 : splitterWidth;
    const rightPaneWidth = isChatPaneCollapsed ? panelRailWidth : chatPaneWidth;
    const maxWidth = Math.max(minSidebarPaneWidth, Math.min(420, gridRect.width - rightPaneWidth - rightSplitterWidth - leftSplitterWidth - minEditorPaneWidth));
    return Math.min(Math.max(nextWidth, minSidebarPaneWidth), maxWidth);
  }

  function clampChatPaneWidth(nextWidth: number): number {
    const gridRect = workbenchGridRef.current?.getBoundingClientRect();

    if (!gridRect) {
      return nextWidth;
    }

    const maxWidth = maxChatPaneWidth(gridRect.width);
    return Math.min(Math.max(nextWidth, minChatPaneWidth), maxWidth);
  }

  function availableRightPaneWidth(gridWidth: number): number {
    const leftSplitterWidth = isSidebarCollapsed ? 0 : splitterWidth;
    const rightSplitterWidth = splitterWidth;
    const leftPaneWidth = isSidebarCollapsed ? panelRailWidth : sidebarWidth;
    return gridWidth - leftPaneWidth - leftSplitterWidth - rightSplitterWidth;
  }

  function defaultChatPaneWidth(gridWidth: number): number {
    return Math.max(minChatPaneWidth, Math.round(availableRightPaneWidth(gridWidth) * defaultChatPaneRatio));
  }

  function maxChatPaneWidth(gridWidth: number): number {
    const availableWidth = availableRightPaneWidth(gridWidth);
    return Math.max(minChatPaneWidth, Math.floor(Math.min(availableWidth * maxChatPaneRatio, availableWidth - minEditorPaneWidth)));
  }

  function beginResizeSidebarPane() {
    setIsSidebarCollapsed(false);
    setIsResizingSidebarPane(true);
  }

  function toggleSidebarCollapsed() {
    setIsResizingSidebarPane(false);
    setIsSidebarCollapsed((current) => !current);
  }

  function toggleChatPaneCollapsed() {
    setIsResizingChatPane(false);
    setIsChatPaneCollapsed((current) => !current);
  }

  function expandSidebar() {
    setIsSidebarCollapsed(false);
  }

  function expandChatPane() {
    setIsChatPaneCollapsed(false);
  }

  function beginResizeChatPane() {
    setIsChatPaneCollapsed(false);
    setIsResizingChatPane(true);
  }

  function resizeSidebarBy(delta: number) {
    setSidebarWidth((current) => clampSidebarWidth(current + delta));
  }

  function resizeChatPaneBy(delta: number) {
    setChatPaneWidth((current) => clampChatPaneWidth(current + delta));
  }

  const workbenchColumns = isSidebarCollapsed
    ? isChatPaneCollapsed
      ? 'var(--panel-rail-width) minmax(360px, 1fr) var(--panel-rail-width)'
      : 'var(--panel-rail-width) minmax(360px, 1fr) 10px minmax(280px, var(--chat-pane-width, 35%))'
    : isChatPaneCollapsed
      ? 'minmax(190px, var(--sidebar-width, 240px)) 10px minmax(360px, 1fr) var(--panel-rail-width)'
      : 'minmax(190px, var(--sidebar-width, 240px)) 10px minmax(360px, 1fr) 10px minmax(280px, var(--chat-pane-width, 35%))';

  function toggleTheme() {
    setThemeMode((current) => current === 'dark' ? 'light' : 'dark');
  }

  function toggleMarkdownView() {
    setMarkdownViewMode((current) => current === 'preview' ? 'edit' : 'preview');
  }

  async function openFile(path: string) {
    setSelectedWorkspacePath(path);
    const node = findTreeNode(tree, path);
    if (node?.type === 'directory') {
      setCurrentFile(null);
      setEditorValue('');
      setStatus(`Selected folder ${path}`);
      return;
    }

    const file = await workbenchApi.getFile(path, activeWorkspaceId);
    setCurrentFile(file);
    setEditorValue(file.content);
    setStatus(`Opened ${path}`);
  }

  async function saveCurrentFile() {
    if (!currentFile) {
      return;
    }

    setBusy(true);
    try {
      const saved = await workbenchApi.saveFile(currentFile.path, editorValue, activeWorkspaceId);
      setCurrentFile(saved);
      setStatus(`Saved ${saved.path}`);
      await refreshWorkspace(saved.path);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function sendPrompt() {
    if (busy) {
      return;
    }

    if (!prompt.trim()) {
      return;
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: prompt.trim(),
      createdAt: new Date().toISOString()
    };

    pendingScrollMessageIdRef.current = userMessage.id;
    setMessages((current) => [...current, userMessage]);
    setPrompt('');
    setBusy(true);
    const liveAssistantId = crypto.randomUUID();
    let streamedReasoning = '';
    let streamedContent = '';
    const abortController = new AbortController();
    activeStreamAbortRef.current = abortController;
    setLiveAssistantTurn({ id: liveAssistantId, content: '', reasoning: '' });
    setStatus('Junior is working over the package files...');

    try {
      let finalResponse: AgentResponse | null = null;
      await workbenchApi.sendAgentMessageStream(
        userMessage.content,
        selectedWorkspaceAgent?.id,
        { autoApproveChanges },
        activeWorkspaceId,
        selectedSessionId || undefined,
        (event) => {
          if (event.type === 'assistant_text') {
            streamedContent = `${streamedContent}${event.text}`;
            setLiveAssistantTurn((current) => current && current.id === liveAssistantId
              ? { ...current, content: `${current.content}${event.text}` }
              : current);
            return;
          }

          if (event.type === 'reasoning') {
            const delta = normalizeReasoningStreamText(event.text);
            streamedReasoning = `${streamedReasoning}${delta}`;
            setLiveAssistantTurn((current) => current && current.id === liveAssistantId
              ? { ...current, reasoning: `${current.reasoning}${delta}` }
              : current);
            return;
          }

          if (event.type === 'completed') {
            finalResponse = event.response;
            return;
          }

          throw new Error(event.message);
        },
        abortController.signal
      );

      if (!finalResponse) {
        throw new Error('Agent stream ended before a final response was returned.');
      }

      const response = finalResponse as AgentResponse;
      setLiveAssistantTurn(null);
  setMessages((current) => [...current, mergeStreamedReasoning(response.message, streamedReasoning)]);
      await refreshChatSessions(response.sessionId);

      if (response.appliedChangeCount > 0) {
        await refreshWorkspace(currentFile?.path);
        setStatus(`Junior applied ${response.appliedChangeCount} file change${response.appliedChangeCount === 1 ? '' : 's'} directly`);
      } else {
        setStatus('Junior finished without new file edits');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setLiveAssistantTurn(null);
        const partialMessage = mergeStreamedReasoning({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: streamedContent.trim() || 'Stopped.',
          createdAt: new Date().toISOString()
        }, streamedReasoning);
        setMessages((current) => [...current, partialMessage]);
        setStatus('Stopped');
        return;
      }

      setLiveAssistantTurn(null);
      const message = error instanceof Error ? error.message : 'Agent request failed';
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `The connection to the LLM is not available right now. ${message}`,
        createdAt: new Date().toISOString()
      }]);
      setStatus(message);
    } finally {
      activeStreamAbortRef.current = null;
      setBusy(false);
    }
  }

  function stopPrompt() {
    activeStreamAbortRef.current?.abort();
  }

  async function createNewSession() {
    setBusy(true);
    try {
      const session = await workbenchApi.createChatSession(selectedWorkspaceAgent?.id, activeWorkspaceId);
      await refreshChatSessions(session.id);
      setMessages([]);
      setStatus(`Started session ${session.title}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to create session');
    } finally {
      setBusy(false);
    }
  }

  async function createWorkspace() {
    const name = window.prompt('Workspace name', 'New Workspace');
    if (!name?.trim()) {
      return;
    }

    const description = window.prompt('Workspace description', '');
    const templateOptions = workspaceTemplates.map((template) => `${template.id}: ${template.name}`).join('\n');
    const templateId = workspaceTemplates.length > 0
      ? window.prompt(`Workspace template id (leave blank for none)\n${templateOptions}`, '')?.trim() || undefined
      : undefined;
    const template = templateId ? workspaceTemplates.find((candidate) => candidate.id === templateId) : undefined;

    setBusy(true);
    try {
      const createdWorkspace = await workbenchApi.createWorkspace({
        name: name.trim(),
        description: description?.trim() || undefined,
        templateId: template?.id,
        templateName: template?.name
      });
      const nextWorkspaces = await workbenchApi.getWorkspaces();
      setWorkspaces(nextWorkspaces);
      setSelectedWorkspaceId(createdWorkspace.id);
      setSelectedSessionId('');
      setMessages([]);
      setCurrentFile(null);
      setEditorValue('');
      setStatus(`Created workspace ${createdWorkspace.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to create workspace');
    } finally {
      setBusy(false);
    }
  }

  async function saveConnector() {
    const request: AgentConnectionSaveRequest = {
      id: selectedConnectorId === 'new' ? undefined : selectedConnectorId,
      name: connectorNameDraft,
      type: connectorTypeDraft,
      authMode: connectorAuthDraft,
      cloud: connectorCloudDraft,
      endpointKind: connectorTypeDraft === 'azure-openai' ? connectorEndpointKindDraft : undefined,
      endpoint: connectorEndpointDraft.trim() || undefined,
      credentialScope: connectorCredentialScopeDraft.trim() || undefined,
      apiKey: connectorApiKeyDraft.trim() || undefined,
      deployment: connectorTypeDraft === 'azure-openai' ? connectorDeploymentDraft.trim() || undefined : undefined,
      apiVersion: connectorTypeDraft === 'azure-openai' ? connectorApiVersionDraft.trim() || undefined : undefined,
      defaultApiVersion: connectorTypeDraft === 'azure-openai' ? connectorApiVersionDraft.trim() || undefined : undefined,
      indexNames: connectorTypeDraft === 'azure-ai-search' ? listFromLines(connectorIndexesDraft) : undefined,
      semanticConfigurations: connectorTypeDraft === 'azure-ai-search' ? listFromLines(connectorSemanticDraft) : undefined,
      top: connectorTypeDraft === 'azure-ai-search' ? connectorTopDraft : undefined,
      queryType: connectorTypeDraft === 'azure-ai-search' ? connectorQueryTypeDraft : undefined
    };

    setBusy(true);
    try {
      const saved = isWorkspaceSettings
        ? await workbenchApi.saveWorkspaceAgentConnection(request, activeWorkspaceId)
        : await workbenchApi.saveAgentConnection(request);
      const nextConnections = isWorkspaceSettings
        ? await workbenchApi.getWorkspaceAgentConnections(activeWorkspaceId)
        : await workbenchApi.getAgentConnections();
      if (isWorkspaceSettings) {
        setWorkspaceSettingsConnections(nextConnections);
      } else {
        setConnections(nextConnections);
      }
      setSelectedConnectorId(saved.id);
      setConnectorApiKeyDraft('');
      setStatus(`Saved connector ${saved.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to save connector');
    } finally {
      setBusy(false);
    }
  }

  function beginCreateMcpServer() {
    setSelectedMcpServerId('new');
    setSelectedMcpCatalogId('');
    setMcpServerNameDraft('Remote MCP Server');
    setMcpServerEndpointDraft('');
    setMcpServerAuthDraft('none');
    setMcpServerBearerTokenDraft('');
    setMcpServerApiKeyDraft('');
    setMcpServerAudienceDraft('');
    setMcpServerHeadersDraft('');
  }

  function selectMcpServerForEditing(id: string) {
    setSelectedMcpServerId(id);
  }

  async function saveMcpServer() {
    setBusy(true);
    try {
      const saved = isWorkspaceSettings
        ? await workbenchApi.saveWorkspaceMcpServer({
          id: selectedMcpServerId === 'new' ? undefined : selectedMcpServerId,
          name: mcpServerNameDraft,
          transport: 'http',
          endpoint: mcpServerEndpointDraft.trim() || undefined,
          authMode: mcpServerAuthDraft,
          bearerToken: mcpServerAuthDraft === 'bearer-token' ? mcpServerBearerTokenDraft.trim() || undefined : undefined,
          apiKey: mcpServerAuthDraft === 'api-key' ? mcpServerApiKeyDraft.trim() || undefined : undefined,
          audience: mcpServerAuthDraft === 'entra' ? mcpServerAudienceDraft.trim() || undefined : undefined,
          customHeaders: mcpServerAuthDraft === 'custom-headers' ? headersFromLines(mcpServerHeadersDraft) : undefined
        }, activeWorkspaceId)
        : await workbenchApi.saveMcpServer({
        id: selectedMcpServerId === 'new' ? undefined : selectedMcpServerId,
        name: mcpServerNameDraft,
        transport: 'http',
        endpoint: mcpServerEndpointDraft.trim() || undefined,
        authMode: mcpServerAuthDraft,
        bearerToken: mcpServerAuthDraft === 'bearer-token' ? mcpServerBearerTokenDraft.trim() || undefined : undefined,
        apiKey: mcpServerAuthDraft === 'api-key' ? mcpServerApiKeyDraft.trim() || undefined : undefined,
        audience: mcpServerAuthDraft === 'entra' ? mcpServerAudienceDraft.trim() || undefined : undefined,
        customHeaders: mcpServerAuthDraft === 'custom-headers' ? headersFromLines(mcpServerHeadersDraft) : undefined
      });
      const nextMcpServers = isWorkspaceSettings
        ? await workbenchApi.getWorkspaceMcpServers(activeWorkspaceId)
        : await workbenchApi.getMcpServers();
      if (isWorkspaceSettings) {
        setWorkspaceSettingsMcpServers(nextMcpServers);
      } else {
        setMcpServers(nextMcpServers);
      }
      setSelectedMcpServerId(saved.id);
      setMcpServerBearerTokenDraft('');
      setMcpServerApiKeyDraft('');
      setStatus(`Saved MCP server ${saved.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to save MCP server');
    } finally {
      setBusy(false);
    }
  }

  function beginCreateAgent() {
    setCustomAgentMode('create');
    setSelectedAgentTemplateId('');
    setCustomAgentNameDraft('');
    setCustomAgentDescriptionDraft('');
    setCustomAgentModelDraft(modelConnections[0]?.id ?? '');
    setCustomAgentReasoningEffortDraft(defaultReasoningEffort);
    setCustomAgentTemperatureDraft('');
    setCustomAgentMaxTokensDraft('');
    setCustomAgentSearchConnectorDraft(searchConnections[0]?.id ?? '');
    setCustomAgentMcpServerIdsDraft([]);
    setAgentInstructionsDraft(defaultCustomAgentPrompt);
    setSearchEnabledDraft(false);
    setSearchIndexDraft('');
    setSearchSemanticConfigDraft('default');
  }

  async function saveCustomAgent() {
    const groundingSources = buildUpdatedGroundingSources(customAgentMode === 'edit' && selectedConfigAgent ? selectedConfigAgent.groundingSources : []);
    let aiSettings: AgentAiSettings;

    try {
      aiSettings = resolveAgentAiSettingsDraft(
        customAgentTemperatureDraft,
        customAgentMaxTokensDraft,
        customAgentReasoningEffortDraft
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to validate custom agent AI settings');
      return;
    }

    setBusy(true);
    try {
      const saved = customAgentMode === 'create'
        ? (isWorkspaceSettings
          ? await workbenchApi.createWorkspaceAgent({
            name: customAgentNameDraft,
            description: customAgentDescriptionDraft,
            instructions: agentInstructionsDraft,
            modelConnectionId: customAgentModelDraft,
            reasoningEffort: customAgentReasoningEffortDraft,
            aiSettings,
            groundingSources,
            mcpServerIds: customAgentMcpServerIdsDraft
          }, activeWorkspaceId)
          : await workbenchApi.createAgent({
            name: customAgentNameDraft,
            description: customAgentDescriptionDraft,
            instructions: agentInstructionsDraft,
            modelConnectionId: customAgentModelDraft,
            reasoningEffort: customAgentReasoningEffortDraft,
            aiSettings,
            groundingSources,
            mcpServerIds: customAgentMcpServerIdsDraft
          }))
        : selectedConfigAgent
          ? (isWorkspaceSettings
            ? await workbenchApi.updateWorkspaceAgent(selectedConfigAgent.id, {
              name: customAgentNameDraft,
              description: customAgentDescriptionDraft,
              modelConnectionId: customAgentModelDraft,
              reasoningEffort: customAgentReasoningEffortDraft,
              aiSettings,
              instructions: agentInstructionsDraft,
              groundingSources,
              mcpServerIds: customAgentMcpServerIdsDraft
            }, activeWorkspaceId)
            : await workbenchApi.updateAgent(selectedConfigAgent.id, {
            name: customAgentNameDraft,
            description: customAgentDescriptionDraft,
            modelConnectionId: customAgentModelDraft,
            reasoningEffort: customAgentReasoningEffortDraft,
            aiSettings,
            instructions: agentInstructionsDraft,
            groundingSources,
            mcpServerIds: customAgentMcpServerIdsDraft
            }))
          : null;

      if (!saved) {
        return;
      }

      const nextAgents = isWorkspaceSettings
        ? await workbenchApi.getWorkspaceSettingsAgents(activeWorkspaceId)
        : await workbenchApi.getAgents();
      if (isWorkspaceSettings) {
        setWorkspaceSettingsAgents(nextAgents);
      } else {
        setAgents(nextAgents);
      }
      const nextWorkspaceAgents = await workbenchApi.getWorkspaceAgents(activeWorkspaceId);
      setWorkspaceAgents(nextWorkspaceAgents);
      setSelectedWorkspaceAgentId((current) => nextWorkspaceAgents.some((agent) => agent.id === current) ? current : nextWorkspaceAgents[0]?.id);
      setSelectedAgentId(saved.id);
      setCustomAgentMode('edit');
      setStatus(`Saved custom agent ${saved.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to save custom agent');
    } finally {
      setBusy(false);
    }
  }

  function applyAgentTemplate(templateId: string) {
    setSelectedAgentTemplateId(templateId);
    const template = agentTemplates.find((candidate) => candidate.id === templateId);

    if (!template) {
      return;
    }

    setCustomAgentNameDraft(template.name);
    setCustomAgentDescriptionDraft(template.description);
    setCustomAgentModelDraft(template.suggestedModelConnectionId ?? modelConnections[0]?.id ?? '');
    setCustomAgentTemperatureDraft('');
    setCustomAgentMaxTokensDraft('');
    setAgentInstructionsDraft(template.instructions);
    setCustomAgentMcpServerIdsDraft(template.mcpServerIds ?? []);
  }

  function applyMcpCatalogEntry(entryId: string) {
    setSelectedMcpCatalogId(entryId);
    const entry = mcpCatalog.find((candidate) => candidate.id === entryId);

    if (!entry) {
      return;
    }

    setMcpServerNameDraft(entry.name);
    setMcpServerEndpointDraft(entry.endpoint ?? '');
    setMcpServerAuthDraft(entry.authMode);
    setMcpServerAudienceDraft(entry.audience ?? '');
    setMcpServerHeadersDraft(linesFromHeaders(entry.customHeaders));
  }

  function buildUpdatedGroundingSources(sources: AgentGroundingSource[]): AgentGroundingSource[] {
    const nextSearchSource: AzureAiSearchGroundingSource = {
      id: selectedSearchSource?.id ?? 'user-azure-ai-search',
      type: 'azure-ai-search',
      label: selectedSearchSource?.label ?? 'Azure AI Search grounding',
      enabled: searchEnabledDraft,
      connectorId: customAgentSearchConnectorDraft || undefined,
      indexName: searchIndexDraft.trim() || undefined,
      top: selectedSearchSource?.top ?? 5,
      queryType: 'semantic',
      semanticConfiguration: searchSemanticConfigDraft.trim() || 'default',
      selectFields: selectedSearchSource?.selectFields ?? ['title', 'content', 'path', 'canonicalUrl', 'documentId', 'chunkId', 'repositoryId', 'sourceSystem', 'mediaType', 'sectionLabel', 'pageNumber', 'chunkOrdinal', 'lastIndexedAt', 'sourceVersion'],
      titleField: selectedSearchSource?.titleField ?? 'title',
      contentFields: selectedSearchSource?.contentFields ?? ['content', 'chunk', 'text'],
      pathField: selectedSearchSource?.pathField ?? 'path',
      canonicalUrlField: selectedSearchSource?.canonicalUrlField ?? 'canonicalUrl',
      sourceSystemField: selectedSearchSource?.sourceSystemField ?? 'sourceSystem',
      documentIdField: selectedSearchSource?.documentIdField ?? 'documentId',
      chunkIdField: selectedSearchSource?.chunkIdField ?? 'chunkId',
      repositoryIdField: selectedSearchSource?.repositoryIdField ?? 'repositoryId',
      mediaTypeField: selectedSearchSource?.mediaTypeField ?? 'mediaType',
      sectionField: selectedSearchSource?.sectionField ?? 'sectionLabel',
      pageNumberField: selectedSearchSource?.pageNumberField ?? 'pageNumber',
      chunkOrdinalField: selectedSearchSource?.chunkOrdinalField ?? 'chunkOrdinal',
      lastIndexedAtField: selectedSearchSource?.lastIndexedAtField ?? 'lastIndexedAt',
      sourceVersionField: selectedSearchSource?.sourceVersionField ?? 'sourceVersion'
    };
    const withoutSearch = sources.filter((source) => source.type !== 'azure-ai-search');
    return [...withoutSearch, nextSearchSource];
  }

  async function handleWorkspaceUpload(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);
    if (selectedFiles.length === 0) {
      return;
    }

    const uploadableFiles = selectedFiles.filter((file) => isUploadableDocument(file.name));
    const skippedCount = selectedFiles.length - uploadableFiles.length;

    if (uploadableFiles.length === 0) {
      setStatus('Only text documents can be uploaded right now: md, markdown, txt, json, yaml, yml, csv.');
      event.target.value = '';
      return;
    }

    setBusy(true);
    try {
      const payload = await Promise.all(uploadableFiles.map(async (file) => ({
        path: normalizeUploadPath(file.name),
        content: await file.text()
      })));
      const uploaded = await workbenchApi.uploadWorkspaceFiles(payload, activeWorkspaceId);
      await refreshWorkspace(uploaded[0]?.path);
      setStatus(`Uploaded ${uploaded.length} document${uploaded.length === 1 ? '' : 's'}${skippedCount > 0 ? `; skipped ${skippedCount} unsupported file${skippedCount === 1 ? '' : 's'}` : ''}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Document upload failed');
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  function suggestedWorkspaceCreationBasePath(): string {
    if (selectedWorkspaceNode?.type === 'directory') {
      return selectedWorkspaceNode.path;
    }

    if (selectedWorkspaceNode?.path.includes('/')) {
      return selectedWorkspaceNode.path.slice(0, selectedWorkspaceNode.path.lastIndexOf('/'));
    }

    return '';
  }

  async function createFile() {
    const basePath = suggestedWorkspaceCreationBasePath();
    const requestedPath = window.prompt('New file path', basePath ? `${basePath}/untitled.md` : 'untitled.md');
    setWorkspaceCreateMenuOpen(false);

    if (!requestedPath?.trim()) {
      return;
    }

    const normalizedPath = requestedPath.trim().replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/g, '');
    if (!normalizedPath || normalizedPath.endsWith('/')) {
      setStatus('A file path is required. Example: notes/todo.md');
      return;
    }

    setBusy(true);
    try {
      const created = await workbenchApi.saveFile(normalizedPath, '', activeWorkspaceId);
      await refreshWorkspace(created.path);
      setStatus(`Created file ${created.path}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'File creation failed');
    } finally {
      setBusy(false);
    }
  }

  async function createFolder() {
    const basePath = suggestedWorkspaceCreationBasePath();
    const requestedPath = window.prompt('New folder path', basePath ? `${basePath}/` : '');
    setWorkspaceCreateMenuOpen(false);

    if (!requestedPath?.trim()) {
      return;
    }

    setBusy(true);
    try {
      const created = await workbenchApi.createDirectory(requestedPath.trim().replace(/\/+$/g, ''), activeWorkspaceId);
      await refreshWorkspace(created.path);
      setStatus(`Created folder ${created.path}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Folder creation failed');
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedWorkspacePath() {
    if (!selectedWorkspaceNode) {
      return;
    }

    const confirmed = window.confirm(`Delete ${selectedWorkspaceNode.type} ${selectedWorkspaceNode.path}?`);
    if (!confirmed) {
      return;
    }

    setBusy(true);
    try {
      const deleted = await workbenchApi.deleteWorkspacePath(selectedWorkspaceNode.path, activeWorkspaceId);
      const nextSelection = currentFile?.path === deleted.path ? undefined : currentFile?.path;
      await refreshWorkspace(nextSelection);
      setStatus(`Deleted ${deleted.type} ${deleted.path}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  }

  function openConfigDrawer(view: 'connectors' | 'mcp' | 'agents' | 'workspace-templates' | 'connectivity' | 'classification') {
    setConfigView(view);
    setActiveScreen('admin');
  }

  async function saveClassificationBar() {
    setBusy(true);
    try {
      const next = await workbenchApi.saveClassificationBar({
        text: classificationTextDraft,
        color: classificationColorDraft
      });
      setClassificationBar(next);
      setStatus(next.text ? 'Updated classification bar.' : 'Classification bar hidden.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to save classification bar');
    } finally {
      setBusy(false);
    }
  }

  async function runConnectivityTest(target: 'cosmos' | 'storage') {
    setConnectivityTestTarget(target);
    try {
      const result = await workbenchApi.runAdminConnectivityTest(target);
      await refreshAdminConnectivity();
      setStatus(result.message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Connectivity test failed');
    } finally {
      setConnectivityTestTarget(null);
    }
  }

  function closeAdminScreen() {
    setActiveScreen('workbench');
  }

  function openWorkspaceSettings() {
    setWorkspaceTemplateDraft(activeWorkspace?.templateId ?? '');
    setConfigView('workspace');
    setActiveScreen('workspace-settings');
  }

  async function saveWorkspaceSettings() {
    if (!activeWorkspace || activeWorkspaceId === 'current') {
      return;
    }

    setBusy(true);
    try {
      const template = workspaceTemplateDraft ? workspaceTemplates.find((candidate) => candidate.id === workspaceTemplateDraft) : undefined;
      const updatedWorkspace = await workbenchApi.updateWorkspace(activeWorkspace.id, {
        templateId: template?.id ?? '',
        templateName: template?.name ?? ''
      });
      const nextWorkspaces = await workbenchApi.getWorkspaces();
      setWorkspaces(nextWorkspaces);
      setSelectedWorkspaceId(updatedWorkspace.id);
      setStatus(`Updated settings for ${updatedWorkspace.name}`);
      setActiveScreen('workbench');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to update workspace settings');
    } finally {
      setBusy(false);
    }
  }

  async function importWorkspaceTemplateResources() {
    if (!activeWorkspace || activeWorkspaceId === 'current' || !selectedWorkspaceTemplate) {
      return;
    }

    setBusy(true);
    try {
      const result = await workbenchApi.importWorkspaceTemplateResources({
        templateId: selectedWorkspaceTemplate.id,
        agentTemplateIds: workspaceTemplateAgentImportIds,
        mcpCatalogIds: workspaceTemplateMcpImportIds,
        connectorIds: workspaceTemplateConnectionImportIds
      }, activeWorkspace.id);
      await refreshWorkspaceSettingsConfig();
      const nextWorkspaceAgents = await workbenchApi.getWorkspaceAgents(activeWorkspace.id);
      setWorkspaceAgents(nextWorkspaceAgents);
      setSelectedWorkspaceAgentId((current) => nextWorkspaceAgents.some((agent) => agent.id === current) ? current : nextWorkspaceAgents[0]?.id);
      setStatus(`Imported ${result.importedAgents.length} agent${result.importedAgents.length === 1 ? '' : 's'}, ${result.importedConnections.length} connector${result.importedConnections.length === 1 ? '' : 's'}, and ${result.importedMcpServers.length} MCP server${result.importedMcpServers.length === 1 ? '' : 's'} from ${selectedWorkspaceTemplate.name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to import template resources');
    } finally {
      setBusy(false);
    }
  }

  function beginCreateConnector() {
    setSelectedConnectorId('new');
  }

  function selectConnectorForEditing(id: string) {
    setSelectedConnectorId(id);
  }

  function selectAgentForEditing(id: string) {
    setCustomAgentMode('edit');
    setSelectedAgentId(id);
  }

  async function deleteSelectedConnector() {
    if (selectedConnectorId === 'new') {
      return;
    }

    const confirmed = window.confirm(`Delete connector ${selectedConnector?.name ?? selectedConnectorId}?`);
    if (!confirmed) {
      return;
    }

    setBusy(true);
    try {
      const deleted = isWorkspaceSettings
        ? await workbenchApi.deleteWorkspaceAgentConnection(selectedConnectorId, activeWorkspaceId)
        : await workbenchApi.deleteAgentConnection(selectedConnectorId);
      const nextConnections = isWorkspaceSettings
        ? await workbenchApi.getWorkspaceAgentConnections(activeWorkspaceId)
        : await workbenchApi.getAgentConnections();
      if (isWorkspaceSettings) {
        setWorkspaceSettingsConnections(nextConnections);
      } else {
        setConnections(nextConnections);
      }
      setSelectedConnectorId('new');
      setStatus(`Deleted connector ${deleted.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to delete connector');
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedAgent() {
    if (!selectedConfigAgent) {
      return;
    }

    const confirmed = window.confirm(`Delete agent ${selectedConfigAgent.name}?`);
    if (!confirmed) {
      return;
    }

    setBusy(true);
    try {
      const deleted = isWorkspaceSettings
        ? await workbenchApi.deleteWorkspaceAgent(selectedConfigAgent.id, activeWorkspaceId)
        : await workbenchApi.deleteAgent(selectedConfigAgent.id);
      const nextAgents = isWorkspaceSettings
        ? await workbenchApi.getWorkspaceSettingsAgents(activeWorkspaceId)
        : await workbenchApi.getAgents();
      if (isWorkspaceSettings) {
        setWorkspaceSettingsAgents(nextAgents);
      } else {
        setAgents(nextAgents);
      }
      const nextWorkspaceAgents = await workbenchApi.getWorkspaceAgents(activeWorkspaceId);
      setWorkspaceAgents(nextWorkspaceAgents);
      setSelectedWorkspaceAgentId((current) => nextWorkspaceAgents.some((agent) => agent.id === current) ? current : nextWorkspaceAgents[0]?.id);
      setSelectedAgentId(nextAgents[0]?.id);
      setCustomAgentMode('edit');
      setStatus(`Deleted agent ${deleted.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to delete agent');
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedMcpServer() {
    if (selectedMcpServerId === 'new') {
      return;
    }

    const confirmed = window.confirm(`Delete MCP server ${selectedMcpServer?.name ?? selectedMcpServerId}?`);
    if (!confirmed) {
      return;
    }

    setBusy(true);
    try {
      const deleted = isWorkspaceSettings
        ? await workbenchApi.deleteWorkspaceMcpServer(selectedMcpServerId, activeWorkspaceId)
        : await workbenchApi.deleteMcpServer(selectedMcpServerId);
      const nextMcpServers = isWorkspaceSettings
        ? await workbenchApi.getWorkspaceMcpServers(activeWorkspaceId)
        : await workbenchApi.getMcpServers();
      if (isWorkspaceSettings) {
        setWorkspaceSettingsMcpServers(nextMcpServers);
      } else {
        setMcpServers(nextMcpServers);
      }
      setSelectedMcpServerId('new');
      setStatus(`Deleted MCP server ${deleted.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to delete MCP server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={`workbench-shell theme-${themeMode}`}>
      {classificationBar.text.trim() ? (
        <div className="classification-bar" style={{ backgroundColor: classificationBar.color, color: classificationTextColor(classificationBar.color) }}>
          <span>{classificationBar.text}</span>
        </div>
      ) : null}
      <header className="topbar">
        <div className="title-lockup">
          <PremiumJuniorWorkbenchIcon size={34} className="brand-icon" />
          <div className="title-copy">
            <h1>Jr. Workbench</h1>
            <span>{activeWorkspace?.name ?? 'Workspace'}</span>
          </div>
        </div>
        <div className="topbar-actions">
          {authBootstrapState === 'signin-required' && signInUrl ? (
            <button type="button" className="topbar-settings-button" onClick={beginSignIn}>
              <ShieldCheck size={17} />
              Sign In
            </button>
          ) : authBootstrapState === 'signin-required' && authConfig?.identityMode === 'entra-msal' ? (
            <button type="button" className="topbar-settings-button" onClick={beginSignIn}>
              <ShieldCheck size={17} />
              Sign In
            </button>
          ) : null}
          {authBootstrapState === 'access-denied' && (signOutUrl || authConfig?.identityMode === 'entra-msal') ? (
            <button type="button" className="topbar-settings-button" onClick={beginSignOut}>
              <X size={17} />
              Sign Out
            </button>
          ) : null}
          {authBootstrapState === 'authorized' ? (
            <button type="button" className="topbar-settings-button" onClick={createWorkspace} disabled={busy} title="Create workspace">
              <Plus size={17} />
              Workspace
            </button>
          ) : null}
          <button type="button" className="topbar-theme-button" onClick={toggleTheme} title={themeMode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
            {themeMode === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            {themeMode === 'dark' ? 'Light' : 'Dark'}
          </button>
          {authBootstrapState === 'authorized' ? (
            <button type="button" className="topbar-settings-button" onClick={() => openConfigDrawer('connectivity')} title={isAdminIdentity ? 'Open admin' : 'Admin access requires Junior.Admin'} disabled={!isAdminIdentity}>
              <Settings size={17} />
              Admin
            </button>
          ) : null}
          {authBootstrapState === 'authorized' && currentIdentity && canAccessWorkbench ? (
            <div className="identity-menu" ref={identityMenuRef}>
              <button
                type="button"
                className="identity-avatar-button"
                onClick={() => setIsIdentityMenuOpen((value) => !value)}
                aria-haspopup="menu"
                aria-expanded={isIdentityMenuOpen}
                aria-label={`Open account menu for ${currentIdentity.displayName}`}
                title={currentIdentity.displayName}
              >
                <span className="identity-avatar" aria-hidden="true">{identityInitials(currentIdentity)}</span>
              </button>
              {isIdentityMenuOpen ? (
                <div className="identity-dropdown" role="menu" aria-label="Account menu">
                  <div className="identity-dropdown-section">
                    <strong>{currentIdentity.displayName}</strong>
                    <span>{currentIdentity.userId}</span>
                  </div>
                  <div className="identity-dropdown-section">
                    <span>{hasAdminRole(currentIdentity) ? 'Administrator' : 'Authorized user'}</span>
                    <span>{currentIdentity.roles.join(', ') || 'No roles assigned'}</span>
                    <span>{authConfig?.providerName ?? authModeLabel(currentIdentity)}</span>
                    {currentIdentity.tenantId ? <span>{currentIdentity.tenantId}</span> : null}
                  </div>
                  <button type="button" className="identity-dropdown-action" onClick={beginSignOut} role="menuitem">
                    Sign Out
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      {authBootstrapState === 'loading' ? (
        <section className="auth-gate-screen">
          <div className="auth-gate-card">
            <p className="eyebrow">Authentication</p>
            <h2>Checking access</h2>
            <p>Junior Workbench is verifying your identity before loading workspace data.</p>
          </div>
        </section>
      ) : authBootstrapState === 'signin-required' || authBootstrapState === 'access-denied' ? (
        <section className="auth-gate-screen">
          <div className="auth-gate-card">
            <p className="eyebrow">Authentication</p>
            <h2>{authBootstrapState === 'signin-required' ? `Sign in with ${authConfig?.providerName ?? 'Microsoft Entra ID'}` : 'Access to Junior Workbench is blocked'}</h2>
            <p>
              {authBootstrapState === 'signin-required'
                ? `${authConfig?.providerName ?? 'Microsoft Entra ID'} is enabled for this application. Until sign-in succeeds, workspace data and agent actions stay locked.`
                : 'Your account reached the app but does not have a Junior role that allows workspace access.'}
            </p>
            {currentIdentity ? (
              <div className="auth-gate-details">
                <strong>{currentIdentity.displayName}</strong>
                <span>{currentIdentity.userId}</span>
                <span>{currentIdentity.roles.join(', ') || 'No app roles assigned'}</span>
              </div>
            ) : null}
            {authBootstrapState === 'access-denied' && authDiagnostics?.tokenClaims ? (
              <div className="auth-gate-details">
                <strong>Auth diagnostics</strong>
                <span>{`aud: ${authDiagnostics.tokenClaims.aud ?? 'missing'}`}</span>
                <span>{`scp: ${authDiagnostics.tokenClaims.scp ?? 'missing'}`}</span>
                <span>{`roles: ${(authDiagnostics.tokenClaims.roles ?? []).join(', ') || 'missing'}`}</span>
                <span>{`oid: ${authDiagnostics.tokenClaims.oid ?? 'missing'}`}</span>
              </div>
            ) : null}
            <div className="auth-gate-actions">
              {authBootstrapState === 'signin-required' && signInUrl ? (
                <button type="button" onClick={beginSignIn}>
                  Sign in with {authConfig?.providerName ?? 'Microsoft Entra ID'}
                </button>
              ) : authBootstrapState === 'signin-required' && authConfig?.identityMode === 'entra-msal' ? (
                <button type="button" onClick={beginSignIn}>
                  Sign in with {authConfig?.providerName ?? 'Microsoft Entra ID'}
                </button>
              ) : null}
              {authBootstrapState === 'access-denied' && (signOutUrl || authConfig?.identityMode === 'entra-msal') ? (
                <button type="button" onClick={beginSignOut}>
                  Sign out
                </button>
              ) : null}
            </div>
            {showDevIdentityTools ? (
              <section className="dev-identity-panel auth-gate-dev-panel" aria-label="Local auth test controls">
                <div className="dev-identity-summary">
                  <strong>Local trusted-header override</strong>
                  <span>Use this only for local development when you need to simulate an authenticated Entra user.</span>
                </div>
                <div className="dev-identity-form">
                  <input value={devIdentityUserIdDraft} onChange={(event) => setDevIdentityUserIdDraft(event.target.value)} placeholder="User ID" />
                  <input value={devIdentityDisplayNameDraft} onChange={(event) => setDevIdentityDisplayNameDraft(event.target.value)} placeholder="Display name" />
                  <input value={devIdentityTenantIdDraft} onChange={(event) => setDevIdentityTenantIdDraft(event.target.value)} placeholder="Tenant ID (optional)" />
                  <input value={devIdentityRolesDraft} onChange={(event) => setDevIdentityRolesDraft(event.target.value)} placeholder="Junior.User, Junior.Admin" />
                </div>
                <div className="dev-identity-actions">
                  <button type="button" onClick={() => applyDevIdentityDraft({ userId: devIdentityUserIdDraft, displayName: devIdentityDisplayNameDraft, tenantId: devIdentityTenantIdDraft, roles: devIdentityRolesDraft })}>Apply Identity</button>
                  <button type="button" onClick={() => {
                    setDevIdentityUserIdDraft(defaultAdminDevIdentity.userId);
                    setDevIdentityDisplayNameDraft(defaultAdminDevIdentity.displayName);
                    setDevIdentityTenantIdDraft(defaultAdminDevIdentity.tenantId);
                    setDevIdentityRolesDraft(defaultAdminDevIdentity.roles);
                  }}>Admin Preset</button>
                  <button type="button" onClick={() => {
                    setDevIdentityUserIdDraft(defaultUserDevIdentity.userId);
                    setDevIdentityDisplayNameDraft(defaultUserDevIdentity.displayName);
                    setDevIdentityTenantIdDraft(defaultUserDevIdentity.tenantId);
                    setDevIdentityRolesDraft(defaultUserDevIdentity.roles);
                  }}>User Preset</button>
                  <button type="button" onClick={clearDevIdentityDraft}>Clear</button>
                </div>
              </section>
            ) : null}
          </div>
        </section>
      ) : activeScreen === 'workspace-settings' ? (
        <section className="admin-screen">
          <section className="config-drawer workspace-admin standalone-admin">
            <div className="config-nav" aria-label="Workspace settings sections">
              <button type="button" className={configView === 'workspace' ? 'selected' : ''} onClick={() => setConfigView('workspace')}>Workspace</button>
              <button type="button" className={configView === 'connectors' ? 'selected' : ''} onClick={() => setConfigView('connectors')}>Connectors</button>
              <button type="button" className={configView === 'mcp' ? 'selected' : ''} onClick={() => setConfigView('mcp')}>MCP Servers</button>
              <button type="button" className={configView === 'agents' ? 'selected' : ''} onClick={() => setConfigView('agents')}>Custom Agents</button>
              <button type="button" onClick={() => openConfigDrawer('workspace-templates')}>Shared Templates</button>
            </div>

            <aside className="config-list-pane">
              {configView === 'workspace' ? (
                <>
                  <div className="config-list-header">
                    <div>
                      <strong>{activeWorkspace?.name ?? 'Workspace'}</strong>
                      <span>{activeWorkspace?.description || 'Workspace-scoped settings and shared template attachments'}</span>
                    </div>
                  </div>
                  <div className="config-item-list">
                    <div className="config-item-row selected">
                      <strong>Current template</strong>
                      <span>{activeWorkspace?.templateName ?? 'No shared template attached'}</span>
                    </div>
                    <div className="config-item-row">
                      <strong>Workspace agents</strong>
                      <span>{workspaceSettingsAgents.length} persisted</span>
                    </div>
                    <div className="config-item-row">
                      <strong>Workspace MCP servers</strong>
                      <span>{workspaceSettingsMcpServers.length} persisted</span>
                    </div>
                    <div className="config-item-row">
                      <strong>Workspace connectors</strong>
                      <span>{workspaceSettingsConnections.length} persisted</span>
                    </div>
                  </div>
                </>
              ) : configView === 'connectors' ? (
                <>
                  <div className="config-list-header">
                    <div>
                      <strong>Workspace Connectors</strong>
                      <span>{workspaceSettingsConnections.length} configured</span>
                    </div>
                    <button type="button" onClick={beginCreateConnector}><Plus size={16} /> New</button>
                  </div>
                  <div className="config-item-list">
                    <button type="button" className={selectedConnectorId === 'new' ? 'config-item-row selected' : 'config-item-row'} onClick={beginCreateConnector}>
                      <strong>New connector</strong>
                      <span>Create a workspace-only Azure OpenAI or Search connector</span>
                    </button>
                    {workspaceSettingsConnections.map((connection) => (
                      <button key={connection.id} type="button" className={selectedConnectorId === connection.id ? 'config-item-row selected' : 'config-item-row'} onClick={() => selectConnectorForEditing(connection.id)}>
                        <strong>{connection.name}</strong>
                        <span>{connectorListSummary(connection)}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : configView === 'mcp' ? (
                <>
                  <div className="config-list-header">
                    <div>
                      <strong>Workspace MCP Servers</strong>
                      <span>{workspaceSettingsMcpServers.length} configured</span>
                    </div>
                    <button type="button" onClick={beginCreateMcpServer}><Plus size={16} /> New</button>
                  </div>
                  <div className="config-item-list">
                    <button type="button" className={selectedMcpServerId === 'new' ? 'config-item-row selected' : 'config-item-row'} onClick={beginCreateMcpServer}>
                      <strong>New MCP server</strong>
                      <span>Add a hosted MCP endpoint scoped to this workspace</span>
                    </button>
                    {workspaceSettingsMcpServers.map((server) => (
                      <button key={server.id} type="button" className={selectedMcpServerId === server.id ? 'config-item-row selected' : 'config-item-row'} onClick={() => selectMcpServerForEditing(server.id)}>
                        <strong>{server.name}</strong>
                        <span>{server.configured ? 'Configured' : `Missing ${server.missing.join(', ')}`}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="config-list-header">
                    <div>
                      <strong>Workspace Agents</strong>
                      <span>{workspaceSettingsAgents.length} configured</span>
                    </div>
                    <button type="button" onClick={beginCreateAgent}><Plus size={16} /> New</button>
                  </div>
                  <div className="config-item-list">
                    <button type="button" className={customAgentMode === 'create' ? 'config-item-row selected' : 'config-item-row'} onClick={beginCreateAgent}>
                      <strong>New agent</strong>
                      <span>Create a workspace-only agent persona</span>
                    </button>
                    {workspaceSettingsAgents.map((agent) => (
                      <button key={agent.id} type="button" className={customAgentMode === 'edit' && selectedConfigAgent?.id === agent.id ? 'config-item-row selected' : 'config-item-row'} onClick={() => selectAgentForEditing(agent.id)}>
                        <strong>{agent.name}</strong>
                        <span>{agent.description || 'No description set'}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </aside>

            {configView === 'workspace' ? (
              <div className="config-panel">
                <div className="config-header-row">
                  <div>
                    <h2>Workspace Settings</h2>
                    <p>Attach a shared template for discovery, then selectively import the starter resources this workspace should keep locally.</p>
                  </div>
                  <div className="config-header-actions">
                    <button type="button" className="icon-only" onClick={closeAdminScreen} title="Close workspace settings" aria-label="Close workspace settings">
                      <X size={16} />
                    </button>
                  </div>
                </div>
                <div className="config-form-grid">
                  <label className="wide-field">
                    <span>Workspace template</span>
                    <select value={workspaceTemplateDraft} onChange={(event) => setWorkspaceTemplateDraft(event.target.value)}>
                      <option value="">No shared template</option>
                      {workspaceTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                    </select>
                  </label>
                  <div className="wide-field config-item-row">
                    <strong>{selectedWorkspaceTemplate?.name ?? 'No template selected'}</strong>
                    <span>{selectedWorkspaceTemplate?.description ?? 'Attach a shared template to preview and selectively import its referenced resources.'}</span>
                  </div>
                  <div className="wide-field workspace-template-preview">
                    <div>
                      <strong>Agent templates</strong>
                      {draftWorkspaceAgentTemplates.length > 0 ? (
                        <div className="config-checklist">
                          {draftWorkspaceAgentTemplates.map((template) => template && (
                            <label key={template.id} className="checklist-row">
                              <input type="checkbox" checked={workspaceTemplateAgentImportIds.includes(template.id)} onChange={() => setWorkspaceTemplateAgentImportIds((current) => toggleSelection(current, template.id))} />
                              <span>{template.name}</span>
                            </label>
                          ))}
                        </div>
                      ) : <ul><li>None</li></ul>}
                    </div>
                    <div>
                      <strong>MCP catalog entries</strong>
                      {draftWorkspaceMcpCatalog.length > 0 ? (
                        <div className="config-checklist">
                          {draftWorkspaceMcpCatalog.map((entry) => entry && (
                            <label key={entry.id} className="checklist-row">
                              <input type="checkbox" checked={workspaceTemplateMcpImportIds.includes(entry.id)} onChange={() => setWorkspaceTemplateMcpImportIds((current) => toggleSelection(current, entry.id))} />
                              <span>{entry.name}</span>
                            </label>
                          ))}
                        </div>
                      ) : <ul><li>None</li></ul>}
                    </div>
                    <div>
                      <strong>Connectors</strong>
                      {draftWorkspaceConnections.length > 0 ? (
                        <div className="config-checklist">
                          {draftWorkspaceConnections.map((connection) => connection && (
                            <label key={connection.id} className="checklist-row">
                              <input type="checkbox" checked={workspaceTemplateConnectionImportIds.includes(connection.id)} onChange={() => setWorkspaceTemplateConnectionImportIds((current) => toggleSelection(current, connection.id))} />
                              <span>{connection.name}</span>
                            </label>
                          ))}
                        </div>
                      ) : <ul><li>None</li></ul>}
                    </div>
                  </div>
                  <div className="wide-field config-item-row">
                    <strong>Selective import</strong>
                    <span>Only the checked resources will be materialized into this workspace. The shared template remains a starting point, not a live binding.</span>
                  </div>
                </div>
                <div className="config-header-actions">
                  <button type="button" className="primary config-save" onClick={saveWorkspaceSettings} disabled={busy || !activeWorkspace || activeWorkspaceId === 'current'}>Save Template Attachment</button>
                  <button type="button" className="config-save" onClick={importWorkspaceTemplateResources} disabled={busy || !activeWorkspace || activeWorkspaceId === 'current' || !selectedWorkspaceTemplate}>Import Selected Resources</button>
                </div>
              </div>
            ) : configView === 'connectors' ? (
              <div className="config-panel">
                <div className="config-header-row">
                  <div>
                    <h2>{selectedConnector ? selectedConnector.name : 'New Workspace Connector'}</h2>
                    <p>Create connectors that only this workspace uses at runtime.</p>
                  </div>
                  <div className="config-header-actions">
                    {selectedConnector && (
                      <button type="button" className="danger" onClick={deleteSelectedConnector} disabled={busy}><Trash2 size={16} /> Delete</button>
                    )}
                    <button type="button" className="icon-only" onClick={closeAdminScreen} title="Close workspace settings" aria-label="Close workspace settings">
                      <X size={16} />
                    </button>
                  </div>
                </div>
                <div className="config-form-grid">
                  <label>
                    <span>Connector type</span>
                    <select value={connectorTypeDraft} onChange={(event) => setConnectorTypeDraft(event.target.value as AgentConnectionType)}>
                      <option value="azure-openai">Azure OpenAI</option>
                      <option value="azure-ai-search">Azure AI Search</option>
                    </select>
                  </label>
                  <label>
                    <span>Name</span>
                    <input value={connectorNameDraft} onChange={(event) => setConnectorNameDraft(event.target.value)} placeholder="Workspace Azure OpenAI" />
                  </label>
                  <label>
                    <span>Authentication</span>
                    <select value={connectorAuthDraft} onChange={(event) => setConnectorAuthDraft(event.target.value as AzureAuthMode)}>
                      <option value="entra">Microsoft Entra ID</option>
                      <option value="api-key">API key</option>
                    </select>
                  </label>
                  <label>
                    <span>Cloud</span>
                    <select value={connectorCloudDraft} onChange={(event) => setConnectorCloudDraft(event.target.value as AzureCloud)}>
                      <option value="public">Azure public</option>
                      <option value="usgovernment">Azure Government</option>
                      <option value="china">Azure China</option>
                      <option value="custom">Custom sovereign cloud</option>
                    </select>
                  </label>
                  <label className="wide-field">
                    <span>Service endpoint</span>
                    <input value={connectorEndpointDraft} onChange={(event) => setConnectorEndpointDraft(event.target.value)} placeholder={connectorTypeDraft === 'azure-openai' ? 'https://your-resource.openai.azure.com' : 'https://your-search.search.windows.net'} />
                  </label>
                  {connectorTypeDraft === 'azure-openai' && (
                    <label>
                      <span>Endpoint type</span>
                      <select value={connectorEndpointKindDraft} onChange={(event) => setConnectorEndpointKindDraft(event.target.value as AzureOpenAiEndpointKind)}>
                        <option value="auto">Auto-detect from endpoint</option>
                        <option value="foundry-project">Foundry project endpoint</option>
                        <option value="openai-v1">OpenAI-compatible v1 endpoint</option>
                        <option value="azure-openai-legacy">Azure OpenAI legacy endpoint</option>
                      </select>
                    </label>
                  )}
                  {connectorTypeDraft === 'azure-openai' && connectorAuthDraft === 'entra' && (
                    <label className="wide-field">
                      <span>Credential scope</span>
                      <input value={connectorCredentialScopeDraft} onChange={(event) => setConnectorCredentialScopeDraft(event.target.value)} placeholder={suggestedCredentialScope(connectorEndpointDraft, connectorCloudDraft, connectorEndpointKindDraft)} />
                    </label>
                  )}
                  {connectorAuthDraft === 'api-key' && (
                    <label className="wide-field">
                      <span>API key</span>
                      <input type="password" value={connectorApiKeyDraft} onChange={(event) => setConnectorApiKeyDraft(event.target.value)} placeholder={selectedConnector?.hasApiKey ? 'Stored key exists; enter a new value to replace it' : 'Paste API key'} />
                    </label>
                  )}
                  {connectorTypeDraft === 'azure-openai' ? (
                    <>
                      <label>
                        <span>Deployment / model</span>
                        <input value={connectorDeploymentDraft} onChange={(event) => setConnectorDeploymentDraft(event.target.value)} placeholder="gpt-4.1" />
                      </label>
                      <label>
                        <span>API version</span>
                        <input value={connectorApiVersionDraft} onChange={(event) => setConnectorApiVersionDraft(event.target.value)} placeholder="2025-01-01-preview" />
                      </label>
                    </>
                  ) : (
                    <>
                      <label>
                        <span>Query type</span>
                        <select value={connectorQueryTypeDraft} onChange={(event) => setConnectorQueryTypeDraft(event.target.value as 'simple' | 'full' | 'semantic')}>
                          <option value="semantic">Semantic</option>
                          <option value="simple">Simple</option>
                          <option value="full">Full Lucene</option>
                        </select>
                      </label>
                      <label>
                        <span>Top K</span>
                        <input type="number" min="1" max="50" value={connectorTopDraft} onChange={(event) => setConnectorTopDraft(Number(event.target.value))} />
                      </label>
                      <label>
                        <span>Indexes</span>
                        <textarea value={connectorIndexesDraft} onChange={(event) => setConnectorIndexesDraft(event.target.value)} placeholder="security-index&#10;policy-index" />
                      </label>
                      <label>
                        <span>Semantic configurations</span>
                        <textarea value={connectorSemanticDraft} onChange={(event) => setConnectorSemanticDraft(event.target.value)} placeholder="default" />
                      </label>
                    </>
                  )}
                  {connectorTypeDraft === 'azure-openai' && (
                    <div className="wide-field connector-diagnostics">
                      <strong>Resolved connector diagnostics</strong>
                      <div className="config-checklist">
                        <div className="checklist-row"><strong>Endpoint host</strong><span>{endpointHost(connectorEndpointDraft)}</span></div>
                        <div className="checklist-row"><strong>Endpoint type</strong><span>{azureOpenAiEndpointKindLabel(connectorEndpointDraft, connectorEndpointKindDraft)}</span></div>
                        <div className="checklist-row"><strong>Authentication</strong><span>{connectorAuthDraft === 'entra' ? 'Microsoft Entra ID' : 'API key'}</span></div>
                        <div className="checklist-row"><strong>Effective credential scope</strong><span>{connectorResolvedScope}</span></div>
                        <div className="checklist-row"><strong>Deployment / model</strong><span>{connectorDeploymentDraft.trim() || 'Not set'}</span></div>
                        <div className="checklist-row"><strong>API version</strong><span>{connectorApiVersionDraft.trim() || 'Not set'}</span></div>
                        <div className="checklist-row"><strong>Stored API key</strong><span>{selectedConnector?.hasApiKey ? 'Present' : 'Not stored'}</span></div>
                      </div>
                      <p className="connector-hint">Use an explicit endpoint type for air-gapped or custom hosts so request shape and default token scope do not depend on hostname heuristics. Override credential scope when your environment uses a non-public audience.</p>
                      {connectorRoleHint ? <p className="connector-hint">{connectorRoleHint}</p> : null}
                    </div>
                  )}
                </div>
                <button type="button" className="primary config-save" onClick={saveConnector} disabled={busy || !connectorNameDraft.trim()}>Save Connector</button>
              </div>
            ) : configView === 'mcp' ? (
              <div className="config-panel">
                <div className="config-header-row">
                  <div>
                    <h2>{selectedMcpServer ? selectedMcpServer.name : 'New Workspace MCP Server'}</h2>
                    <p>Register workspace-local MCP endpoints and attach them to workspace agents.</p>
                  </div>
                  <div className="config-header-actions">
                    {selectedMcpServer && (
                      <button type="button" className="danger" onClick={deleteSelectedMcpServer} disabled={busy}><Trash2 size={16} /> Delete</button>
                    )}
                    <button type="button" className="icon-only" onClick={closeAdminScreen} title="Close workspace settings" aria-label="Close workspace settings">
                      <X size={16} />
                    </button>
                  </div>
                </div>
                <div className="config-form-grid">
                  {selectedMcpServerId === 'new' && workspaceSharedMcpCatalog.length > 0 && (
                    <label className="wide-field">
                      <span>Known server</span>
                      <select value={selectedMcpCatalogId} onChange={(event) => applyMcpCatalogEntry(event.target.value)}>
                        <option value="">Start from a blank MCP server</option>
                        {workspaceSharedMcpCatalog.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                      </select>
                    </label>
                  )}
                  <label>
                    <span>Name</span>
                    <input value={mcpServerNameDraft} onChange={(event) => setMcpServerNameDraft(event.target.value)} placeholder="Workspace MCP Server" />
                  </label>
                  <label>
                    <span>Transport</span>
                    <input value="Remote HTTP" disabled />
                  </label>
                  <label className="wide-field">
                    <span>Endpoint</span>
                    <input value={mcpServerEndpointDraft} onChange={(event) => setMcpServerEndpointDraft(event.target.value)} placeholder="https://your-mcp-host.example.com" />
                  </label>
                  <label>
                    <span>Authentication</span>
                    <select value={mcpServerAuthDraft} onChange={(event) => setMcpServerAuthDraft(event.target.value as McpServerAuthMode)}>
                      <option value="none">None</option>
                      <option value="bearer-token">Bearer token</option>
                      <option value="api-key">API key</option>
                      <option value="entra">Microsoft Entra ID</option>
                      <option value="custom-headers">Custom headers</option>
                    </select>
                  </label>
                  {mcpServerAuthDraft === 'bearer-token' && (
                    <label className="wide-field">
                      <span>Bearer token</span>
                      <input type="password" value={mcpServerBearerTokenDraft} onChange={(event) => setMcpServerBearerTokenDraft(event.target.value)} placeholder={selectedMcpServer?.hasBearerToken ? 'Stored token exists; enter a new value to replace it' : 'Paste bearer token'} />
                    </label>
                  )}
                  {mcpServerAuthDraft === 'api-key' && (
                    <label className="wide-field">
                      <span>API key</span>
                      <input type="password" value={mcpServerApiKeyDraft} onChange={(event) => setMcpServerApiKeyDraft(event.target.value)} placeholder={selectedMcpServer?.hasApiKey ? 'Stored key exists; enter a new value to replace it' : 'Paste API key'} />
                    </label>
                  )}
                  {mcpServerAuthDraft === 'entra' && (
                    <label className="wide-field">
                      <span>Audience / scope</span>
                      <input value={mcpServerAudienceDraft} onChange={(event) => setMcpServerAudienceDraft(event.target.value)} placeholder="api://resource/.default" />
                    </label>
                  )}
                  {mcpServerAuthDraft === 'custom-headers' && (
                    <label className="wide-field">
                      <span>Custom headers</span>
                      <textarea value={mcpServerHeadersDraft} onChange={(event) => setMcpServerHeadersDraft(event.target.value)} placeholder="x-api-key: value&#10;x-tenant: tenant-id" />
                    </label>
                  )}
                </div>
                <button type="button" className="primary config-save" onClick={saveMcpServer} disabled={busy || !mcpServerNameDraft.trim() || !mcpServerEndpointDraft.trim()}>Save MCP Server</button>
              </div>
            ) : (
              <div className="config-panel">
                <div className="config-header-row">
                  <div>
                    <h2>{customAgentMode === 'create' ? 'New Workspace Agent' : (selectedConfigAgent?.name ?? 'Workspace Agent')}</h2>
                    <p>Create a workspace-scoped agent persona, connector choice, and optional search grounding.</p>
                  </div>
                  <div className="config-header-actions">
                    {customAgentMode === 'edit' && selectedConfigAgent && (
                      <button type="button" className="danger" onClick={deleteSelectedAgent} disabled={busy}><Trash2 size={16} /> Delete</button>
                    )}
                    <button type="button" className="icon-only" onClick={closeAdminScreen} title="Close workspace settings" aria-label="Close workspace settings">
                      <X size={16} />
                    </button>
                  </div>
                </div>
                <div className="config-form-grid agent-form-grid">
                  {customAgentMode === 'create' && workspaceSharedAgentTemplates.length > 0 && (
                    <label className="wide-field">
                      <span>Shared agent template</span>
                      <select value={selectedAgentTemplateId} onChange={(event) => applyAgentTemplate(event.target.value)}>
                        <option value="">Start from scratch</option>
                        {workspaceSharedAgentTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                      </select>
                    </label>
                  )}
                  <label>
                    <span>Name</span>
                    <input value={customAgentNameDraft} onChange={(event) => setCustomAgentNameDraft(event.target.value)} placeholder="Workspace Research Agent" />
                  </label>
                  <label>
                    <span>Description</span>
                    <input value={customAgentDescriptionDraft} onChange={(event) => setCustomAgentDescriptionDraft(event.target.value)} placeholder="Explains what this agent is for" />
                  </label>
                  <label>
                    <span>Model connector</span>
                    <select value={customAgentModelDraft} onChange={(event) => setCustomAgentModelDraft(event.target.value)}>
                      {modelConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Search connector</span>
                    <select value={customAgentSearchConnectorDraft} onChange={(event) => setCustomAgentSearchConnectorDraft(event.target.value)}>
                      <option value="">None</option>
                      {searchConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Reasoning effort</span>
                    <select value={customAgentReasoningEffortDraft} onChange={(event) => setCustomAgentReasoningEffortDraft(event.target.value as ReasoningEffort)}>
                      <option value="none">None</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="xhigh">Very high</option>
                    </select>
                    <p className="connector-hint">Controls how much reasoning this agent should use when it calls the model.</p>
                  </label>
                  <label>
                    <span>Temperature</span>
                    <input type="number" min="0" max="2" step="0.1" value={customAgentTemperatureDraft} onChange={(event) => setCustomAgentTemperatureDraft(event.target.value)} placeholder="Inherit connector default" />
                    <p className="connector-hint">Leave blank to use the connector default.</p>
                  </label>
                  <label>
                    <span>Max output tokens</span>
                    <input type="number" min="1" max="8192" step="1" value={customAgentMaxTokensDraft} onChange={(event) => setCustomAgentMaxTokensDraft(event.target.value)} placeholder="Inherit connector default" />
                    <p className="connector-hint">Leave blank to use the connector default.</p>
                  </label>
                  <label className="wide-field">
                    <span>Instructions</span>
                    <textarea value={agentInstructionsDraft} onChange={(event) => setAgentInstructionsDraft(event.target.value)} rows={10} />
                  </label>
                  <label className="wide-field checkbox-field">
                    <input type="checkbox" checked={searchEnabledDraft} onChange={(event) => setSearchEnabledDraft(event.target.checked)} />
                    <span>Enable Azure AI Search grounding</span>
                  </label>
                  <label>
                    <span>Search index</span>
                    <input value={searchIndexDraft} onChange={(event) => setSearchIndexDraft(event.target.value)} placeholder="security-index" />
                  </label>
                  <label>
                    <span>Semantic config</span>
                    <input value={searchSemanticConfigDraft} onChange={(event) => setSearchSemanticConfigDraft(event.target.value)} placeholder="default" />
                  </label>
                  <label className="wide-field">
                    <span>MCP servers</span>
                    <select multiple value={customAgentMcpServerIdsDraft} onChange={(event) => setCustomAgentMcpServerIdsDraft(Array.from(event.target.selectedOptions).map((option) => option.value))}>
                      {editableMcpServers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}
                    </select>
                  </label>
                </div>
                <button type="button" className="primary config-save" onClick={saveCustomAgent} disabled={busy || !customAgentNameDraft.trim() || !customAgentModelDraft}>{customAgentMode === 'create' ? 'Create Workspace Agent' : 'Save Workspace Agent'}</button>
              </div>
            )}
          </section>
        </section>
      ) : activeScreen === 'admin' ? (
        <section className="admin-screen">
          <section className="config-drawer workspace-admin standalone-admin">
            <div className="config-nav" aria-label="Configuration sections">
              <button type="button" className={configView === 'connectivity' ? 'selected' : ''} onClick={() => setConfigView('connectivity')}>Connectivity</button>
              <button type="button" className={configView === 'classification' ? 'selected' : ''} onClick={() => setConfigView('classification')}>Classification</button>
              <button type="button" className={configView === 'workspace-templates' ? 'selected' : ''} onClick={() => setConfigView('workspace-templates')}>Workspace Templates</button>
              <button type="button" className={configView === 'connectors' ? 'selected' : ''} onClick={() => setConfigView('connectors')}>Connectors</button>
              <button type="button" className={configView === 'mcp' ? 'selected' : ''} onClick={() => setConfigView('mcp')}>MCP Servers</button>
              <button type="button" className={configView === 'agents' ? 'selected' : ''} onClick={() => setConfigView('agents')}>Custom Agents</button>
            </div>

            <aside className="config-list-pane">
              {configView === 'connectivity' ? (
                <>
                  <div className="config-list-header">
                    <div>
                      <strong>Connectivity</strong>
                      <span>{adminConnectivity?.sections.length ?? 0} sections</span>
                    </div>
                    <button type="button" onClick={() => void refreshAdminConnectivity()} disabled={adminConnectivityBusy}>{adminConnectivityBusy ? 'Refreshing...' : 'Refresh'}</button>
                  </div>
                  <div className="config-item-list connectivity-list">
                    {(adminConnectivity?.sections ?? []).map((section) => (
                      <div key={section.id} className="config-item-row selected connectivity-summary-row">
                        <strong>{section.label}</strong>
                        <span>{section.message}</span>
                        <div className={`connection-status compact ${connectivityTone(section.status)}`}>
                          <strong>{section.status === 'ok' ? 'Green' : section.status === 'disabled' ? 'Disabled' : 'Red'}</strong>
                          <span>{section.checks.filter((check) => check.status === 'ok').length}/{section.checks.length} passing</span>
                        </div>
                      </div>
                    ))}
                    {!adminConnectivity && !adminConnectivityBusy && (
                      <div className="config-item-row selected connectivity-summary-row">
                        <strong>Connectivity</strong>
                        <span>Open this tab to load current service diagnostics.</span>
                      </div>
                    )}
                  </div>
                </>
              ) : configView === 'classification' ? (
                <>
                  <div className="config-list-header">
                    <div>
                      <strong>Classification</strong>
                      <span>{classificationBar.text.trim() ? 'Visible banner' : 'Hidden until text is set'}</span>
                    </div>
                  </div>
                  <div className="config-item-list">
                    <div className="config-item-row selected">
                      <strong>{classificationBar.text.trim() || 'No banner text set'}</strong>
                      <span>{classificationBar.color}</span>
                    </div>
                  </div>
                </>
              ) : configView === 'workspace-templates' ? (
                <>
                  <div className="config-list-header">
                    <div>
                      <strong>Workspace Templates</strong>
                      <span>{workspaceTemplates.length} configured</span>
                    </div>
                  </div>
                  <div className="config-item-list">
                    {workspaceTemplates.map((template) => (
                      <div key={template.id} className="config-item-row selected">
                        <strong>{template.name}</strong>
                        <span>{template.description}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : configView === 'connectors' ? (
                <>
                  <div className="config-list-header">
                    <div>
                      <strong>Connectors</strong>
                      <span>{connections.length} configured</span>
                    </div>
                    <button type="button" onClick={beginCreateConnector}><Plus size={16} /> New</button>
                  </div>
                  <div className="config-item-list">
                    <button type="button" className={selectedConnectorId === 'new' ? 'config-item-row selected' : 'config-item-row'} onClick={beginCreateConnector}>
                      <strong>New connector</strong>
                      <span>Create a new Azure OpenAI or Search connector</span>
                    </button>
                    {connections.map((connection) => (
                      <button key={connection.id} type="button" className={selectedConnectorId === connection.id ? 'config-item-row selected' : 'config-item-row'} onClick={() => selectConnectorForEditing(connection.id)}>
                        <strong>{connection.name}</strong>
                        <span>{connectorListSummary(connection)}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : configView === 'mcp' ? (
                <>
                  <div className="config-list-header">
                    <div>
                      <strong>MCP Servers</strong>
                      <span>{mcpServers.length} configured</span>
                    </div>
                    <button type="button" onClick={beginCreateMcpServer}><Plus size={16} /> New</button>
                  </div>
                  <div className="config-item-list">
                    <button type="button" className={selectedMcpServerId === 'new' ? 'config-item-row selected' : 'config-item-row'} onClick={beginCreateMcpServer}>
                      <strong>New MCP server</strong>
                      <span>Add a hosted MCP endpoint with auth and agent access</span>
                    </button>
                    {mcpServers.map((server) => (
                      <button key={server.id} type="button" className={selectedMcpServerId === server.id ? 'config-item-row selected' : 'config-item-row'} onClick={() => selectMcpServerForEditing(server.id)}>
                        <strong>{server.name}</strong>
                        <span>{server.configured ? 'Configured' : `Missing ${server.missing.join(', ')}`}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="config-list-header">
                    <div>
                      <strong>Custom Agents</strong>
                      <span>{agents.length} configured</span>
                    </div>
                    <button type="button" onClick={beginCreateAgent}><Plus size={16} /> New</button>
                  </div>
                  <div className="config-item-list">
                    <button type="button" className={customAgentMode === 'create' ? 'config-item-row selected' : 'config-item-row'} onClick={beginCreateAgent}>
                      <strong>New agent</strong>
                      <span>Create a new custom agent persona</span>
                    </button>
                    {editableAgents.map((agent) => (
                      <button key={agent.id} type="button" className={customAgentMode === 'edit' && selectedConfigAgent?.id === agent.id ? 'config-item-row selected' : 'config-item-row'} onClick={() => selectAgentForEditing(agent.id)}>
                        <strong>{agent.name}</strong>
                        <span>{agent.description || 'No description set'}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </aside>

            {configView === 'connectivity' ? (
              <div className="config-panel">
                <div className="config-header-row">
                  <div>
                    <h2>Connectivity</h2>
                    <p>Validate Cosmos DB, workspace storage, and AI connector readiness from the admin section.</p>
                  </div>
                  <div className="config-header-actions">
                    <button type="button" onClick={() => void refreshAdminConnectivity()} disabled={adminConnectivityBusy}>{adminConnectivityBusy ? 'Refreshing...' : 'Refresh'}</button>
                    <button type="button" className="icon-only" onClick={closeAdminScreen} title="Close admin" aria-label="Close admin">
                      <X size={16} />
                    </button>
                  </div>
                </div>
                <div className="connectivity-section-list">
                  {(adminConnectivity?.sections ?? []).map((section) => (
                    <section key={section.id} className="connectivity-section-card">
                      <div className="connectivity-section-header">
                        <div>
                          <h3>{section.label}</h3>
                          <p>{section.message}</p>
                        </div>
                        <div className={`connection-status ${connectivityTone(section.status)}`}>
                          <strong>{section.status === 'ok' ? 'Green light' : section.status === 'disabled' ? 'Disabled' : 'Red light'}</strong>
                          <span>{section.checks.filter((check) => check.status === 'ok').length} of {section.checks.length} passing</span>
                        </div>
                      </div>
                      {(section.id === 'cosmos' || section.id === 'storage') && (
                        <div className="connectivity-test-actions">
                          <button type="button" className="primary" onClick={() => void runConnectivityTest(section.id === 'cosmos' ? 'cosmos' : 'storage')} disabled={connectivityTestTarget !== null}>
                            {connectivityTestTarget === section.id ? 'Running test...' : 'Run read/write test'}
                          </button>
                        </div>
                      )}
                      <div className="connectivity-check-grid">
                        {section.checks.map((check) => (
                          <div key={check.id} className="connectivity-check-card">
                            <div className={`connectivity-light ${check.status}`} aria-hidden="true" />
                            <div>
                              <strong>{check.label}</strong>
                              <p>{check.message}</p>
                              {check.detail ? <small>{check.detail}</small> : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                  {!adminConnectivity && !adminConnectivityBusy ? (
                    <section className="connectivity-section-card empty">
                      <div className="connectivity-section-header">
                        <div>
                          <h3>Connectivity</h3>
                          <p>Refresh to load current service diagnostics.</p>
                        </div>
                      </div>
                    </section>
                  ) : null}
                </div>
              </div>
            ) : configView === 'classification' ? (
              <div className="config-panel">
                <div className="config-header-row">
                  <div>
                    <h2>Classification</h2>
                    <p>Configure the centered text and color for the banner shown at the top of the application.</p>
                  </div>
                  <div className="config-header-actions">
                    <button type="button" className="icon-only" onClick={closeAdminScreen} title="Close admin" aria-label="Close admin">
                      <X size={16} />
                    </button>
                  </div>
                </div>
                <div className="config-form-grid">
                  <label className="wide-field">
                    <span>Banner text</span>
                    <input value={classificationTextDraft} onChange={(event) => setClassificationTextDraft(event.target.value)} placeholder="Confidential" />
                  </label>
                  <label>
                    <span>Banner color</span>
                    <input type="color" value={classificationColorDraft} onChange={(event) => setClassificationColorDraft(event.target.value)} />
                  </label>
                  <label>
                    <span>Hex color</span>
                    <input value={classificationColorDraft} onChange={(event) => setClassificationColorDraft(event.target.value)} placeholder="#7f1d1d" />
                  </label>
                  <div className="wide-field classification-preview" style={{ backgroundColor: classificationColorDraft, color: classificationTextColor(classificationColorDraft) }}>
                    <span>{classificationTextDraft.trim() || 'Classification preview'}</span>
                  </div>
                </div>
                <button type="button" className="primary config-save" onClick={saveClassificationBar} disabled={busy}>Save Classification</button>
              </div>
            ) : configView === 'workspace-templates' ? (
              <div className="config-panel">
                <div className="config-header-row">
                  <div>
                    <h2>Workspace Templates</h2>
                    <p>These admin-managed templates can be selected when creating a new workspace.</p>
                  </div>
                  <div className="config-header-actions">
                    <button type="button" className="icon-only" onClick={closeAdminScreen} title="Close admin" aria-label="Close admin">
                      <X size={16} />
                    </button>
                  </div>
                </div>
                <div className="config-item-list">
                  {workspaceTemplates.map((template) => (
                    <div key={template.id} className="config-item-row">
                      <strong>{template.name}</strong>
                      <span>{template.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : configView === 'connectors' ? (
              <div className="config-panel">
                <div className="config-header-row">
                  <div>
                    <h2>{selectedConnector ? selectedConnector.name : 'New Connector'}</h2>
                    <p>{selectedConnector ? 'Update Azure OpenAI models and Azure AI Search grounding sources.' : 'Configure a new Azure OpenAI model or Azure AI Search grounding source.'}</p>
                  </div>
                  <div className="config-header-actions">
                    {selectedConnector && (
                      <button type="button" className="danger" onClick={deleteSelectedConnector} disabled={busy}><Trash2 size={16} /> Delete</button>
                    )}
                    <button type="button" className="icon-only" onClick={closeAdminScreen} title="Close admin" aria-label="Close admin">
                      <X size={16} />
                    </button>
                  </div>
                </div>
                <div className="config-form-grid">
                  <label>
                    <span>Connector type</span>
                    <select value={connectorTypeDraft} onChange={(event) => setConnectorTypeDraft(event.target.value as AgentConnectionType)}>
                      <option value="azure-openai">Azure OpenAI</option>
                      <option value="azure-ai-search">Azure AI Search</option>
                    </select>
                  </label>
                  <label>
                    <span>Name</span>
                    <input value={connectorNameDraft} onChange={(event) => setConnectorNameDraft(event.target.value)} placeholder="Production Azure OpenAI" />
                  </label>
                  <label>
                    <span>Authentication</span>
                    <select value={connectorAuthDraft} onChange={(event) => setConnectorAuthDraft(event.target.value as AzureAuthMode)}>
                      <option value="entra">Microsoft Entra ID</option>
                      <option value="api-key">API key</option>
                    </select>
                  </label>
                  <label>
                    <span>Cloud</span>
                    <select value={connectorCloudDraft} onChange={(event) => setConnectorCloudDraft(event.target.value as AzureCloud)}>
                      <option value="public">Azure public</option>
                      <option value="usgovernment">Azure Government</option>
                      <option value="china">Azure China</option>
                      <option value="custom">Custom sovereign cloud</option>
                    </select>
                  </label>
                  <label className="wide-field">
                    <span>Service endpoint</span>
                    <input value={connectorEndpointDraft} onChange={(event) => setConnectorEndpointDraft(event.target.value)} placeholder={connectorTypeDraft === 'azure-openai' ? 'https://your-resource.openai.azure.com' : 'https://your-search.search.windows.net'} />
                  </label>
                  {connectorTypeDraft === 'azure-openai' && (
                    <label>
                      <span>Endpoint type</span>
                      <select value={connectorEndpointKindDraft} onChange={(event) => setConnectorEndpointKindDraft(event.target.value as AzureOpenAiEndpointKind)}>
                        <option value="auto">Auto-detect from endpoint</option>
                        <option value="foundry-project">Foundry project endpoint</option>
                        <option value="openai-v1">OpenAI-compatible v1 endpoint</option>
                        <option value="azure-openai-legacy">Azure OpenAI legacy endpoint</option>
                      </select>
                    </label>
                  )}
                  {connectorTypeDraft === 'azure-openai' && connectorAuthDraft === 'entra' && (
                    <label className="wide-field">
                      <span>Credential scope</span>
                      <input value={connectorCredentialScopeDraft} onChange={(event) => setConnectorCredentialScopeDraft(event.target.value)} placeholder={suggestedCredentialScope(connectorEndpointDraft, connectorCloudDraft, connectorEndpointKindDraft)} />
                    </label>
                  )}
                  {connectorAuthDraft === 'api-key' && (
                    <label className="wide-field">
                      <span>API key</span>
                      <input type="password" value={connectorApiKeyDraft} onChange={(event) => setConnectorApiKeyDraft(event.target.value)} placeholder={selectedConnector?.hasApiKey ? 'Stored key exists; enter a new value to replace it' : 'Paste API key'} />
                    </label>
                  )}
                  {connectorTypeDraft === 'azure-openai' ? (
                    <>
                      <label>
                        <span>Deployment / model</span>
                        <input value={connectorDeploymentDraft} onChange={(event) => setConnectorDeploymentDraft(event.target.value)} placeholder="gpt-4.1" />
                      </label>
                      <label>
                        <span>API version</span>
                        <input value={connectorApiVersionDraft} onChange={(event) => setConnectorApiVersionDraft(event.target.value)} placeholder="2025-01-01-preview" />
                      </label>
                    </>
                  ) : (
                    <>
                      <label>
                        <span>Query type</span>
                        <select value={connectorQueryTypeDraft} onChange={(event) => setConnectorQueryTypeDraft(event.target.value as 'simple' | 'full' | 'semantic')}>
                          <option value="semantic">Semantic</option>
                          <option value="simple">Simple</option>
                          <option value="full">Full Lucene</option>
                        </select>
                      </label>
                      <label>
                        <span>Top K</span>
                        <input type="number" min="1" max="50" value={connectorTopDraft} onChange={(event) => setConnectorTopDraft(Number(event.target.value))} />
                      </label>
                      <label>
                        <span>Indexes</span>
                        <textarea value={connectorIndexesDraft} onChange={(event) => setConnectorIndexesDraft(event.target.value)} placeholder="security-index&#10;policy-index" />
                      </label>
                      <label>
                        <span>Semantic configurations</span>
                        <textarea value={connectorSemanticDraft} onChange={(event) => setConnectorSemanticDraft(event.target.value)} placeholder="default" />
                      </label>
                    </>
                  )}
                  {connectorTypeDraft === 'azure-openai' && (
                    <div className="wide-field connector-diagnostics">
                      <strong>Resolved connector diagnostics</strong>
                      <div className="config-checklist">
                        <div className="checklist-row"><strong>Endpoint host</strong><span>{endpointHost(connectorEndpointDraft)}</span></div>
                        <div className="checklist-row"><strong>Endpoint type</strong><span>{azureOpenAiEndpointKindLabel(connectorEndpointDraft, connectorEndpointKindDraft)}</span></div>
                        <div className="checklist-row"><strong>Authentication</strong><span>{connectorAuthDraft === 'entra' ? 'Microsoft Entra ID' : 'API key'}</span></div>
                        <div className="checklist-row"><strong>Effective credential scope</strong><span>{connectorResolvedScope}</span></div>
                        <div className="checklist-row"><strong>Deployment / model</strong><span>{connectorDeploymentDraft.trim() || 'Not set'}</span></div>
                        <div className="checklist-row"><strong>API version</strong><span>{connectorApiVersionDraft.trim() || 'Not set'}</span></div>
                        <div className="checklist-row"><strong>Stored API key</strong><span>{selectedConnector?.hasApiKey ? 'Present' : 'Not stored'}</span></div>
                      </div>
                      <p className="connector-hint">Use an explicit endpoint type for air-gapped or custom hosts so request shape and default token scope do not depend on hostname heuristics. Override credential scope when your environment uses a non-public audience.</p>
                      {connectorRoleHint ? <p className="connector-hint">{connectorRoleHint}</p> : null}
                    </div>
                  )}
                </div>
                <button type="button" className="primary config-save" onClick={saveConnector} disabled={busy || !connectorNameDraft.trim()}>Save Connector</button>
              </div>
            ) : configView === 'mcp' ? (
              <div className="config-panel">
                <div className="config-header-row">
                  <div>
                    <h2>{selectedMcpServer ? selectedMcpServer.name : 'New MCP Server'}</h2>
                    <p>Register a hosted MCP endpoint and make it available for agent attachment.</p>
                  </div>
                  <div className="config-header-actions">
                    {selectedMcpServer && (
                      <button type="button" className="danger" onClick={deleteSelectedMcpServer} disabled={busy}><Trash2 size={16} /> Delete</button>
                    )}
                    <button type="button" className="icon-only" onClick={closeAdminScreen} title="Close admin" aria-label="Close admin">
                      <X size={16} />
                    </button>
                  </div>
                </div>
                <div className="config-form-grid">
                  {selectedMcpServerId === 'new' && mcpCatalog.length > 0 && (
                    <label className="wide-field">
                      <span>Known server</span>
                      <select value={selectedMcpCatalogId} onChange={(event) => applyMcpCatalogEntry(event.target.value)}>
                        <option value="">Start from a blank MCP server</option>
                        {mcpCatalog.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                      </select>
                    </label>
                  )}
                  <label>
                    <span>Name</span>
                    <input value={mcpServerNameDraft} onChange={(event) => setMcpServerNameDraft(event.target.value)} placeholder="Azure MCP Server" />
                  </label>
                  <label>
                    <span>Transport</span>
                    <input value="Remote HTTP" disabled />
                  </label>
                  <label className="wide-field">
                    <span>Endpoint</span>
                    <input value={mcpServerEndpointDraft} onChange={(event) => setMcpServerEndpointDraft(event.target.value)} placeholder="https://your-mcp-host.example.com" />
                  </label>
                  <label>
                    <span>Authentication</span>
                    <select value={mcpServerAuthDraft} onChange={(event) => setMcpServerAuthDraft(event.target.value as McpServerAuthMode)}>
                      <option value="none">None</option>
                      <option value="bearer-token">Bearer token</option>
                      <option value="api-key">API key</option>
                      <option value="entra">Microsoft Entra ID</option>
                      <option value="custom-headers">Custom headers</option>
                    </select>
                  </label>
                  {mcpServerAuthDraft === 'entra' && (
                    <label>
                      <span>Audience / scope</span>
                      <input value={mcpServerAudienceDraft} onChange={(event) => setMcpServerAudienceDraft(event.target.value)} placeholder="api://resource/.default" />
                    </label>
                  )}
                  {mcpServerAuthDraft === 'bearer-token' && (
                    <label className="wide-field">
                      <span>Bearer token</span>
                      <input type="password" value={mcpServerBearerTokenDraft} onChange={(event) => setMcpServerBearerTokenDraft(event.target.value)} placeholder={selectedMcpServer?.hasBearerToken ? 'Stored token exists; enter a new value to replace it' : 'Paste bearer token'} />
                    </label>
                  )}
                  {mcpServerAuthDraft === 'api-key' && (
                    <label className="wide-field">
                      <span>API key</span>
                      <input type="password" value={mcpServerApiKeyDraft} onChange={(event) => setMcpServerApiKeyDraft(event.target.value)} placeholder={selectedMcpServer?.hasApiKey ? 'Stored key exists; enter a new value to replace it' : 'Paste API key'} />
                    </label>
                  )}
                  {mcpServerAuthDraft === 'custom-headers' && (
                    <label className="wide-field">
                      <span>Custom headers</span>
                      <textarea value={mcpServerHeadersDraft} onChange={(event) => setMcpServerHeadersDraft(event.target.value)} placeholder="x-api-key: secret-value&#10;x-tenant-id: contoso" />
                    </label>
                  )}
                </div>
                <button type="button" className="primary config-save" onClick={saveMcpServer} disabled={busy || !mcpServerNameDraft.trim() || !mcpServerEndpointDraft.trim()}>Save MCP Server</button>
              </div>
            ) : (
              <div className="config-panel">
                <div className="config-header-row">
                  <div>
                    <h2>{customAgentMode === 'create' ? 'New Custom Agent' : (selectedConfigAgent?.name ?? 'Custom Agent')}</h2>
                    <p>Create a persona, choose its model connector, and ground it on a Search connector index.</p>
                  </div>
                  <div className="config-header-actions">
                    {customAgentMode === 'edit' && selectedConfigAgent && (
                      <button type="button" className="danger" onClick={deleteSelectedAgent} disabled={busy}><Trash2 size={16} /> Delete</button>
                    )}
                    <button type="button" className="icon-only" onClick={closeAdminScreen} title="Close admin" aria-label="Close admin">
                      <X size={16} />
                    </button>
                  </div>
                </div>
                <div className="config-form-grid agent-form-grid">
                  {customAgentMode === 'create' && agentTemplates.length > 0 && (
                    <label className="wide-field">
                      <span>Template</span>
                      <select value={selectedAgentTemplateId} onChange={(event) => applyAgentTemplate(event.target.value)}>
                        <option value="">Start from a blank custom agent</option>
                        {agentTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                      </select>
                    </label>
                  )}
                  <label>
                    <span>Name</span>
                    <input value={customAgentNameDraft} onChange={(event) => setCustomAgentNameDraft(event.target.value)} placeholder="Payments Expert" />
                  </label>
                  <label className="wide-field">
                    <span>Description</span>
                    <input value={customAgentDescriptionDraft} onChange={(event) => setCustomAgentDescriptionDraft(event.target.value)} placeholder="One-line summary" />
                  </label>
                  <label>
                    <span>Model</span>
                    <select value={customAgentModelDraft} onChange={(event) => setCustomAgentModelDraft(event.target.value)}>
                      {modelConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Azure AI Search connector</span>
                    <select value={customAgentSearchConnectorDraft} onChange={(event) => setCustomAgentSearchConnectorDraft(event.target.value)} disabled={!searchEnabledDraft}>
                      <option value="">No Search connector</option>
                      {searchConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Reasoning effort</span>
                    <select value={customAgentReasoningEffortDraft} onChange={(event) => setCustomAgentReasoningEffortDraft(event.target.value as ReasoningEffort)}>
                      <option value="none">None</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="xhigh">Very high</option>
                    </select>
                    <p className="connector-hint">Controls how much reasoning this agent should use when it calls the model.</p>
                  </label>
                  <label>
                    <span>Temperature</span>
                    <input type="number" min="0" max="2" step="0.1" value={customAgentTemperatureDraft} onChange={(event) => setCustomAgentTemperatureDraft(event.target.value)} placeholder="Inherit connector default" />
                    <p className="connector-hint">Leave blank to use the connector default.</p>
                  </label>
                  <label>
                    <span>Max output tokens</span>
                    <input type="number" min="1" max="8192" step="1" value={customAgentMaxTokensDraft} onChange={(event) => setCustomAgentMaxTokensDraft(event.target.value)} placeholder="Inherit connector default" />
                    <p className="connector-hint">Leave blank to use the connector default.</p>
                  </label>
                  <label className="wide-field">
                    <span>Attached MCP servers</span>
                    <div className="config-checklist">
                      {mcpServers.length === 0 ? (
                        <span className="muted">No MCP servers configured yet.</span>
                      ) : (
                        mcpServers.map((server) => (
                          <label key={server.id} className="checklist-row">
                            <input
                              type="checkbox"
                              checked={customAgentMcpServerIdsDraft.includes(server.id)}
                              onChange={(event) => {
                                setCustomAgentMcpServerIdsDraft((current) => event.target.checked
                                  ? [...current, server.id]
                                  : current.filter((candidate) => candidate !== server.id));
                              }}
                            />
                            <span>{server.name}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </label>
                  <label className="inline-check wide-field">
                    <input type="checkbox" checked={searchEnabledDraft} onChange={(event) => setSearchEnabledDraft(event.target.checked)} />
                    <span>Ground this agent on Azure AI Search</span>
                  </label>
                  <label>
                    <span>Index</span>
                    <input value={searchIndexDraft} onChange={(event) => setSearchIndexDraft(event.target.value)} placeholder="security-approval-index" disabled={!searchEnabledDraft} />
                  </label>
                  <label>
                    <span>Semantic configuration</span>
                    <input value={searchSemanticConfigDraft} onChange={(event) => setSearchSemanticConfigDraft(event.target.value)} placeholder="default" disabled={!searchEnabledDraft} />
                  </label>
                  <label className="wide-field">
                    <span>Prompt</span>
                    <textarea className="prompt-editor" value={agentInstructionsDraft} onChange={(event) => setAgentInstructionsDraft(event.target.value)} />
                  </label>
                </div>
                <button type="button" className="primary config-save" onClick={saveCustomAgent} disabled={busy || !customAgentNameDraft.trim() || !customAgentModelDraft}>{customAgentMode === 'create' ? 'Create Custom Agent' : 'Save Custom Agent'}</button>
              </div>
            )}
          </section>
        </section>
      ) : (
      <section
        ref={workbenchGridRef}
        className={isResizingSidebarPane || isResizingChatPane ? 'workbench-grid resizing' : 'workbench-grid'}
        style={{ '--chat-pane-width': `${chatPaneWidth}px`, '--sidebar-width': `${sidebarWidth}px`, '--workbench-columns': workbenchColumns } as React.CSSProperties}
      >
        <aside className={isSidebarCollapsed ? 'sidebar panel-rail' : 'sidebar'}>
          {isSidebarCollapsed ? (
            <div className="panel-rail-content">
              <button type="button" className="icon-only sidebar-toggle-button" onClick={expandSidebar} title="Open Workspace sidebar" aria-label="Open Workspace sidebar">
                <PanelLeftOpen size={16} />
              </button>
            </div>
          ) : (
            <>
              <div className="panel-title">
                <span className="panel-title-label"><Folder size={16} /> Workspace</span>
                <button type="button" className="icon-only panel-toggle sidebar-toggle-button" onClick={toggleSidebarCollapsed} title="Close Workspace sidebar" aria-label="Close Workspace sidebar">
                  <PanelLeftClose size={16} />
                </button>
              </div>
              <label className="workspace-pane-switcher" aria-label="Select workspace">
                <span>Active workspace</span>
                <select value={activeWorkspaceId} onChange={(event) => setSelectedWorkspaceId(event.target.value)}>
                  {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                </select>
              </label>
              <div className="workspace-toolbar" aria-label="Workspace actions">
                <input
                  ref={uploadInputRef}
                  className="hidden-file-input"
                  type="file"
                  accept=".md,.markdown,.txt,.json,.yaml,.yml,.csv,text/markdown,text/plain,application/json,text/csv"
                  multiple
                  onChange={(event) => { void handleWorkspaceUpload(event); }}
                />
                <div className="workspace-create-menu" ref={workspaceCreateMenuRef}>
                  <button
                    type="button"
                    className="icon-only"
                    onClick={() => setWorkspaceCreateMenuOpen((open) => !open)}
                    disabled={busy}
                    title="Create file or folder"
                    aria-label="Create file or folder"
                    aria-haspopup="menu"
                    aria-expanded={workspaceCreateMenuOpen}
                  >
                    <Plus size={15} />
                  </button>
                  {workspaceCreateMenuOpen && (
                    <div className="workspace-create-menu-popover" role="menu" aria-label="Create workspace item">
                      <button type="button" role="menuitem" onClick={() => { void createFile(); }}>
                        <span>New file</span>
                        <strong>Write empty file</strong>
                      </button>
                      <button type="button" role="menuitem" onClick={() => { void createFolder(); }}>
                        <span>New folder</span>
                        <strong>Create directory</strong>
                      </button>
                    </div>
                  )}
                </div>
                <button type="button" className="icon-only" onClick={() => uploadInputRef.current?.click()} disabled={busy} title="Upload documents">
                  <Upload size={15} />
                </button>
                <button type="button" className="icon-only danger" onClick={deleteSelectedWorkspacePath} disabled={busy || !selectedWorkspaceNode} title="Delete selected file or folder">
                  <Trash2 size={15} />
                </button>
                <button type="button" className="icon-only" onClick={openWorkspaceSettings} disabled={busy || !activeWorkspace} title="Workspace settings">
                  <Settings size={15} />
                </button>
              </div>
              <ul className="tree">
                {tree.map((node) => <TreeNode key={node.path} node={node} selectedPath={selectedWorkspacePath ?? undefined} onSelect={openFile} />)}
              </ul>
              <div className="workspace-note">
                <ShieldCheck size={16} />
                <span>{workspaceIndex ? `${workspaceIndex.indexedFileCount}/${workspaceIndex.fileCount} files indexed` : `${files.length} files`} in {activeWorkspace?.name ?? 'the workspace'}.</span>
              </div>
              <div className="index-note">
                <strong>Workspace settings</strong>
                <span>{activeWorkspace?.templateName ?? 'No shared template attached'}</span>
              </div>
              {workspaceIndex && (
                <div className="index-note">
                  <strong>Package index</strong>
                  <span>{workspaceIndex.packageSections.length > 0 ? workspaceIndex.packageSections.join(', ') : 'manifest and text index ready'}</span>
                </div>
              )}
            </>
          )}
        </aside>

        {!isSidebarCollapsed && (
          <button
            type="button"
            className="pane-splitter"
            aria-label="Resize Workspace panel"
            aria-orientation="vertical"
            aria-valuemin={190}
            aria-valuemax={420}
            aria-valuenow={sidebarWidth}
            onPointerDown={beginResizeSidebarPane}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                resizeSidebarBy(-24);
              }

              if (event.key === 'ArrowRight') {
                event.preventDefault();
                resizeSidebarBy(24);
              }
            }}
          >
            <span className="pane-splitter-handle" aria-hidden="true" />
          </button>
        )}

        <section className="editor-pane">
          <>
              <div className="pane-toolbar">
                <span>{currentFile?.path ?? 'No file selected'}</span>
                <div className="editor-toolbar-actions">
                  {supportsPreviewMode && (
                    <div className="editor-view-menu" ref={markdownViewMenuRef}>
                      <div className="editor-view-toggle-group">
                        <button
                          type="button"
                          className="editor-view-button"
                          onClick={toggleMarkdownView}
                          title={markdownViewMode === 'preview' ? 'Switch to edit mode' : 'Switch to preview mode'}
                        >
                          {markdownViewMode === 'preview' ? 'Edit' : 'Preview'}
                        </button>
                        <button
                          type="button"
                          className="icon-only editor-view-menu-trigger"
                          onClick={() => setMarkdownViewMenuOpen((open) => !open)}
                          title={`Choose ${previewModeLabel.toLowerCase()} view`}
                          aria-haspopup="menu"
                          aria-expanded={markdownViewMenuOpen}
                        >
                          <ChevronDown size={15} />
                        </button>
                      </div>
                      {markdownViewMenuOpen && (
                        <div className="editor-view-menu-popover" role="menu" aria-label={`${previewModeLabel} view options`}>
                          <button type="button" role="menuitemradio" aria-checked={markdownViewMode === 'edit'} onClick={() => { setMarkdownViewMode('edit'); setMarkdownViewMenuOpen(false); }}>
                            <span>Edit</span>
                            {markdownViewMode === 'edit' && <strong>Current</strong>}
                          </button>
                          <button type="button" role="menuitemradio" aria-checked={markdownViewMode === 'preview'} onClick={() => { setMarkdownViewMode('preview'); setMarkdownViewMenuOpen(false); }}>
                            <span>Preview</span>
                            {markdownViewMode === 'preview' && <strong>Current</strong>}
                          </button>
                          <button type="button" role="menuitemradio" aria-checked={markdownViewMode === 'split'} onClick={() => { setMarkdownViewMode('split'); setMarkdownViewMenuOpen(false); }}>
                            <span>Split Edit / Preview</span>
                            {markdownViewMode === 'split' && <strong>Current</strong>}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  <button type="button" onClick={saveCurrentFile} disabled={!currentFile || busy} title="Save file">
                    <Save size={16} />
                    Save
                  </button>
                </div>
              </div>
              {supportsPreviewMode && markdownViewMode !== 'edit' ? (
                markdownViewMode === 'split' ? (
                  <div className="editor-content split-markdown-view">
                    <div className="editor-surface">
                      <Editor
                        height="100%"
                        language={languageForPath(currentFile?.path ?? '')}
                        value={editorValue}
                        theme={themeMode === 'dark' ? 'vs-dark' : 'vs'}
                        options={{ minimap: { enabled: false }, wordWrap: 'on', fontSize: 14, scrollBeyondLastLine: false }}
                        onChange={(value) => setEditorValue(value ?? '')}
                      />
                    </div>
                    <div className="markdown-preview-pane">
                      {isSvgFile ? (
                        <div className="svg-preview-shell">
                          {svgPreviewUrl && !svgPreviewInvalid ? (
                            <img
                              src={svgPreviewUrl}
                              alt={currentFile?.path ?? 'SVG preview'}
                              className="svg-preview-image"
                              onError={() => setSvgPreviewInvalid(true)}
                            />
                          ) : (
                            <p className="muted">{editorValue.trim() ? 'Unable to render SVG preview.' : 'Nothing to preview yet.'}</p>
                          )}
                        </div>
                      ) : (
                        <ReactMarkdown>{editorValue || 'Nothing to preview yet.'}</ReactMarkdown>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="editor-content markdown-preview-pane">
                    {isSvgFile ? (
                      <div className="svg-preview-shell">
                        {svgPreviewUrl && !svgPreviewInvalid ? (
                          <img
                            src={svgPreviewUrl}
                            alt={currentFile?.path ?? 'SVG preview'}
                            className="svg-preview-image"
                            onError={() => setSvgPreviewInvalid(true)}
                          />
                        ) : (
                          <p className="muted">{editorValue.trim() ? 'Unable to render SVG preview.' : 'Nothing to preview yet.'}</p>
                        )}
                      </div>
                    ) : (
                      <ReactMarkdown>{editorValue || 'Nothing to preview yet.'}</ReactMarkdown>
                    )}
                  </div>
                )
              ) : (
                <div className="editor-content editor-surface">
                  <Editor
                    height="100%"
                    language={languageForPath(currentFile?.path ?? '')}
                    value={editorValue}
                    theme={themeMode === 'dark' ? 'vs-dark' : 'vs'}
                    options={{ minimap: { enabled: false }, wordWrap: 'on', fontSize: 14, scrollBeyondLastLine: false }}
                    onChange={(value) => setEditorValue(value ?? '')}
                  />
                </div>
              )}
            </>
        </section>

        {!isChatPaneCollapsed && (
          <button
            type="button"
            className="pane-splitter"
            aria-label="Resize Agent Loop panel"
            aria-orientation="vertical"
            aria-valuemin={minChatPaneWidth}
            aria-valuemax={workbenchGridRef.current ? maxChatPaneWidth(workbenchGridRef.current.getBoundingClientRect().width) : chatPaneWidth}
            aria-valuenow={chatPaneWidth}
            onPointerDown={beginResizeChatPane}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                resizeChatPaneBy(24);
              }

              if (event.key === 'ArrowRight') {
                event.preventDefault();
                resizeChatPaneBy(-24);
              }
            }}
          >
            <span className="pane-splitter-handle" aria-hidden="true" />
          </button>
        )}

        <aside className={isChatPaneCollapsed ? 'chat-pane panel-rail' : 'chat-pane'}>
          {isChatPaneCollapsed ? (
            <div className="panel-rail-content">
              <button type="button" className="icon-only sidebar-toggle-button" onClick={expandChatPane} title="Open Agent Loop sidebar" aria-label="Open Agent Loop sidebar">
                <PanelRightOpen size={16} />
              </button>
            </div>
          ) : (
            <>
              <div className="panel-title">
                <span className="panel-title-label"><MessageSquare size={16} /> Agent Loop</span>
                <button type="button" className="icon-only panel-toggle sidebar-toggle-button" onClick={toggleChatPaneCollapsed} title="Close Agent Loop sidebar" aria-label="Close Agent Loop sidebar">
                  <PanelRightClose size={16} />
                </button>
              </div>
              <div className={isChatDetailsExpanded ? 'agent-config' : 'agent-config minimized'}>
                <div className="agent-config-summary">
                  <div className="agent-config-summary-line" title={[selectedWorkspaceAgent?.name ?? 'No agent selected', selectedChatSession?.title ?? 'Latest session', selectedConnection?.name ?? 'No model connection'].join(' · ')}>
                    <strong>{selectedWorkspaceAgent?.name ?? 'No agent selected'}</strong>
                    <span>{selectedChatSession?.title ?? 'Latest session'}</span>
                    <span>{selectedConnection?.name ?? 'No model connection'}</span>
                  </div>
                  <button
                    type="button"
                    className="icon-only agent-config-disclosure"
                    onClick={() => setIsChatDetailsExpanded((current) => !current)}
                    aria-expanded={isChatDetailsExpanded}
                    aria-controls="agent-loop-details"
                    title={isChatDetailsExpanded ? 'Minimize agent details' : 'Expand agent details'}
                    aria-label={isChatDetailsExpanded ? 'Minimize agent details' : 'Expand agent details'}
                  >
                    {isChatDetailsExpanded ? <PanelBottomClose size={15} /> : <PanelBottomOpen size={15} />}
                  </button>
                </div>
                {isChatDetailsExpanded && (
                  <div id="agent-loop-details" className="agent-config-details">
                    <div className="agent-config-row">
                      <label className="agent-select-field">
                        <span>Agent</span>
                        <select value={selectedWorkspaceAgent?.id ?? ''} onChange={(event) => setSelectedWorkspaceAgentId(event.target.value)}>
                          {workspaceAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                        </select>
                      </label>
                      <button type="button" className="settings-toggle compact" onClick={() => openConfigDrawer('agents')}>
                        <Database size={15} />
                        Manage
                      </button>
                    </div>
                    <div className="agent-config-row">
                      <label className="agent-select-field">
                        <span>Session</span>
                        <select value={selectedSessionId} onChange={(event) => setSelectedSessionId(event.target.value)}>
                          <option value="">Latest session</option>
                          {chatSessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
                        </select>
                      </label>
                      <button type="button" className="settings-toggle compact" onClick={createNewSession} disabled={busy}>
                        <Plus size={15} />
                        New
                      </button>
                    </div>
                    <div className={selectedConnection?.configured ? 'connection-status ready compact' : 'connection-status missing compact'}>
                      <strong>{selectedConnection?.name ?? 'No model connection'}</strong>
                      <span>{selectedConnection?.configured
                        ? `${selectedConnection.authMode === 'entra' ? 'Entra ID' : 'API key'} · ${selectedConnection.deployment}`
                        : `Needs ${selectedConnection?.missing.join(', ') || 'configuration'}`}</span>
                    </div>
                  </div>
                )}
              </div>
              <div className="messages" ref={messagesRef}>
                {messages.length === 0 && (
                  <div className="empty-state">
                    <Bot size={22} />
                    <span>Ask Junior to inspect files, draft package content, and build files directly in the workspace.</span>
                  </div>
                )}
                {messages.map((message) => (
                  <article key={message.id} className={`message ${message.role}`} data-message-id={message.id}>
                    {message.role !== 'user' && (
                      <div className="message-role-badge">
                        {message.role === 'assistant' && <Bot size={14} />}
                        <span>{message.role === 'assistant' ? 'Assistant' : message.role}</span>
                      </div>
                    )}
                    <div className="message-body">{renderPlainText(message.content)}</div>
                    {message.display && message.display.length > 0 && (
                      <div className="message-meta">
                        {message.display.map((part) => renderMessageDisplayPart(part, message.id, scrollDetailIntoView))}
                      </div>
                    )}
                  </article>
                ))}
                {liveAssistantTurn && (
                  <article key={liveAssistantTurn.id} className="message assistant live-assistant" data-message-id={liveAssistantTurn.id}>
                    <div className="message-role-badge">
                      <Bot size={14} />
                      <span>Assistant</span>
                    </div>
                    <div className="message-body">
                      {liveAssistantTurn.content.trim()
                        ? renderStreamingText(liveAssistantTurn.content)
                        : <p>Thinking through the request...</p>}
                    </div>
                    <div className="message-meta">
                      {renderLiveReasoning(liveAssistantTurn.reasoning, liveAssistantTurn.id, scrollDetailIntoView)}
                    </div>
                  </article>
                )}
                {messages.length > 0 && (
                  <div
                    className="messages-tail-spacer"
                    aria-hidden="true"
                    style={{ minHeight: chatTailSpacerHeight }}
                  />
                )}
              </div>
              <div className="prompt-box">
                <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void sendPrompt();
                  }
                }} />
                {liveAssistantTurn ? (
                  <button type="button" className="danger icon-only" onClick={stopPrompt} title="Stop response">
                    <Square size={17} />
                  </button>
                ) : (
                  <button type="button" className="primary icon-only" onClick={sendPrompt} disabled={busy || !prompt.trim()} title="Send to Junior">
                    <Send size={17} />
                  </button>
                )}
              </div>
            </>
          )}
        </aside>
      </section>
      )}

      <footer className="status-bar" aria-label="Workbench status bar">
        <span className="status-bar-item primary">{busy ? 'Working' : status}</span>
        <span className="status-bar-item">{currentFile?.path ?? 'No file selected'}</span>
        <span className="status-bar-item">{selectedWorkspaceAgent ? `Agent: ${selectedWorkspaceAgent.name}` : 'No agent selected'}</span>
        <span className="status-bar-item">{currentIdentity ? `Identity: ${currentIdentity.displayName} (${currentIdentity.roles.join(', ') || 'no roles'})` : 'Identity: loading'}</span>
        <span className="status-bar-item">{`Auth: ${authModeLabel(currentIdentity)}`}</span>
        <span className="status-bar-item">{workspaceIndex ? `${workspaceIndex.indexedFileCount}/${workspaceIndex.fileCount} indexed` : `${files.length} files`}</span>
      </footer>
    </main>
  );
}

export default App;
