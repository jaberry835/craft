import assert from 'node:assert/strict';
import test from 'node:test';
import { evidenceCapturePath } from '../../src/evidenceLinks.js';

test('HTTP documentation links receive safe evidence paths', () => {
  assert.equal(
    evidenceCapturePath('https://portal.example.test/security/controls?id=1', new Date('2026-09-25T16:00:00.000Z')),
    'evidence/screenshots/portal-example-test-controls-2026-09-25T16-00-00-000Z.png'
  );
  assert.equal(evidenceCapturePath('file:///C:/secret.txt'), undefined);
  assert.equal(evidenceCapturePath('not a URL'), undefined);
});
