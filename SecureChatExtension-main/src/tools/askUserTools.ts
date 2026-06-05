/**
 * Ask-user tool — ask_user.
 * Lets the agent ask the user one or more structured questions and pause until
 * the user answers via an interactive form rendered in the chat webview.
 */
import { AskUserQuestion } from '../types';
import { ToolEntry, ToolContext } from './types';

export function createAskUserTools(ctx: ToolContext): ToolEntry[] {
    return [
        {
            definition: {
                type: 'function',
                function: {
                    name: 'ask_user',
                    description:
                        'Ask the user one or more clarifying questions and wait for their answer. ' +
                        'Renders an interactive form in the chat: free-text questions, single-select, or multi-select. ' +
                        'Use this only for a small number of genuinely blocking clarifications (e.g. which framework, ' +
                        'whether to overwrite a file, choosing a target). Do NOT use it for sensitive input such as ' +
                        'passwords, API keys, or tokens.',
                    parameters: {
                        type: 'object',
                        properties: {
                            questions: {
                                type: 'array',
                                description: 'The questions to ask. Keep the list short.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        header: {
                                            type: 'string',
                                            description: 'Short unique identifier for the question (used to map the answer back).'
                                        },
                                        question: {
                                            type: 'string',
                                            description: 'The question text shown to the user.'
                                        },
                                        detail: {
                                            type: 'string',
                                            description: 'Optional extra context shown below the question (markdown).'
                                        },
                                        options: {
                                            type: 'array',
                                            description: 'Optional predefined choices. Omit for a free-text question.',
                                            items: {
                                                type: 'object',
                                                properties: {
                                                    label: { type: 'string', description: 'Display label and value for the option.' },
                                                    description: { type: 'string', description: 'Optional secondary text shown with the option.' },
                                                    recommended: { type: 'boolean', description: 'Mark this option as the recommended choice.' }
                                                },
                                                required: ['label']
                                            }
                                        },
                                        multiSelect: {
                                            type: 'boolean',
                                            description: 'Allow selecting multiple options. Only meaningful when options are provided.'
                                        },
                                        allowFreeformInput: {
                                            type: 'boolean',
                                            description: 'Allow a custom typed answer in addition to options. Defaults to true.'
                                        }
                                    },
                                    required: ['header', 'question']
                                }
                            }
                        },
                        required: ['questions']
                    }
                }
            },
            handler: async (args) => {
                const raw = args.questions;
                if (!Array.isArray(raw) || raw.length === 0) {
                    return { success: false, result: 'No questions were provided to ask_user.' };
                }

                const questions: AskUserQuestion[] = [];
                for (const q of raw) {
                    if (!q || typeof q !== 'object') { continue; }
                    const obj = q as Record<string, unknown>;
                    const header = typeof obj.header === 'string' ? obj.header.trim() : '';
                    const question = typeof obj.question === 'string' ? obj.question.trim() : '';
                    if (!header || !question) { continue; }
                    const rawOptions = Array.isArray(obj.options) ? obj.options : undefined;
                    const options = rawOptions
                        ?.map((o) => {
                            if (!o || typeof o !== 'object') { return null; }
                            const oo = o as Record<string, unknown>;
                            const label = typeof oo.label === 'string' ? oo.label : '';
                            if (!label) { return null; }
                            return {
                                label,
                                description: typeof oo.description === 'string' ? oo.description : undefined,
                                recommended: oo.recommended === true,
                            };
                        })
                        .filter((o): o is NonNullable<typeof o> => o !== null);
                    questions.push({
                        header,
                        question,
                        detail: typeof obj.detail === 'string' ? obj.detail : undefined,
                        options: options && options.length > 0 ? options : undefined,
                        multiSelect: obj.multiSelect === true,
                        allowFreeformInput: obj.allowFreeformInput !== false,
                    });
                }

                if (questions.length === 0) {
                    return { success: false, result: 'No valid questions were provided to ask_user (each needs a header and question).' };
                }

                const answers = await ctx.askUser(questions);
                if (!answers) {
                    return { success: false, result: 'The user dismissed the questions without answering. Proceed using your best judgment or ask again.' };
                }

                const lines = questions.map((q) => {
                    const values = answers[q.header] ?? [];
                    const answer = values.length > 0 ? values.join(', ') : '(no answer)';
                    return `Q (${q.header}): ${q.question}\nA: ${answer}`;
                });
                return { success: true, result: lines.join('\n\n') };
            }
        },
    ];
}
