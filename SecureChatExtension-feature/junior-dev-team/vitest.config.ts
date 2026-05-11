import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        alias: {
            // Stub out vscode module (not available outside extension host)
            vscode: new URL('./test/__mocks__/vscode.ts', import.meta.url).pathname,
        },
    },
});
