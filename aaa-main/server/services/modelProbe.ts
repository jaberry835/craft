import type {
  ModelApi,
  ModelChatMessage,
  ModelToolDefinition,
  ResolvedModelConnection
} from '../modelTypes.js';
import { AzureOpenAiChatClient, describeShape, type ModelRequestShape } from './azureOpenAiChatClient.js';

type Fetch = typeof globalThis.fetch;

export interface ModelProbeCheck {
  scenario: 'text' | 'tools' | 'tool-history';
  ok: boolean;
  detail: string;
}

export interface ModelProbeApiResult {
  api: ModelApi;
  ok: boolean;
  checks: ModelProbeCheck[];
  learned?: ModelRequestShape;
  notes: string[];
}

export interface ModelProbeReport {
  results: ModelProbeApiResult[];
  recommended?: { api: ModelApi; tokenParameter: string; temperature?: number | null };
}

const pingTool: ModelToolDefinition = {
  type: 'function',
  function: {
    name: 'aaa_probe_ping',
    description: 'Connectivity probe tool. Returns "pong".',
    parameters: { type: 'object', properties: { note: { type: 'string' } } }
  }
};

const scenarios: Array<{ id: ModelProbeCheck['scenario']; messages: ModelChatMessage[]; tools?: ModelToolDefinition[] }> = [
  {
    id: 'text',
    messages: [{ role: 'system', content: 'You are a connectivity probe.' }, { role: 'user', content: 'Reply with the single word OK.' }]
  },
  {
    id: 'tools',
    messages: [{ role: 'system', content: 'You are a connectivity probe.' }, { role: 'user', content: 'Reply with the single word OK. Do not call tools.' }],
    tools: [pingTool]
  },
  {
    // Mirrors the second round of a skill or prompt run: an assistant tool call plus its result.
    id: 'tool-history',
    messages: [
      { role: 'system', content: 'You are a connectivity probe.' },
      { role: 'user', content: 'Call aaa_probe_ping, then reply with the single word OK.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_aaaprobe1', type: 'function', function: { name: 'aaa_probe_ping', arguments: '{}' } }]
      },
      { role: 'tool', content: 'pong', toolCallId: 'call_aaaprobe1' }
    ],
    tools: [pingTool]
  }
];

/**
 * Sends three small requests per API (plain text, tool definitions, and a replayed tool
 * result) so an operator can see which wire protocol and parameters a deployment accepts.
 */
export async function probeModelConnection(
  base: ResolvedModelConnection,
  options: { fetchImpl?: Fetch; apis?: ModelApi[] } = {}
): Promise<ModelProbeReport> {
  const results: ModelProbeApiResult[] = [];
  for (const api of options.apis ?? ['chat-completions', 'responses']) {
    const notes: string[] = [];
    const client = new AzureOpenAiChatClient(options.fetchImpl, undefined, (message) => notes.push(message));
    const connection: ResolvedModelConnection = {
      ...base,
      definition: {
        ...base.definition,
        id: `${base.definition.id}#probe-${api}`,
        api,
        maxTokens: Math.min(base.definition.maxTokens ?? 16000, 2048)
      }
    };
    const checks: ModelProbeCheck[] = [];
    const quietError = console.error;
    console.error = () => {};
    try {
      for (const scenario of scenarios) {
        try {
          let text = '';
          for await (const chunk of client.stream(connection, scenario.messages, AbortSignal.timeout(120_000), scenario.tools)) {
            if (chunk.type === 'assistant_text') text += chunk.text;
          }
          checks.push({ scenario: scenario.id, ok: true, detail: text.trim().slice(0, 60) || '(no text)' });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Reaching the output limit still proves the request shape was accepted.
          const accepted = /token output limit/.test(message);
          checks.push({ scenario: scenario.id, ok: accepted, detail: accepted ? 'accepted (hit output limit)' : message });
        }
      }
    } finally {
      console.error = quietError;
    }
    results.push({
      api,
      ok: checks.every((check) => check.ok),
      checks,
      learned: client.learnedShape(connection),
      notes
    });
  }

  const configured = base.definition.api ?? 'auto';
  const working = results.find((result) => result.ok && result.api === configured)
    ?? results.find((result) => result.ok);
  return {
    results,
    recommended: working
      ? {
        api: working.api,
        tokenParameter: working.learned?.tokenParameter ?? base.definition.tokenParameter ?? 'auto',
        ...(working.learned && !working.learned.temperature ? { temperature: null } : {})
      }
      : undefined
  };
}

export function formatProbeReport(report: ModelProbeReport): string {
  const labels: Record<ModelProbeCheck['scenario'], string> = {
    text: 'plain chat',
    tools: 'tool definitions',
    'tool-history': 'tool-result replay (skills/prompts)'
  };
  const lines: string[] = [];
  for (const result of report.results) {
    lines.push(`${result.ok ? 'PASS' : 'FAIL'}  ${result.api}`);
    for (const check of result.checks) {
      lines.push(`  ${check.ok ? 'ok  ' : 'FAIL'}  ${labels[check.scenario]}: ${check.detail}`);
    }
    if (result.learned) lines.push(`  adapted to: ${describeShape(result.learned)}`);
    for (const note of result.notes) lines.push(`  note: ${note}`);
    lines.push('');
  }
  if (report.recommended) {
    lines.push('Recommended settings for config/agent-connections.json:');
    lines.push(JSON.stringify(report.recommended, null, 2));
  } else {
    lines.push('No API passed every check. Review the failures above (endpoint, api-version, deployment, and model support).');
  }
  return lines.join('\n');
}
