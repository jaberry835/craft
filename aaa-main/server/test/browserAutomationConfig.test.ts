import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBrowserAutomationConfig } from '../browserAutomationConfig.js';

test('browser automation mode is optional and defaults to disabled', () => {
  assert.deepEqual(loadBrowserAutomationConfig({}), { mode: 'disabled', enabled: false });
  assert.deepEqual(loadBrowserAutomationConfig({ AAA_BROWSER_MODE: 'local' }), { mode: 'local', enabled: true });
  assert.deepEqual(loadBrowserAutomationConfig({ AAA_BROWSER_MODE: 'bridge' }), { mode: 'bridge', enabled: true });
  assert.throws(
    () => loadBrowserAutomationConfig({ AAA_BROWSER_MODE: 'remote' }),
    /AAA_BROWSER_MODE must be "disabled", "local", or "bridge"/
  );
});