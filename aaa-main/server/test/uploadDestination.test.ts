import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveUploadDestination } from '../../src/uploadDestination.js';

test('root image uploads default to the screenshot evidence directory', () => {
  assert.equal(resolveUploadDestination('portal.PNG', ''), 'evidence/screenshots');
  assert.equal(resolveUploadDestination('architecture.svg', ''), 'evidence/screenshots');
  assert.equal(resolveUploadDestination('scan.json', ''), '');
});

test('an explicitly selected upload folder is always respected', () => {
  assert.equal(resolveUploadDestination('portal.png', 'security-package/background-docs'), 'security-package/background-docs');
});
