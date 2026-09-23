import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bot,
  BookOpen,
  Braces,
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
  FilePlus2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Globe2,
  Home,
  LayoutPanelLeft,
  Link2,
  Lightbulb,
  Maximize2,
  MessageSquareText,
  MoreHorizontal,
  Moon,
  PanelLeftClose,
  PanelRightClose,
  Paperclip,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  Save,
  Sparkles,
  Square,
  Sun,
  TerminalSquare,
  Trash2,
  UserRound,
  Wrench,
  X,
  Zap
} from 'lucide-react';
import { aaaApi, ApiRequestError } from './api/aaaApi';
import type {
  ChatMessage,
  ChatMessageDisplayPart,
  ChatSession,
  ChatSessionSummary,
  CustomizationEditor,
  CustomizationItem,
  EditableCustomizationKind,
  FileTreeNode,
  ModelConnectionStatus,
  ProjectSummary,
  ProjectTextFile,
  StorageStatus,
  ToolEvent
} from './types/api';
import './App.css';

type PreviewMode = 'preview' | 'source' | 'browser';
type ArtifactTab = 'files' | PreviewMode;
type Theme = 'light' | 'dark';
type CustomizationSection = 'overview' | CustomizationItem['kind'];
type FileDialogState =
  | { kind: 'create'; value: string }
  | { kind: 'rename'; value: string }
  | { kind: 'delete'; value: string };
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
  active = false,
  onClick
}: {
  icon: typeof ShieldCheck;
  label: string;
  count?: number | string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button className={`sidebar-item ${active ? 'active' : ''}`} onClick={onClick}>
      <Icon size={16} strokeWidth={1.8} />
      <span>{label}</span>
      {count !== undefined && <small>{count}</small>}
    </button>
  );
}

function MessageDetails({
  parts,
  live = false
}: {
  parts: ChatMessageDisplayPart[];
  live?: boolean;
}) {
  return (
    <div className="message-details">
      {parts.map((part, index) => part.kind === 'reasoning'
        ? (
          <details className="message-detail reasoning-detail" open={live} key={`reasoning-${index}`}>
            <summary>
              <Sparkles size={12} />
              <span>Reasoning</span>
              {live && <small>Live</small>}
              <ChevronDown size={12} className="detail-chevron" />
            </summary>
            <div className="detail-panel">
              <div className="detail-header"><Sparkles size={13} /><strong>{live ? 'Live reasoning' : 'Reasoning'}</strong></div>
              <div className="reasoning-body">
                {part.text.trim() || 'Waiting for reasoning from the model…'}
              </div>
            </div>
          </details>
        )
        : (
          <details className="message-detail working-detail" key={`working-${index}`}>
            <summary>
              <Wrench size={12} />
              <span>Steps</span>
              <small>{part.events.length}</small>
              <ChevronDown size={12} className="detail-chevron" />
            </summary>
            <div className="detail-panel">
              <div className="detail-header">
                <Wrench size={13} />
                <strong>{part.title}</strong>
                <small>{part.events.length} step{part.events.length === 1 ? '' : 's'}</small>
              </div>
              <div className="working-events">
                {part.events.map((event) => (
                  <div className="working-event" key={event.id}>
                    {event.type === 'read' || event.type === 'search'
                      ? <Search size={13} />
                      : <FileCheck2 size={13} />}
                    <div>
                      <span>{event.label}</span>
                      {event.detail && <small>{event.detail}</small>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </details>
        ))}
    </div>
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
  const [editorContent, setEditorContent] = useState('');
  const [isSavingFile, setIsSavingFile] = useState(false);
  const [fileDialog, setFileDialog] = useState<FileDialogState | null>(null);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [projectDraft, setProjectDraft] = useState({ name: '', systemName: '', description: '' });
  const [customizationsOpen, setCustomizationsOpen] = useState(false);
  const [customizationSection, setCustomizationSection] = useState<CustomizationSection>('overview');
  const [customizationItems, setCustomizationItems] = useState<CustomizationItem[]>([]);
  const [customizationSearch, setCustomizationSearch] = useState('');
  const [customizationDraft, setCustomizationDraft] = useState<CustomizationEditor | null>(null);
  const [customizationEditorOpen, setCustomizationEditorOpen] = useState(false);
  const [customizationEditorError, setCustomizationEditorError] = useState('');
  const [isSavingCustomization, setIsSavingCustomization] = useState(false);
  const [sessionSearch, setSessionSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingReasoning, setStreamingReasoning] = useState('');
  const [streamingToolEvents, setStreamingToolEvents] = useState<ToolEvent[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelConnectionStatus | null>(null);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const sessionSearchRef = useRef<HTMLInputElement>(null);
  const chatContentRef = useRef<HTMLDivElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const pendingFileActionRef = useRef<(() => void) | null>(null);
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const messages = activeSession?.messages ?? [];
  const lastRun = activeSession?.runs.at(-1);
  const isMarkdownSelected = selectedFile?.path.toLowerCase().endsWith('.md') ?? false;
  const isFileDirty = selectedFile !== null && editorContent !== selectedFile.content;
  const publishedUrl = activeProjectId && selectedFile && isMarkdownSelected
    ? aaaApi.publishedMarkdownUrl(activeProjectId, selectedFile.path)
    : '';
  const visibleFiles = useMemo(
    () => flattenVisibleNodes(fileTree, expandedPaths),
    [expandedPaths, fileTree]
  );
  const filteredSessions = useMemo(() => {
    const query = sessionSearch.trim().toLowerCase();
    return query ? sessions.filter((session) => session.title.toLowerCase().includes(query)) : sessions;
  }, [sessionSearch, sessions]);
  const filteredCustomizations = useMemo(() => {
    const query = customizationSearch.trim().toLowerCase();
    return customizationItems.filter((item) =>
      (customizationSection === 'overview' || item.kind === customizationSection)
      && (!query || `${item.name} ${item.description} ${item.detail ?? ''}`.toLowerCase().includes(query))
    );
  }, [customizationItems, customizationSearch, customizationSection]);
  const customizationCount = useCallback(
    (kind: CustomizationItem['kind']) => customizationItems.filter((item) => item.kind === kind).length,
    [customizationItems]
  );

  const shellStyle = useMemo(() => ({
    '--left-width': leftOpen ? `${leftWidth}px` : '0px',
    '--right-width': rightOpen ? `${rightWidth}px` : '0px'
  }) as React.CSSProperties, [leftOpen, leftWidth, rightOpen, rightWidth]);

  const refreshCustomizations = useCallback(async () => {
    if (!activeProjectId) return;
    const response = await aaaApi.getCustomizations(activeProjectId);
    setCustomizationItems(response.items);
  }, [activeProjectId]);

  useEffect(() => {
    window.localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  useEffect(() => {
    setEditorContent(selectedFile?.content ?? '');
  }, [selectedFile?.content, selectedFile?.path]);

  useEffect(() => {
    const warnOnUnsavedFile = (event: BeforeUnloadEvent) => {
      if (isFileDirty) {
        event.preventDefault();
      }
    };
    window.addEventListener('beforeunload', warnOnUnsavedFile);
    return () => window.removeEventListener('beforeunload', warnOnUnsavedFile);
  }, [isFileDirty]);

  const scrollChatToEnd = useCallback((behavior: ScrollBehavior = 'smooth') => {
    window.requestAnimationFrame(() => {
      const chat = chatContentRef.current;
      if (chat) {
        chat.scrollTo({ top: chat.scrollHeight, behavior });
      }
    });
  }, []);

  useEffect(() => {
    if (!activeProjectId) return;
    let cancelled = false;
    aaaApi.getCustomizations(activeProjectId)
      .then((response) => {
        if (!cancelled) setCustomizationItems(response.items);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Could not load customizations.');
      });
    return () => { cancelled = true; };
  }, [activeProjectId]);

  useEffect(() => {
    scrollChatToEnd(isThinking ? 'auto' : 'smooth');
  }, [
    activeSession?.id,
    isThinking,
    messages.length,
    scrollChatToEnd,
    streamingReasoning,
    streamingText,
    streamingToolEvents.length
  ]);

  useEffect(() => {
    const chat = chatContentRef.current;
    if (!chat) return;
    const observer = new ResizeObserver(() => scrollChatToEnd('auto'));
    if (chat.firstElementChild) {
      observer.observe(chat.firstElementChild);
    }
    return () => observer.disconnect();
  }, [activeSession?.id, messages.length, scrollChatToEnd]);

  useEffect(() => {
    const focusSessionSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        sessionSearchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', focusSessionSearch);
    return () => window.removeEventListener('keydown', focusSessionSearch);
  }, []);

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

  const selectProject = useCallback(async (projectId: string) => {
    if (projectId === activeProjectId) {
      setProjectMenuOpen(false);
      return;
    }
    if (isFileDirty) {
      setError('Save or discard the current file changes before switching projects.');
      return;
    }
    setError('');
    try {
      await aaaApi.selectProject(projectId);
      setActiveSession(null);
      setSelectedFile(null);
      setFileTree([]);
      setSessions([]);
      setActiveProjectId(projectId);
      setProjects((current) => current.map((project) => ({ ...project, active: project.id === projectId })));
      setProjectMenuOpen(false);
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : 'Could not switch projects.');
    }
  }, [activeProjectId, isFileDirty]);

  const createProject = useCallback(async () => {
    if (!projectDraft.name.trim()) return;
    setError('');
    try {
      const project = await aaaApi.createProject({
        name: projectDraft.name,
        systemName: projectDraft.systemName,
        description: projectDraft.description
      });
      const response = await aaaApi.listProjects();
      setProjects(response.projects);
      setActiveSession(null);
      setSelectedFile(null);
      setFileTree([]);
      setSessions([]);
      setActiveProjectId(project.id);
      setProjectDraft({ name: '', systemName: '', description: '' });
      setShowCreateProject(false);
      setProjectMenuOpen(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create the project.');
    }
  }, [projectDraft]);

  const openCustomizations = useCallback((section: CustomizationSection = 'overview') => {
    setCustomizationSection(section);
    setCustomizationSearch('');
    setCustomizationsOpen(true);
  }, []);

  const openCustomizationEditor = useCallback(async (item?: CustomizationItem) => {
    if (!activeProjectId) return;
    setCustomizationEditorError('');
    setCustomizationEditorOpen(true);
    if (!item) {
      const kind = customizationSection as EditableCustomizationKind;
      if (!['agent', 'skill', 'mcp-server'].includes(kind)) {
        setCustomizationEditorOpen(false);
        return;
      }
      setCustomizationDraft({
        kind,
        name: '',
        description: '',
        enabled: true,
        ...(kind === 'mcp-server'
          ? { transport: 'http', url: '' }
          : { instructions: '', argumentHint: '', ...(kind === 'agent' ? { tools: '' } : {}) })
      });
      return;
    }
    setCustomizationDraft(null);
    try {
      setCustomizationDraft(await aaaApi.getCustomization(activeProjectId, item.id));
    } catch (loadError) {
      setCustomizationEditorError(loadError instanceof Error
        ? loadError.message
        : 'Could not load this capability.');
    }
  }, [activeProjectId, customizationSection]);

  const saveCustomization = useCallback(async () => {
    if (!activeProjectId || !customizationDraft || isSavingCustomization) return;
    setCustomizationEditorError('');
    setIsSavingCustomization(true);
    try {
      const request = {
        kind: customizationDraft.kind,
        name: customizationDraft.name,
        description: customizationDraft.description,
        enabled: customizationDraft.enabled,
        instructions: customizationDraft.instructions,
        argumentHint: customizationDraft.argumentHint,
        tools: customizationDraft.tools,
        transport: customizationDraft.transport,
        url: customizationDraft.url,
        command: customizationDraft.command,
        args: customizationDraft.args
      };
      if (customizationDraft.id) {
        await aaaApi.updateCustomization(activeProjectId, customizationDraft.id, request);
      } else {
        await aaaApi.createCustomization(activeProjectId, request);
      }
      await Promise.all([refreshCustomizations(), loadProjectData(activeProjectId)]);
      setCustomizationEditorOpen(false);
      setCustomizationDraft(null);
    } catch (saveError) {
      setCustomizationEditorError(saveError instanceof Error
        ? saveError.message
        : 'Could not save this capability.');
    } finally {
      setIsSavingCustomization(false);
    }
  }, [
    activeProjectId,
    customizationDraft,
    isSavingCustomization,
    loadProjectData,
    refreshCustomizations
  ]);

  const toggleCustomization = useCallback(async (item: CustomizationItem) => {
    if (!activeProjectId) return;
    setCustomizationEditorError('');
    try {
      const updated = await aaaApi.setCustomizationEnabled(activeProjectId, item.id, {
        enabled: !item.enabled
      });
      setCustomizationItems((current) => current.map((candidate) =>
        candidate.id === item.id ? updated : candidate));
    } catch (toggleError) {
      setCustomizationEditorError(toggleError instanceof Error
        ? toggleError.message
        : 'Could not update this capability.');
    }
  }, [activeProjectId]);

  const selectSession = useCallback(async (sessionId: string) => {
    if (!activeProjectId || sessionId === activeSession?.id) return;
    setError('');
    try {
      setActiveSession(await aaaApi.getSession(activeProjectId, sessionId));
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : 'Could not load the session.');
    }
  }, [activeProjectId, activeSession?.id]);

  const requestFileAction = useCallback((action: () => void) => {
    if (!isFileDirty) {
      action();
      return;
    }
    pendingFileActionRef.current = action;
    setShowDiscardDialog(true);
  }, [isFileDirty]);

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

    const loadFile = async () => {
      setError('');
      try {
        const file = await aaaApi.readTextFile(activeProjectId, node.path);
        setSelectedFile(file);
        setArtifactTab(node.name.toLowerCase().endsWith('.md') ? 'preview' : 'source');
      } catch (fileError) {
        setError(fileError instanceof Error ? fileError.message : 'Could not open the file.');
      }
    };
    if (selectedFile?.path === node.path) {
      setArtifactTab(node.name.toLowerCase().endsWith('.md') ? 'preview' : 'source');
      return;
    }
    requestFileAction(() => void loadFile());
  }, [activeProjectId, requestFileAction, selectedFile?.path]);

  const refreshFiles = useCallback(async () => {
    if (!activeProjectId) return;
    try {
      setFileTree(await aaaApi.getFileTree(activeProjectId));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Could not refresh project files.');
    }
  }, [activeProjectId]);

  const saveSelectedFile = useCallback(async () => {
    if (!activeProjectId || !selectedFile || !isFileDirty || isSavingFile) return;
    setError('');
    setIsSavingFile(true);
    try {
      const saved = await aaaApi.writeTextFile(activeProjectId, {
        path: selectedFile.path,
        content: editorContent,
        updatedAt: selectedFile.updatedAt
      });
      setSelectedFile(saved);
      setEditorContent(saved.content);
      await refreshFiles();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the file.');
    } finally {
      setIsSavingFile(false);
    }
  }, [activeProjectId, editorContent, isFileDirty, isSavingFile, refreshFiles, selectedFile]);

  const createFile = useCallback(() => {
    if (!activeProjectId) return;
    requestFileAction(() => setFileDialog({ kind: 'create', value: 'new-document.md' }));
  }, [activeProjectId, requestFileAction]);

  const renameSelectedFile = useCallback(() => {
    if (!activeProjectId || !selectedFile) return;
    requestFileAction(() => setFileDialog({ kind: 'rename', value: selectedFile.path }));
  }, [activeProjectId, requestFileAction, selectedFile]);

  const deleteSelectedFile = useCallback(() => {
    if (!activeProjectId || !selectedFile) return;
    setFileDialog({ kind: 'delete', value: selectedFile.path });
  }, [activeProjectId, selectedFile]);

  const submitFileDialog = useCallback(async () => {
    if (!activeProjectId || !fileDialog) return;
    const path = fileDialog.value.trim();
    if (!path) return;
    setError('');
    try {
      if (fileDialog.kind === 'create') {
        const created = await aaaApi.createTextFile(activeProjectId, { path, content: '' });
        setSelectedFile(created);
        setArtifactTab('source');
      } else if (fileDialog.kind === 'rename' && selectedFile && path !== selectedFile.path) {
        await aaaApi.renamePath(activeProjectId, { path: selectedFile.path, newPath: path });
        setSelectedFile(await aaaApi.readTextFile(activeProjectId, path));
      } else if (fileDialog.kind === 'delete' && selectedFile) {
        await aaaApi.deletePath(activeProjectId, selectedFile.path);
        setSelectedFile(null);
        setEditorContent('');
        setArtifactTab('files');
      }
      await refreshFiles();
      setFileDialog(null);
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : 'Could not update the file.');
    }
  }, [activeProjectId, fileDialog, refreshFiles, selectedFile]);

  const discardAndContinue = useCallback(() => {
    setEditorContent(selectedFile?.content ?? '');
    setShowDiscardDialog(false);
    const action = pendingFileActionRef.current;
    pendingFileActionRef.current = null;
    action?.();
  }, [selectedFile?.content]);

  const sendMessage = useCallback(async (content = draft) => {
    const trimmed = content.trim();
    if (!trimmed || isThinking || isCreatingSession) {
      return;
    }

    setError('');
    setIsThinking(true);
    setStreamingText('');
    setStreamingReasoning('');
    setStreamingToolEvents([]);
    scrollChatToEnd('auto');
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
        } else if (event.type === 'tool_event') {
          setStreamingToolEvents((current) => [...current, event.event]);
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
      await refreshFiles();
      if (selectedFile && !isFileDirty) {
        setSelectedFile(await aaaApi.readTextFile(activeProjectId, selectedFile.path));
      }
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
      setStreamingToolEvents([]);
      setIsThinking(false);
    }
  }, [activeProjectId, activeSession, draft, isCreatingSession, isFileDirty, isThinking, refreshFiles, scrollChatToEnd, selectedFile]);

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

        <div className="project-switcher-wrap">
          <button
            className="project-switcher"
            title={activeProject?.description}
            aria-expanded={projectMenuOpen}
            onClick={() => setProjectMenuOpen((open) => !open)}
          >
            <span className="project-icon">{activeProject?.name.slice(0, 2).toUpperCase() ?? 'AA'}</span>
            <span>{activeProject?.name ?? (isLoading ? 'Loading project…' : 'No project')}</span>
            <ChevronDown size={14} />
          </button>
          {projectMenuOpen && (
            <div className="project-menu" role="menu">
              <div>
                <strong>Projects</strong>
                <small>Select an authorization package</small>
              </div>
              {projects.map((project) => (
                <button
                  role="menuitem"
                  className={project.id === activeProjectId ? 'active' : ''}
                  key={project.id}
                  onClick={() => void selectProject(project.id)}
                >
                  <span className="project-icon">{project.name.slice(0, 2).toUpperCase()}</span>
                  <span><strong>{project.name}</strong><small>{project.description}</small></span>
                  {project.id === activeProjectId && <Check size={15} />}
                </button>
              ))}
              <button className="project-menu-create" onClick={() => setShowCreateProject(true)}>
                <Plus size={15} /> Create project
              </button>
            </div>
          )}
        </div>

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
                ref={sessionSearchRef}
                aria-label="Search sessions"
                placeholder="Search sessions"
                value={sessionSearch}
                onChange={(event) => setSessionSearch(event.target.value)}
              />
              <kbd aria-label="Control K keyboard shortcut">Ctrl K</kbd>
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
              <SidebarItem icon={Bot} label="Agents" count={customizationCount('agent')} onClick={() => openCustomizations('agent')} />
              <SidebarItem icon={Sparkles} label="Skills" count={customizationCount('skill')} onClick={() => openCustomizations('skill')} />
              <SidebarItem icon={Server} label="MCP servers" count={customizationCount('mcp-server')} onClick={() => openCustomizations('mcp-server')} />
              <SidebarItem icon={Wrench} label="Tools" count={customizationCount('tool')} onClick={() => openCustomizations('tool')} />
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

            <button className="sidebar-settings" onClick={() => openCustomizations()}><Settings2 size={16} /> Project customizations</button>
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
          <div ref={chatContentRef} className={`chat-content ${messages.length ? 'has-messages' : ''}`}>
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
                      {message.display?.length ? <MessageDetails parts={message.display} /> : null}
                    </div>
                  </article>
                ))}
                {isThinking && (
                  <article className="message assistant">
                    <div className="message-avatar"><BrandMark compact /></div>
                    <div>
                      <strong>AAA</strong>
                      {streamingText
                        ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
                        : <div className="thinking"><i /><i /><i /></div>}
                      <MessageDetails
                        live
                        parts={[
                          { kind: 'reasoning', text: streamingReasoning },
                          ...(streamingToolEvents.length > 0
                            ? [{ kind: 'working' as const, title: 'Agent steps', events: streamingToolEvents }]
                            : [])
                        ]}
                      />
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
                <button
                  className="icon-button"
                  disabled={!publishedUrl}
                  onClick={() => window.open(publishedUrl, '_blank', 'noopener,noreferrer')}
                  aria-label="Open published preview in a new tab"
                >
                  <ExternalLink size={17} />
                </button>
                <button
                  className="icon-button"
                  onClick={() => setRightWidth(window.innerWidth / 2)}
                  aria-label="Maximize artifact panel"
                >
                  <Maximize2 size={17} />
                </button>
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
                <div>
                  <button className="icon-button small" onClick={() => void createFile()} aria-label="Create text file" title="Create text file"><FilePlus2 size={14} /></button>
                  <button className="icon-button small" onClick={() => void refreshFiles()} aria-label="Refresh files" title="Refresh files"><RefreshCw size={14} /></button>
                </div>
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
                  {isFileDirty && <small className="dirty-indicator">Unsaved</small>}
                </div>
                <div className="file-actions">
                  <button className="icon-button small" onClick={() => void createFile()} aria-label="Create text file" title="Create text file"><FilePlus2 size={14} /></button>
                  <button className="icon-button small" disabled={!selectedFile} onClick={() => void renameSelectedFile()} aria-label="Rename selected file" title="Rename"><Pencil size={14} /></button>
                  <button className="icon-button small" disabled={!isFileDirty || isSavingFile} onClick={() => void saveSelectedFile()} aria-label="Save selected file" title="Save"><Save size={14} /></button>
                  <button className="icon-button small danger-icon" disabled={!selectedFile} onClick={() => void deleteSelectedFile()} aria-label="Delete selected file" title="Delete"><Trash2 size={14} /></button>
                  <button className="icon-button small" onClick={() => setArtifactTab('files')} aria-label="Back to files" title="Files"><FolderOpen size={15} /></button>
                </div>
              </div>
              <div className="preview-content">
                {artifactTab === 'preview' && (
                  <div className="markdown-preview">
                    {selectedFile
                      ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{editorContent}</ReactMarkdown>
                      : <p>Select a Markdown file from Files to preview it.</p>}
                  </div>
                )}
                {artifactTab === 'source' && (
                  selectedFile
                    ? (
                      <textarea
                        className="source-editor"
                        aria-label={`Edit ${selectedFile.path}`}
                        value={editorContent}
                        onChange={(event) => setEditorContent(event.target.value)}
                        onKeyDown={(event) => {
                          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                            event.preventDefault();
                            void saveSelectedFile();
                          }
                        }}
                        spellCheck={false}
                      />
                    )
                    : <div className="source-empty">Select a text file from Files to edit its source.</div>
                )}
                {artifactTab === 'browser' && (
                  <div className="browser-preview">
                    <div className="browser-bar">
                      <span /><span /><span />
                      <div><ShieldCheck size={13} /> aaa.local/{selectedFile?.path ?? 'preview'}</div>
                    </div>
                    {publishedUrl
                      ? (
                        <iframe
                          className="published-frame"
                          src={publishedUrl}
                          title={`Published preview of ${selectedFile?.path}`}
                          sandbox=""
                        />
                      )
                      : (
                        <div className="published-page published-empty">
                          <div className="published-brand"><BrandMark compact /> AAA Published</div>
                          <p className="eyebrow">Local project preview</p>
                          <h2>Select a Markdown document</h2>
                          <p>The Web view renders Markdown through AAA's local published-preview route.</p>
                        </div>
                      )}
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

      {showCreateProject && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="file-dialog project-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-project-title"
            onSubmit={(event) => {
              event.preventDefault();
              void createProject();
            }}
          >
            <div>
              <strong id="create-project-title">Create authorization project</strong>
              <button type="button" className="icon-button small" onClick={() => setShowCreateProject(false)} aria-label="Close create project dialog"><X size={15} /></button>
            </div>
            <p>AAA will create a local project with the security-package structure, agent, skills, and MCP configuration ready to customize.</p>
            <label>
              Project name
              <input autoFocus required value={projectDraft.name} onChange={(event) => setProjectDraft((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label>
              System name
              <input value={projectDraft.systemName} onChange={(event) => setProjectDraft((current) => ({ ...current, systemName: event.target.value }))} placeholder="Optional; can be completed later" />
            </label>
            <label>
              Description
              <textarea value={projectDraft.description} onChange={(event) => setProjectDraft((current) => ({ ...current, description: event.target.value }))} rows={3} />
            </label>
            <div className="file-dialog-actions">
              <button type="button" className="secondary-button" onClick={() => setShowCreateProject(false)}>Cancel</button>
              <button type="submit" className="dialog-primary" disabled={!projectDraft.name.trim()}>Create project</button>
            </div>
          </form>
        </div>
      )}

      {customizationsOpen && (
        <div className="customizations-backdrop" role="presentation">
          <section className="customizations-window" role="dialog" aria-modal="true" aria-labelledby="customizations-title">
            <header>
              <div><BrandMark compact /><strong id="customizations-title">Project Customizations</strong><span>{activeProject?.name}</span></div>
              <div>
                <button className="icon-button" onClick={() => setCustomizationsOpen(false)} aria-label="Close customizations"><X size={19} /></button>
              </div>
            </header>
            <div className="customizations-layout">
              <nav aria-label="Customization sections">
                {([
                  ['overview', Home, 'Overview'],
                  ['mcp-server', Plug, 'MCP Servers'],
                  ['skill', Lightbulb, 'Skills'],
                  ['instruction', BookOpen, 'Instructions'],
                  ['agent', Braces, 'Agents'],
                  ['hook', Zap, 'Hooks'],
                  ['tool', Wrench, 'Tools']
                ] as const).map(([id, Icon, label]) => (
                  <button
                    className={`${customizationSection === id ? 'active' : ''} ${id === 'instruction' || id === 'hook' ? 'coming-soon' : ''}`}
                    key={id}
                    onClick={() => setCustomizationSection(id)}
                    disabled={id === 'instruction' || id === 'hook'}
                    title={id === 'instruction' || id === 'hook' ? `${label} are coming soon` : undefined}
                  >
                    <Icon size={16} />
                    <span>{label}</span>
                    {id !== 'overview' && (
                      <small>{id === 'instruction' || id === 'hook' ? 'Soon' : customizationCount(id)}</small>
                    )}
                  </button>
                ))}
              </nav>
              <div className="customizations-content">
                <div className="customizations-heading">
                  <div>
                    <p className="eyebrow">Selected project</p>
                    <h2>{customizationSection === 'overview'
                      ? 'Customize your AAA workspace'
                      : customizationSection === 'mcp-server'
                        ? 'MCP Servers'
                        : `${customizationSection[0].toUpperCase()}${customizationSection.slice(1)}s`}</h2>
                    <p>
                      {customizationSection === 'overview'
                        ? 'Configure the AI capabilities available to this authorization project.'
                        : customizationSection === 'tool'
                          ? 'Control which built-in workspace capabilities are available to this project.'
                          : 'Create and edit friendly project-level capability settings.'}
                    </p>
                  </div>
                  {customizationSection !== 'overview' && customizationSection !== 'tool' && (
                    <button className="customization-add" onClick={() => void openCustomizationEditor()}>
                      <Plus size={14} /> Add {customizationSection === 'mcp-server' ? 'server' : customizationSection}
                    </button>
                  )}
                </div>
                {customizationSection === 'overview'
                  ? (
                    <div className="customization-overview-grid">
                      {([
                        ['agent', Bot, 'Agents', 'Choose the assistants that orchestrate your A&A workflow.'],
                        ['skill', Sparkles, 'Skills', 'Reusable procedures for package initialization, analysis, and validation.'],
                        ['mcp-server', Server, 'MCP Servers', 'Connect approved local and remote tools and services.'],
                        ['tool', Wrench, 'Tools', 'Review the file and workspace capabilities available to agents.'],
                        ['instruction', BookOpen, 'Instructions', 'Reusable instruction sets are coming soon.'],
                        ['hook', Zap, 'Hooks', 'Lifecycle automation hooks are coming soon.']
                      ] as const).map(([kind, Icon, label, description]) => {
                        const comingSoon = kind === 'instruction' || kind === 'hook';
                        return (
                        <button
                          key={kind}
                          className={comingSoon ? 'coming-soon' : ''}
                          disabled={comingSoon}
                          onClick={() => setCustomizationSection(kind)}
                        >
                          <span><Icon size={19} /></span>
                          <strong>{label}</strong>
                          <small>{comingSoon ? 'Coming soon' : `${customizationCount(kind)} configured`}</small>
                          <p>{description}</p>
                        </button>
                        );
                      })}
                    </div>
                  )
                  : (
                    <>
                      <label className="customization-search">
                        <Search size={15} />
                        <input value={customizationSearch} onChange={(event) => setCustomizationSearch(event.target.value)} placeholder={`Search ${customizationSection.replace('-', ' ')}s…`} />
                      </label>
                      <div className="customization-group-title">
                        <ChevronDown size={15} /><strong>Configured</strong><span>{filteredCustomizations.length}</span>
                      </div>
                      <div className="customization-list">
                        {filteredCustomizations.map((item) => (
                          <article key={item.id}>
                            <div>
                              <strong>{item.name}</strong>
                              <p>{item.description}</p>
                              <small>{item.detail ?? item.sourcePath ?? 'Project configuration'}</small>
                            </div>
                            <div>
                              <span className={`customization-status ${item.status}`}><Check size={12} /> {item.status}</span>
                              <button
                                className={`toggle ${item.enabled ? 'on' : ''}`}
                                aria-label={`${item.enabled ? 'Disable' : 'Enable'} ${item.name}`}
                                onClick={() => void toggleCustomization(item)}
                              >
                                <span />
                              </button>
                              <button
                                className="icon-button small"
                                aria-label={`Edit ${item.name}`}
                                onClick={() => void openCustomizationEditor(item)}
                              >
                                <Pencil size={14} />
                              </button>
                            </div>
                          </article>
                        ))}
                        {filteredCustomizations.length === 0 && (
                          <div className="customization-empty">No configured items match this view.</div>
                        )}
                      </div>
                    </>
                  )}
              </div>
            </div>
          </section>
        </div>
      )}

      {customizationEditorOpen && (
        <div className="capability-editor-backdrop" role="presentation">
          <form
            className="capability-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="capability-editor-title"
            onSubmit={(event) => {
              event.preventDefault();
              void saveCustomization();
            }}
          >
            <header>
              <div>
                <span className="capability-editor-icon">
                  {customizationDraft?.kind === 'agent'
                    ? <Bot size={18} />
                    : customizationDraft?.kind === 'skill'
                      ? <Sparkles size={18} />
                      : customizationDraft?.kind === 'mcp-server'
                        ? <Server size={18} />
                        : <Wrench size={18} />}
                </span>
                <div>
                  <strong id="capability-editor-title">
                    {customizationDraft?.id ? 'Edit' : 'Add'} {customizationDraft?.kind === 'mcp-server'
                      ? 'MCP server'
                      : customizationDraft?.kind ?? 'capability'}
                  </strong>
                  <small>{customizationDraft?.sourcePath ?? 'Project capability'}</small>
                </div>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  setCustomizationEditorOpen(false);
                  setCustomizationDraft(null);
                  setCustomizationEditorError('');
                }}
                aria-label="Close capability editor"
              >
                <X size={18} />
              </button>
            </header>
            {customizationDraft
              ? (
                <div className="capability-editor-body">
                  <div className="capability-form-grid">
                    <label>
                      Display name
                      <input
                        autoFocus
                        required
                        readOnly={customizationDraft.readOnly}
                        value={customizationDraft.name}
                        onChange={(event) => setCustomizationDraft((current) =>
                          current ? { ...current, name: event.target.value } : current)}
                      />
                    </label>
                    <label className="capability-enabled-field">
                      Availability
                      <button
                        type="button"
                        className={`capability-availability ${customizationDraft.enabled ? 'enabled' : ''}`}
                        onClick={() => setCustomizationDraft((current) =>
                          current ? { ...current, enabled: !current.enabled } : current)}
                      >
                        <span><span /></span>
                        {customizationDraft.enabled ? 'Enabled for this project' : 'Disabled for this project'}
                      </button>
                    </label>
                  </div>
                  <label>
                    Description
                    <textarea
                      required
                      readOnly={customizationDraft.readOnly}
                      rows={3}
                      value={customizationDraft.description}
                      onChange={(event) => setCustomizationDraft((current) =>
                        current ? { ...current, description: event.target.value } : current)}
                    />
                    <small>Shown in capability pickers so users know when to use it.</small>
                  </label>

                  {(customizationDraft.kind === 'agent' || customizationDraft.kind === 'skill') && (
                    <>
                      <label>
                        Suggested prompt
                        <input
                          value={customizationDraft.argumentHint ?? ''}
                          placeholder="Describe what a user should ask this capability to do"
                          onChange={(event) => setCustomizationDraft((current) =>
                            current ? { ...current, argumentHint: event.target.value } : current)}
                        />
                      </label>
                      {customizationDraft.kind === 'agent' && (
                        <label>
                          Allowed tools
                          <input
                            value={customizationDraft.tools ?? ''}
                            placeholder="read, search, edit, mcp-publisher/*"
                            onChange={(event) => setCustomizationDraft((current) =>
                              current ? { ...current, tools: event.target.value } : current)}
                          />
                          <small>Comma-separated tool names or patterns available to this agent.</small>
                        </label>
                      )}
                      <label>
                        Instructions
                        <textarea
                          required
                          className="capability-instructions"
                          rows={14}
                          value={customizationDraft.instructions ?? ''}
                          onChange={(event) => setCustomizationDraft((current) =>
                            current ? { ...current, instructions: event.target.value } : current)}
                        />
                        <small>Markdown instructions stored directly with the project capability.</small>
                      </label>
                    </>
                  )}

                  {customizationDraft.kind === 'mcp-server' && (
                    <>
                      <fieldset className="transport-picker">
                        <legend>Connection type</legend>
                        <button
                          type="button"
                          className={customizationDraft.transport === 'http' ? 'active' : ''}
                          onClick={() => setCustomizationDraft((current) =>
                            current ? { ...current, transport: 'http' } : current)}
                        >
                          <Globe2 size={16} /><span><strong>HTTP endpoint</strong><small>Connect to a local or approved remote MCP endpoint.</small></span>
                        </button>
                        <button
                          type="button"
                          className={customizationDraft.transport === 'stdio' ? 'active' : ''}
                          onClick={() => setCustomizationDraft((current) =>
                            current ? { ...current, transport: 'stdio' } : current)}
                        >
                          <TerminalSquare size={16} /><span><strong>Local command</strong><small>Launch an MCP server process on this machine.</small></span>
                        </button>
                      </fieldset>
                      {customizationDraft.transport === 'http'
                        ? (
                          <label>
                            Server URL
                            <input
                              required
                              type="url"
                              placeholder="http://127.0.0.1:3000/mcp"
                              value={customizationDraft.url ?? ''}
                              onChange={(event) => setCustomizationDraft((current) =>
                                current ? { ...current, url: event.target.value } : current)}
                            />
                          </label>
                        )
                        : (
                          <>
                            <label>
                              Command
                              <input
                                required
                                placeholder="node"
                                value={customizationDraft.command ?? ''}
                                onChange={(event) => setCustomizationDraft((current) =>
                                  current ? { ...current, command: event.target.value } : current)}
                              />
                            </label>
                            <label>
                              Arguments
                              <textarea
                                rows={5}
                                placeholder={"One argument per line\nserver.js\n--local"}
                                value={customizationDraft.args ?? ''}
                                onChange={(event) => setCustomizationDraft((current) =>
                                  current ? { ...current, args: event.target.value } : current)}
                              />
                            </label>
                          </>
                        )}
                    </>
                  )}

                  {customizationDraft.kind === 'tool' && (
                    <div className="capability-readonly-note">
                      <ShieldCheck size={17} />
                      <div>
                        <strong>Built-in AAA tool</strong>
                        <p>The implementation and safety boundaries are managed by AAA. You can control whether this tool is available to the selected project.</p>
                      </div>
                    </div>
                  )}
                  {customizationEditorError && <div className="capability-editor-error">{customizationEditorError}</div>}
                </div>
              )
              : (
                <div className="capability-editor-loading">
                  {customizationEditorError || 'Loading capability settings…'}
                </div>
              )}
            <footer>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setCustomizationEditorOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="dialog-primary"
                disabled={!customizationDraft || isSavingCustomization}
              >
                {isSavingCustomization ? 'Saving…' : 'Save capability'}
              </button>
            </footer>
          </form>
        </div>
      )}

      {fileDialog && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="file-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="file-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              void submitFileDialog();
            }}
          >
            <div>
              <strong id="file-dialog-title">
                {fileDialog.kind === 'create'
                  ? 'Create text file'
                  : fileDialog.kind === 'rename'
                    ? 'Rename file'
                    : 'Delete file'}
              </strong>
              <button type="button" className="icon-button small" onClick={() => setFileDialog(null)} aria-label="Close file dialog">×</button>
            </div>
            {fileDialog.kind === 'delete'
              ? <p>Delete <code>{fileDialog.value}</code>? This cannot be undone.</p>
              : (
                <label>
                  Project-relative path
                  <input
                    autoFocus
                    value={fileDialog.value}
                    onChange={(event) => setFileDialog({ ...fileDialog, value: event.target.value })}
                    aria-label="Project-relative path"
                  />
                </label>
              )}
            <div className="file-dialog-actions">
              <button type="button" className="secondary-button" onClick={() => setFileDialog(null)}>Cancel</button>
              <button type="submit" className={fileDialog.kind === 'delete' ? 'dialog-danger' : 'dialog-primary'}>
                {fileDialog.kind === 'create' ? 'Create' : fileDialog.kind === 'rename' ? 'Rename' : 'Delete'}
              </button>
            </div>
          </form>
        </div>
      )}

      {showDiscardDialog && (
        <div className="modal-backdrop" role="presentation">
          <div className="file-dialog" role="dialog" aria-modal="true" aria-labelledby="discard-dialog-title">
            <div><strong id="discard-dialog-title">Unsaved changes</strong></div>
            <p>Discard the unsaved changes to <code>{selectedFile?.path}</code> and continue?</p>
            <div className="file-dialog-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  pendingFileActionRef.current = null;
                  setShowDiscardDialog(false);
                }}
              >
                Keep editing
              </button>
              <button type="button" className="dialog-danger" onClick={discardAndContinue}>Discard changes</button>
            </div>
          </div>
        </div>
      )}

      <footer className="statusbar">
        <div><span className="classification-dot" /> CONTROLLED · LOCAL DEMO</div>
        <div>
          <span title={storageStatus?.sessions.endpointHost}><Database size={12} /> {storageStatus?.sessions.backend ?? '…'} sessions</span>
          <span title={modelStatus?.endpointHost}><Link2 size={12} /> {modelStatus?.ready ? modelStatus.deployment : 'Model unavailable'}</span>
          <span title={lastRun?.error}>
            <TerminalSquare size={12} />
            {isThinking
              ? 'Model running'
              : lastRun
                ? `Last run ${lastRun.status}`
                : 'No recorded runs'}
          </span>
        </div>
      </footer>
    </div>
  );
}

export default App;
