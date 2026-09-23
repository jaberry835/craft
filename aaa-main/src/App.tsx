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
  Search,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  TerminalSquare,
  UserRound,
  Wrench
} from 'lucide-react';
import './App.css';

type PreviewMode = 'preview' | 'source' | 'browser';
type ArtifactTab = 'files' | PreviewMode;
type Theme = 'light' | 'dark';
type FileKind = 'folder' | 'markdown' | 'json';

interface WorkspaceFile {
  name: string;
  kind: FileKind;
  depth: number;
  open?: boolean;
  selected?: boolean;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const files: WorkspaceFile[] = [
  { name: 'security-package', kind: 'folder', depth: 0, open: true },
  { name: 'background-docs', kind: 'folder', depth: 1 },
  { name: 'cloud-scan', kind: 'folder', depth: 1 },
  { name: 'control-responses', kind: 'folder', depth: 1, open: true },
  { name: 'AU', kind: 'folder', depth: 2, open: true },
  { name: 'AU-2.md', kind: 'markdown', depth: 3 },
  { name: 'SC', kind: 'folder', depth: 2 },
  { name: 'security-standards', kind: 'folder', depth: 1 },
  { name: 'standard-docs', kind: 'folder', depth: 1, open: true },
  { name: 'artifact-index.md', kind: 'markdown', depth: 2 },
  { name: 'evidence-register.md', kind: 'markdown', depth: 2 },
  { name: 'validation-report.md', kind: 'markdown', depth: 2, selected: true },
  { name: 'package-config.json', kind: 'json', depth: 1 }
];

const markdownContent = `# Validation report

**Package:** Atlas Authorization Package  
**Scope:** AU-2, SC-7  
**Overall result:** Ready for human review

## Summary

| Result | Count |
| --- | ---: |
| Pass | 12 |
| Warning | 2 |
| Fail | 0 |

## Findings

### AU-2 · Event logging

**Determination:** Satisfied

All required event categories are configured in the current policy. Configuration values are supported by evidence **EV-0001** and **EV-0002**.

### SC-7 · Boundary protection

**Determination:** Partially Satisfied

Network controls are present. Reviewer confirmation is still required for the documented exception path.

> AI-generated assessment aid. Final authorization decisions remain with the designated human reviewer.
`;

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

const initialMessages: ChatMessage[] = [];
const themeStorageKey = 'aaa-theme';

const sessions = [
  { title: 'Build AU-2 and SC-7', detail: 'Just now', active: true },
  { title: 'Validate package evidence', detail: 'Yesterday' },
  { title: 'Initialize security package', detail: 'Sep 18' }
];

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
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [selectedFile, setSelectedFile] = useState('validation-report.md');
  const activeProject = 'Atlas Authorization';
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const shellStyle = useMemo(() => ({
    '--left-width': leftOpen ? `${leftWidth}px` : '0px',
    '--right-width': rightOpen ? `${rightWidth}px` : '0px'
  }) as React.CSSProperties, [leftOpen, leftWidth, rightOpen, rightWidth]);

  useEffect(() => {
    window.localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  useEffect(() => {
    if (!isThinking) {
      return;
    }

    const timer = window.setTimeout(() => {
      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: 'I’ll use the **Security Package Builder** workflow and ground each response in local evidence. I found 2 controls in scope and will preserve the human-review boundary while generating the draft package.'
        }
      ]);
      setIsThinking(false);
    }, 900);

    return () => window.clearTimeout(timer);
  }, [isThinking]);

  const sendMessage = useCallback((content = draft) => {
    const trimmed = content.trim();
    if (!trimmed || isThinking) {
      return;
    }

    setMessages((current) => [...current, { role: 'user', content: trimmed }]);
    setDraft('');
    setIsThinking(true);
  }, [draft, isThinking]);

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

        <button className="project-switcher">
          <span className="project-icon">AT</span>
          <span>{activeProject}</span>
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
              <button className="icon-button small" aria-label="Create session"><Plus size={16} /></button>
            </div>

            <label className="search-box">
              <Search size={15} />
              <input aria-label="Search sessions" placeholder="Search sessions" />
              <kbd>⌘ K</kbd>
            </label>

            <div className="project-list">
              {sessions.map((session, index) => (
              <button className={`project-row ${session.active ? 'active' : ''}`} key={session.title}>
                <span className={`session-icon ${index === 0 ? 'active' : ''}`}><MessageSquareText size={14} /></span>
                <span>
                  <strong>{session.title}</strong>
                  <small>{session.detail}</small>
                </span>
                {index === 0 && <MoreHorizontal size={16} />}
              </button>
              ))}
            </div>

            <div className="sidebar-section customizations">
              <div className="sidebar-label">Capabilities</div>
              <SidebarItem icon={Bot} label="Agents" count={1} />
              <SidebarItem icon={Sparkles} label="Skills" count={4} />
              <SidebarItem icon={Server} label="MCP servers" count={1} />
              <SidebarItem icon={Wrench} label="Tools" count={6} />
            </div>

            <div className="connection-card">
              <div className="connection-icon"><Server size={16} /></div>
              <div>
                <strong>Publisher connected</strong>
                <span>localhost:3000</span>
              </div>
              <span className="status-dot" />
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
                <small><span className="online-dot" /> Ready</small>
              </span>
            </div>
            <div>
              <button className="secondary-button"><Plus size={15} /> New session</button>
              <button className="icon-button" aria-label="Session options"><MoreHorizontal size={18} /></button>
            </div>
          </div>

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
                {messages.map((message, index) => (
                  <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
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
                      <div className="thinking"><i /><i /><i /></div>
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
                <button className="send-button" onClick={() => sendMessage()} disabled={!draft.trim() || isThinking} aria-label="Send message">
                  <Send size={16} />
                </button>
              </div>
            </div>
            <div className="composer-meta">
              <button><Bot size={13} /> Security Package Builder <ChevronDown size={12} /></button>
              <span>Grounded in this workspace</span>
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
                <button className="icon-button small"><MoreHorizontal size={15} /></button>
              </div>
              {files.map((file, index) => {
                const Icon = file.kind === 'folder'
                  ? (file.open ? FolderOpen : Folder)
                  : file.kind === 'json' ? FileJson : FileText;
                const isSelected = selectedFile === file.name;
                return (
                  <button
                    className={`file-row ${isSelected ? 'selected' : ''}`}
                    key={`${file.name}-${index}`}
                    style={{ paddingLeft: `${12 + file.depth * 16}px` }}
                    onClick={() => {
                      if (file.kind !== 'folder') {
                        setSelectedFile(file.name);
                        setArtifactTab(file.kind === 'markdown' ? 'preview' : 'source');
                      }
                    }}
                  >
                    {file.kind === 'folder'
                      ? (file.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)
                      : <span className="tree-spacer" />}
                    <Icon size={15} />
                    <span>{file.name}</span>
                    {file.name === 'validation-report.md' && <Check size={13} className="file-check" />}
                  </button>
                );
              })}
            </div>}

            {artifactTab !== 'files' && <div className="preview-pane">
              <div className="preview-toolbar">
                <div className="preview-file-title">
                  <FileText size={15} />
                  <span>{selectedFile}</span>
                </div>
                <button className="icon-button small" onClick={() => setArtifactTab('files')} aria-label="Back to files"><FolderOpen size={15} /></button>
              </div>
              <div className="preview-content">
                {artifactTab === 'preview' && (
                  <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{markdownContent}</ReactMarkdown></div>
                )}
                {artifactTab === 'source' && (
                  <pre className="source-preview"><code>{markdownContent}</code></pre>
                )}
                {artifactTab === 'browser' && (
                  <div className="browser-preview">
                    <div className="browser-bar">
                      <span /><span /><span />
                      <div><ShieldCheck size={13} /> aaa.local/package/validation-report</div>
                    </div>
                    <div className="published-page">
                      <div className="published-brand"><BrandMark compact /> AAA Published</div>
                      <p className="eyebrow">Authorization package</p>
                      <h2>Validation report</h2>
                      <div className="published-status"><Check size={16} /> Ready for human review</div>
                      <p>12 checks passed with 2 reviewer warnings and no blocking failures.</p>
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
          <span><Database size={12} /> 6 evidence items</span>
          <span><Link2 size={12} /> 1 MCP connected</span>
          <span><TerminalSquare size={12} /> No active runs</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
