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
  threshold,
  busy,
  disabled,
  onCompact
}: {
  context?: { tokens: number; approximate: boolean };
  contextWindow?: number;
  threshold: number;
  busy: boolean;
  disabled: boolean;
  onCompact: () => void;
}) {
  const share = context && contextWindow ? Math.min(1, context.tokens / contextWindow) : undefined;
  const level = share === undefined ? '' : share >= threshold ? 'high' : share >= threshold * 0.75 ? 'medium' : '';
  const label = context
    ? `${context.approximate ? '~' : ''}${formatTokens(context.tokens)}${contextWindow ? ` / ${formatTokens(contextWindow)}` : ''}`
    : 'No usage yet';
  const title = [
    context ? `Context used by the latest request: ${context.approximate ? 'about ' : ''}${context.tokens.toLocaleString()} tokens.` : 'No measured request yet.',
    contextWindow
      ? `Configured window ${contextWindow.toLocaleString()} tokens; auto-compaction at ${Math.round(threshold * 100)}%.`
      : 'Set contextWindow in config/agent-connections.json to enable the meter and auto-compaction.',
    'Click to compact the conversation now (or type /compact).'
  ].join('\n');
  return (
    <button
      className={`context-meter ${level}`}
      onClick={onCompact}
      disabled={disabled || busy}
      title={title}
      aria-label={`Context ${label}. Compact conversation`}
    >
      <Layers size={12} />
      {share !== undefined && (
        <span className="context-meter-bar" aria-hidden="true"><i style={{ width: `${Math.max(3, share * 100)}%` }} /></span>
      )}
      <span>{busy ? 'Compacting…' : label}</span>
    </button>
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
