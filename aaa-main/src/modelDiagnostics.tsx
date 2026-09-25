import { useRef, useState } from 'react';
import { Check, Copy, Play, Square, X } from 'lucide-react';
import { aaaApi } from './api/aaaApi';
import type { ModelConnectionStatus, ModelDiagnosticsReport } from './types/api';

const scenarioLabels = {
  text: 'Plain chat',
  tools: 'Tool definitions',
  'tool-history': 'Tool-result replay (skills, prompts, file edits)'
} as const;

/**
 * Model connection settings and an end-to-end diagnostic that tests Chat Completions
 * and Responses against the configured deployment.
 */
export function ModelDiagnosticsPanel({ status }: { status: ModelConnectionStatus | null }) {
  const [report, setReport] = useState<ModelDiagnosticsReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const current = report?.status ?? status;

  const run = async () => {
    setRunning(true);
    setError('');
    setCopied(false);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      setReport(await aaaApi.runModelDiagnostics(controller.signal));
    } catch (runError) {
      if (!controller.signal.aborted) {
        setError(runError instanceof Error ? runError.message : 'Diagnostics failed.');
      }
    } finally {
      controllerRef.current = null;
      setRunning(false);
    }
  };

  const recommendedJson = report?.recommended ? JSON.stringify(report.recommended, null, 2) : '';
  const settings: Array<[string, string | undefined]> = current
    ? [
      ['Connection', `${current.name} (${current.id})`],
      ['Endpoint host', current.endpointHost],
      ['Deployment', current.deployment],
      ['Endpoint kind', current.endpointKind],
      ['API', current.api],
      ['API version', current.apiVersion],
      ['Authentication', current.authMode],
      ['Adaptive retries', current.adaptive ? 'on' : 'off'],
      ['Context window', current.contextWindow ? `${current.contextWindow.toLocaleString()} tokens` : 'not set'],
      ['Auto-compaction', current.autoCompact ? `at ${Math.round(current.compactThreshold * 100)}%` : 'off']
    ]
    : [];

  return (
    <div className="model-diagnostics">
      <section className="model-settings">
        <header>
          <strong>Resolved connection</strong>
          <span className={`customization-status ${current?.ready ? 'ready' : 'unavailable'}`}>
            {current?.ready ? <Check size={12} /> : <X size={12} />} {current?.ready ? 'ready' : 'not ready'}
          </span>
        </header>
        {current && !current.ready && current.missing.length > 0 && (
          <p className="model-missing">Missing environment values: {current.missing.join(', ')}</p>
        )}
        <dl>
          {settings.map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{value || '—'}</dd></div>
          ))}
        </dl>
        <p className="model-hint">
          Values come from <code>config/agent-connections.json</code> and <code>.env</code>. Credentials are never shown.
        </p>
      </section>

      <div className="model-diagnostics-actions">
        <button
          className="capability-test-button"
          disabled={!current?.ready}
          onClick={() => (running ? controllerRef.current?.abort() : void run())}
        >
          {running ? <><Square size={12} /> Stop</> : <><Play size={12} /> Run diagnostics</>}
        </button>
        <small>
          {running
            ? 'Testing Chat Completions and Responses… each sends three small requests.'
            : 'Sends three small requests per API: plain chat, tool definitions, and a replayed tool result.'}
        </small>
      </div>
      {error && <div className="capability-test-result failure"><span><X size={12} />{error}</span></div>}

      {report && (
        <div className="model-diagnostics-results">
          {report.results.map((result) => (
            <section key={result.api} className={result.ok ? 'success' : 'failure'}>
              <header>
                <strong>{result.ok ? <Check size={13} /> : <X size={13} />} {result.api}</strong>
                <code title="Request URL (no credentials)">{result.url}</code>
              </header>
              <ul>
                {result.checks.map((check) => (
                  <li key={check.scenario} className={check.ok ? 'ok' : 'failed'}>
                    <span>{check.ok ? <Check size={12} /> : <X size={12} />} {scenarioLabels[check.scenario]}</span>
                    <small>{check.durationMs} ms</small>
                    <p>{check.detail}</p>
                  </li>
                ))}
              </ul>
              {result.adaptedTo && <p className="model-hint">Adapted to: {result.adaptedTo}</p>}
              {result.notes.map((note, index) => <p className="model-hint" key={index}>{note}</p>)}
            </section>
          ))}
          {report.recommended
            ? (
              <section className="model-recommendation">
                <header>
                  <strong>Recommended settings</strong>
                  <button
                    className="capability-test-button"
                    onClick={() => void navigator.clipboard?.writeText(recommendedJson).then(() => setCopied(true))}
                  >
                    {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                  </button>
                </header>
                <pre>{recommendedJson}</pre>
                <p className="model-hint">Add these fields to the connection in <code>config/agent-connections.json</code> and restart AAA.</p>
              </section>
            )
            : (
              <p className="capability-test-result failure">
                <span><X size={12} />No API passed every check. Review the endpoint, api-version, deployment, and model support above.</span>
              </p>
            )}
          <p className="model-hint">Tested {new Date(report.testedAt).toLocaleString()}.</p>
        </div>
      )}
    </div>
  );
}
