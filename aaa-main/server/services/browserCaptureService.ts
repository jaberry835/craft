import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import type {
  BrowserCaptureRequest,
  BrowserCaptureResult,
  BrowserFormFillRequest,
  BrowserFormSnapshot,
  BrowserFormUploadRequest,
  BrowserLaunchRequest,
  BrowserNavigateRequest,
  BrowserSessionStatus
} from '../../src/types/api.js';
import { BadRequestError, ConflictError } from '../httpErrors.js';
import { ProjectFileService } from '../projectFileService.js';

interface BrowserSession {
  context: BrowserContextLike;
  page: BrowserPageLike;
  launchedAt: string;
  headless: boolean;
}

const defaultViewport = { width: 1440, height: 1000 };

export interface BrowserResponseLike {
  status(): number;
}

export interface BrowserPageLike {
  url(): string;
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<BrowserResponseLike | null>;
  viewportSize(): { width: number; height: number } | null;
  evaluate(expression: string): Promise<unknown>;
  locator?(selector: string): BrowserLocatorLike;
  screenshot(options: {
    type: 'png';
    clip: { x: number; y: number; width: number; height: number };
  }): Promise<Buffer>;
}

export interface BrowserLocatorLike {
  count(): Promise<number>;
  fill(value: string): Promise<void>;
  check(): Promise<void>;
  uncheck(): Promise<void>;
  selectOption(value: string): Promise<unknown>;
  setInputFiles(file: { name: string; mimeType: string; buffer: Buffer }): Promise<void>;
}

export interface BrowserContextLike {
  pages(): BrowserPageLike[];
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
  on(event: 'close', listener: () => void): unknown;
}

export interface BrowserLaunchOptions {
  executablePath?: string;
  channel?: string;
  headless: boolean;
  viewport: { width: number; height: number };
  acceptDownloads: boolean;
}

export type BrowserLauncher = (profilePath: string, options: BrowserLaunchOptions) => Promise<BrowserContextLike>;

export function normalizeBrowserUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestError('Enter a valid absolute HTTP or HTTPS URL.', 'invalid_browser_url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestError('Browser navigation only supports HTTP and HTTPS URLs.', 'unsupported_browser_protocol');
  }
  return parsed;
}

function capturePath(requestedPath?: string): string {
  if (requestedPath) {
    return requestedPath.toLowerCase().endsWith('.png') ? requestedPath : `${requestedPath}.png`;
  }
  return `evidence/screenshots/capture-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
}

export class BrowserCaptureService {
  private readonly sessions = new Map<string, BrowserSession>();

  constructor(
    private readonly dataRoot: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly launcher: BrowserLauncher = (profilePath, options) =>
      chromium.launchPersistentContext(profilePath, options)
  ) {}

  status(projectId: string): BrowserSessionStatus {
    const session = this.sessions.get(projectId);
    if (!session || session.context.pages().length === 0) {
      this.sessions.delete(projectId);
      return { active: false };
    }
    return {
      active: true,
      headless: session.headless,
      currentUrl: session.page.url(),
      launchedAt: session.launchedAt
    };
  }

  async launch(projectId: string, request: BrowserLaunchRequest = {}): Promise<BrowserSessionStatus> {
    if (this.status(projectId).active) {
      throw new ConflictError('An Edge capture session is already running for this project.', 'browser_session_active');
    }
    const headless = request.headless ?? false;
    const profilePath = path.join(this.dataRoot, 'browser-profiles', projectId);
    await mkdir(profilePath, { recursive: true });
    const executablePath = this.environment.AAA_EDGE_EXECUTABLE_PATH?.trim();
    let context: BrowserContextLike;
    try {
      context = await this.launcher(profilePath, {
        ...(executablePath ? { executablePath } : { channel: this.environment.AAA_EDGE_CHANNEL?.trim() || 'msedge' }),
        headless,
        viewport: defaultViewport,
        acceptDownloads: false
      });
    } catch (error) {
      throw new Error(
        `Microsoft Edge could not be launched. Install Edge or set AAA_EDGE_EXECUTABLE_PATH. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const page = context.pages()[0] ?? await context.newPage();
    const session: BrowserSession = {
      context,
      page,
      launchedAt: new Date().toISOString(),
      headless
    };
    context.on('close', () => this.sessions.delete(projectId));
    this.sessions.set(projectId, session);
    if (request.url) await this.navigate(projectId, { url: request.url });
    return this.status(projectId);
  }

  async navigate(projectId: string, request: BrowserNavigateRequest): Promise<BrowserSessionStatus> {
    const session = this.requireSession(projectId);
    const target = normalizeBrowserUrl(request.url);
    const response = await session.page.goto(target.href, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000
    });
    const finalUrl = normalizeBrowserUrl(session.page.url());
    if (response && response.status() >= 400) {
      throw new Error(`Navigation completed with HTTP ${response.status()} at ${finalUrl.href}.`);
    }
    return this.status(projectId);
  }

  async capture(
    projectId: string,
    fileService: ProjectFileService,
    request: BrowserCaptureRequest = {}
  ): Promise<BrowserCaptureResult> {
    const session = this.requireSession(projectId);
    const currentUrl = normalizeBrowserUrl(session.page.url()).href;
    const outputPath = capturePath(request.outputPath);
    const viewport = session.page.viewportSize() ?? defaultViewport;
    const documentHeight = Number(await session.page.evaluate(
      'Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)'
    ));
    const captureHeight = Math.max(1, Math.min(documentHeight, viewport.height * 2));
    const content = await session.page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: viewport.width, height: captureHeight }
    });
    await fileService.uploadFile(outputPath, content.toString('base64'), { createParents: true });
    const capturedAt = new Date().toISOString();
    const metadataPath = outputPath.replace(/\.png$/i, '.json');
    await fileService.createTextFile(metadataPath, `${JSON.stringify({
      sourceUrl: currentUrl,
      capturedAt,
      browser: 'Microsoft Edge',
      headless: session.headless,
      captureRegion: 'top',
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      capturedHeight: captureHeight,
      maximumViewportHeights: 2,
      screenshotPath: outputPath
    }, null, 2)}\n`, { createParents: true });
    return { path: outputPath, metadataPath, sourceUrl: currentUrl, capturedAt };
  }

  async inspectForm(projectId: string): Promise<BrowserFormSnapshot> {
    const session = this.requireSession(projectId);
    const sourceUrl = normalizeBrowserUrl(session.page.url()).href;
    const fields = await session.page.evaluate(`(() => {
      const elements = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select'));
      const usedIds = new Set();
      return elements.map((element, index) => {
        const tag = element.tagName.toLowerCase();
        const inputType = tag === 'input' ? (element.getAttribute('type') || 'text').toLowerCase() : tag;
        let fieldId = element.getAttribute('data-aaa-field-id');
        if (!fieldId || !/^field-[a-zA-Z0-9_-]{8,100}$/.test(fieldId) || usedIds.has(fieldId)) {
          const token = globalThis.crypto?.randomUUID?.()
            || (Date.now().toString(36) + '-' + index + '-' + Math.random().toString(36).slice(2));
          fieldId = 'field-' + token;
          element.setAttribute('data-aaa-field-id', fieldId);
        }
        usedIds.add(fieldId);
        const explicitLabel = element.id
          ? document.querySelector('label[for="' + CSS.escape(element.id) + '"]')
          : null;
        const wrappingLabel = element.closest('label');
        const label = (explicitLabel?.textContent || wrappingLabel?.textContent
          || element.getAttribute('aria-label') || element.getAttribute('placeholder')
          || element.getAttribute('name') || element.id || ('Field ' + (index + 1))).trim();
        const result = {
          id: fieldId,
          label: label.slice(0, 240),
          name: element.getAttribute('name') || undefined,
          type: inputType,
          required: element.required === true,
          disabled: element.disabled === true
        };
        if (tag === 'select') {
          result.options = Array.from(element.options).slice(0, 200).map((option) => ({
            value: option.value,
            label: (option.textContent || option.value).trim().slice(0, 240)
          }));
        }
        return result;
      });
    })()`) as BrowserFormSnapshot['fields'];
    if (!Array.isArray(fields)) throw new Error('Microsoft Edge returned an invalid form snapshot.');
    return { sourceUrl, fields };
  }

  async fillForm(projectId: string, request: BrowserFormFillRequest): Promise<BrowserFormSnapshot> {
    const session = this.requireSession(projectId);
    if (!session.page.locator) throw new Error('The active browser does not support reviewed form filling.');
    const entries = Object.entries(request.values ?? {});
    if (entries.length === 0) throw new BadRequestError('Choose at least one field to fill.', 'form_values_required');
    if (entries.length > 100) throw new BadRequestError('At most 100 fields can be filled at once.', 'too_many_form_values');
    for (const [fieldId, value] of entries) {
      assertFormFieldId(fieldId);
      if (typeof value !== 'string' && typeof value !== 'boolean') {
        throw new BadRequestError(`Invalid value for ${fieldId}.`, 'invalid_form_value');
      }
      if (typeof value === 'string' && value.length > 12_000) {
        throw new BadRequestError(`The value for ${fieldId} is too long.`, 'form_value_too_long');
      }
    }
    const snapshot = await this.inspectForm(projectId);
    const operations: Array<{
      field: BrowserFormSnapshot['fields'][number];
      locator: BrowserLocatorLike;
      value: string | boolean;
    }> = [];
    for (const [fieldId, value] of entries) {
      const field = snapshot.fields.find((candidate) => candidate.id === fieldId);
      if (!field || field.disabled || ['file', 'password', 'submit'].includes(field.type)) {
        throw formChangedError();
      }
      if ((field.type === 'checkbox' || field.type === 'radio') && typeof value !== 'boolean') {
        throw new BadRequestError(`The value for ${fieldId} must be true or false.`, 'invalid_form_value');
      }
      const locator = session.page.locator(formFieldSelector(fieldId));
      if (await locator.count() !== 1) throw formChangedError();
      operations.push({ field, locator, value });
    }
    for (const { field, locator, value } of operations) {
      if (field.type === 'checkbox' || field.type === 'radio') {
        if (value) await locator.check();
        else await locator.uncheck();
      } else if (field.type === 'select') {
        await locator.selectOption(String(value));
      } else {
        await locator.fill(String(value));
      }
    }
    return this.inspectForm(projectId);
  }

  async uploadFormFile(
    projectId: string,
    fileService: ProjectFileService,
    request: BrowserFormUploadRequest
  ): Promise<BrowserFormSnapshot> {
    const session = this.requireSession(projectId);
    assertFormFieldId(request.fieldId);
    const snapshot = await this.inspectForm(projectId);
    const field = snapshot.fields.find((candidate) => candidate.id === request.fieldId);
    if (!field || field.type !== 'file') {
      throw new BadRequestError('Choose a file-upload field from the latest form snapshot.', 'file_field_required');
    }
    if (!session.page.locator) throw new Error('The active browser does not support file attachments.');
    const locator = session.page.locator(formFieldSelector(request.fieldId));
    if (await locator.count() !== 1) throw formChangedError();
    const file = await fileService.readUploadFile(request.projectPath);
    await locator.setInputFiles({
      name: file.name,
      mimeType: 'application/octet-stream',
      buffer: file.content
    });
    return this.inspectForm(projectId);
  }

  async close(projectId: string): Promise<BrowserSessionStatus> {
    const session = this.sessions.get(projectId);
    if (session) {
      this.sessions.delete(projectId);
      await session.context.close();
    }

    return { active: false };
  }

  private requireSession(projectId: string): BrowserSession {
    const session = this.sessions.get(projectId);
    if (!session || session.context.pages().length === 0) {
      this.sessions.delete(projectId);
      throw new BadRequestError('Launch an Edge capture session first.', 'browser_session_inactive');
    }
    return session;
  }
}

function assertFormFieldId(fieldId: string): void {
  if (!/^field-[a-zA-Z0-9_-]{8,100}$/.test(fieldId)) {
    throw new BadRequestError('The form field reference is invalid. Inspect the form again.', 'invalid_form_field');
  }
}

function formFieldSelector(fieldId: string): string {
  assertFormFieldId(fieldId);
  return `[data-aaa-field-id="${fieldId}"]`;
}

function formChangedError(): ConflictError {
  return new ConflictError(
    'A reviewed form field is no longer available. Inspect the form again because it may have changed.',
    'form_changed'
  );
}
