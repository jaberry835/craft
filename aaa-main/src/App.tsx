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
  Eye,
  EyeOff,
  FileCheck2,
  FileCode2,
  FilePlus2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Globe2,
  Home,
  Image as ImageIcon,
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
  Upload,
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
  BrowserCaptureResult,
  BrowserSessionStatus,
  CapabilityTestResult,
  CustomizationEditor,
  CustomizationItem,
  EditableCustomizationKind,
  FileTreeNode,
  ModelConnectionStatus,
  ProjectSummary,
  ProjectTextFile,
  ProjectWorkflowSummary,
  PublicationStatus,
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
const hiddenFilesStorageKey = 'aaa-show-hidden-files';
const agentSelectionStorageKey = 'aaa-agent-selection';
const previewImageExtensions = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']);

function getInitialAgentSelections(): Record<string, string> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(agentSelectionStorageKey) ?? '{}') as unknown;
    return stored && typeof stored === 'object' ? stored as Record<string, string> : {};
  } catch {
    return {};
  }
}

function isPreviewImage(filePath: string): boolean {
  const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return previewImageExtensions.has(extension);
}

function JsonPreview({ content }: { content: string }) {
  try {
    const value = JSON.parse(content) as unknown;
    return <pre className="json-preview">{JSON.stringify(value, null, 2)}</pre>;
  } catch (error) {
    return (
      <div className="json-preview-error" role="alert">
        <Braces size={18} />
        <div>
          <strong>Invalid JSON</strong>
          <span>{error instanceof Error ? error.message : 'This file could not be parsed.'}</span>
        </div>
      </div>
    );
  }
}

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
                      : event.type === 'skill'
                        ? <Sparkles size={13} />
                        : event.type === 'mcp'
                          ? <Plug size={13} />
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

function flattenFiles(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.flatMap((node) => node.type === 'file' ? [node] : flattenFiles(node.children ?? []));
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
  const [selectedImagePath, setSelectedImagePath] = useState('');
  const [browserStatus, setBrowserStatus] = useState<BrowserSessionStatus>({ active: false });
  const [browserUrl, setBrowserUrl] = useState('https://');
  const [browserHeadless, setBrowserHeadless] = useState(false);
  const [browserOutputPath, setBrowserOutputPath] = useState('');
  const [browserCapture, setBrowserCapture] = useState<BrowserCaptureResult | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [publicationStatus, setPublicationStatus] = useState<PublicationStatus | null>(null);
  const [isReviewingFile, setIsReviewingFile] = useState(false);
  const [editorContent, setEditorContent] = useState('');
  const [isSavingFile, setIsSavingFile] = useState(false);
  const [fileDialog, setFileDialog] = useState<FileDialogState | null>(null);
  const [uploadTargetPath, setUploadTargetPath] = useState('');
  const [dragTargetPath, setDragTargetPath] = useState<string | null>(null);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
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
  const [capabilityTests, setCapabilityTests] = useState<Record<string, CapabilityTestResult>>({});
  const [testingCapabilityId, setTestingCapabilityId] = useState('');
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
  const [workflow, setWorkflow] = useState<ProjectWorkflowSummary | null>(null);
  const [agentSelections, setAgentSelections] = useState<Record<string, string>>(getInitialAgentSelections);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [evidenceMenuOpen, setEvidenceMenuOpen] = useState(false);
  const [attachedEvidence, setAttachedEvidence] = useState<string[]>([]);
  const [showHiddenFiles, setShowHiddenFiles] = useState(
    () => window.localStorage.getItem(hiddenFilesStorageKey) === 'true'
  );
  const showHiddenFilesRef = useRef(showHiddenFiles);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const sessionSearchRef = useRef<HTMLInputElement>(null);
  const chatContentRef = useRef<HTMLDivElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const pendingFileActionRef = useRef<(() => void) | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const messages = activeSession?.messages ?? [];
  const lastRun = activeSession?.runs.at(-1);
  const isMarkdownSelected = selectedFile?.path.toLowerCase().endsWith('.md') ?? false;
  const isJsonSelected = selectedFile?.path.toLowerCase().endsWith('.json') ?? false;
  const selectedArtifactPath = selectedFile?.path ?? selectedImagePath;
  const isFileDirty = selectedFile !== null && editorContent !== selectedFile.content;
  const publishedUrl = activeProjectId && selectedFile && isMarkdownSelected && publicationStatus?.reviewed
    ? aaaApi.publishedMarkdownUrl(activeProjectId, selectedFile.path)
    : '';
  const imageUrl = activeProjectId && selectedImagePath
    ? aaaApi.imageUrl(activeProjectId, selectedImagePath)
    : '';
  const visibleFiles = useMemo(
    () => flattenVisibleNodes(fileTree, expandedPaths),
    [expandedPaths, fileTree]
  );
  const evidenceFiles = useMemo(() => flattenFiles(fileTree), [fileTree]);
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
  const selectedAgent = useMemo(() => {
    const agents = workflow?.agents ?? [];
    const requested = agentSelections[activeProjectId];
    if (requested === 'default') return undefined;
    return agents.find((agent) => agent.id === requested) ?? agents[0];
  }, [activeProjectId, agentSelections, workflow?.agents]);
  const agentLabel = selectedAgent?.name ?? 'AAA Assistant';
  const slashQuery = /^\/(\S*)$/.exec(draft)?.[1]?.toLowerCase();
  const commandSuggestions = useMemo(() => {
    const commands = workflow?.commands ?? [];
    if (slashQuery === undefined) return commandMenuOpen ? commands : [];
    return commands.filter((command) =>
      command.name.includes(slashQuery) || command.label.toLowerCase().includes(slashQuery));
  }, [commandMenuOpen, slashQuery, workflow?.commands]);

  const shellStyle = useMemo(() => ({
    '--left-width': leftOpen ? `${leftWidth}px` : '0px',
    '--right-width': rightOpen ? `${rightWidth}px` : '0px'
  }) as React.CSSProperties, [leftOpen, leftWidth, rightOpen, rightWidth]);

  const refreshCustomizations = useCallback(async () => {
    if (!activeProjectId) return;
    const [response, nextWorkflow] = await Promise.all([
      aaaApi.getCustomizations(activeProjectId),
      aaaApi.getWorkflow(activeProjectId)
    ]);
    setCustomizationItems(response.items);
    setWorkflow(nextWorkflow);
  }, [activeProjectId]);

  useEffect(() => {
    window.localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(agentSelectionStorageKey, JSON.stringify(agentSelections));
  }, [agentSelections]);

  useEffect(() => {
    setEditorContent(selectedFile?.content ?? '');
  }, [selectedFile?.content, selectedFile?.path]);

  useEffect(() => {
    if (!activeProjectId || !selectedFile || !isMarkdownSelected) {
      setPublicationStatus(null);
      return;
    }
    let cancelled = false;
    aaaApi.getPublicationStatus(activeProjectId, selectedFile.path)
      .then((status) => {
        if (!cancelled) setPublicationStatus(status);
      })
      .catch((statusError) => {
        if (!cancelled) setError(statusError instanceof Error
          ? statusError.message
          : 'Could not load publication status.');
      });
    return () => { cancelled = true; };
  }, [activeProjectId, isMarkdownSelected, selectedFile]);

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
    setWorkflow(null);
    Promise.all([aaaApi.getCustomizations(activeProjectId), aaaApi.getWorkflow(activeProjectId)])
      .then(([response, nextWorkflow]) => {
        if (cancelled) return;
        setCustomizationItems(response.items);
        setWorkflow(nextWorkflow);
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
      const [nextSessions, nextTree, nextBrowserStatus] = await Promise.all([
        aaaApi.listSessions(projectId),
        aaaApi.getFileTree(projectId, showHiddenFilesRef.current),
        aaaApi.getBrowserStatus(projectId)
      ]);
      setSessions(nextSessions);
      setFileTree(nextTree);
      setBrowserStatus(nextBrowserStatus);
      if (nextBrowserStatus.currentUrl?.startsWith('http')) setBrowserUrl(nextBrowserStatus.currentUrl);
      setExpandedPaths(new Set(nextTree.filter((node) => node.type === 'directory').map((node) => node.path)));

      const preferredSessionId = activeSession?.projectId === projectId ? activeSession.id : nextSessions[0]?.id;
      setActiveSession(preferredSessionId ? await aaaApi.getSession(projectId, preferredSessionId) : null);

      if (!selectedFile || activeProjectId !== projectId) {
        const defaultFile = findDefaultFile(nextTree);
        if (defaultFile?.type === 'file') {
          if (isPreviewImage(defaultFile.path)) {
            setSelectedFile(null);
            setSelectedImagePath(defaultFile.path);
          } else {
            setSelectedFile(await aaaApi.readTextFile(projectId, defaultFile.path));
            setSelectedImagePath('');
          }
        } else {
          setSelectedFile(null);
          setSelectedImagePath('');
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
      setSelectedImagePath('');
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
      setSelectedImagePath('');
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
      setWorkflow(await aaaApi.getWorkflow(activeProjectId));
    } catch (toggleError) {
      setCustomizationEditorError(toggleError instanceof Error
        ? toggleError.message
        : 'Could not update this capability.');
    }
  }, [activeProjectId]);

  const testCapability = useCallback(async (item: CustomizationItem) => {
    if (!activeProjectId || testingCapabilityId) return;
    setCustomizationEditorError('');
    setTestingCapabilityId(item.id);
    try {
      const result = await aaaApi.testCapability(activeProjectId, item.id);
      setCapabilityTests((current) => ({ ...current, [item.id]: result }));
    } catch (testError) {
      setCapabilityTests((current) => ({
        ...current,
        [item.id]: {
          itemId: item.id,
          ok: false,
          testedAt: new Date().toISOString(),
          summary: testError instanceof Error ? testError.message : 'Capability test failed.'
        }
      }));
    } finally {
      setTestingCapabilityId('');
    }
  }, [activeProjectId, testingCapabilityId]);

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
        if (isPreviewImage(node.path)) {
          setSelectedFile(null);
          setSelectedImagePath(node.path);
          setArtifactTab('preview');
          return;
        }
        const file = await aaaApi.readTextFile(activeProjectId, node.path);
        setSelectedFile(file);
        setSelectedImagePath('');
        setArtifactTab(/\.(md|json)$/i.test(node.name) ? 'preview' : 'source');
      } catch (fileError) {
        setError(fileError instanceof Error ? fileError.message : 'Could not open the file.');
      }
    };
    if (selectedArtifactPath === node.path) {
      setArtifactTab(/\.(md|json)$/i.test(node.name) ? 'preview' : 'source');
      return;
    }
    requestFileAction(() => void loadFile());
  }, [activeProjectId, requestFileAction, selectedArtifactPath]);

  const refreshFiles = useCallback(async () => {
    if (!activeProjectId) return;
    try {
      setFileTree(await aaaApi.getFileTree(activeProjectId, showHiddenFilesRef.current));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Could not refresh project files.');
    }
  }, [activeProjectId]);

  const launchBrowser = useCallback(async () => {
    if (!activeProjectId || browserBusy) return;
    setBrowserBusy(true);
    setError('');
    try {
      setBrowserStatus(await aaaApi.launchBrowser(activeProjectId, { headless: browserHeadless }));
    } catch (browserError) {
      setError(browserError instanceof Error ? browserError.message : 'Could not launch Microsoft Edge.');
    } finally {
      setBrowserBusy(false);
    }
  }, [activeProjectId, browserBusy, browserHeadless]);

  const navigateBrowser = useCallback(async () => {
    if (!activeProjectId || browserBusy) return;
    setBrowserBusy(true);
    setError('');
    try {
      setBrowserStatus(await aaaApi.navigateBrowser(activeProjectId, { url: browserUrl }));
    } catch (browserError) {
      setError(browserError instanceof Error ? browserError.message : 'Could not navigate Microsoft Edge.');
    } finally {
      setBrowserBusy(false);
    }
  }, [activeProjectId, browserBusy, browserUrl]);

  const captureBrowser = useCallback(async () => {
    if (!activeProjectId || browserBusy) return;
    setBrowserBusy(true);
    setError('');
    try {
      const captured = await aaaApi.captureBrowser(activeProjectId, {
        outputPath: browserOutputPath.trim() || undefined
      });
      setBrowserCapture(captured);
      setBrowserOutputPath('');
      await refreshFiles();
    } catch (browserError) {
      setError(browserError instanceof Error ? browserError.message : 'Could not capture browser evidence.');
    } finally {
      setBrowserBusy(false);
    }
  }, [activeProjectId, browserBusy, browserOutputPath, refreshFiles]);

  const closeBrowser = useCallback(async () => {
    if (!activeProjectId || browserBusy) return;
    setBrowserBusy(true);
    setError('');
    try {
      setBrowserStatus(await aaaApi.closeBrowser(activeProjectId));
    } catch (browserError) {
      setError(browserError instanceof Error ? browserError.message : 'Could not close Microsoft Edge.');
    } finally {
      setBrowserBusy(false);
    }
  }, [activeProjectId, browserBusy]);

  useEffect(() => {
    window.localStorage.setItem(hiddenFilesStorageKey, String(showHiddenFiles));
    if (showHiddenFilesRef.current === showHiddenFiles) return;
    showHiddenFilesRef.current = showHiddenFiles;
    void refreshFiles();
  }, [refreshFiles, showHiddenFiles]);

  useEffect(() => {
    if (!agentMenuOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !(event.target as Element).closest?.('.agent-picker')) {
        setAgentMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [agentMenuOpen]);

  useEffect(() => {
    if (!evidenceMenuOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !(event.target as Element).closest?.('.evidence-picker')) {
        setEvidenceMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [evidenceMenuOpen]);

  useEffect(() => {
    setAttachedEvidence([]);
    setEvidenceMenuOpen(false);
  }, [activeProjectId]);

  const insertCommand = useCallback((name: string) => {
    setDraft(`/${name} `);
    setCommandMenuOpen(false);
    window.requestAnimationFrame(() => {
      const composer = composerRef.current;
      composer?.focus();
      composer?.setSelectionRange(composer.value.length, composer.value.length);
    });
  }, []);

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

  const uploadFiles = useCallback(async (files: File[], destination: string) => {
    if (!activeProjectId || files.length === 0 || isUploadingFiles) return;
    setError('');
    setIsUploadingFiles(true);
    const failures: string[] = [];
    let uploaded = 0;
    try {
      for (const file of files) {
        const relativePath = destination ? `${destination}/${file.name}` : file.name;
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = '';
          const chunkSize = 32_768;
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
          }
          await aaaApi.uploadFile(activeProjectId, {
            path: relativePath,
            contentBase64: window.btoa(binary)
          });
          uploaded += 1;
        } catch (uploadError) {
          failures.push(`${file.name}: ${uploadError instanceof Error ? uploadError.message : 'Upload failed.'}`);
        }
      }
      await refreshFiles();
      if (failures.length > 0) {
        setError(`${uploaded} file${uploaded === 1 ? '' : 's'} uploaded. ${failures.join(' ')}`);
      }
    } finally {
      setIsUploadingFiles(false);
      setDragTargetPath(null);
    }
  }, [activeProjectId, isUploadingFiles, refreshFiles]);

  const handleFileDrop = useCallback((
    event: React.DragEvent<HTMLElement>,
    destination: string
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setUploadTargetPath(destination);
    void uploadFiles(Array.from(event.dataTransfer.files), destination);
  }, [uploadFiles]);

  const renameSelectedFile = useCallback(() => {
    if (!activeProjectId || !selectedArtifactPath) return;
    requestFileAction(() => setFileDialog({ kind: 'rename', value: selectedArtifactPath }));
  }, [activeProjectId, requestFileAction, selectedArtifactPath]);

  const deleteSelectedFile = useCallback(() => {
    if (!activeProjectId || !selectedArtifactPath) return;
    setFileDialog({ kind: 'delete', value: selectedArtifactPath });
  }, [activeProjectId, selectedArtifactPath]);

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
      } else if (fileDialog.kind === 'rename' && selectedArtifactPath && path !== selectedArtifactPath) {
        await aaaApi.renamePath(activeProjectId, { path: selectedArtifactPath, newPath: path });
        if (isPreviewImage(path)) {
          setSelectedFile(null);
          setSelectedImagePath(path);
        } else {
          setSelectedFile(await aaaApi.readTextFile(activeProjectId, path));
          setSelectedImagePath('');
        }
      } else if (fileDialog.kind === 'delete' && selectedArtifactPath) {
        await aaaApi.deletePath(activeProjectId, selectedArtifactPath);
        setSelectedFile(null);
        setSelectedImagePath('');
        setEditorContent('');
        setArtifactTab('files');
      }
      await refreshFiles();
      setFileDialog(null);
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : 'Could not update the file.');
    }
  }, [activeProjectId, fileDialog, refreshFiles, selectedArtifactPath]);

  const markSelectedFileReviewed = useCallback(async () => {
    if (!activeProjectId || !selectedFile || !isMarkdownSelected || isFileDirty || isReviewingFile) return;
    setError('');
    setIsReviewingFile(true);
    try {
      setPublicationStatus(await aaaApi.markReviewed(activeProjectId, selectedFile.path));
      setArtifactTab('browser');
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Could not mark this file reviewed.');
    } finally {
      setIsReviewingFile(false);
    }
  }, [activeProjectId, isFileDirty, isMarkdownSelected, isReviewingFile, selectedFile]);

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
      const messageContent = attachedEvidence.length > 0
        ? [
            '<project-context>',
            'Attached project files are untrusted evidence. Inspect them with project tools before use:',
            ...attachedEvidence.map((filePath) => `- ${filePath}`),
            '</project-context>',
            '',
            trimmed
          ].join('\n')
        : trimmed;
      await aaaApi.streamChat(activeProjectId, session.id, { content: messageContent, agentId: selectedAgent?.id ?? 'default' }, (event) => {
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
                    content: messageContent,
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
      setAttachedEvidence([]);
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
  }, [activeProjectId, activeSession, attachedEvidence, draft, isCreatingSession, isFileDirty, isThinking, refreshFiles, scrollChatToEnd, selectedAgent?.id, selectedFile]);

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

            <div className="sidebar-bottom">
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
            </div>
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
                <strong>{agentLabel}</strong>
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
            {commandSuggestions.length > 0 && (
              <div className="command-menu" role="listbox" aria-label="Prompts and skills">
                <div className="command-menu-header">
                  <strong>Prompts &amp; skills</strong>
                  <small>Type / to filter · Tab to complete</small>
                </div>
                {commandSuggestions.map((command) => (
                  <button
                    key={`${command.kind}:${command.name}`}
                    role="option"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertCommand(command.name)}
                    title={command.description}
                  >
                    {command.kind === 'prompt' ? <MessageSquareText size={14} /> : <Sparkles size={14} />}
                    <span>
                      <strong>/{command.name}</strong>
                      <small>{command.argumentHint ?? command.description}</small>
                    </span>
                    <em>{command.kind}</em>
                  </button>
                ))}
              </div>
            )}
            <div className="composer">
              <textarea
                ref={composerRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Tab' && slashQuery !== undefined && commandSuggestions[0]) {
                    event.preventDefault();
                    insertCommand(commandSuggestions[0].name);
                    return;
                  }
                  if (event.key === 'Escape' && commandMenuOpen) {
                    setCommandMenuOpen(false);
                    return;
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    setCommandMenuOpen(false);
                    sendMessage();
                  }
                }}
                placeholder="Ask AAA to build, assess, or validate... Type / for prompts and skills"
                rows={1}
              />
              <div className="composer-toolbar">
                <div>
                  <div className="evidence-picker">
                    <button
                      className={`tool-button ${evidenceMenuOpen ? 'active' : ''}`}
                      aria-haspopup="menu"
                      aria-expanded={evidenceMenuOpen}
                      disabled={evidenceFiles.length === 0}
                      title={evidenceFiles.length ? 'Attach project evidence as model context' : 'This project has no files to attach'}
                      onClick={() => setEvidenceMenuOpen((open) => !open)}
                    >
                      <Paperclip size={16} /> Add evidence
                      {attachedEvidence.length > 0 && <span className="attachment-count">{attachedEvidence.length}</span>}
                    </button>
                    {evidenceMenuOpen && (
                      <div className="evidence-menu" role="menu">
                        <div className="command-menu-header">
                          <strong>Project evidence</strong>
                          <span>Contents may be sent to the configured model when inspected</span>
                        </div>
                        {evidenceFiles.map((file) => {
                          const selected = attachedEvidence.includes(file.path);
                          return (
                            <button
                              key={file.path}
                              role="menuitemcheckbox"
                              aria-checked={selected}
                              onClick={() => setAttachedEvidence((current) =>
                                selected ? current.filter((path) => path !== file.path) : [...current, file.path])}
                            >
                              <FileText size={14} />
                              <span><strong>{file.name}</strong><small>{file.path}</small></span>
                              {selected && <Check size={13} />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <button
                    className={`tool-button ${commandMenuOpen ? 'active' : ''}`}
                    aria-expanded={commandMenuOpen}
                    disabled={!workflow?.commands.length}
                    title={workflow?.commands.length ? 'Insert a prompt or skill' : 'This project has no prompts or skills'}
                    onClick={() => setCommandMenuOpen((open) => !open)}
                  >
                    <Code2 size={16} /> Skills
                  </button>
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
              <div className="agent-picker">
                <button
                  aria-haspopup="menu"
                  aria-expanded={agentMenuOpen}
                  onClick={() => setAgentMenuOpen((open) => !open)}
                  title={selectedAgent?.description ?? 'Run without a project agent'}
                >
                  <Bot size={13} /> {agentLabel} <ChevronDown size={12} />
                </button>
                {agentMenuOpen && (
                  <div className="agent-menu" role="menu">
                    {[...(workflow?.agents ?? []), { id: 'default', name: 'AAA Assistant', description: 'General assistant without project agent instructions.' }]
                      .map((agent) => (
                        <button
                          key={agent.id}
                          role="menuitemradio"
                          aria-checked={(selectedAgent?.id ?? 'default') === agent.id}
                          onClick={() => {
                            setAgentSelections((current) => ({ ...current, [activeProjectId]: agent.id }));
                            setAgentMenuOpen(false);
                          }}
                        >
                          <span>
                            <strong>{agent.name}</strong>
                            <small>{agent.description}</small>
                          </span>
                          {(selectedAgent?.id ?? 'default') === agent.id && <Check size={13} />}
                        </button>
                      ))}
                    <button
                      className="agent-menu-manage"
                      role="menuitem"
                      onClick={() => {
                        setAgentMenuOpen(false);
                        openCustomizations('agent');
                      }}
                    >
                      <Settings2 size={13} />
                      <span><strong>Manage agents</strong><small>Open advanced project settings</small></span>
                    </button>
                  </div>
                )}
              </div>
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

            {artifactTab === 'files' && (
              <div
               className={`file-tree ${dragTargetPath === '' ? 'drop-active' : ''}`}
               onDragEnter={(event) => {
                 if (event.dataTransfer.types.includes('Files')) {
                   event.preventDefault();
                   setDragTargetPath('');
                 }
               }}
               onDragOver={(event) => {
                 if (event.dataTransfer.types.includes('Files')) {
                   event.preventDefault();
                   event.dataTransfer.dropEffect = 'copy';
                 }
               }}
               onDragLeave={(event) => {
                 if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                   setDragTargetPath(null);
                 }
               }}
               onDrop={(event) => handleFileDrop(event, '')}
              >
              <div className="tree-title">
                <span>
                  PACKAGE FILES
                  <small>Upload to {uploadTargetPath ? `/${uploadTargetPath}` : 'project root'}</small>
                </span>
                <div>
                  <input
                    ref={uploadInputRef}
                    className="visually-hidden"
                    type="file"
                    multiple
                    onChange={(event) => {
                      void uploadFiles(Array.from(event.target.files ?? []), uploadTargetPath);
                      event.currentTarget.value = '';
                    }}
                  />
                  <button
                    className="icon-button small"
                    disabled={isUploadingFiles}
                    onClick={() => uploadInputRef.current?.click()}
                    aria-label={`Upload files to ${uploadTargetPath || 'project root'}`}
                    title={`Upload files to ${uploadTargetPath ? `/${uploadTargetPath}` : 'project root'}`}
                  >
                    <Upload size={14} />
                  </button>
                  <button className="icon-button small" onClick={() => void createFile()} aria-label="Create text file" title="Create text file"><FilePlus2 size={14} /></button>
                  <button
                    className={`icon-button small ${showHiddenFiles ? 'active' : ''}`}
                    onClick={() => setShowHiddenFiles((show) => !show)}
                    aria-pressed={showHiddenFiles}
                    aria-label={showHiddenFiles ? 'Hide dotfiles' : 'Show dotfiles'}
                    title={showHiddenFiles ? 'Hide dotfiles (.github, .vscode, .aaa)' : 'Show dotfiles (.github, .vscode, .aaa)'}
                  >
                    {showHiddenFiles ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>
                  <button className="icon-button small" onClick={() => void refreshFiles()} aria-label="Refresh files" title="Refresh files"><RefreshCw size={14} /></button>
                </div>
              </div>
              <div className={`file-drop-hint ${isUploadingFiles ? 'uploading' : ''}`}>
                <Upload size={14} />
                {isUploadingFiles ? 'Uploading files…' : 'Drop files here for the project root, or onto a folder'}
              </div>
              {visibleFiles.map(({ node, depth }) => {
                const isExpanded = node.type === 'directory' && expandedPaths.has(node.path);
                const isJson = node.name.toLowerCase().endsWith('.json');
                const Icon = node.type === 'directory'
                  ? (isExpanded ? FolderOpen : Folder)
                  : isPreviewImage(node.path) ? ImageIcon : isJson ? FileJson : FileText;
                const isSelected = selectedArtifactPath === node.path;
                return (
                  <button
                    className={[
                      'file-row',
                      isSelected ? 'selected' : '',
                      node.type === 'directory' && uploadTargetPath === node.path ? 'upload-target' : '',
                      node.type === 'directory' && dragTargetPath === node.path ? 'drop-target' : ''
                    ].filter(Boolean).join(' ')}
                    key={node.path}
                    style={{ paddingLeft: `${12 + depth * 16}px` }}
                    onClick={() => {
                      if (node.type === 'directory') setUploadTargetPath(node.path);
                      void openFile(node);
                    }}
                    onDragEnter={node.type === 'directory'
                      ? (event) => {
                          if (event.dataTransfer.types.includes('Files')) {
                            event.preventDefault();
                            event.stopPropagation();
                            setDragTargetPath(node.path);
                          }
                        }
                      : undefined}
                    onDragOver={node.type === 'directory'
                      ? (event) => {
                          if (event.dataTransfer.types.includes('Files')) {
                            event.preventDefault();
                            event.stopPropagation();
                            event.dataTransfer.dropEffect = 'copy';
                          }
                        }
                      : undefined}
                    onDrop={node.type === 'directory'
                      ? (event) => handleFileDrop(event, node.path)
                      : undefined}
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
            </div>
            )}

            {artifactTab !== 'files' && <div className="preview-pane">
              <div className="preview-toolbar">
                <div className="preview-file-title">
                  {selectedImagePath ? <ImageIcon size={15} /> : isJsonSelected ? <Braces size={15} /> : <FileText size={15} />}
                  <span>{selectedArtifactPath || 'Select a file'}</span>
                  {isFileDirty && <small className="dirty-indicator">Unsaved</small>}
                  {isMarkdownSelected && publicationStatus && (
                    <small className={`publication-badge ${publicationStatus.reviewed ? 'reviewed' : 'draft'}`}>
                      {publicationStatus.reviewed ? 'Reviewed' : 'Draft'}
                    </small>
                  )}
                </div>
                <div className="file-actions">
                  {isMarkdownSelected && !publicationStatus?.reviewed && (
                    <button
                      className="review-button"
                      disabled={isFileDirty || isReviewingFile}
                      onClick={() => void markSelectedFileReviewed()}
                      title={isFileDirty ? 'Save changes before review' : 'Mark this saved version reviewed'}
                    >
                      <FileCheck2 size={13} /> {isReviewingFile ? 'Reviewing…' : 'Mark reviewed'}
                    </button>
                  )}
                  <button className="icon-button small" onClick={() => void createFile()} aria-label="Create text file" title="Create text file"><FilePlus2 size={14} /></button>
                  <button className="icon-button small" disabled={!selectedArtifactPath} onClick={() => void renameSelectedFile()} aria-label="Rename selected file" title="Rename"><Pencil size={14} /></button>
                  <button className="icon-button small" disabled={!isFileDirty || isSavingFile} onClick={() => void saveSelectedFile()} aria-label="Save selected file" title="Save"><Save size={14} /></button>
                  <button className="icon-button small danger-icon" disabled={!selectedArtifactPath} onClick={() => void deleteSelectedFile()} aria-label="Delete selected file" title="Delete"><Trash2 size={14} /></button>
                  <button className="icon-button small" onClick={() => setArtifactTab('files')} aria-label="Back to files" title="Files"><FolderOpen size={15} /></button>
                </div>
              </div>
              <div className="preview-content">
                {artifactTab === 'preview' && (
                  <div className="markdown-preview">
                    {selectedImagePath
                      ? (
                        <div className="image-preview">
                          <img src={imageUrl} alt={selectedImagePath.split('/').at(-1)} />
                          <small>{selectedImagePath}</small>
                        </div>
                      )
                      : selectedFile
                      ? isJsonSelected
                        ? <JsonPreview content={editorContent} />
                        : <ReactMarkdown remarkPlugins={[remarkGfm]}>{editorContent}</ReactMarkdown>
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
                      <div>
                        <ShieldCheck size={13} />
                        {browserStatus.active ? browserStatus.currentUrl ?? 'Edge session active' : 'Microsoft Edge capture is not running'}
                      </div>
                    </div>
                    <div className="browser-capture-panel">
                      <div className="browser-capture-heading">
                        <div>
                          <strong>Authenticated web evidence</strong>
                          <span>{browserStatus.active
                            ? `${browserStatus.headless ? 'Headless' : 'Visible'} Edge · profile retained for this project`
                            : 'Launch visible Edge, authenticate, navigate, then capture evidence.'}</span>
                        </div>
                        <label className="browser-headless">
                          <input
                            type="checkbox"
                            checked={browserHeadless}
                            disabled={browserStatus.active || browserBusy}
                            onChange={(event) => setBrowserHeadless(event.target.checked)}
                          />
                          Headless
                        </label>
                      </div>
                      <div className="browser-address-row">
                        <input
                          aria-label="Browser address"
                          value={browserUrl}
                          onChange={(event) => setBrowserUrl(event.target.value)}
                          placeholder="https://portal.example"
                        />
                        <button className="secondary-button" disabled={!browserStatus.active || browserBusy} onClick={() => void navigateBrowser()}>
                          <Globe2 size={14} /> Go
                        </button>
                      </div>
                      <div className="browser-address-row">
                        <input
                          aria-label="Screenshot output path"
                          value={browserOutputPath}
                          onChange={(event) => setBrowserOutputPath(event.target.value)}
                          placeholder="evidence/screenshots/portal.png (optional)"
                        />
                        <button className="secondary-button" disabled={!browserStatus.active || browserBusy} onClick={() => void captureBrowser()}>
                          <ImageIcon size={14} /> Capture
                        </button>
                      </div>
                      <div className="browser-actions">
                        {!browserStatus.active
                          ? <button className="dialog-primary" disabled={browserBusy} onClick={() => void launchBrowser()}><ExternalLink size={14} /> Launch Edge</button>
                          : <button className="secondary-button" disabled={browserBusy} onClick={() => void closeBrowser()}><X size={14} /> Close Edge</button>}
                        <small>HTTP and HTTPS addresses are allowed. Credentials remain in the project-scoped Edge profile and are never stored in package artifacts.</small>
                      </div>
                      {browserCapture && (
                        <button
                          className="browser-capture-result"
                          onClick={() => void openFile({ name: browserCapture.path.split('/').at(-1)!, path: browserCapture.path, type: 'file' })}
                        >
                          <img src={aaaApi.imageUrl(activeProjectId, browserCapture.path)} alt="Most recent browser capture" />
                          <span><strong>{browserCapture.path}</strong><small>{browserCapture.sourceUrl}</small></span>
                        </button>
                      )}
                    </div>
                    <div className="browser-published">
                      {publishedUrl ? (
                        <iframe
                          className="published-frame"
                          src={publishedUrl}
                          title={`Published preview of ${selectedFile?.path}`}
                          sandbox=""
                        />
                      ) : (
                        <div className="published-page published-empty">
                          <div className="published-brand"><BrandMark compact /> AAA Published</div>
                          <p className="eyebrow">{isMarkdownSelected ? 'Review required' : 'Local project preview'}</p>
                          <h2>{isMarkdownSelected ? 'This document is still a draft' : 'Select a Markdown document'}</h2>
                          <p>{isMarkdownSelected
                            ? 'Save the document and mark this exact version reviewed before opening its published Web view.'
                            : 'The Web view renders reviewed Markdown through AAA’s local published-preview route.'}</p>
                          {isMarkdownSelected && (
                            <button
                              className="dialog-primary"
                              disabled={isFileDirty || isReviewingFile}
                              onClick={() => void markSelectedFileReviewed()}
                            >
                              <FileCheck2 size={14} /> Mark reviewed
                            </button>
                          )}
                        </div>
                      )}
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
                        {filteredCustomizations.map((item) => {
                          const testResult = capabilityTests[item.id];
                          const testable = item.kind === 'mcp-server' || item.kind === 'tool';
                          return (
                          <article key={item.id} className={testResult ? 'has-diagnostic' : ''}>
                            <div>
                              <strong>{item.name}</strong>
                              <p>{item.description}</p>
                              <small>{item.detail ?? item.sourcePath ?? 'Project configuration'}</small>
                              {testResult && (
                                <div className={`capability-test-result ${testResult.ok ? 'success' : 'failure'}`}>
                                  <span>{testResult.ok ? <Check size={12} /> : <X size={12} />}{testResult.summary}</span>
                                  {testResult.tools && testResult.tools.length > 0 && (
                                    <ul>
                                      {testResult.tools.map((tool) => (
                                        <li key={tool.name}><code>{tool.name}</code>{tool.description && ` — ${tool.description}`}</li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                              )}
                            </div>
                            <div>
                              <span className={`customization-status ${item.status}`}><Check size={12} /> {item.status}</span>
                              {testable && (
                                <button
                                  className="capability-test-button"
                                  disabled={testingCapabilityId !== ''}
                                  onClick={() => void testCapability(item)}
                                >
                                  <RefreshCw size={12} className={testingCapabilityId === item.id ? 'spinning' : ''} />
                                  {testingCapabilityId === item.id ? 'Testing…' : 'Test'}
                                </button>
                              )}
                              <button
                                className={`toggle ${item.enabled ? 'on' : ''}`}
                                aria-label={`${item.enabled ? 'Disable' : 'Enable'} ${item.name}`}
                                onClick={() => void toggleCustomization(item)}
                              >
                                <span />
                              </button>
                              <button
                                className="icon-button small"
                                aria-label={`Open advanced settings for ${item.name}`}
                                title="Advanced settings"
                                onClick={() => void openCustomizationEditor(item)}
                              >
                                <Pencil size={14} />
                              </button>
                            </div>
                          </article>
                          );
                        })}
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
