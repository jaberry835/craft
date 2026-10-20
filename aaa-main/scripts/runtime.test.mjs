import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const distRoot = path.resolve(import.meta.dirname, '..', 'dist');

for (const [mode, authMode] of [
  ['disabled', undefined],
  ['disabled', 'none'],
  ['bridge', 'none'],
  ['local', 'none']
]) {
  test(`standalone runtime works without Playwright in ${mode} mode with auth ${authMode ?? 'unset'}`, { timeout: 30_000 }, async (t) => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'aaa-runtime-'));
    t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
    await cp(distRoot, path.join(temporaryRoot, 'dist'), { recursive: true });
    await cp(path.join(distRoot, 'config'), path.join(temporaryRoot, 'config'), { recursive: true });
    await cp(path.join(distRoot, 'template'), path.join(temporaryRoot, 'template'), { recursive: true });
    await mkdir(path.join(temporaryRoot, 'logs'));
    await mkdir(path.join(temporaryRoot, 'data'));
    const entries = await readdir(temporaryRoot, { recursive: true });
    assert.ok(!entries.some((entry) => entry.split(path.sep).includes('node_modules')));
    assert.ok(!entries.some((entry) => /playwright/i.test(entry)));

    const environment = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/^(AAA_|AZURE_|COSMOS_|JUNIOR_|PORT$|NODE_OPTIONS$|NODE_PATH$)/i.test(key)));
    const child = spawn(process.execPath, [path.join('dist', 'index.js')], {
      cwd: temporaryRoot,
      env: {
        ...environment,
        NODE_ENV: 'production',
        AAA_HOST: '0.0.0.0',
        ...(authMode ? { AAA_AUTH_MODE: authMode } : {}),
        AAA_PROJECT_TEMPLATE: path.join(temporaryRoot, 'template'),
        AAA_BROWSER_MODE: mode,
        PORT: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    });
    let output = '';
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    const baseUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Runtime startup timed out:\n${output}`)), 20_000);
      const finish = (error, url) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(url);
      };
      child.once('error', (error) => finish(error));
      child.once('exit', (code) => finish(new Error(`Runtime exited with code ${code}:\n${output}`)));
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        const match = output.match(/AAA local API listening on http:\/\/0\.0\.0\.0:(\d+)/);
        if (match) finish(null, `http://127.0.0.1:${match[1]}`);
      });
    });
    assert.match(output, /App sign-in is disabled on 0\.0\.0\.0/);
    const authResponse = await fetch(`${baseUrl}/api/auth/config`);
    assert.equal(authResponse.status, 200, output);
    assert.deepEqual(await authResponse.json(), { mode: 'none' });
    assert.equal((await fetch(baseUrl)).status, 200);
    const projectsResponse = await fetch(`${baseUrl}/api/projects`);
    assert.equal(projectsResponse.status, 200);
    const { projects } = await projectsResponse.json();
    assert.ok(projects.length > 0);
    const browserUrl = `${baseUrl}/api/projects/${projects[0].id}/browser`;
    const statusResponse = await fetch(browserUrl);
    assert.equal(statusResponse.status, 200);
    assert.deepEqual(await statusResponse.json(), {
      enabled: mode !== 'disabled',
      mode,
      bridgeAvailable: false,
      active: false
    });
    const launchResponse = await fetch(`${browserUrl}/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const launchResult = await launchResponse.json();
    if (mode === 'local') {
      assert.equal(launchResponse.status, 500);
      assert.match(launchResult.error, /Local Playwright is not included in the container runtime/);
    } else {
      assert.equal(launchResponse.status, 503);
      assert.equal(launchResult.code, mode === 'disabled' ? 'browser_automation_disabled' : 'browser_bridge_unavailable');
      assert.ok(!(await readdir(path.join(temporaryRoot, 'data'))).includes('browser-profiles'));
    }
    assert.equal((await fetch(`${baseUrl}/api/auth/config`)).status, 200);
  });
}
