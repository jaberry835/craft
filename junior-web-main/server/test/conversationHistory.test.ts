import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConversationHistoryArchiver, conversationHistoryFolder } from '../services/conversationHistoryArchiver.js';
import { LocalWorkspaceStorage } from '../services/localWorkspaceStorage.js';
import type { ChatSession } from '../types.js';
import { cleanupHarness, createHarness, FakeAzureOpenAiChatClient, startHarnessServer, stopHarnessServer } from './testHarness.js';

function buildSession(): ChatSession {
  return {
    id: 'session-123',
    title: 'Investigate workspace layout',
    agentId: 'security-package-drafter',
    createdAt: '2026-06-16T10:00:00.000Z',
    updatedAt: '2026-06-16T10:05:00.000Z',
    messageCount: 2,
    messages: [
      {
        id: 'user-1',
        role: 'user',
        content: 'What is in this workspace?',
        createdAt: '2026-06-16T10:00:00.000Z'
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'It contains a README and a package folder.',
        createdAt: '2026-06-16T10:05:00.000Z',
        display: [
          { kind: 'reasoning', text: 'The user wants an overview, so I inspected the index.' },
          {
            kind: 'working',
            title: 'Reviewed the workspace',
            events: [
              {
                id: 'event-1',
                type: 'read',
                label: 'Read README.md',
                filePath: 'README.md',
                createdAt: '2026-06-16T10:04:00.000Z'
              }
            ]
          }
        ]
      }
    ]
  };
}

test('archiver writes a session transcript with reasoning when enabled', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'junior-web-history-'));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));

  const storage = new LocalWorkspaceStorage(rootDir);
  await storage.ensureSeedWorkspace();
  const archiver = new ConversationHistoryArchiver(storage);
  const session = buildSession();

  await archiver.archiveSession(session, { includeReasoning: true });

  const readme = await storage.readTextFile(`${conversationHistoryFolder}/README.md`);
  assert.match(readme.content, /# Conversation History/);

  assert.match(archiver.sessionFileName(session), /^2026-06-16_\d{6}-/);
  const transcript = await storage.readTextFile(archiver.sessionPath(session));
  assert.match(transcript.content, /What is in this workspace\?/);
  assert.match(transcript.content, /It contains a README and a package folder\./);
  assert.match(transcript.content, /### Reasoning/);
  assert.match(transcript.content, /The user wants an overview/);
  assert.match(transcript.content, /Read README\.md/);
});

test('archiver omits reasoning when includeReasoning is false', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'junior-web-history-'));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));

  const storage = new LocalWorkspaceStorage(rootDir);
  await storage.ensureSeedWorkspace();
  const archiver = new ConversationHistoryArchiver(storage);
  const session = buildSession();

  await archiver.archiveSession(session, { includeReasoning: false });

  const transcript = await storage.readTextFile(archiver.sessionPath(session));
  assert.doesNotMatch(transcript.content, /### Reasoning/);
  assert.doesNotMatch(transcript.content, /The user wants an overview/);
  assert.match(transcript.content, /### Workspace actions/);
});

test('history settings route defaults to disabled and persists updates', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const defaultResponse = await fetch(`${baseUrl}/api/workspaces/default/settings/history`);
  assert.equal(defaultResponse.status, 200);
  const defaults = await defaultResponse.json() as { enabled: boolean; includeReasoning: boolean };
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.includeReasoning, true);

  const saveResponse = await fetch(`${baseUrl}/api/workspaces/default/settings/history`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(saveResponse.status, 200);
  const saved = await saveResponse.json() as { enabled: boolean; includeReasoning: boolean };
  assert.equal(saved.enabled, true);
  assert.equal(saved.includeReasoning, true);

  const reloadResponse = await fetch(`${baseUrl}/api/workspaces/default/settings/history`);
  const reloaded = await reloadResponse.json() as { enabled: boolean; includeReasoning: boolean };
  assert.equal(reloaded.enabled, true);
});

test('agent archives a conversation when history is enabled', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient({
    plannerResponses: [
      {
        content: 'This workspace stores agent collaboration notes.',
        toolCalls: []
      }
    ]
  }));
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const enableResponse = await fetch(`${baseUrl}/api/workspaces/default/settings/history`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(enableResponse.status, 200);

  const response = await harness.agent.sendMessage('What is this workspace for?', undefined, { autoApproveChanges: false });
  assert.ok(response.sessionId);

  const tree = await harness.storage.listTree();
  const historyFolder = tree.find((node) => node.type === 'directory' && node.name === conversationHistoryFolder);
  const transcriptFile = historyFolder?.children?.find((node) => node.type === 'file' && node.name !== 'README.md');
  assert.ok(transcriptFile, 'expected a date-time named transcript file in the conversation-history folder');
  assert.match(transcriptFile.name, /^\d{4}-\d{2}-\d{2}_\d{6}-.+\.md$/);

  const archive = await harness.storage.readTextFile(transcriptFile.path);
  assert.match(archive.content, /What is this workspace for\?/);
  assert.match(archive.content, /This workspace stores agent collaboration notes\./);
});
