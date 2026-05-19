import type { AgentResponse } from '../types.js';
import type { AgentMiddleware, ToolMiddleware } from './agentLoopFramework.js';
import type { LoopContext } from './juniorAgentLoop.js';
import { ChangeManager } from './changeManager.js';
import { WorkspaceIndexer } from './workspaceIndexer.js';
import type { LoopToolResult } from './tools/types.js';

export class AutoApplyChangesMiddleware implements AgentMiddleware<LoopContext, AgentResponse> {
  readonly name = 'auto-apply-changes';

  constructor(
    private readonly changeManager: ChangeManager,
    private readonly workspaceIndexer: WorkspaceIndexer
  ) {}

  async run(context: LoopContext, next: () => Promise<AgentResponse>): Promise<AgentResponse> {
    const response = await next();

    if (!context.options.autoApproveChanges || context.staged.length === 0) {
      return response;
    }

    const stagedIds = Array.from(new Set(context.staged.map((change) => change.id)));
    for (const changeId of stagedIds) {
      await this.changeManager.approve(changeId);
    }

    context.appliedChangeCount = stagedIds.length;
    await this.workspaceIndexer.refresh();
    context.toolEvents.push({
      id: crypto.randomUUID(),
      type: 'edit',
      label: 'Applied agent updates directly',
      detail: `${context.appliedChangeCount} file change${context.appliedChangeCount === 1 ? '' : 's'} written to the workspace.`,
      createdAt: new Date().toISOString()
    });

    return {
      ...response,
      pendingChanges: await this.changeManager.list(),
      toolEvents: context.toolEvents,
      appliedChangeCount: context.appliedChangeCount
    };
  }
}

export class LoopStepTrackingMiddleware implements ToolMiddleware<LoopContext> {
  readonly name = 'loop-step-tracking';

  async run(toolName: string, args: Record<string, unknown>, context: LoopContext, next: () => Promise<LoopToolResult>): Promise<LoopToolResult> {
    context.iteration += 1;
    context.state.set('lastToolName', toolName);
    context.state.set('lastToolArgs', args);
    const startingEventCount = context.toolEvents.length;
    const result = await next();
    const completedStepsValue = context.state.get('completedSteps');
    if (completedStepsValue instanceof Set) {
      completedStepsValue.add(toolName);
    }

    const newEvents = context.toolEvents.slice(startingEventCount);
    const eventSummary = newEvents.length > 0
      ? newEvents.map((event) => `${event.label}${event.detail ? `: ${event.detail}` : ''}`).join('\n')
      : '';
    const observation = result.result || eventSummary;
    if (observation) {
      const currentToolCallId = context.state.get('currentToolCallId');
      context.loopMessages.push({
        role: 'tool',
        content: `[${toolName}] ${observation}`,
        toolCallId: typeof currentToolCallId === 'string' ? currentToolCallId : undefined,
        name: toolName
      });
      context.state.set('lastToolObservation', observation);
    }

    return result;
  }
}