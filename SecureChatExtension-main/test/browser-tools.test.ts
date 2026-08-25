import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { commands } from 'vscode';
import { afterEach, describe, expect, it } from 'vitest';
import { createBrowserTools } from '../src/tools/browserTools';
import { ToolContext } from '../src/tools/types';

function hasInstalledBrowser(): boolean {
    if (process.platform !== 'win32') { return true; }
    return [
        path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge_proxy.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge_proxy.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
    ].some(candidate => fs.existsSync(candidate));
}

describe.skipIf(!hasInstalledBrowser())('browser tools', () => {
    const disposers: Array<() => Promise<void>> = [];
    const servers: http.Server[] = [];
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(disposers.splice(0).map(dispose => dispose()));
        await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
            server.closeAllConnections();
            server.close(() => resolve());
        })));
        for (const dir of tempDirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('opens, inspects, interacts with, screenshots, and closes a local page', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'junior-browser-test-'));
        tempDirs.push(workspace);
        const server = http.createServer((_request, response) => {
            response.setHeader('content-type', 'text/html');
            response.end(`<!doctype html><title>Junior Browser Test</title>
                <button onclick="document.querySelector('#status').textContent='clicked'">Run</button>
                <input placeholder="Name" oninput="document.querySelector('#status').textContent=this.value">
                <p id="status">ready</p>`);
        });
        servers.push(server);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') { throw new Error('Test server did not bind a TCP port.'); }

        const context = {
            requestConfirmation: async () => true,
            validatePath: (relativePath: string) => {
                const resolved = path.resolve(workspace, relativePath);
                return resolved.startsWith(workspace + path.sep) ? resolved : null;
            },
            snapshotOriginal: async () => true,
            notifyFileChanged: () => {},
        } as unknown as ToolContext;
        const browserTools = createBrowserTools(context);
        disposers.push(browserTools.dispose);
        const handlers = new Map(browserTools.entries.map(entry => [entry.definition.function.name, entry.handler]));

        const opened = await handlers.get('browser_open')!({ url: `http://127.0.0.1:${address.port}` });
        expect(opened.success, opened.result).toBe(true);
    expect(commands.executeCommand).toHaveBeenCalledWith('simpleBrowser.show', `http://127.0.0.1:${address.port}`);
    expect(opened.result).toContain('VS Code preview: opened.');
        expect(opened.result).toContain('Junior Browser Test');
        expect(opened.result).toContain('[e1] <button> Run');
        expect(opened.result).toContain('[e2] <input> Name');

        const clicked = await handlers.get('browser_click')!({ ref: 'e1' });
        expect(clicked.success).toBe(true);
        expect(clicked.result).toContain('clicked');

        const typed = await handlers.get('browser_type')!({ ref: 'e2', text: 'Ada' });
        expect(typed.success).toBe(true);
        expect(typed.result).toContain('Ada');

        const screenshot = await handlers.get('browser_screenshot')!({ path: 'artifacts/browser.png' });
        expect(screenshot.success).toBe(true);
        expect(fs.statSync(path.join(workspace, 'artifacts/browser.png')).size).toBeGreaterThan(100);

        const closed = await handlers.get('browser_close')!({});
        expect(closed.success).toBe(true);
    }, 30_000);
});