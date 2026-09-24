import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import type {
  BrowserCaptureRequest,
  BrowserCaptureResult,
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
  screenshot(options: { type: 'png'; fullPage: boolean }): Promise<Buffer>;
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
    const content = await session.page.screenshot({
      type: 'png',
      fullPage: request.fullPage ?? true
    });
    await fileService.uploadFile(outputPath, content.toString('base64'), { createParents: true });
    const capturedAt = new Date().toISOString();
    const metadataPath = outputPath.replace(/\.png$/i, '.json');
    await fileService.createTextFile(metadataPath, `${JSON.stringify({
      sourceUrl: currentUrl,
      capturedAt,
      browser: 'Microsoft Edge',
      headless: session.headless,
      fullPage: request.fullPage ?? true,
      screenshotPath: outputPath
    }, null, 2)}\n`, { createParents: true });
    return { path: outputPath, metadataPath, sourceUrl: currentUrl, capturedAt };
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
