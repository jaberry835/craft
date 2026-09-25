import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, Gauge, Layers } from 'lucide-react';
import type { RunUsage, SessionCompaction } from './types/api';
import { formatTokens, usageTitle } from './usageMath';

/** Compact per-turn token summary shown under assistant messages. */
export function UsageLine({ usage, live = false }: { usage: RunUsage; live?: boolean }) {
  const cachedShare = usage.inputTokens > 0 ? Math.round((usage.cachedInputTokens / usage.inputTokens) * 100) : 0;
  return (
    <div className="usage-line" title={usageTitle(usage)}>
      <Gauge size={11} />
      <span>{usage.estimated ? '~' : ''}{formatTokens(usage.inputTokens)} in</span>
      {usage.cachedInputTokens > 0 && <span>{cachedShare}% cached</span>}
      <span>{formatTokens(usage.outputTokens)} out</span>
      {usage.reasoningTokens > 0 && <span>{formatTokens(usage.reasoningTokens)} reasoning</span>}
      <span>{usage.requests} request{usage.requests === 1 ? '' : 's'}</span>
      {live && <em>live</em>}
    </div>
  );
}

export function ContextMeter({
  context,
  contextWindow,
  usage,
  threshold,
  busy,
  compactDisabled,
  onCompact
}: {
  context?: { tokens: number; approximate: boolean };
  contextWindow?: number;
  usage?: RunUsage;
  threshold: number;
  busy: boolean;
  compactDisabled: boolean;
  onCompact: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const share = context && contextWindow ? Math.min(1, context.tokens / contextWindow) : undefined;
  const level = share === undefined ? '' : share >= threshold ? 'high' : share >= threshold * 0.75 ? 'medium' : '';
  const label = context
    ? `${context.approximate ? '~' : ''}${formatTokens(context.tokens)}${contextWindow ? ` / ${formatTokens(contextWindow)}` : ''}`
    : 'No usage yet';
  const percentage = share === undefined ? undefined : Math.round(share * 100);
  const cachedShare = usage && usage.inputTokens > 0
    ? Math.round((usage.cachedInputTokens / usage.inputTokens) * 100)
    : 0;

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className="context-meter-shell" ref={containerRef}>
      <button
        className={`context-meter ${level}`}
        onClick={() => setOpen((current) => !current)}
        title="View session token and context details"
        aria-label={`Context ${label}. View session info`}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Layers size={12} />
        {share !== undefined && (
          <span className="context-meter-bar" aria-hidden="true"><i style={{ width: `${Math.max(3, share * 100)}%` }} /></span>
        )}
        <span>{label}</span>
        <ChevronDown size={11} className={open ? 'context-meter-chevron open' : 'context-meter-chevron'} />
      </button>
      {open && (
        <div className="session-info-popover" role="dialog" aria-label="Session token information">
          <h3>Session Info</h3>
          <section>
            <div className="session-info-heading">
              <span>Session Tokens</span>
              <strong>{usage ? `${usage.estimated ? '~' : ''}${formatTokens(usage.totalTokens)}` : '—'}</strong>
            </div>
            <dl className="session-token-grid">
              <div><dt>Input</dt><dd>{usage ? formatTokens(usage.inputTokens) : '—'}</dd></div>
              <div><dt>Cached input</dt><dd>{usage ? `${formatTokens(usage.cachedInputTokens)}${cachedShare ? ` (${cachedShare}%)` : ''}` : '—'}</dd></div>
              <div><dt>Output</dt><dd>{usage ? formatTokens(usage.outputTokens) : '—'}</dd></div>
              <div><dt>Reasoning</dt><dd>{usage ? formatTokens(usage.reasoningTokens) : '—'}</dd></div>
              <div><dt>Model requests</dt><dd>{usage?.requests ?? '—'}</dd></div>
            </dl>
          </section>
          <section>
            <div className="session-info-heading">
              <span>Context Window</span>
              <strong>{percentage === undefined ? 'Not configured' : `${percentage}%`}</strong>
            </div>
            <div className="session-context-value">{label} tokens</div>
            <div className={`session-context-bar ${level}`} aria-hidden="true">
              <i style={{ width: `${Math.max(share === undefined ? 0 : 3, (share ?? 0) * 100)}%` }} />
            </div>
            <small>
              {contextWindow
                ? `Automatic compaction at ${Math.round(threshold * 100)}% of the configured window.`
                : 'Set contextWindow in the model connection to enable context limits and automatic compaction.'}
            </small>
          </section>
          <button
            className="session-compact-button"
            onClick={onCompact}
            disabled={compactDisabled || busy}
          >
            {busy ? 'Compacting Conversation…' : 'Compact Conversation'}
          </button>
        </div>
      )}
    </div>
  );
}

export function CompactionDivider({ compaction }: { compaction: SessionCompaction }) {
  return (
    <details className="compaction-divider">
      <summary>
        <Layers size={12} />
        <span>
          {compaction.trigger === 'auto' ? 'Automatically compacted' : 'Compacted'} · {compaction.messagesCompacted} message
          {compaction.messagesCompacted === 1 ? '' : 's'} · ~{formatTokens(compaction.estimatedTokensBefore)} → ~
          {formatTokens(compaction.estimatedTokensAfter)} tokens
        </span>
        <ChevronDown size={12} className="detail-chevron" />
      </summary>
      <div className="compaction-summary">
        <small>
          Messages above remain visible here, but the model now sees this summary instead of them.
          {compaction.focus ? ` Focus: ${compaction.focus}` : ''}
        </small>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{compaction.summary}</ReactMarkdown>
      </div>
    </details>
  );
}
