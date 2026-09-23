import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  Code2,
  Database,
  ExternalLink,
  FileCheck2,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Globe2,
  LayoutPanelLeft,
  Link2,
  Maximize2,
  MessageSquareText,
  MoreHorizontal,
  Moon,
  PanelLeftClose,
  PanelRightClose,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  TerminalSquare,
  UserRound,
  Wrench
} from 'lucide-react';
import { aaaApi, ApiRequestError } from './api/aaaApi';
import type {
  ChatMessage,
  ChatSession,
  ChatSessionSummary,
  FileTreeNode,
  ModelConnectionStatus,
  ProjectSummary,
  ProjectTextFile,
  StorageStatus
} from './types/api';
import './App.css';

type PreviewMode = 'preview' | 'source' | 'browser';
type ArtifactTab = 'files' | PreviewMode;
type Theme = 'light' | 'dark';
const starterPrompts = [
  {
    icon: ShieldCheck,
    title: 'Build control responses',
    detail: 'Analyze AU-2 and SC-7 against available evidence'
  },
  {
    icon: Cloud,
    title: 'Retrieve cloud evidence',
    detail: 'Collect relevant configuration evidence from the connected Azure environment'
  },
  {
    icon: FileCheck2,
    title: 'Validate this package',
    detail: 'Check traceability, citations, and reviewer boundaries'
  }
];

const themeStorageKey = 'aaa-theme';

function formatRelativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Yesterday' : `${days}d ago`;
}

function flattenVisibleNodes(
  nodes: FileTreeNode[],
  expanded: Set<string>,
  depth = 0
): Array<{ node: FileTreeNode; depth: number }> {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.type === 'directory' && expanded.has(node.path)
      ? flattenVisibleNodes(node.children ?? [], expanded, depth + 1)
      : [])
  ]);
}

function findDefaultFile(nodes: FileTreeNode[]): FileTreeNode | undefined {
  const allFiles = findAllFiles(nodes);
  return allFiles.find((node) => node.name === 'validation-report.md')
    ?? allFiles.find((node) => node.name === 'README.md')
    ?? allFiles.find((node) => node.type === 'file' && node.name.endsWith('.md'))
    ?? allFiles.find((node) => node.type === 'file');
}

function findAllFiles(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.flatMap((node) => node.type === 'file' ? [node] : findAllFiles(node.children ?? []));
}

function getInitialTheme(): Theme {
  const stored = window.localStorage.getItem(themeStorageKey);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'brand-mark compact' : 'brand-mark'} aria-label="AAA">
      <svg viewBox="0 0 96 64" aria-hidden="true">
        <path className="brand-orbit" d="M10 36C10 19 25 8 47 8C68 8 82 17 83 31C84 47 69 57 47 57C25 57 10 48 10 36Z" />
        <path className="brand-swoosh" d="M68 18C81 11 91 9 93 13C96 20 84 35 70 46" />
        <path className="brand-tail" d="M15 49C7 56 5 61 11 62C17 63 25 60 31 57" />
        <path className="brand-letters" d="M20 44L28 20L36 44M23 35H33M36 44L44 20L52 44M39 35H49M52 44L60 20L68 44M55 35H65" />
      </svg>
    </div>
  );
}

function ResizeHandle({ onResize }: { onResize: (delta: number) => void }) {
  const startX = useRef(0);

  const beginResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    startX.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const resize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }

    const delta = event.clientX - startX.current;
    startX.current = event.clientX;
    onResize(delta);
  }, [onResize]);

  return (
    <div
      className="resize-handle"
      onPointerDown={beginResize}
      onPointerMove={resize}
      role="separator"
      aria-orientation="vertical"
    >
      <span />
    </div>
  );
}

function SidebarItem({
  icon: Icon,
  label,
  count,
  active = false
}: {
  icon: typeof ShieldCheck;
  label: string;
  count?: number | string;
  active?: boolean;
}) {
  return (
    <button className={`sidebar-item ${active ? 'active' : ''}`}>
      <Icon size={16} strokeWidth={1.8} />
      <span>{label}</span>
      {count !== undefined && <small>{count}</small>}
    </button>
  );
}

function App() {
  const [leftWidth, setLeftWidth] = useState(268);
  const [rightWidth, setRightWidth] = useState(390);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [artifactTab, setArtifactTab] = useState<ArtifactTab>('files');
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState('');
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<ProjectTextFile | null>(null);
  const [sessionSearch, setSessionSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingReasoning, setStreamingReasoning] = useState('');
  const [modelStatus, setModelStatus] = useState<ModelConnectionStatus | null>(null);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const messages = activeSession?.messages ?? [];
  const visibleFiles = useMemo(
    () => flattenVisibleNodes(fileTree, expandedPaths),
    [expandedPaths, fileTree]
  );
  const filteredSessions = useMemo(() => {
    const query = sessionSearch.trim().toLowerCase();
    return query ? sessions.filter((session) => session.title.toLowerCase().includes(query)) : sessions;
  }, [sessionSearch, sessions]);

  const shellStyle = useMemo(() => ({
    '--left-width': leftOpen ? `${leftWidth}px` : '0px',
    '--right-width': rightOpen ? `${rightWidth}px` : '0px'
  }) as React.CSSProperties, [leftOpen, leftWidth, rightOpen, rightWidth]);

  useEffect(() => {
    window.localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    const loadWorkspace = async () => {
      setIsLoading(true);
      setError('');
      try {
        const [response, status, storage] = await Promise.all([
          aaaApi.listProjects(),
          aaaApi.getModelStatus(),
          aaaApi.getStorageStatus()
        ]);
        if (cancelled) return;
        setProjects(response.projects);
        setActiveProjectId(response.activeProjectId);
        setModelStatus(status);
        setStorageStatus(storage);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Could not load projects.');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void loadWorkspace();
    return () => { cancelled = true; };
  }, []);

  const loadProjectData = useCallback(async (projectId: string) => {
    setIsLoading(true);
    setError('');
    try {
      const [nextSessions, nextTree] = await Promise.all([
        aaaApi.listSessions(projectId),
        aaaApi.getFileTree(projectId)
      ]);
      setSessions(nextSessions);
      setFileTree(nextTree);
      setExpandedPaths(new Set(nextTree.filter((node) => node.type === 'directory').map((node) => node.path)));

      const preferredSessionId = activeSession?.projectId === projectId ? activeSession.id : nextSessions[0]?.id;
      setActiveSession(preferredSessionId ? await aaaApi.getSession(projectId, preferredSessionId) : null);

      if (!selectedFile || activeProjectId !== projectId) {
        const defaultFile = findDefaultFile(nextTree);
        if (defaultFile?.type === 'file') {
          setSelectedFile(await aaaApi.readTextFile(projectId, defaultFile.path));
        } else {
          setSelectedFile(null);
        }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the project workspace.');
    } finally {
      setIsLoading(false);
    }
  }, [activeProjectId, activeSession?.id, activeSession?.projectId, selectedFile]);

  useEffect(() => {
    if (activeProjectId) void loadProjectData(activeProjectId);
    // Project changes intentionally trigger one complete workspace reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  const createSession = useCallback(async () => {
    if (!activeProjectId || isCreatingSession) return;
    setError('');
    setIsCreatingSession(true);
    try {
      const session = await aaaApi.createSession(activeProjectId);
      setActiveSession(session);
      setSessions((current) => [{ ...session }, ...current]);
      composerRef.current?.focus();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create a session.');
    } finally {
      setIsCreatingSession(false);
    }
  }, [activeProjectId, isCreatingSession]);

  const selectSession = useCallback(async (sessionId: string) => {
    if (!activeProjectId || sessionId === activeSession?.id) return;
    setError('');
    try {
      setActiveSession(await aaaApi.getSession(activeProjectId, sessionId));
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : 'Could not load the session.');
    }
  }, [activeProjectId, activeSession?.id]);

  const openFile = useCallback(async (node: FileTreeNode) => {
    if (!activeProjectId) return;
    if (node.type === 'directory') {
      setExpandedPaths((current) => {
        const next = new Set(current);
        if (next.has(node.path)) next.delete(node.path);
        else next.add(node.path);
        return next;
      });
      return;
    }

    setError('');
    try {
      const file = await aaaApi.readTextFile(activeProjectId, node.path);
      setSelectedFile(file);
      setArtifactTab(node.name.toLowerCase().endsWith('.md') ? 'preview' : 'source');
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : 'Could not open the file.');
    }
  }, [activeProjectId]);

  const refreshFiles = useCallback(async () => {
    if (!activeProjectId) return;
    try {
      setFileTree(await aaaApi.getFileTree(activeProjectId));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Could not refresh project files.');
    }
  }, [activeProjectId]);

  const sendMessage = useCallback(async (content = draft) => {
    const trimmed = content.trim();
    if (!trimmed || isThinking || isCreatingSession) {
      return;
    }

    setError('');
    setIsThinking(true);
    setStreamingText('');
    setStreamingReasoning('');
    let requestSessionId = activeSession?.id;
    try {
      let session = activeSession;
      if (!session) {
        if (!activeProjectId) throw new Error('Select a project before starting a session.');
        session = await aaaApi.createSession(activeProjectId);
        setActiveSession(session);
      }
      requestSessionId = session.id;
      setDraft('');
      const controller = new AbortController();
      streamAbortRef.current = controller;
      await aaaApi.streamChat(activeProjectId, session.id, { content: trimmed }, (event) => {
        if (event.type === 'assistant_text') {
          setStreamingText((current) => current + event.text);
        } else if (event.type === 'reasoning') {
          setStreamingReasoning((current) => current + event.text);
        } else if (event.type === 'completed') {
          setActiveSession((current) => current
            ? {
                ...current,
                updatedAt: event.response.message.createdAt,
                messageCount: current.messageCount + 2,
                messages: [
                  ...current.messages,
                  {
                    id: `user-${event.response.message.id}`,
                    role: 'user',
                    content: trimmed,
                    createdAt: event.response.message.createdAt
                  },
                  event.response.message
                ]
              }
            : current);
        } else if (event.type === 'error') {
          throw new Error(event.message);
        }
      }, controller.signal);
      setActiveSession(await aaaApi.getSession(activeProjectId, session.id));
      setSessions(await aaaApi.listSessions(activeProjectId));
    } catch (sendError) {
      if (activeProjectId && requestSessionId) {
        try {
          setActiveSession(await aaaApi.getSession(activeProjectId, requestSessionId));
          setSessions(await aaaApi.listSessions(activeProjectId));
        } catch {
          // Preserve the original model or transport error.
        }
      }
      if (sendError instanceof DOMException && sendError.name === 'AbortError') {
        setError('Response stopped.');
        return;
      }
      const message = sendError instanceof ApiRequestError || sendError instanceof Error
        ? sendError.message
        : 'Could not save the message.';
      setError(message);
    } finally {
      streamAbortRef.current = null;
      setStreamingText('');
      setStreamingReasoning('');
      setIsThinking(false);
    }
  }, [activeProjectId, activeSession, draft, isCreatingSession, isThinking]);

  const stopResponse = useCallback(() => {
    streamAbortRef.current?.abort();
  }, []);

  return (
    <div className={`app-shell theme-${theme}`} style={shellStyle}>
      <header className="topbar">
        <div className="topbar-brand">
          <BrandMark />
          <div>
            <strong>AAA</strong>
            <span>A&amp;A Accelerator</span>
          </div>
        </div>

        <button className="project-switcher" title={activeProject?.description}>
          <span className="project-icon">{activeProject?.name.slice(0, 2).toUpperCase() ?? 'AA'}</span>
          <span>{activeProject?.name ?? (isLoading ? 'Loading project…' : 'No project')}</span>
          <ChevronDown size={14} />
        </button>

        <div className="topbar-actions">
          <div className="environment-pill"><span /> Local workspace</div>
          <button
            className="icon-button"
            onClick={() => setTheme((current) => current === 'light' ? 'dark' : 'light')}
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          >
            {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          <button className="icon-button" aria-label="Help"><CircleHelp size={18} /></button>
          <button className="avatar" aria-label="User profile">JD</button>
        </div>
      </header>

      <main className="workbench">
        {leftOpen && (
          <aside className="sidebar">
            <div className="sidebar-heading">
              <span>Sessions</span>
              <button className="icon-button small" aria-label="Create session" disabled={isCreatingSession} onClick={() => void createSession()}><Plus size={16} /></button>
            </div>

            <label className="search-box">
              <Search size={15} />
              <input
                aria-label="Search sessions"
                placeholder="Search sessions"
                value={sessionSearch}
                onChange={(event) => setSessionSearch(event.target.value)}
              />
              <kbd>⌘ K</kbd>
            </label>

            <div className="project-list">
              {filteredSessions.map((session) => (
              <button
                className={`project-row ${session.id === activeSession?.id ? 'active' : ''}`}
                key={session.id}
                onClick={() => void selectSession(session.id)}
              >
                <span className={`session-icon ${session.id === activeSession?.id ? 'active' : ''}`}><MessageSquareText size={14} /></span>
                <span>
                  <strong>{session.title}</strong>
                  <small>{formatRelativeTime(session.updatedAt)} · {session.messageCount} messages</small>
                </span>
                {session.id === activeSession?.id && <MoreHorizontal size={16} />}
              </button>
              ))}
              {!isLoading && filteredSessions.length === 0 && (
                <div className="empty-sidebar">No sessions yet. Start a new conversation.</div>
              )}
            </div>

            <div className="sidebar-section customizations">
              <div className="sidebar-label">Capabilities</div>
              <SidebarItem icon={Bot} label="Agents" count={1} />
              <SidebarItem icon={Sparkles} label="Skills" count={4} />
              <SidebarItem icon={Server} label="MCP servers" count={1} />
              <SidebarItem icon={Wrench} label="Tools" count={6} />
            </div>

            <div className="connection-card">
              <div className="connection-icon"><Database size={16} /></div>
              <div>
                <strong>{storageStatus?.sessions.backend === 'cosmos' ? 'Cosmos sessions' : 'Local sessions'}</strong>
                <span>
                  {storageStatus?.sessions.ready
                    ? storageStatus.sessions.endpointHost ?? 'Air-gap ready'
                    : 'Storage setup needed'}
                </span>
              </div>
              <span className={storageStatus?.sessions.ready ? 'status-dot' : 'offline-dot'} />
            </div>

            <button className="sidebar-settings"><Settings2 size={16} /> Workspace settings</button>
          </aside>
        )}

        {leftOpen && <ResizeHandle onResize={(delta) => setLeftWidth((width) => Math.min(380, Math.max(220, width + delta)))} />}

        <section className="chat-panel">
          <div className="panel-header chat-header">
            <div>
              <button className="icon-button panel-toggle" onClick={() => setLeftOpen((open) => !open)} aria-label="Toggle projects panel">
                {leftOpen ? <PanelLeftClose size={18} /> : <LayoutPanelLeft size={18} />}
              </button>
              <span className="agent-avatar"><ShieldCheck size={17} /></span>
              <span>
                <strong>Security Package Builder</strong>
                <small>
                  <span className={modelStatus?.ready ? 'online-dot' : 'offline-dot'} />
                  {modelStatus?.ready ? `${modelStatus.name} ready` : 'Model setup needed'}
                </small>
              </span>
            </div>
            <div>
              <button className="secondary-button" disabled={isCreatingSession} onClick={() => void createSession()}><Plus size={15} /> New session</button>
              <button className="icon-button" aria-label="Session options"><MoreHorizontal size={18} /></button>
            </div>
          </div>

          {error && <div className="app-error" role="alert">{error}</div>}
          <div className={`chat-content ${messages.length ? 'has-messages' : ''}`}>
            {messages.length === 0 ? (
              <div className="welcome">
                <div className="welcome-mark"><BrandMark compact /></div>
                <p className="eyebrow">Evidence-driven authorization</p>
                <h1>What are we assessing today?</h1>
                <p className="welcome-copy">
                  Turn local standards, cloud evidence, and system documentation into
                  traceable authorization package drafts.
                </p>
                <div className="starter-grid">
                  {starterPrompts.map(({ icon: Icon, title, detail }) => (
                    <button key={title} onClick={() => sendMessage(detail)}>
                      <span><Icon size={18} /></span>
                      <strong>{title}</strong>
                      <small>{detail}</small>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="message-list">
                {messages.filter((message) => message.role !== 'system').map((message: ChatMessage) => (
                  <article className={`message ${message.role}`} key={message.id}>
                    <div className="message-avatar">
                      {message.role === 'assistant' ? <BrandMark compact /> : <UserRound size={17} />}
                    </div>
                    <div>
                      <strong>{message.role === 'assistant' ? 'AAA' : 'You'}</strong>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                    </div>
                  </article>
                ))}
                {isThinking && (
                  <article className="message assistant">
                    <div className="message-avatar"><BrandMark compact /></div>
                    <div>
                      <strong>AAA</strong>
                      {streamingReasoning && <div className="stream-reasoning">{streamingReasoning}</div>}
                      {streamingText
                        ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
                        : <div className="thinking"><i /><i /><i /></div>}
                    </div>
                  </article>
                )}
              </div>
            )}
          </div>

          <div className="composer-wrap">
            <div className="composer">
              <textarea
                ref={composerRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="Ask AAA to build, assess, or validate..."
                rows={1}
              />
              <div className="composer-toolbar">
                <div>
                  <button className="tool-button"><Plus size={17} /></button>
                  <button className="tool-button"><Paperclip size={16} /> Add evidence</button>
                  <button className="tool-button"><Code2 size={16} /> Skills</button>
                </div>
                <button
                  className={`send-button ${isThinking ? 'stop' : ''}`}
                  onClick={() => isThinking ? stopResponse() : void sendMessage()}
                  disabled={isCreatingSession || (!isThinking && !draft.trim())}
                  aria-label={isThinking ? 'Stop response' : 'Send message'}
                >
                  {isThinking ? <Square size={13} fill="currentColor" /> : <Send size={16} />}
                </button>
              </div>
            </div>
            <div className="composer-meta">
              <button><Bot size={13} /> Security Package Builder <ChevronDown size={12} /></button>
              <span title={modelStatus?.missing.join(', ')}>
                {modelStatus?.ready
                  ? `${modelStatus.deployment ?? modelStatus.name} · Grounded in this workspace`
                  : `Model unavailable${modelStatus?.missing.length ? ` · Missing ${modelStatus.missing.join(', ')}` : ''}`}
              </span>
            </div>
          </div>
        </section>

        {rightOpen && <ResizeHandle onResize={(delta) => setRightWidth((width) => Math.min(window.innerWidth / 2, Math.max(300, width - delta)))} />}

        {rightOpen && (
          <aside className="artifact-panel">
            <div className="panel-header artifact-header">
              <div>
                <button className="icon-button panel-toggle" onClick={() => setRightOpen(false)} aria-label="Close artifact panel">
                  <PanelRightClose size={18} />
                </button>
                <strong>Artifacts</strong>
              </div>
              <div>
                <button className="icon-button" aria-label="Open externally"><ExternalLink size={17} /></button>
                <button className="icon-button" aria-label="Maximize preview"><Maximize2 size={17} /></button>
              </div>
            </div>

            <div className="artifact-tabs">
              <button className={artifactTab === 'files' ? 'active' : ''} onClick={() => setArtifactTab('files')}><FolderOpen size={15} /> Files</button>
              <button className={artifactTab === 'preview' ? 'active' : ''} onClick={() => setArtifactTab('preview')}><FileText size={15} /> Preview</button>
              <button className={artifactTab === 'source' ? 'active' : ''} onClick={() => setArtifactTab('source')}><Code2 size={15} /> Source</button>
              <button className={artifactTab === 'browser' ? 'active icon-only' : 'icon-only'} onClick={() => setArtifactTab('browser')} aria-label="Web preview"><Globe2 size={15} /></button>
            </div>

            {artifactTab === 'files' && <div className="file-tree">
              <div className="tree-title">
                <span>PACKAGE FILES</span>
                <button className="icon-button small" onClick={() => void refreshFiles()} aria-label="Refresh files"><RefreshCw size={14} /></button>
              </div>
              {visibleFiles.map(({ node, depth }) => {
                const isExpanded = node.type === 'directory' && expandedPaths.has(node.path);
                const isJson = node.name.toLowerCase().endsWith('.json');
                const Icon = node.type === 'directory'
                  ? (isExpanded ? FolderOpen : Folder)
                  : isJson ? FileJson : FileText;
                const isSelected = selectedFile?.path === node.path;
                return (
                  <button
                    className={`file-row ${isSelected ? 'selected' : ''}`}
                    key={node.path}
                    style={{ paddingLeft: `${12 + depth * 16}px` }}
                    onClick={() => void openFile(node)}
                  >
                    {node.type === 'directory'
                      ? (isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />)
                      : <span className="tree-spacer" />}
                    <Icon size={15} />
                    <span>{node.name}</span>
                    {node.name === 'validation-report.md' && <Check size={13} className="file-check" />}
                  </button>
                );
              })}
              {!isLoading && visibleFiles.length === 0 && <div className="empty-sidebar">No project files found.</div>}
            </div>}

            {artifactTab !== 'files' && <div className="preview-pane">
              <div className="preview-toolbar">
                <div className="preview-file-title">
                  <FileText size={15} />
                  <span>{selectedFile?.path ?? 'Select a file'}</span>
                </div>
                <button className="icon-button small" onClick={() => setArtifactTab('files')} aria-label="Back to files"><FolderOpen size={15} /></button>
              </div>
              <div className="preview-content">
                {artifactTab === 'preview' && (
                  <div className="markdown-preview">
                    {selectedFile
                      ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedFile.content}</ReactMarkdown>
                      : <p>Select a Markdown file from Files to preview it.</p>}
                  </div>
                )}
                {artifactTab === 'source' && (
                  <pre className="source-preview"><code>{selectedFile?.content ?? 'Select a text file from Files to view its source.'}</code></pre>
                )}
                {artifactTab === 'browser' && (
                  <div className="browser-preview">
                    <div className="browser-bar">
                      <span /><span /><span />
                      <div><ShieldCheck size={13} /> aaa.local/{selectedFile?.path ?? 'preview'}</div>
                    </div>
                    <div className="published-page">
                      <div className="published-brand"><BrandMark compact /> AAA Published</div>
                      <p className="eyebrow">Local project preview</p>
                      <h2>{selectedFile?.path.split('/').at(-1) ?? 'Select a document'}</h2>
                      <div className="published-status"><Check size={16} /> Local draft</div>
                      <p>This browser-style view is served entirely from the selected local A&amp;A project.</p>
                    </div>
                  </div>
                )}
              </div>
            </div>}
          </aside>
        )}

        {!rightOpen && (
          <button className="reopen-right" onClick={() => setRightOpen(true)}><FileCode2 size={17} /> Artifacts</button>
        )}
      </main>

      <footer className="statusbar">
        <div><span className="classification-dot" /> CONTROLLED · LOCAL DEMO</div>
        <div>
          <span title={storageStatus?.sessions.endpointHost}><Database size={12} /> {storageStatus?.sessions.backend ?? '…'} sessions</span>
          <span title={modelStatus?.endpointHost}><Link2 size={12} /> {modelStatus?.ready ? modelStatus.deployment : 'Model unavailable'}</span>
          <span><TerminalSquare size={12} /> {isThinking ? 'Model running' : 'No active runs'}</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
