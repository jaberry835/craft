import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contextEstimate,
  formatTokens,
  sessionUsage,
  sessionUsageTitle,
  usageTitle
} from '../../src/usageMath.js';
import type { AgentRun, ChatSession, RunUsage } from '../../src/types/api.js';

const usage = (overrides: Partial<RunUsage> = {}): RunUsage => ({
  inputTokens: 1_000,
  cachedInputTokens: 200,
  outputTokens: 300,
  reasoningTokens: 100,
  totalTokens: 1_300,
  requests: 2,
  promptTokens: 900,
  peakInputTokens: 1_100,
  estimated: false,
  ...overrides
});

const run = (id: string, runUsage?: RunUsage, completedAt = '2026-09-30T12:00:00.000Z'): AgentRun => ({
  id,
  status: 'completed',
  startedAt: '2026-09-30T11:59:00.000Z',
  completedAt,
  userMessageId: `message-${id}`,
  modelConnectionId: 'model',
  reasoning: '',
  toolEvents: [],
  changedFiles: [],
  usage: runUsage
});

test('token display helpers format thresholds and optional usage details', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1_500), '1.5k');
  assert.equal(formatTokens(15_000), '15k');
  assert.equal(formatTokens(1_250_000), '1.25M');
  assert.match(usageTitle(usage({ estimated: true })), /Model requests: 2/);
  assert.match(usageTitle(usage({ estimated: true })), /estimated/);
  assert.match(sessionUsageTitle(usage()), /^Session usage\nInput:/);
});

test('session usage aggregates measured runs and ignores unmeasured runs', () => {
  assert.equal(sessionUsage([run('unmeasured')]), undefined);
  assert.deepEqual(
    sessionUsage([
      run('first', usage()),
      run('unmeasured'),
      run('second', usage({
        inputTokens: 500,
        cachedInputTokens: 50,
        outputTokens: 200,
        reasoningTokens: 25,
        totalTokens: 700,
        requests: 1,
        peakInputTokens: 800,
        estimated: true
      }))
    ]),
    {
      inputTokens: 1_500,
      cachedInputTokens: 250,
      outputTokens: 500,
      reasoningTokens: 125,
      totalTokens: 2_000,
      requests: 3,
      promptTokens: 0,
      peakInputTokens: 1_100,
      estimated: true
    }
  );
});

test('context estimates use the newest measured run and account for later compaction', () => {
  const session: ChatSession = {
    id: 'session',
    projectId: 'project',
    title: 'Session',
    createdAt: '2026-09-30T11:00:00.000Z',
    updatedAt: '2026-09-30T13:00:00.000Z',
    messageCount: 0,
    messages: [],
    runs: [
      run('first', usage({ peakInputTokens: 2_000 }), '2026-09-30T12:00:00.000Z'),
      run('second', usage({ peakInputTokens: 3_000, estimated: true }), '2026-09-30T12:30:00.000Z')
    ],
    compactions: [{
      id: 'compaction',
      createdAt: '2026-09-30T12:45:00.000Z',
      trigger: 'manual',
      throughMessageId: 'message',
      summary: 'Summary',
      messagesCompacted: 4,
      estimatedTokensBefore: 2_500,
      estimatedTokensAfter: 500
    }]
  };

  assert.deepEqual(contextEstimate(session), { tokens: 1_000, approximate: true });
  assert.equal(contextEstimate(null), undefined);
});
