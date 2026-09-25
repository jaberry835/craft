import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { BrowserCaptureService, normalizeBrowserUrl, type BrowserContextLike, type BrowserPageLike } from '../services/browserCaptureService.js';
import { ProjectFileService } from '../projectFileService.js';

const root = path.join(process.cwd(), '.test-data', 'browser-capture');

test('browser URL validation permits HTTP(S) and rejects other schemes', () => {
  assert.equal(normalizeBrowserUrl('https://example.test/path').href, 'https://example.test/path');
  assert.throws(() => normalizeBrowserUrl('file:///C:/secret.txt'), /only supports HTTP and HTTPS/);
  assert.throws(() => normalizeBrowserUrl('not a url'), /valid absolute HTTP or HTTPS URL/);
});

test('Edge capture session navigates and writes PNG evidence with provenance', async (t) => {
  await rm(root, { recursive: true, force: true });
  const projectRoot = path.join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  const server = createServer((_request, response) => response.end('<h1>Evidence</h1>'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const target = `http://127.0.0.1:${address.port}/evidence`;

  let currentUrl = 'about:blank';
  let closed = false;
  let closeListener = () => {};
  let screenshotClip: { x: number; y: number; width: number; height: number } | undefined;
  let attachedFileName = '';
  let filledSelector = '';
  let filledValue = '';
  let reverseFields = false;
  const fields = [
    { id: 'field-narrative1', label: 'Control narrative', name: 'narrative', type: 'textarea', required: true, disabled: false },
    { id: 'field-artifact01', label: 'Supporting artifact', name: 'artifact', type: 'file', required: false, disabled: false }
  ];
  const page: BrowserPageLike = {
    url: () => currentUrl,
    goto: async (url) => {
      const response = await fetch(url);
      currentUrl = response.url;
      return { status: () => response.status };
    },
    viewportSize: () => ({ width: 1440, height: 1000 }),
    evaluate: async (expression) => {
      if (expression.includes('return elements.map')) {
        return reverseFields ? [...fields].reverse() : fields;
      }
      return 5400;
    },
    locator: (selector) => ({
      count: async () => 1,
      fill: async (value) => {
        filledSelector = selector;
        filledValue = value;
      },
      check: async () => {},
      uncheck: async () => {},
      selectOption: async () => [],
      setInputFiles: async (file) => {
        filledSelector = selector;
        attachedFileName = file.name;
      }
    }),
    screenshot: async (options) => {
      screenshotClip = options.clip;
      return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
  };
  const context: BrowserContextLike = {
    pages: () => closed ? [] : [page],
    newPage: async () => page,
    close: async () => {
      closed = true;
      closeListener();
    },
    on: (_event, listener) => {
      closeListener = listener;
    }
  };
  const service = new BrowserCaptureService(path.join(root, 'data'), {}, async () => context);
  const status = await service.launch('demo', { headless: true });
  assert.equal(status.active, true);
  assert.equal(status.headless, true);

  assert.equal((await service.navigate('demo', { url: target })).currentUrl, target);
  const capture = await service.capture('demo', new ProjectFileService(projectRoot), {
    outputPath: 'evidence/screenshots/portal.png'
  });
  assert.equal(capture.path, 'evidence/screenshots/portal.png');
  assert.deepEqual(screenshotClip, { x: 0, y: 0, width: 1440, height: 2000 });
  assert.deepEqual(
    await readFile(path.join(projectRoot, 'evidence', 'screenshots', 'portal.png')),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  );
  const metadata = JSON.parse(await readFile(
    path.join(projectRoot, 'evidence', 'screenshots', 'portal.json'),
    'utf8'
  )) as {
    sourceUrl: string;
    browser: string;
    headless: boolean;
    viewportHeight: number;
    capturedHeight: number;
    maximumViewportHeights: number;
  };
  assert.deepEqual(
    {
      sourceUrl: metadata.sourceUrl,
      browser: metadata.browser,
      headless: metadata.headless,
      viewportHeight: metadata.viewportHeight,
      capturedHeight: metadata.capturedHeight,
      maximumViewportHeights: metadata.maximumViewportHeights
    },
    {
      sourceUrl: target,
      browser: 'Microsoft Edge',
      headless: true,
      viewportHeight: 1000,
      capturedHeight: 2000,
      maximumViewportHeights: 2
    }
  );
  const form = await service.inspectForm('demo');
  assert.equal(form.sourceUrl, target);
  assert.deepEqual(form.fields.map((field) => field.type), ['textarea', 'file']);
  reverseFields = true;
  assert.equal((await service.fillForm('demo', {
    values: { 'field-narrative1': 'Grounded response' }
  })).fields.length, 2);
  assert.equal(filledSelector, '[data-aaa-field-id="field-narrative1"]');
  assert.equal(filledValue, 'Grounded response');
  await new ProjectFileService(projectRoot).createTextFile('evidence/control.txt', 'Supporting evidence');
  await service.uploadFormFile('demo', new ProjectFileService(projectRoot), {
    fieldId: 'field-artifact01',
    projectPath: 'evidence/control.txt'
  });
  assert.equal(filledSelector, '[data-aaa-field-id="field-artifact01"]');
  assert.equal(attachedFileName, 'control.txt');
  assert.deepEqual(await service.close('demo'), { active: false });
});
