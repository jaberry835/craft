/**
 * ProgressMiddleware — AgentMiddleware that manages WorkingBlock
 * lifecycle for progress tracking in the chat UI.
 *
 * Extracted from AgentLoop working block logic:
 * - Creates/continues working blocks per tool execution phase
 * - Maps tool names to progress descriptors (icon, label, group)
 * - Sends progress updates via callbacks
 */

import type { AgentMiddleware, AgentContext } from '../framework/middleware';
import type { AgentResponse } from '../framework/types';
import type { AgentCallbacks } from '../agentLoop';
import type {
    WorkingBlock,
    WorkingBlockActionEntry,
    WorkingBlockProgressEntry,
    WorkingActionType,
} from '../types';

type WorkingIcon = 'search' | 'read' | 'edit' | 'run' | 'check' | 'loading' | 'done' | 'error';

export interface ToolProgressDescriptor {
    icon: WorkingIcon;
    label: string;
    doneLabel: string;
    failLabel?: string;
    detail?: string;
    filePath?: string;
    actionType: WorkingActionType;
    progressGroup: 'inspect' | 'edit' | 'check' | 'run' | 'todo' | 'other';
    progressText?: string;
}

export interface ProgressMiddlewareOptions {
    callbacks: AgentCallbacks;
    /** Optional custom tool→descriptor mapping. */
    toolProgressMap?: Map<string, (args: Record<string, unknown>) => ToolProgressDescriptor>;
}

export class ProgressMiddleware implements AgentMiddleware {
    readonly name = 'progress';
    private callbacks: ProgressMiddlewareOptions['callbacks'];
    private activeBlock: WorkingBlock | null = null;
    private lastProgressGroup: ToolProgressDescriptor['progressGroup'] | null = null;
    private allPhases: WorkingBlock[] = [];

    constructor(private options: ProgressMiddlewareOptions) {
        this.callbacks = options.callbacks;
    }

    async process(context: AgentContext, next: () => Promise<AgentResponse>): Promise<AgentResponse> {
        try {
            const response = await next();
            this.completeActiveBlock();
            return response;
        } catch (err) {
            this.completeActiveBlock();
            throw err;
        }
    }

    // ── Public API for the agent loop to call during tool execution ──

    /** Ensure a working block exists, creating one if needed. */
    ensureBlock(title: string): WorkingBlock {
        if (this.activeBlock && this.activeBlock.status === 'in_progress') {
            return this.activeBlock;
        }
        return this.startBlock(title);
    }

    /** Start a new working block. */
    startBlock(title: string): WorkingBlock {
        this.completeActiveBlock();
        const block: WorkingBlock = {
            id: `wb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            status: 'in_progress',
            title,
            entries: [],
            startedAt: Date.now(),
        };
        this.activeBlock = block;
        this.allPhases.push(block);
        this.lastProgressGroup = null;
        this.callbacks.sendToWebview({ type: 'workingBlockStarted', block });
        return block;
    }

    /** Add a progress text entry to the active block. */
    appendText(text: string): void {
        if (!this.activeBlock) { return; }
        const entry: WorkingBlockProgressEntry = {
            id: `wp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            kind: 'progress',
            text,
            createdAt: Date.now(),
        };
        this.activeBlock.entries.push(entry);
        this.callbacks.sendToWebview({
            type: 'workingTextAppended',
            blockId: this.activeBlock.id,
            entry,
        });
    }

    /** Add a tool action entry (status: running). Returns the entry ID. */
    addAction(descriptor: ToolProgressDescriptor): string {
        const block = this.ensureBlock(descriptor.progressText ?? 'Working...');
        const entry: WorkingBlockActionEntry = {
            id: `wa_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            kind: 'action',
            text: descriptor.label,
            createdAt: Date.now(),
            actionType: descriptor.actionType,
            status: 'running',
            detail: descriptor.detail,
            filePath: descriptor.filePath,
            icon: descriptor.icon,
        };
        block.entries.push(entry);

        // Send progress text if group changed
        if (descriptor.progressGroup !== this.lastProgressGroup && descriptor.progressText) {
            this.appendText(descriptor.progressText);
            this.lastProgressGroup = descriptor.progressGroup;
        }

        this.callbacks.sendToWebview({
            type: 'workingActionAdded',
            blockId: block.id,
            entry,
        });
        return entry.id;
    }

    /** Update an action entry's status. */
    updateAction(entryId: string, status: 'done' | 'error', updates?: Partial<Pick<WorkingBlockActionEntry, 'text' | 'detail' | 'filePath' | 'icon'>>): void {
        if (!this.activeBlock) { return; }
        const entry = this.activeBlock.entries.find(e => e.id === entryId) as WorkingBlockActionEntry | undefined;
        if (!entry || entry.kind !== 'action') { return; }
        entry.status = status;
        if (updates?.text) { entry.text = updates.text; }
        if (updates?.detail !== undefined) { entry.detail = updates.detail; }
        if (updates?.filePath !== undefined) { entry.filePath = updates.filePath; }
        if (updates?.icon) { entry.icon = updates.icon; }

        this.callbacks.sendToWebview({
            type: 'workingActionUpdated',
            blockId: this.activeBlock.id,
            entryId,
            status,
            ...(updates ?? {}),
        });
    }

    /** Complete the active working block with a summary. */
    completeActiveBlock(summary?: string): void {
        if (!this.activeBlock || this.activeBlock.status !== 'in_progress') { return; }
        this.activeBlock.status = 'completed';
        this.activeBlock.completedAt = Date.now();
        this.activeBlock.summary = summary ?? this.buildSummary(this.activeBlock);
        this.callbacks.sendToWebview({
            type: 'workingBlockCompleted',
            blockId: this.activeBlock.id,
            summary: this.activeBlock.summary,
            completedAt: this.activeBlock.completedAt,
        });
        this.activeBlock = null;
    }

    /** Get all working phases for embedding in message history. */
    getAllPhases(): WorkingBlock[] {
        return [...this.allPhases];
    }

    /** Reset state for a new run. */
    reset(): void {
        this.activeBlock = null;
        this.lastProgressGroup = null;
        this.allPhases = [];
    }

    private buildSummary(block: WorkingBlock): string {
        const actions = block.entries.filter(e => e.kind === 'action') as WorkingBlockActionEntry[];
        if (actions.length === 0) { return 'Done'; }

        const counts = new Map<WorkingActionType, number>();
        for (const a of actions) {
            counts.set(a.actionType, (counts.get(a.actionType) ?? 0) + 1);
        }

        const parts: string[] = [];
        const labels: Record<WorkingActionType, string> = {
            read: 'file', search: 'search', review: 'file', create: 'file',
            edit: 'file', todo: 'step', analyze: 'analysis', run: 'command',
            check: 'check', other: 'action',
        };

        for (const [type, count] of counts) {
            const noun = labels[type] ?? 'action';
            const verb = type === 'edit' ? 'Updated' : type === 'search' ? 'Ran' : type === 'read' ? 'Reviewed' : type === 'run' ? 'Ran' : type === 'create' ? 'Created' : 'Performed';
            parts.push(`${verb} ${count} ${noun}${count > 1 ? 's' : ''}`);
            if (parts.length >= 2) { break; }
        }

        return parts.join(' and ');
    }
}
