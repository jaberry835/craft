import { describe, expect, it, vi } from 'vitest';
import { createAskUserTools } from '../src/tools/askUserTools';
import { AskUserQuestion, AskUserAnswers } from '../src/types';
import { ToolContext } from '../src/tools/types';

/** Build a minimal ToolContext exposing only the askUser hook the tool uses. */
function makeContext(askUser: ToolContext['askUser']): ToolContext {
    return { askUser } as unknown as ToolContext;
}

function getHandler(askUser: ToolContext['askUser']) {
    const entries = createAskUserTools(makeContext(askUser));
    const entry = entries.find(e => e.definition.function.name === 'ask_user');
    if (!entry) { throw new Error('ask_user tool not registered'); }
    return entry.handler;
}

describe('ask_user tool', () => {
    it('exposes the ask_user definition with a questions parameter', () => {
        const entries = createAskUserTools(makeContext(async () => ({})));
        const def = entries[0].definition.function;
        expect(def.name).toBe('ask_user');
        expect(def.parameters.required).toContain('questions');
    });

    it('rejects when no questions are provided', async () => {
        const askUser = vi.fn();
        const handler = getHandler(askUser);
        const res = await handler({ questions: [] });
        expect(res.success).toBe(false);
        expect(askUser).not.toHaveBeenCalled();
    });

    it('rejects when every question is missing a header or text', async () => {
        const askUser = vi.fn();
        const handler = getHandler(askUser);
        const res = await handler({ questions: [{ header: '', question: '' }, { foo: 'bar' }] });
        expect(res.success).toBe(false);
        expect(askUser).not.toHaveBeenCalled();
    });

    it('normalizes options and defaults allowFreeformInput to true', async () => {
        let captured: AskUserQuestion[] = [];
        const askUser = async (questions: AskUserQuestion[]): Promise<AskUserAnswers> => {
            captured = questions;
            return { framework: ['React'] };
        };
        const handler = getHandler(askUser);
        const res = await handler({
            questions: [{
                header: 'framework',
                question: 'Which framework?',
                options: [
                    { label: 'React', recommended: true },
                    { label: 'Vue', description: 'Progressive' },
                    { bad: 'no label' },
                ],
            }],
        });

        expect(res.success).toBe(true);
        expect(captured).toHaveLength(1);
        expect(captured[0].allowFreeformInput).toBe(true);
        // Invalid option (no label) is dropped.
        expect(captured[0].options).toHaveLength(2);
        expect(captured[0].options?.[0]).toMatchObject({ label: 'React', recommended: true });
        expect(res.result).toContain('framework');
        expect(res.result).toContain('React');
    });

    it('treats a question with no options as free-text and preserves multiSelect', async () => {
        let captured: AskUserQuestion[] = [];
        const askUser = async (questions: AskUserQuestion[]): Promise<AskUserAnswers> => {
            captured = questions;
            return { targets: ['web', 'mobile'] };
        };
        const handler = getHandler(askUser);
        await handler({
            questions: [
                { header: 'name', question: 'Project name?' },
                { header: 'targets', question: 'Targets?', multiSelect: true, options: [{ label: 'web' }, { label: 'mobile' }] },
            ],
        });

        expect(captured[0].options).toBeUndefined();
        expect(captured[1].multiSelect).toBe(true);
    });

    it('respects an explicit allowFreeformInput: false', async () => {
        let captured: AskUserQuestion[] = [];
        const askUser = async (questions: AskUserQuestion[]): Promise<AskUserAnswers> => {
            captured = questions;
            return { q: ['A'] };
        };
        const handler = getHandler(askUser);
        await handler({
            questions: [{ header: 'q', question: 'Pick one', allowFreeformInput: false, options: [{ label: 'A' }] }],
        });
        expect(captured[0].allowFreeformInput).toBe(false);
    });

    it('reports a failure when the user dismisses the questions', async () => {
        const handler = getHandler(async () => null);
        const res = await handler({ questions: [{ header: 'q', question: 'Anything?' }] });
        expect(res.success).toBe(false);
        expect(res.result.toLowerCase()).toContain('dismissed');
    });

    it('formats multiple answers back into the result string', async () => {
        const handler = getHandler(async () => ({ a: ['yes'], b: ['one', 'two'] }));
        const res = await handler({
            questions: [
                { header: 'a', question: 'First?' },
                { header: 'b', question: 'Second?' },
            ],
        });
        expect(res.success).toBe(true);
        expect(res.result).toContain('A: yes');
        expect(res.result).toContain('A: one, two');
    });
});
