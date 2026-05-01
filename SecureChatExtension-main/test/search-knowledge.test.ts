import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    createSearchKnowledgeTool,
    SEARCH_KNOWLEDGE_TOOL_NAME,
    acquireSearchEntraToken,
    searchAuthProviderForEndpoint,
} from '../src/tools/searchKnowledge';
import type { CustomAgentDef } from '../src/customAgents';

function makeAgent(overrides: Partial<CustomAgentDef> = {}): CustomAgentDef {
    return {
        id: 'a',
        name: 'A',
        systemPrompt: 'p',
        search: {
            endpoint: 'https://my.search.windows.net',
            indexName: 'idx',
            auth: 'key',
            queryType: 'semantic',
            semanticConfiguration: 'default',
            topK: 5,
            apiVersion: '2024-07-01',
        },
        ...overrides,
    };
}

describe('createSearchKnowledgeTool', () => {
    it('returns undefined when the agent has no search config', () => {
        const tool = createSearchKnowledgeTool({ id: 'a', name: 'A', systemPrompt: 'p' }, {
            getSearchKey: async () => 'k',
            getEntraToken: async () => undefined,
        });
        expect(tool).toBeUndefined();
    });

    it('exposes the expected tool name and parameters', () => {
        const tool = createSearchKnowledgeTool(makeAgent(), {
            getSearchKey: async () => 'k',
            getEntraToken: async () => undefined,
        });
        expect(tool).toBeDefined();
        expect(tool!.definition.function.name).toBe(SEARCH_KNOWLEDGE_TOOL_NAME);
        expect(tool!.definition.function.parameters.required).toEqual(['query']);
    });

    it('rejects empty queries without making a request', async () => {
        const tool = createSearchKnowledgeTool(makeAgent(), {
            getSearchKey: async () => { throw new Error('should not be called'); },
            getEntraToken: async () => undefined,
        });
        const res = await tool!.handler({ query: '   ' });
        expect(res.success).toBe(false);
        expect(res.result).toMatch(/query is required/);
    });

    it('returns an error when no key is available for key-auth agents', async () => {
        const tool = createSearchKnowledgeTool(makeAgent(), {
            getSearchKey: async () => undefined,
            getEntraToken: async () => undefined,
        });
        const res = await tool!.handler({ query: 'hello' });
        expect(res.success).toBe(false);
        expect(res.result).toMatch(/search_knowledge failed/);
    });
});

describe('searchAuthProviderForEndpoint', () => {
    it('uses the public Microsoft provider for *.search.windows.net', () => {
        expect(searchAuthProviderForEndpoint('https://x.search.windows.net')).toBe('microsoft');
    });
    it('uses the sovereign provider for any other hostname', () => {
        expect(searchAuthProviderForEndpoint('https://x.search.azure.us')).toBe('microsoft-sovereign-cloud');
        expect(searchAuthProviderForEndpoint('https://x.search.azure.cn')).toBe('microsoft-sovereign-cloud');
        expect(searchAuthProviderForEndpoint('https://search.internal.contoso.example')).toBe('microsoft-sovereign-cloud');
    });
    it('falls back to microsoft when endpoint is missing or invalid', () => {
        expect(searchAuthProviderForEndpoint(undefined)).toBe('microsoft');
        expect(searchAuthProviderForEndpoint('not a url')).toBe('microsoft');
    });
});

describe('acquireSearchEntraToken', () => {
    const getSession = vscode.authentication.getSession as unknown as ReturnType<typeof vi.fn>;

    it('derives provider id and scope from endpoint by default', async () => {
        getSession.mockReset();
        getSession.mockResolvedValueOnce({ accessToken: 'tok' });
        await acquireSearchEntraToken('https://x.search.azure.us');
        expect(getSession).toHaveBeenCalledTimes(1);
        const [providerId, scopes] = getSession.mock.calls[0];
        expect(providerId).toBe('microsoft-sovereign-cloud');
        expect(scopes).toEqual(['https://search.azure.us/.default']);
    });

    it('uses public-cloud provider and azure.com audience for windows.net endpoints', async () => {
        getSession.mockReset();
        getSession.mockResolvedValueOnce({ accessToken: 'tok' });
        await acquireSearchEntraToken('https://x.search.windows.net');
        const [providerId, scopes] = getSession.mock.calls[0];
        expect(providerId).toBe('microsoft');
        expect(scopes).toEqual(['https://search.azure.com/.default']);
    });

    it('honors per-agent provider id and scope overrides', async () => {
        getSession.mockReset();
        getSession.mockResolvedValueOnce({ accessToken: 'tok' });
        await acquireSearchEntraToken('https://x.search.windows.net', {
            authProviderId: 'microsoft-sovereign-cloud',
            entraScope: 'https://search.contoso.example/.default',
        });
        const [providerId, scopes] = getSession.mock.calls[0];
        expect(providerId).toBe('microsoft-sovereign-cloud');
        expect(scopes).toEqual(['https://search.contoso.example/.default']);
    });

    it('returns undefined when getSession throws (e.g. user cancelled)', async () => {
        getSession.mockReset();
        getSession.mockRejectedValueOnce(new Error('cancelled'));
        const tok = await acquireSearchEntraToken('https://x.search.windows.net');
        expect(tok).toBeUndefined();
    });
});
