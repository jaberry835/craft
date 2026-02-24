import { useState, useRef, useEffect, useCallback, type FormEvent } from 'react';
import { MessageSquare, Send, Sparkles, Bot, User, Loader2, AlertCircle, ShieldCheck, FileText, RotateCcw, ExternalLink } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useFormContext } from '../contexts/FormContext';
import { getPolicyById } from '../data/policies';
import type { PolicyMeta } from '../data/policies';
import type { RequestFormData } from '../types/request';
import PolicyModal from './PolicyModal';
import './ChatPanel.css';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

// ── Types ───────────────────────────────────────────────────
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

// ── SSE helpers ─────────────────────────────────────────────

async function* streamChat(
  message: string,
  sessionId: string,
  formData: RequestFormData,
): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, session_id: sessionId, form_data: formData }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Server error: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE lines
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    let currentEvent = 'message';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        const raw = line.slice(6);
        try {
          yield { event: currentEvent, data: JSON.parse(raw) };
        } catch {
          yield { event: currentEvent, data: { text: raw } };
        }
        currentEvent = 'message';
      }
    }
  }
}

// ── Component ───────────────────────────────────────────────

export default function ChatPanel() {
  const { formData, updateForm, resetForm } = useFormContext();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId] = useState(() => crypto.randomUUID());
  const [backendAvailable, setBackendAvailable] = useState<boolean | null>(null);
  const [modalPolicy, setModalPolicy] = useState<{ policy: PolicyMeta; hash?: string } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Open a policy in the popup modal */
  const openPolicyModal = useCallback((href: string) => {
    // href like "/policies/directive-1200#section-2-1"
    const [path, hash] = href.split('#');
    const slug = path.replace('/policies/', '');
    const policy = getPolicyById(slug);
    if (policy) {
      setModalPolicy({ policy, hash: hash ? `#${hash}` : undefined });
    } else {
      navigate(href);
    }
  }, [navigate]);

  /** Open a policy in a new browser tab */
  const openPolicyInTab = useCallback((href: string) => {
    window.open(href, '_blank');
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Check backend health on mount
  useEffect(() => {
    fetch(`${API_BASE}/api/health`)
      .then((r) => r.ok && setBackendAvailable(true))
      .catch(() => setBackendAvailable(false));
  }, []);

  const handleSubmit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const userText = input.trim();
      if (!userText || isStreaming) return;

      // Add user message
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: userText,
        timestamp: new Date(),
      };

      // Add placeholder for assistant
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput('');
      setIsStreaming(true);

      try {
        for await (const { event, data } of streamChat(userText, sessionId, formData)) {
          if (event === 'token') {
            const text = (data as { text?: string }).text ?? '';
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last.role === 'assistant') {
                next[next.length - 1] = { ...last, content: last.content + text };
              }
              return next;
            });
          } else if (event === 'tool_call') {
            // Apply form field updates from agent tools
            const field = (data as { field?: string }).field;
            const value = (data as { value?: string }).value;
            if (field && value !== undefined) {
              // Convert numeric strings for numeric fields
              if (field === 'quantity') {
                updateForm({ [field]: Number(value) || null });
              } else {
                updateForm({ [field]: value } as Partial<RequestFormData>);
              }
            }
          } else if (event === 'error') {
            const errMsg = (data as { message?: string }).message ?? 'Unknown error';
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last.role === 'assistant') {
                next[next.length - 1] = { ...last, content: `⚠️ ${errMsg}` };
              }
              return next;
            });
          }
          // 'done' event — nothing extra to do
        }
      } catch (err) {
        const errText = err instanceof Error ? err.message : 'Connection failed';
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last.role === 'assistant') {
            next[next.length - 1] = {
              ...last,
              content: `⚠️ ${errText}. Make sure the backend is running on ${API_BASE}.`,
            };
          }
          return next;
        });
      } finally {
        setIsStreaming(false);
        inputRef.current?.focus();
      }
    },
    [input, isStreaming, sessionId, formData, updateForm],
  );

  const handleQuickAction = useCallback(
    (text: string) => {
      setInput(text);
      // Small delay so the input renders, then submit
      setTimeout(() => {
        const form = document.querySelector('.chat-input-form') as HTMLFormElement | null;
        form?.requestSubmit();
      }, 50);
    },
    [],
  );

  // ── Render ────────────────────────────────────────────────

  const showWelcome = messages.length === 0;

  return (
    <div className="chat-panel">
      {/* Chat Header */}
      <div className="chat-header">
        <div className="chat-header-info">
          <div className="chat-avatar">
            <Sparkles size={16} />
          </div>
          <div>
            <div className="chat-title">PixelPress AI</div>
            <div className="chat-status">
              <span className={`status-dot ${backendAvailable === false ? 'offline' : ''}`} />
              {backendAvailable === false ? 'Offline' : 'Online'}
            </div>
          </div>
        </div>
        <div className="chat-header-actions">
          <button
            className="validate-shortcut-btn"
            onClick={() => handleQuickAction('Please validate my current request form')}
            disabled={isStreaming}
            title="Validate form against FCA policies"
          >
            <ShieldCheck size={14} />
            Validate
          </button>
          <button
            className="clear-form-btn"
            onClick={resetForm}
            title="Clear all form fields"
          >
            <RotateCcw size={14} />
          </button>
        </div>
      </div>
      <div className="chat-messages">
        {showWelcome && (
          <div className="chat-welcome">
            <div className="welcome-icon">
              <MessageSquare size={32} />
            </div>
            <h3>Welcome to PixelPress AI</h3>
            <p>
              I can help you create print &amp; digital media requests, validate
              them against FCA policies, and estimate costs.
            </p>
            <div className="quick-actions">
              <button
                className="quick-action-btn"
                onClick={() => handleQuickAction('I need to create a new print request for posters')}
              >
                🖼️ Request posters
              </button>
              <button
                className="quick-action-btn"
                onClick={() => handleQuickAction('Help me create social media graphics')}
              >
                📱 Social media assets
              </button>
              <button
                className="quick-action-btn"
                onClick={() => handleQuickAction("What are the brand color requirements?")}
              >
                🎨 Brand guidelines
              </button>
              <button
                className="quick-action-btn"
                onClick={() => handleQuickAction('Validate my current request')}
              >
                ✅ Validate request
              </button>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`chat-bubble-row ${msg.role}`}>
            <div className={`chat-bubble-avatar ${msg.role}`}>
              {msg.role === 'user' ? <User size={14} /> : <Bot size={14} />}
            </div>
            <div className={`chat-bubble ${msg.role}`}>
              {!msg.content ? (
                <span className="chat-typing">
                  <Loader2 size={14} className="spin" /> Thinking…
                </span>
              ) : msg.role === 'assistant' ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ href, children }) => {
                      // In-app policy links: /policies/directive-XXXX...
                      if (href?.startsWith('/policies/')) {
                        return (
                          <span className="policy-link-group">
                            <a
                              href={href}
                              className="policy-link"
                              onClick={(e) => {
                                e.preventDefault();
                                openPolicyModal(href);
                              }}
                            >
                              <FileText size={12} />
                              {children}
                            </a>
                            <button
                              className="policy-open-tab-btn"
                              onClick={() => openPolicyInTab(href)}
                              title="Open in main view"
                            >
                              <ExternalLink size={10} />
                            </button>
                          </span>
                        );
                      }
                      // External links
                      return (
                        <a href={href} target="_blank" rel="noopener noreferrer">
                          {children}
                        </a>
                      );
                    },
                    // Keep paragraphs compact inside chat bubbles
                    p: ({ children }) => <p className="chat-md-p">{children}</p>,
                  }}
                >
                  {msg.content}
                </ReactMarkdown>
              ) : (
                msg.content
              )}
            </div>
          </div>
        ))}

        {backendAvailable === false && messages.length === 0 && (
          <div className="chat-notice">
            <AlertCircle size={14} />
            <span>
              Backend not detected at {API_BASE}. Start the backend server to
              enable chat.
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <form className="chat-input-area chat-input-form" onSubmit={handleSubmit}>
        <div className="chat-input-wrapper">
          <input
            ref={inputRef}
            type="text"
            className="chat-input"
            placeholder="Ask about policies, costs, or fill in your request…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isStreaming}
          />
          <button
            type="submit"
            className="send-btn"
            disabled={isStreaming || !input.trim()}
          >
            {isStreaming ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
          </button>
        </div>
        <div className="chat-footer-text">
          Powered by Microsoft Agent Framework + Azure OpenAI
        </div>
      </form>

      {/* Policy popup modal */}
      {modalPolicy && (
        <PolicyModal
          policy={modalPolicy.policy}
          hash={modalPolicy.hash}
          onClose={() => setModalPolicy(null)}
          onOpenTab={openPolicyInTab}
        />
      )}
    </div>
  );
}
