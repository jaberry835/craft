import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { chromium, type Browser } from 'playwright-core';

export const clientDist = path.join(process.cwd(), 'dist', 'client');

export async function launchTestBrowser(t: TestContext): Promise<Browser | undefined> {
  if (!existsSync(path.join(clientDist, 'index.html'))) {
    t.skip('Run npm run build to enable browser tests.');
    return undefined;
  }
  try {
    return await chromium.launch({
      headless: true,
      ...(process.env.AAA_EDGE_EXECUTABLE_PATH
        ? { executablePath: process.env.AAA_EDGE_EXECUTABLE_PATH }
        : { channel: process.env.AAA_EDGE_CHANNEL || 'msedge' })
    });
  } catch {
    t.skip('Microsoft Edge is not available for browser tests.');
    return undefined;
  }
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind to a TCP port.');
  }
  return `http://127.0.0.1:${address.port}`;
}

export function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
}
