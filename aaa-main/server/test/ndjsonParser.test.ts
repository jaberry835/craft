import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNdjsonStream } from '../../src/api/aaaApi.js';
import type { ChatStreamEvent } from '../../src/types/api.js';

test('client parser handles NDJSON events split across transport chunks', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"type":"assistant_'));
      controller.enqueue(encoder.encode('text","text":"hello"}\n{"type":"reasoning","text":"why"}'));
      controller.enqueue(encoder.encode('\n{"type":"error","message":"failed"}'));
      controller.close();
    }
  });
  const events: ChatStreamEvent[] = [];
  await parseNdjsonStream(body, (event) => {
    events.push(event);
  });
  assert.deepEqual(events, [
    { type: 'assistant_text', text: 'hello' },
    { type: 'reasoning', text: 'why' },
    { type: 'error', message: 'failed' }
  ]);
});
