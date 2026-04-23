/**
 * Plan tools — set_plan, update_plan_step.
 */
import { ToolEntry, ToolContext } from './types';

export function createPlanTools(ctx: ToolContext): ToolEntry[] {
    return [
        // ── set_plan ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'set_plan',
                    description: 'Set the plan for the current task. Call this at the start of every task with 3-6 specific steps describing what you will do.',
                    parameters: {
                        type: 'object',
                        properties: {
                            steps: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        id: { type: 'string', description: 'Unique step identifier (e.g. "step1")' },
                                        title: { type: 'string', description: 'Short description of the step' }
                                    },
                                    required: ['id', 'title']
                                },
                                description: 'Array of plan steps'
                            }
                        },
                        required: ['steps']
                    }
                }
            },
            handler: async (args) => {
                const steps = args.steps as { id: string; title: string }[];
                if (ctx.callbacks.onSetPlan) { ctx.callbacks.onSetPlan(steps); }
                return { success: true, result: `Plan set with ${steps.length} steps.` };
            }
        },

        // ── update_plan_step ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'update_plan_step',
                    description: 'Update the status of a plan step. Call this as you begin and complete each step.',
                    parameters: {
                        type: 'object',
                        properties: {
                            step_id: { type: 'string', description: 'The id of the step to update' },
                            status: { type: 'string', enum: ['in_progress', 'completed', 'failed'], description: 'New status for the step' }
                        },
                        required: ['step_id', 'status']
                    }
                }
            },
            handler: async (args) => {
                const stepId = args.step_id as string;
                const status = args.status as string;
                if (ctx.callbacks.onUpdatePlanStep) { ctx.callbacks.onUpdatePlanStep(stepId, status); }
                return { success: true, result: `Step "${stepId}" marked as ${status}.` };
            }
        },
    ];
}
