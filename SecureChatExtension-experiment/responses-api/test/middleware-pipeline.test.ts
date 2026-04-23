import { describe, it, expect, vi } from 'vitest';
import { MiddlewarePipeline } from '../src/framework/middleware';
import type {
    AgentMiddleware,
    AgentContext,
    FunctionMiddleware,
    FunctionContext,
    ChatMiddleware,
    ChatContext,
} from '../src/framework/middleware';
import type { AgentResponse, ChatResponse, ToolResult } from '../src/framework/types';

// ── Helpers ──

function makeAgentContext(overrides?: Partial<AgentContext>): AgentContext {
    return {
        messages: [],
        options: {},
        tools: [],
        client: { modelId: 'test', getResponse: vi.fn(), getResponseStream: vi.fn() } as any,
        editedFiles: new Set(),
        iteration: 1,
        cancelled: false,
        state: new Map(),
        ...overrides,
    };
}

function makeFunctionContext(overrides?: Partial<FunctionContext>): FunctionContext {
    return {
        tool: { name: 'test_tool', definition: {} as any, isReadOnly: true, requiresConfirmation: false, execute: vi.fn(), validate: vi.fn() },
        args: {},
        callId: 'call_1',
        state: new Map(),
        ...overrides,
    };
}

function makeChatContext(overrides?: Partial<ChatContext>): ChatContext {
    return {
        client: { modelId: 'test', getResponse: vi.fn(), getResponseStream: vi.fn() } as any,
        messages: [{ role: 'user', content: 'hello' }],
        options: {},
        stream: false,
        ...overrides,
    };
}

const agentResponse: AgentResponse = { messages: [], agentId: 'test' };
const chatResponse: ChatResponse = { messages: [], finishReason: 'stop' };
const toolResult: ToolResult = { success: true, result: 'ok' };

// ── Tests ──

describe('MiddlewarePipeline', () => {
    describe('runAgent', () => {
        it('calls the handler when no middleware', async () => {
            const handler = vi.fn().mockResolvedValue(agentResponse);
            const ctx = makeAgentContext();

            const result = await MiddlewarePipeline.runAgent([], ctx, handler);

            expect(handler).toHaveBeenCalledOnce();
            expect(result).toBe(agentResponse);
        });

        it('executes middleware in order (outer → inner → handler)', async () => {
            const order: string[] = [];
            const mw1: AgentMiddleware = {
                name: 'first',
                async process(_ctx, next) {
                    order.push('first-before');
                    const r = await next();
                    order.push('first-after');
                    return r;
                },
            };
            const mw2: AgentMiddleware = {
                name: 'second',
                async process(_ctx, next) {
                    order.push('second-before');
                    const r = await next();
                    order.push('second-after');
                    return r;
                },
            };
            const handler = vi.fn().mockImplementation(async () => {
                order.push('handler');
                return agentResponse;
            });

            await MiddlewarePipeline.runAgent([mw1, mw2], makeAgentContext(), handler);

            expect(order).toEqual(['first-before', 'second-before', 'handler', 'second-after', 'first-after']);
        });

        it('allows middleware to short-circuit (skip next())', async () => {
            const shortCircuit: AgentMiddleware = {
                name: 'short',
                async process() {
                    return { messages: [{ role: 'assistant', content: 'blocked' }], agentId: 'short' };
                },
            };
            const handler = vi.fn().mockResolvedValue(agentResponse);

            const result = await MiddlewarePipeline.runAgent([shortCircuit], makeAgentContext(), handler);

            expect(handler).not.toHaveBeenCalled();
            expect(result.agentId).toBe('short');
        });

        it('allows middleware to retry by calling next() multiple times', async () => {
            let calls = 0;
            const retrying: AgentMiddleware = {
                name: 'retry',
                async process(_ctx, next) {
                    const r = await next();
                    if (calls < 2) { return next(); }
                    return r;
                },
            };
            const handler = vi.fn().mockImplementation(async () => {
                calls++;
                return agentResponse;
            });

            await MiddlewarePipeline.runAgent([retrying], makeAgentContext(), handler);

            expect(handler).toHaveBeenCalledTimes(2);
        });

        it('allows middleware to mutate context', async () => {
            const injector: AgentMiddleware = {
                name: 'injector',
                async process(ctx, next) {
                    ctx.messages.push({ role: 'system', content: 'injected' });
                    return next();
                },
            };
            const ctx = makeAgentContext();
            const handler = vi.fn().mockResolvedValue(agentResponse);

            await MiddlewarePipeline.runAgent([injector], ctx, handler);

            expect(ctx.messages).toHaveLength(1);
            expect(ctx.messages[0].content).toBe('injected');
        });
    });

    describe('runFunction', () => {
        it('calls handler with no middleware', async () => {
            const handler = vi.fn().mockResolvedValue(toolResult);
            const result = await MiddlewarePipeline.runFunction([], makeFunctionContext(), handler);
            expect(result).toBe(toolResult);
        });

        it('chains middleware correctly', async () => {
            const order: string[] = [];
            const mw: FunctionMiddleware = {
                name: 'log',
                async process(_ctx, next) {
                    order.push('before');
                    const r = await next();
                    order.push('after');
                    return r;
                },
            };
            const handler = vi.fn().mockImplementation(async () => {
                order.push('handler');
                return toolResult;
            });

            await MiddlewarePipeline.runFunction([mw], makeFunctionContext(), handler);
            expect(order).toEqual(['before', 'handler', 'after']);
        });
    });

    describe('runChat', () => {
        it('calls handler with no middleware', async () => {
            const handler = vi.fn().mockResolvedValue(chatResponse);
            const result = await MiddlewarePipeline.runChat([], makeChatContext(), handler);
            expect(result).toBe(chatResponse);
        });

        it('allows middleware to modify messages before next()', async () => {
            const trimmer: ChatMiddleware = {
                name: 'trimmer',
                async process(ctx, next) {
                    ctx.messages = ctx.messages.slice(-1);
                    return next();
                },
            };
            const ctx = makeChatContext({
                messages: [
                    { role: 'system', content: 'sys' },
                    { role: 'user', content: 'hello' },
                ],
            });
            const handler = vi.fn().mockResolvedValue(chatResponse);

            await MiddlewarePipeline.runChat([trimmer], ctx, handler);

            expect(ctx.messages).toHaveLength(1);
            expect(ctx.messages[0].content).toBe('hello');
        });
    });
});
