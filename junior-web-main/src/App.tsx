import { useCallback, useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import {
  Bot,
  Check,
  ChevronRight,
  Database,
  FileText,
  Folder,
  Globe,
  MessageSquare,
  Plus,
  RotateCcw,
  Save,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Undo2
} from 'lucide-react';
import { workbenchApi } from './api/workbenchApi';
import type { AgentConnectionSaveRequest, AgentConnectionType, AgentDefinition, AgentGroundingSource, AgentModelConnectionStatus, AzureAiSearchGroundingSource, AzureAuthMode, AzureCloud, ChatMessage, PendingChange, PublishResult, ToolEvent, WorkspaceFile, WorkspaceIndex, WorkspaceTreeNode } from './types/workbench';
import './App.css';

const defaultPrompt = 'Draft the next security approval package updates for an Azure-hosted workload.';
const defaultCustomAgentPrompt = `You are a domain-expert assistant.

## Role
Describe what this agent specializes in.

## Domain knowledge
List the key concepts, docs, and naming conventions to prefer.

## Behavior
- Prefer grounded knowledge when available.
- Keep answers concise and cite relevant workspace or search context.
- Stage file changes for approval before publishing.`;

function linesFromList(values?: string[]): string {
  return values?.join('\n') ?? '';
}

function listFromLines(value: string): string[] | undefined {
  const items = value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function flattenFiles(nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] {
  return nodes.flatMap((node) => node.type === 'file' ? [node] : flattenFiles(node.children ?? []));
}

function languageForPath(path: string): string {
  if (path.endsWith('.md')) {
    return 'markdown';
  }
  if (path.endsWith('.json')) {
    return 'json';
  }
  return 'plaintext';
}

function TreeNode({ node, selectedPath, onSelect }: { node: WorkspaceTreeNode; selectedPath?: string; onSelect: (path: string) => void }) {
  const [open, setOpen] = useState(true);

  if (node.type === 'directory') {
    return (
      <li>
        <button className="tree-row" type="button" onClick={() => setOpen((value) => !value)} title={node.path}>
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

function DiffPreview({ change }: { change: PendingChange }) {
  return (
    <div className="diff-grid">
      <div>
        <div className="diff-label">Original</div>
        <pre>{change.originalContent || '(new file)'}</pre>
      </div>
      <div>
        <div className="diff-label">Proposed</div>
        <pre>{change.proposedContent}</pre>
      </div>
    </div>
  );
}

function App() {
  const [tree, setTree] = useState<WorkspaceTreeNode[]>([]);
  const [currentFile, setCurrentFile] = useState<WorkspaceFile | null>(null);
  const [editorValue, setEditorValue] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  const [workspaceIndex, setWorkspaceIndex] = useState<WorkspaceIndex | null>(null);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [connections, setConnections] = useState<AgentModelConnectionStatus[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>();
  const [configOpen, setConfigOpen] = useState(false);
  const [configView, setConfigView] = useState<'connectors' | 'agents'>('connectors');
  const [selectedConnectorId, setSelectedConnectorId] = useState<string>('new');
  const [connectorTypeDraft, setConnectorTypeDraft] = useState<AgentConnectionType>('azure-openai');
  const [connectorNameDraft, setConnectorNameDraft] = useState('Azure OpenAI');
  const [connectorAuthDraft, setConnectorAuthDraft] = useState<AzureAuthMode>('entra');
  const [connectorCloudDraft, setConnectorCloudDraft] = useState<AzureCloud>('public');
  const [connectorEndpointDraft, setConnectorEndpointDraft] = useState('');
  const [connectorApiKeyDraft, setConnectorApiKeyDraft] = useState('');
  const [connectorDeploymentDraft, setConnectorDeploymentDraft] = useState('');
  const [connectorApiVersionDraft, setConnectorApiVersionDraft] = useState('2025-01-01-preview');
  const [connectorIndexesDraft, setConnectorIndexesDraft] = useState('');
  const [connectorSemanticDraft, setConnectorSemanticDraft] = useState('default');
  const [connectorTopDraft, setConnectorTopDraft] = useState(5);
  const [connectorQueryTypeDraft, setConnectorQueryTypeDraft] = useState<'simple' | 'full' | 'semantic'>('semantic');
  const [customAgentMode, setCustomAgentMode] = useState<'edit' | 'create'>('edit');
  const [customAgentNameDraft, setCustomAgentNameDraft] = useState('');
  const [customAgentDescriptionDraft, setCustomAgentDescriptionDraft] = useState('');
  const [customAgentModelDraft, setCustomAgentModelDraft] = useState('');
  const [customAgentSearchConnectorDraft, setCustomAgentSearchConnectorDraft] = useState('');
  const [agentInstructionsDraft, setAgentInstructionsDraft] = useState('');
  const [searchEnabledDraft, setSearchEnabledDraft] = useState(false);
  const [searchIndexDraft, setSearchIndexDraft] = useState('');
  const [searchSemanticConfigDraft, setSearchSemanticConfigDraft] = useState('default');
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [status, setStatus] = useState('Ready');
  const [busy, setBusy] = useState(false);

  const files = useMemo(() => flattenFiles(tree), [tree]);
  const selectedChange = pendingChanges.find((change) => change.id === selectedChangeId) ?? pendingChanges[0];
  const packageMarkdown = useMemo(() => editorValue, [editorValue]);
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
  const selectedConnection = connections.find((connection) => connection.id === selectedAgent?.modelConnectionId);
  const selectedSearchSource = selectedAgent?.groundingSources.find((source): source is AzureAiSearchGroundingSource => source.type === 'azure-ai-search');
  const modelConnections = useMemo(() => connections.filter((connection) => connection.type === 'azure-openai'), [connections]);
  const searchConnections = useMemo(() => connections.filter((connection) => connection.type === 'azure-ai-search'), [connections]);
  const selectedConnector = connections.find((connection) => connection.id === selectedConnectorId);

  const refreshWorkspace = useCallback(async (selectPath?: string) => {
    const [nextTree, nextIndex] = await Promise.all([workbenchApi.getTree(), workbenchApi.refreshIndex()]);
    setTree(nextTree);
    setWorkspaceIndex(nextIndex);
    const filePath = selectPath ?? flattenFiles(nextTree)[0]?.path;

    if (filePath) {
      const file = await workbenchApi.getFile(filePath);
      setCurrentFile(file);
      setEditorValue(file.content);
    }
  }, []);

  const refreshChanges = useCallback(async () => {
    const changes = await workbenchApi.getChanges();
    setPendingChanges(changes);
    setSelectedChangeId((current) => current && changes.some((change) => change.id === current) ? current : changes[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void Promise.all([
      refreshWorkspace(),
      workbenchApi.getMessages().then(setMessages),
      workbenchApi.getAgents().then((nextAgents) => {
        setAgents(nextAgents);
        setSelectedAgentId((current) => current ?? nextAgents[0]?.id);
      }),
      workbenchApi.getAgentConnections().then(setConnections),
      refreshChanges()
    ]).catch((error) => setStatus(error.message));
  }, [refreshChanges, refreshWorkspace]);

  useEffect(() => {
    if (!selectedAgent) {
      return;
    }

    setAgentInstructionsDraft(selectedAgent.instructions);
    setCustomAgentNameDraft(selectedAgent.name);
    setCustomAgentDescriptionDraft(selectedAgent.description);
    setCustomAgentModelDraft(selectedAgent.modelConnectionId);
    setCustomAgentSearchConnectorDraft(selectedSearchSource?.connectorId ?? searchConnections[0]?.id ?? '');
    setSearchEnabledDraft(selectedSearchSource?.enabled ?? false);
    setSearchIndexDraft(selectedSearchSource?.indexName ?? '');
    setSearchSemanticConfigDraft(selectedSearchSource?.semanticConfiguration ?? 'default');
  }, [selectedAgent, selectedSearchSource, searchConnections]);

  useEffect(() => {
    if (!selectedConnector) {
      setConnectorTypeDraft('azure-openai');
      setConnectorNameDraft('Azure OpenAI');
      setConnectorAuthDraft('entra');
      setConnectorCloudDraft('public');
      setConnectorEndpointDraft('');
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
    setConnectorEndpointDraft(selectedConnector.endpoint ?? '');
    setConnectorApiKeyDraft('');
    setConnectorDeploymentDraft(selectedConnector.deployment ?? '');
    setConnectorApiVersionDraft(selectedConnector.apiVersion ?? selectedConnector.defaultApiVersion ?? '2025-01-01-preview');
    setConnectorIndexesDraft(linesFromList(selectedConnector.indexNames));
    setConnectorSemanticDraft(linesFromList(selectedConnector.semanticConfigurations) || 'default');
    setConnectorTopDraft(selectedConnector.top ?? 5);
    setConnectorQueryTypeDraft(selectedConnector.queryType ?? 'semantic');
  }, [selectedConnector]);

  async function openFile(path: string) {
    const file = await workbenchApi.getFile(path);
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
      const saved = await workbenchApi.saveFile(currentFile.path, editorValue);
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
    if (!prompt.trim()) {
      return;
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: prompt.trim(),
      createdAt: new Date().toISOString()
    };

    setMessages((current) => [...current, userMessage]);
    setPrompt('');
    setBusy(true);
    setStatus('Junior is working over the package files...');

    try {
      const response = await workbenchApi.sendAgentMessage(userMessage.content, selectedAgent?.id);
      setMessages((current) => [...current, response.message]);
      setToolEvents(response.toolEvents);
      setPendingChanges(response.pendingChanges);
      setSelectedChangeId(response.pendingChanges[0]?.id ?? null);
      setStatus('Junior staged changes for review');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Agent request failed');
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
      endpoint: connectorEndpointDraft.trim() || undefined,
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
      const saved = await workbenchApi.saveAgentConnection(request);
      const nextConnections = await workbenchApi.getAgentConnections();
      setConnections(nextConnections);
      setSelectedConnectorId(saved.id);
      setConnectorApiKeyDraft('');
      setStatus(`Saved connector ${saved.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to save connector');
    } finally {
      setBusy(false);
    }
  }

  function beginCreateAgent() {
    setCustomAgentMode('create');
    setCustomAgentNameDraft('');
    setCustomAgentDescriptionDraft('');
    setCustomAgentModelDraft(modelConnections[0]?.id ?? '');
    setCustomAgentSearchConnectorDraft(searchConnections[0]?.id ?? '');
    setAgentInstructionsDraft(defaultCustomAgentPrompt);
    setSearchEnabledDraft(false);
    setSearchIndexDraft('');
    setSearchSemanticConfigDraft('default');
  }

  async function saveCustomAgent() {
    const groundingSources = buildUpdatedGroundingSources(customAgentMode === 'edit' && selectedAgent ? selectedAgent.groundingSources : []);

    setBusy(true);
    try {
      const saved = customAgentMode === 'create'
        ? await workbenchApi.createAgent({
          name: customAgentNameDraft,
          description: customAgentDescriptionDraft,
          instructions: agentInstructionsDraft,
          modelConnectionId: customAgentModelDraft,
          groundingSources
        })
        : selectedAgent
          ? await workbenchApi.updateAgent(selectedAgent.id, {
            name: customAgentNameDraft,
            description: customAgentDescriptionDraft,
            modelConnectionId: customAgentModelDraft,
            instructions: agentInstructionsDraft,
            groundingSources
          })
          : null;

      if (!saved) {
        return;
      }

      const nextAgents = await workbenchApi.getAgents();
      setAgents(nextAgents);
      setSelectedAgentId(saved.id);
      setCustomAgentMode('edit');
      setStatus(`Saved custom agent ${saved.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to save custom agent');
    } finally {
      setBusy(false);
    }
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
      selectFields: selectedSearchSource?.selectFields ?? ['title', 'content', 'path'],
      titleField: selectedSearchSource?.titleField ?? 'title',
      contentFields: selectedSearchSource?.contentFields ?? ['content', 'chunk', 'text'],
      pathField: selectedSearchSource?.pathField ?? 'path'
    };
    const withoutSearch = sources.filter((source) => source.type !== 'azure-ai-search');
    return [...withoutSearch, nextSearchSource];
  }

  async function approveChange(id: string) {
    await workbenchApi.approveChange(id);
    await Promise.all([refreshWorkspace(currentFile?.path), refreshChanges()]);
    setStatus('Approved change');
  }

  async function undoChange(id: string) {
    await workbenchApi.undoChange(id);
    await refreshChanges();
    setStatus('Undid change');
  }

  async function approveAll() {
    await workbenchApi.approveAll();
    await Promise.all([refreshWorkspace(currentFile?.path), refreshChanges()]);
    setStatus('Approved all changes');
  }

  async function undoAll() {
    await workbenchApi.undoAll();
    await refreshChanges();
    setStatus('Undid all pending changes');
  }

  async function publishPackage() {
    setBusy(true);
    try {
      const result = await workbenchApi.publish();
      setPublishResult(result);
      setStatus('Published static package');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Publish failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="workbench-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Junior Workbench</p>
          <h1>Security approval package builder</h1>
        </div>
        <div className="topbar-actions">
          <span className="status-pill">{status}</span>
          <div className="config-menu">
            <button type="button" className="icon-only" onClick={() => setConfigOpen((open) => !open)} title="Configuration">
              <Settings size={17} />
            </button>
            {configOpen && (
              <div className="config-menu-popover">
                <button type="button" onClick={() => { setConfigView('connectors'); setConfigOpen(true); }}>Connectors</button>
                <button type="button" onClick={() => { setConfigView('agents'); setConfigOpen(true); }}>Custom Agents</button>
              </div>
            )}
          </div>
          <button type="button" className="primary" onClick={publishPackage} disabled={busy || pendingChanges.length > 0} title="Publish package">
            <Globe size={16} />
            Publish
          </button>
        </div>
      </header>

      {configOpen && (
        <section className="config-drawer">
          <div className="config-nav" aria-label="Configuration sections">
            <button type="button" className={configView === 'connectors' ? 'selected' : ''} onClick={() => setConfigView('connectors')}>Connectors</button>
            <button type="button" className={configView === 'agents' ? 'selected' : ''} onClick={() => setConfigView('agents')}>Custom Agents</button>
          </div>

          {configView === 'connectors' ? (
            <div className="config-panel">
              <div className="config-header-row">
                <div>
                  <h2>Connectors</h2>
                  <p>Configure Azure OpenAI models and Azure AI Search grounding sources.</p>
                </div>
                <button type="button" onClick={() => setSelectedConnectorId('new')}><Plus size={16} /> New Connector</button>
              </div>
              <div className="config-form-grid">
                <label>
                  <span>Existing connector</span>
                  <select value={selectedConnectorId} onChange={(event) => setSelectedConnectorId(event.target.value)}>
                    <option value="new">New connector</option>
                    {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
                  </select>
                </label>
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
              </div>
              <button type="button" className="primary config-save" onClick={saveConnector} disabled={busy || !connectorNameDraft.trim()}>Save Connector</button>
            </div>
          ) : (
            <div className="config-panel">
              <div className="config-header-row">
                <div>
                  <h2>Custom Agents</h2>
                  <p>Create a persona, choose its model connector, and ground it on a Search connector index.</p>
                </div>
                <button type="button" onClick={beginCreateAgent}><Plus size={16} /> New Agent</button>
              </div>
              <div className="config-form-grid agent-form-grid">
                <label>
                  <span>Mode</span>
                  <select value={customAgentMode} onChange={(event) => setCustomAgentMode(event.target.value as 'edit' | 'create')}>
                    <option value="edit">Edit selected agent</option>
                    <option value="create">Create new agent</option>
                  </select>
                </label>
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
              <button type="button" className="primary config-save" onClick={saveCustomAgent} disabled={busy || !customAgentNameDraft.trim() || !customAgentModelDraft}>Save Custom Agent</button>
            </div>
          )}
        </section>
      )}

      <section className="workbench-grid">
        <aside className="sidebar">
          <div className="panel-title"><Folder size={16} /> Workspace</div>
          <ul className="tree">
            {tree.map((node) => <TreeNode key={node.path} node={node} selectedPath={currentFile?.path} onSelect={openFile} />)}
          </ul>
          <div className="workspace-note">
            <ShieldCheck size={16} />
            <span>{workspaceIndex ? `${workspaceIndex.indexedFileCount}/${workspaceIndex.fileCount} files indexed` : `${files.length} files`} from local filesystem storage.</span>
          </div>
          {workspaceIndex && (
            <div className="index-note">
              <strong>Package index</strong>
              <span>{workspaceIndex.packageSections.length > 0 ? workspaceIndex.packageSections.join(', ') : 'manifest and text index ready'}</span>
            </div>
          )}
        </aside>

        <section className="editor-pane">
          <div className="pane-toolbar">
            <span>{currentFile?.path ?? 'No file selected'}</span>
            <button type="button" onClick={saveCurrentFile} disabled={!currentFile || busy} title="Save file">
              <Save size={16} />
              Save
            </button>
          </div>
          <Editor
            height="100%"
            language={languageForPath(currentFile?.path ?? '')}
            value={editorValue}
            theme="vs-dark"
            options={{ minimap: { enabled: false }, wordWrap: 'on', fontSize: 14, scrollBeyondLastLine: false }}
            onChange={(value) => setEditorValue(value ?? '')}
          />
        </section>

        <section className="preview-pane">
          <div className="panel-title"><FileText size={16} /> Markdown Preview</div>
          <div className="markdown-preview">
            <ReactMarkdown>{packageMarkdown || 'Open a markdown file to preview it.'}</ReactMarkdown>
          </div>
        </section>

        <aside className="chat-pane">
          <div className="panel-title"><MessageSquare size={16} /> Agent Loop</div>
          <div className="agent-config">
            <label>
              <span>Agent</span>
              <select value={selectedAgent?.id ?? ''} onChange={(event) => setSelectedAgentId(event.target.value)}>
                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </label>
            <button type="button" className="settings-toggle" onClick={() => { setConfigOpen(true); setConfigView('agents'); }}>
              <Database size={15} />
              Custom Agent Settings
            </button>
            <div className={selectedConnection?.configured ? 'connection-status ready' : 'connection-status missing'}>
              <strong>{selectedConnection?.name ?? 'No model connection'}</strong>
              <span>{selectedConnection?.configured
                ? `Azure OpenAI ready via ${selectedConnection.authMode === 'entra' ? 'Entra ID' : 'API key'}: ${selectedConnection.deployment}`
                : `Set ${selectedConnection?.missing.join(', ') || 'agent connection config'}`}</span>
            </div>
          </div>
          <div className="messages">
            {messages.length === 0 && (
              <div className="empty-state">
                <Bot size={22} />
                <span>Ask Junior to inspect files, draft package content, and stage changes for approval.</span>
              </div>
            )}
            {messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                <span>{message.role}</span>
                <p>{message.content}</p>
              </article>
            ))}
          </div>
          {toolEvents.length > 0 && (
            <div className="tool-events">
              {toolEvents.map((event) => (
                <div key={event.id} className="tool-event">
                  <Sparkles size={14} />
                  <span>{event.label}</span>
                </div>
              ))}
            </div>
          )}
          <div className="prompt-box">
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                void sendPrompt();
              }
            }} />
            <button type="button" className="primary icon-only" onClick={sendPrompt} disabled={busy || !prompt.trim()} title="Send to Junior">
              <Send size={17} />
            </button>
          </div>
        </aside>
      </section>

      <section className="changes-band">
        <div className="changes-header">
          <div>
            <p className="eyebrow">Pending Changes</p>
            <h2>{pendingChanges.length} staged file change{pendingChanges.length === 1 ? '' : 's'}</h2>
          </div>
          <div className="button-row">
            <button type="button" onClick={approveAll} disabled={pendingChanges.length === 0}><Check size={16} /> Approve All</button>
            <button type="button" onClick={undoAll} disabled={pendingChanges.length === 0}><RotateCcw size={16} /> Undo All</button>
          </div>
        </div>
        <div className="changes-layout">
          <div className="change-list">
            {pendingChanges.length === 0 && <p className="muted">No staged edits. Ask Junior to draft a package update.</p>}
            {pendingChanges.map((change) => (
              <button key={change.id} type="button" className={selectedChange?.id === change.id ? 'change-row selected' : 'change-row'} onClick={() => setSelectedChangeId(change.id)}>
                <strong>{change.path}</strong>
                <span>{change.summary}</span>
              </button>
            ))}
          </div>
          <div className="change-detail">
            {selectedChange ? (
              <>
                <div className="change-actions">
                  <span>{selectedChange.action.toUpperCase()} {selectedChange.path}</span>
                  <div className="button-row">
                    <button type="button" onClick={() => approveChange(selectedChange.id)}><Check size={16} /> Approve</button>
                    <button type="button" onClick={() => undoChange(selectedChange.id)}><Undo2 size={16} /> Undo</button>
                  </div>
                </div>
                <DiffPreview change={selectedChange} />
              </>
            ) : (
              <div className="empty-state">Pending diffs appear here before they touch the workspace.</div>
            )}
          </div>
        </div>
      </section>

      <section className="publish-band">
        <div>
          <p className="eyebrow">Static Package Preview</p>
          <h2>Publish flow</h2>
          <p className="muted">The first slice writes a static HTML package locally. The storage boundary is ready for Azure Static Web Apps, Blob static hosting, or App Service deployment later.</p>
        </div>
        {publishResult && (
          <a className="published-link" href={publishResult.url} target="_blank" rel="noreferrer">
            <Globe size={16} /> Open published package
          </a>
        )}
      </section>
    </main>
  );
}

export default App;
