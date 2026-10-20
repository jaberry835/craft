import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const scriptPath = path.join(import.meta.dirname, 'Set-AppServiceEnv.ps1');

async function runImport(t, content, { whatIf = false, exitCode = 0 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aaa-env-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envFile = path.join(root, 'input.env');
  const resultFile = path.join(root, 'result.json');
  await writeFile(envFile, content);
  const command = `
    function global:az {
      $settingsIndex = [Array]::IndexOf($args, '--settings') + 1
      $file = $args[$settingsIndex].Substring(1)
      @{
        arguments = $args
        settings = ([IO.File]::ReadAllText($file) | ConvertFrom-Json -AsHashtable)
        file = $file
      } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $env:AAA_TEST_RESULT
      Write-Output 'secret-do-not-print'
      $global:LASTEXITCODE = [int]$env:AAA_TEST_EXIT
    }
    & $env:AAA_TEST_SCRIPT -SubscriptionId 'test-subscription' -ResourceGroup 'test-group' -AppName 'test-app' -Slot 'staging' -EnvFile $env:AAA_TEST_ENV ${whatIf ? '-WhatIf' : ''}
  `;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      AAA_TEST_SCRIPT: scriptPath,
      AAA_TEST_ENV: envFile,
      AAA_TEST_RESULT: resultFile,
      AAA_TEST_EXIT: String(exitCode)
    }
  });
  assert.ifError(result.error);
  return { ...result, resultFile };
}

test('env import preserves values, targets the slot, suppresses secrets, and removes temporary JSON', async (t) => {
  const result = await runImport(t, `
# Example settings
export AAA_AUTH_MODE=none
EMPTY=
PLAIN=value # comment
SINGLE='literal # $VARIABLE'
DOUBLE="line1\\nline2"
MULTILINE="first
second"
KEY_REFERENCE=@Microsoft.KeyVault(SecretUri=https://example.test/secrets/test)
`);
  assert.equal(result.status, 0, result.stderr);
  const captured = JSON.parse(await readFile(result.resultFile, 'utf8'));
  assert.deepEqual(captured.settings, {
    AAA_AUTH_MODE: 'none',
    EMPTY: '',
    PLAIN: 'value',
    SINGLE: 'literal # $VARIABLE',
    DOUBLE: 'line1\nline2',
    MULTILINE: 'first\nsecond',
    KEY_REFERENCE: '@Microsoft.KeyVault(SecretUri=https://example.test/secrets/test)'
  });
  for (const [flag, value] of [
    ['--subscription', 'test-subscription'],
    ['--resource-group', 'test-group'],
    ['--name', 'test-app'],
    ['--slot', 'staging'],
    ['--output', 'none']
  ]) {
    assert.equal(captured.arguments[captured.arguments.indexOf(flag) + 1], value);
  }
  assert.ok(!captured.arguments.some((argument) => argument.includes('literal #')));
  assert.ok(!`${result.stdout}${result.stderr}`.includes('secret-do-not-print'));
  await assert.rejects(access(captured.file), { code: 'ENOENT' });
  await assert.rejects(access(path.dirname(captured.file)), { code: 'ENOENT' });
});

test('env import WhatIf does not call Azure CLI', async (t) => {
  const result = await runImport(t, 'AAA_AUTH_MODE=none\n', { whatIf: true });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(access(result.resultFile), { code: 'ENOENT' });
});

test('env import rejects malformed, duplicate, and empty input before calling Azure CLI', async (t) => {
  for (const content of ['INVALID LINE\n', 'KEY="unterminated\n', 'KEY=one\nKEY=two\n', '# comments only\n']) {
    const result = await runImport(t, content);
    assert.notEqual(result.status, 0);
    await assert.rejects(access(result.resultFile), { code: 'ENOENT' });
  }
});

test('env import surfaces CLI failure without values and cleans up', async (t) => {
  const result = await runImport(t, 'KEY=secret-do-not-print\n', { exitCode: 1 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Azure CLI failed/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('secret-do-not-print'));
  const captured = JSON.parse(await readFile(result.resultFile, 'utf8'));
  await assert.rejects(access(captured.file), { code: 'ENOENT' });
});
