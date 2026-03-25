/**
 * Agent Loop — the core orchestrator.
 * Sends messages to AOAI with tool definitions, processes tool_calls,
 * executes tools, feeds results back, and iterates until done or max iterations.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AzureOpenAIClient } from './aoaiClient';
import { BuiltinTools } from './builtinTools';
import { McpClient } from './mcpClient';
import { ContextManager } from './contextManager';
import { validateToolArgs, buildToolSchemaMap } from './toolValidator';
import { getSetting } from './config';
import { ChatMessage, ContentPart, ToolCall, ToolDefinition, ToolResult, ExtensionMessage, AgentPlanStep, WorkingActionType, WorkingBlock, WorkingBlockActionEntry, WorkingBlockProgressEntry } from './types';
import { TokenTracker } from './tokenTracker';
import { SYSTEM_PROMPT } from './agentPrompt';

export interface AgentCallbacks {
    sendToWebview(msg: ExtensionMessage): void;
}

/** Tools that are never worth retrying (user-cancelled or confirmed unique) */
const NO_RETRY_TOOLS = new Set(['run_terminal_command', 'apply_code_action', 'edit_file', 'set_plan', 'update_plan_step']);

/** Max number of automatic retries per tool call */
const MAX_TOOL_RETRIES = 1;

/** Delay (ms) before retrying a failed tool */
const RETRY_DELAY_MS = 600;

/** Max number of auto-fix cycles when the model stops but errors remain */
const MAX_AUTOFIX_CYCLES = 3;

/** Max number of emergency recovery attempts when the API rejects the prompt */
const MAX_CONTEXT_RECOVERY_ATTEMPTS = 3;

/** Tools that modify files — used to track which files may have new diagnostics */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'replace_lines', 'delete_file', 'apply_code_action', 'rename_symbol']);

type WorkingIcon = 'search' | 'read' | 'edit' | 'run' | 'check' | 'loading' | 'done' | 'error';

interface ToolProgressDescriptor {
    icon: WorkingIcon;
    label: string;
    doneLabel: string;
    detail?: string;
    filePath?: string;
    actionType: WorkingActionType;
    progressGroup: 'inspect' | 'edit' | 'check' | 'run' | 'todo' | 'other';
    progressText?: string;
}

export class AgentLoop {
    private messages: ChatMessage[] = [];
    private abortController: AbortController | null = null;
    private running = false;
    private cancelled = false;
    private maxIterations: number;
    /** Dynamic plan steps set by the model via set_plan / update_plan_step tools */
    private planSteps: AgentPlanStep[] = [];
    private contextManager = new ContextManager();
    /** Cached tool name → definition map for argument validation. */
    private toolSchemaMap: Map<string, ToolDefinition> = new Map();
    /** Pending continuation promise — set when the agent hits maxIterations and pauses */
    private pendingContinuation: { resolve: (shouldContinue: boolean) => void } | null = null;
    /** Files edited during the current agent run (relative paths). */
    private editedFiles: Set<string> = new Set();

    constructor(
        private aoaiClient: AzureOpenAIClient,
        private builtinTools: BuiltinTools,
        private mcpClient: McpClient,
        private callbacks: AgentCallbacks,
        private tokenTracker?: TokenTracker
    ) {
        this.maxIterations = getSetting<number>('agent.maxIterations') ?? 25;
    }

    isRunning(): boolean { return this.running; }

    getMessages(): ChatMessage[] { return [...this.messages]; }

    setMessages(messages: ChatMessage[]) {
        this.messages = messages;
    }

    clearMessages() {
        this.messages = [];
        this.planSteps = [];
    }

    /**
     * Load custom project instructions from well-known file paths.
     * Checks (in order): .junior/instructions.md, .github/copilot-instructions.md
     * Returns the file contents or null if none found.
     */
    private loadCustomInstructions(): string | null {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return null; }
        const candidates = [
            path.join(root, '.junior', 'instructions.md'),
            path.join(root, '.github', 'copilot-instructions.md'),
        ];
        for (const filePath of candidates) {
            try {
                if (fs.existsSync(filePath)) {
                    const content = fs.readFileSync(filePath, 'utf-8').trim();
                    if (content.length > 0) {
                        // Cap at 4000 chars to avoid ballooning the system prompt
                        return content.length > 4000
                            ? content.slice(0, 4000) + '\n... [instructions truncated]'
                            : content;
                    }
                }
            } catch { /* ignore read errors */ }
        }
        return null;
    }

    /** Called by set_plan tool — replaces the plan with new steps (first step auto-starts) */
    setPlan(steps: { id: string; title: string }[]) {
        this.planSteps = steps.map((s, i) => ({
            id: s.id, title: s.title,
            status: i === 0 ? 'in_progress' as const : 'pending' as const
        }));
        this.callbacks.sendToWebview({ type: 'agentPlan', steps: [...this.planSteps] });
    }

    /** Called by update_plan_step tool — updates a step's status and auto-advances */
    updatePlanStep(stepId: string, status: AgentPlanStep['status']) {
        const step = this.planSteps.find(s => s.id === stepId);
        if (step) {
            step.status = status;
            // Auto-advance: if completed/failed and no step is in_progress, start next pending
            if ((status === 'completed' || status === 'failed') &&
                !this.planSteps.some(s => s.status === 'in_progress')) {
                const next = this.planSteps.find(s => s.status === 'pending');
                if (next) { next.status = 'in_progress'; }
            }
            // The agentPlan message triggers the frontend to detect plan step changes
            // and split/create new progress cards automatically.
            this.callbacks.sendToWebview({ type: 'agentPlan', steps: [...this.planSteps] });
        }
    }

    cancel() {
        this.cancelled = true;
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        // Reject any pending continuation prompt
        if (this.pendingContinuation) {
            this.pendingContinuation.resolve(false);
            this.pendingContinuation = null;
        }
        this.running = false;
    }

    /** Called by chatViewProvider when the user clicks Continue or Pause */
    resolveContinuation(shouldContinue: boolean) {
        if (this.pendingContinuation) {
            this.pendingContinuation.resolve(shouldContinue);
            this.pendingContinuation = null;
        }
    }

    private nextUiId(prefix: string): string {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    private createWorkingBlock(title: string): WorkingBlock {
        return {
            id: this.nextUiId('working'),
            status: 'in_progress',
            title,
            entries: [],
            startedAt: Date.now()
        };
    }

    private createWorkingProgressEntry(text: string): WorkingBlockProgressEntry {
        return {
            id: this.nextUiId('progress'),
            kind: 'progress',
            text,
            createdAt: Date.now()
        };
    }

    private isVisibleWorkingTool(name: string): boolean {
        return name !== 'set_plan' && name !== 'update_plan_step';
    }

    private buildWorkingSummary(block: WorkingBlock): string {
        const actions = block.entries.filter((entry): entry is WorkingBlockActionEntry => entry.kind === 'action');
        if (actions.length === 0) {
            return block.title;
        }

        const counts = new Map<WorkingActionType, number>();
        for (const action of actions) {
            counts.set(action.actionType, (counts.get(action.actionType) || 0) + 1);
        }

        const describeBucket = (actionType: WorkingActionType, count: number): string => {
            switch (actionType) {
                case 'read':
                case 'review':
                    return `Reviewed ${count} file${count === 1 ? '' : 's'}`;
                case 'search':
                    return count === 1 ? 'Ran 1 search' : `Ran ${count} searches`;
                case 'create': {
                    if (count === 1) {
                        const single = actions.find(action => action.actionType === actionType);
                        return single?.text || 'Created 1 file';
                    }
                    return `Created ${count} files`;
                }
                case 'edit': {
                    if (count === 1) {
                        const single = actions.find(action => action.actionType === actionType);
                        return single?.text || 'Updated 1 file';
                    }
                    return `Updated ${count} files`;
                }
                case 'todo':
                    return count === 1 ? 'Created 1 todo' : `Created ${count} todos`;
                case 'analyze':
                    return count === 1 ? 'Analyzed 1 item' : `Analyzed ${count} items`;
                case 'run':
                    return count === 1 ? 'Ran 1 command' : `Ran ${count} commands`;
                case 'check':
                    return count === 1 ? 'Checked 1 item' : `Checked ${count} items`;
                default:
                    return count === 1 ? 'Completed 1 action' : `Completed ${count} actions`;
            }
        };

        const seen = new Set<WorkingActionType>();
        const parts: string[] = [];
        for (const action of actions) {
            if (seen.has(action.actionType)) {
                continue;
            }
            seen.add(action.actionType);
            parts.push(describeBucket(action.actionType, counts.get(action.actionType) || 0));
            if (parts.length >= 2) {
                break;
            }
        }

        if (parts.length === 0) {
            return block.title;
        }

        return parts.join(' and ');
    }

    /** Map a tool name + args to a working block action descriptor. */
    private describeToolForProgress(name: string, args: Record<string, unknown>): ToolProgressDescriptor {
        switch (name) {
            case 'grep_search': {
                const pat = typeof args.pattern === 'string' ? ` \`${args.pattern}\`` : '';
                return {
                    icon: 'search',
                    label: `Searching for${pat}`,
                    doneLabel: `Searched for${pat}`,
                    detail: typeof args.include === 'string' ? `(${args.include})` : undefined,
                    actionType: 'search',
                    progressGroup: 'inspect',
                    progressText: 'Inspecting the workspace and gathering relevant context.'
                };
            }
            case 'search_files':
                return {
                    icon: 'search',
                    label: `Searching files: ${args.query || ''}`,
                    doneLabel: `Searched files: ${args.query || ''}`,
                    actionType: 'search',
                    progressGroup: 'inspect',
                    progressText: 'Inspecting the workspace and gathering relevant context.'
                };
            case 'semantic_search':
                return {
                    icon: 'search',
                    label: `Searching: ${args.query || ''}`,
                    doneLabel: `Searched: ${args.query || ''}`,
                    actionType: 'search',
                    progressGroup: 'inspect',
                    progressText: 'Inspecting the workspace and gathering relevant context.'
                };
            case 'find_symbol':
                return {
                    icon: 'search',
                    label: `Finding symbol: ${args.name || ''}`,
                    doneLabel: `Found symbol: ${args.name || ''}`,
                    actionType: 'search',
                    progressGroup: 'inspect',
                    progressText: 'Inspecting the workspace and gathering relevant context.'
                };
            case 'go_to_definition':
                return {
                    icon: 'search',
                    label: `Resolving definition: ${args.symbol || ''}`,
                    doneLabel: `Resolved definition: ${args.symbol || ''}`,
                    actionType: 'search',
                    progressGroup: 'inspect',
                    progressText: 'Inspecting the workspace and gathering relevant context.'
                };
            case 'find_references':
                return {
                    icon: 'search',
                    label: `Finding references: ${args.symbol || ''}`,
                    doneLabel: `Found references: ${args.symbol || ''}`,
                    actionType: 'search',
                    progressGroup: 'inspect',
                    progressText: 'Inspecting the workspace and gathering relevant context.'
                };
            case 'read_file':
                return {
                    icon: 'read',
                    label: `Reading ${this.shortPath(args.path)}`,
                    doneLabel: `Read ${this.shortPath(args.path)}`,
                    detail: args.startLine ? `lines ${args.startLine} to ${args.endLine || ''}` : undefined,
                    filePath: typeof args.path === 'string' ? args.path : undefined,
                    actionType: 'read',
                    progressGroup: 'inspect',
                    progressText: 'Reviewing the current implementation before making changes.'
                };
            case 'get_document_symbols':
                return {
                    icon: 'read',
                    label: `Loading symbols for ${this.shortPath(args.path)}`,
                    doneLabel: `Loaded symbols for ${this.shortPath(args.path)}`,
                    filePath: typeof args.path === 'string' ? args.path : undefined,
                    actionType: 'review',
                    progressGroup: 'inspect',
                    progressText: 'Reviewing the current implementation before making changes.'
                };
            case 'list_directory':
                return {
                    icon: 'read',
                    label: `Listing ${this.shortPath(args.path) || '.'}`,
                    doneLabel: `Listed ${this.shortPath(args.path) || '.'}`,
                    actionType: 'review',
                    progressGroup: 'inspect',
                    progressText: 'Inspecting the workspace layout and relevant files.'
                };
            case 'get_file_tree':
                return {
                    icon: 'read',
                    label: 'Loading workspace file tree',
                    doneLabel: 'Loaded workspace file tree',
                    actionType: 'review',
                    progressGroup: 'inspect',
                    progressText: 'Inspecting the workspace layout and relevant files.'
                };
            case 'get_open_editors':
                return {
                    icon: 'read',
                    label: 'Checking open editors',
                    doneLabel: 'Checked open editors',
                    actionType: 'review',
                    progressGroup: 'inspect',
                    progressText: 'Inspecting the current editor context before continuing.'
                };
            case 'get_diagnostics':
                return {
                    icon: 'check',
                    label: `Checking diagnostics${args.path ? ' for ' + this.shortPath(args.path) : ''}`,
                    doneLabel: `Checked diagnostics${args.path ? ' for ' + this.shortPath(args.path) : ''}`,
                    filePath: typeof args.path === 'string' ? args.path : undefined,
                    actionType: 'check',
                    progressGroup: 'check',
                    progressText: 'Checking the current state for errors before moving on.'
                };
            case 'write_file':
                return {
                    icon: 'edit',
                    label: `Creating ${this.shortPath(args.path)}`,
                    doneLabel: `Created ${this.shortPath(args.path)}`,
                    filePath: typeof args.path === 'string' ? args.path : undefined,
                    actionType: 'create',
                    progressGroup: 'edit',
                    progressText: 'Updating the implementation for this phase.'
                };
            case 'edit_file':
                return {
                    icon: 'edit',
                    label: `Editing ${this.shortPath(args.path)}`,
                    doneLabel: `Edited ${this.shortPath(args.path)}`,
                    filePath: typeof args.path === 'string' ? args.path : undefined,
                    actionType: 'edit',
                    progressGroup: 'edit',
                    progressText: 'Updating the implementation for this phase.'
                };
            case 'replace_lines': {
                const start = Number(args.start_line) || 1;
                const newLineCount = typeof args.new_content === 'string' ? args.new_content.split('\n').length : 0;
                const actualEnd = start + Math.max(newLineCount, 1) - 1;
                return {
                    icon: 'edit',
                    label: `Rewriting lines ${start}–${actualEnd} in ${this.shortPath(args.path)}`,
                    doneLabel: `Rewrote lines ${start}–${actualEnd} in ${this.shortPath(args.path)}`,
                    filePath: typeof args.path === 'string' ? args.path : undefined,
                    actionType: 'edit',
                    progressGroup: 'edit',
                    progressText: 'Updating the implementation for this phase.'
                };
            }
            case 'delete_file':
                return {
                    icon: 'edit',
                    label: `Deleting ${this.shortPath(args.path)}`,
                    doneLabel: `Deleted ${this.shortPath(args.path)}`,
                    filePath: typeof args.path === 'string' ? args.path : undefined,
                    actionType: 'edit',
                    progressGroup: 'edit',
                    progressText: 'Updating the implementation for this phase.'
                };
            case 'apply_code_action':
                return {
                    icon: 'edit',
                    label: `Applying code action at ${this.shortPath(args.path)}`,
                    doneLabel: `Applied code action at ${this.shortPath(args.path)}`,
                    filePath: typeof args.path === 'string' ? args.path : undefined,
                    actionType: 'edit',
                    progressGroup: 'edit',
                    progressText: 'Updating the implementation for this phase.'
                };
            case 'run_terminal_command':
                return {
                    icon: 'run',
                    label: `Running: ${this.truncateStr(String(args.command || ''), 60)}`,
                    doneLabel: `Ran: ${this.truncateStr(String(args.command || ''), 60)}`,
                    actionType: 'run',
                    progressGroup: 'run',
                    progressText: 'Running commands to validate the current changes.'
                };
            case 'set_plan':
                return {
                    icon: 'loading',
                    label: 'Setting plan',
                    doneLabel: 'Set plan',
                    actionType: 'todo',
                    progressGroup: 'todo'
                };
            case 'update_plan_step':
                return {
                    icon: 'loading',
                    label: 'Updating plan step',
                    doneLabel: 'Updated plan step',
                    actionType: 'todo',
                    progressGroup: 'todo'
                };
            default:
                if (name.startsWith('mcp_')) {
                    const short = name.replace(/^mcp_/, '');
                    return {
                        icon: 'run',
                        label: `Running MCP: ${short}`,
                        doneLabel: `MCP: ${short}`,
                        actionType: 'other',
                        progressGroup: 'other',
                        progressText: 'Working through the next tool actions.'
                    };
                }
                return {
                    icon: 'loading',
                    label: `Running: ${name}`,
                    doneLabel: `Completed: ${name}`,
                    actionType: 'other',
                    progressGroup: 'other',
                    progressText: 'Working through the next tool actions.'
                };
        }
    }

    private shortPath(p: unknown): string {
        if (typeof p !== 'string') { return ''; }
        // Show just the last 2-3 path segments
        const parts = p.replace(/\\/g, '/').split('/');
        return parts.length > 3 ? parts.slice(-3).join('/') : p;
    }

    private truncateStr(s: string, max: number): string {
        return s.length <= max ? s : s.slice(0, max) + '...';
    }

    private friendlyToolStatus(name: string): string {
        switch (name) {
            case 'read_file': case 'get_document_symbols': case 'get_open_editors': case 'get_file_tree': case 'list_directory':
                return 'Reading...';
            case 'grep_search': case 'search_files': case 'semantic_search': case 'find_symbol': case 'go_to_definition': case 'find_references':
                return 'Searching...';
            case 'edit_file': case 'write_file': case 'replace_lines': case 'delete_file': case 'apply_code_action':
                return 'Editing...';
            case 'run_terminal_command':
                return 'Running command...';
            case 'get_diagnostics':
                return 'Checking...';
            default:
                return name.startsWith('mcp_') ? 'Running tool...' : 'Working...';
        }
    }

    /** Run the agent loop: send user message, process tool calls iteratively */
    async run(userMessage: string, images?: string[], files?: { name: string; content: string }[], displayText?: string): Promise<void> {
        if (this.running) { return; }
        this.running = true;
        this.cancelled = false;
        this.abortController = new AbortController();
        this.planSteps = [];
        this.editedFiles.clear();
        let autofixCycles = 0;
        let contextRecoveryAttempts = 0;
        let reasoningMode = false;

        // Add system prompt if first message
        if (this.messages.length === 0) {
            let prompt = SYSTEM_PROMPT;
            const customInstructions = this.loadCustomInstructions();
            if (customInstructions) {
                prompt += '\n\n## Custom Project Instructions\n' + customInstructions;
            }
            this.messages.push({ role: 'system', content: prompt });
        }

        // Build user message content — multimodal array when images/files are present
        const hasImages = images && images.length > 0;
        const hasFiles = files && files.length > 0;

        if (hasImages || hasFiles) {
            const parts: ContentPart[] = [];

            // Prepend file contents as context
            if (hasFiles) {
                for (const f of files!) {
                    parts.push({ type: 'text', text: `[Attached file: ${f.name}]\n${f.content}` });
                }
            }

            // Add user text
            if (userMessage.trim()) {
                parts.push({ type: 'text', text: userMessage });
            }

            // Add images for vision API
            if (hasImages) {
                for (const dataUri of images!) {
                    parts.push({ type: 'image_url', image_url: { url: dataUri } });
                }
            }

            const userMsg: ChatMessage = { role: 'user', content: parts };
            if (displayText) { userMsg.displayText = displayText; }
            this.messages.push(userMsg);
        } else {
            const userMsg: ChatMessage = { role: 'user', content: userMessage };
            if (displayText) { userMsg.displayText = displayText; }
            this.messages.push(userMsg);
        }

        // Gather all tool definitions
        const tools = this.getAllToolDefinitions();
        this.toolSchemaMap = buildToolSchemaMap(tools);

        // Inject context snapshot before the first model call
        const contextPack = this.buildContextPack();
        if (contextPack) {
            this.messages.push({ role: 'system', content: contextPack });
        }

        try {
            // Show status when the API is rate-limited and retrying
            this.aoaiClient.setRetryCallback((remainingSec, attempt, maxRetries) => {
                this.callbacks.sendToWebview({
                    type: 'setStatus',
                    status: `Rate limited — retrying in ${remainingSec}s (attempt ${attempt}/${maxRetries})...`
                });
            });

            let iteration = 0;

            // ── Working block state: persists across iterations so actions group together ──
            let activeWorkingBlock: WorkingBlock | null = null;
            let lastProgressGroup: ToolProgressDescriptor['progressGroup'] | null = null;
            const allWorkingPhases: WorkingBlock[] = [];
            /** The most recent assistant message with tool_calls (for storing working phases on). */
            let lastToolAssistantMsg: ChatMessage | null = null;

            const currentWorkingTitle = (): string => this.planSteps.find(s => s.status === 'in_progress')?.title || 'Working';

            const ensureWorkingBlock = (): WorkingBlock => {
                const nextTitle = currentWorkingTitle();
                if (activeWorkingBlock && activeWorkingBlock.status === 'in_progress') {
                    if (activeWorkingBlock.title === nextTitle) {
                        return activeWorkingBlock;
                    }
                    if (activeWorkingBlock.entries.length === 0) {
                        activeWorkingBlock.title = nextTitle;
                        return activeWorkingBlock;
                    }
                    const summary = this.buildWorkingSummary(activeWorkingBlock);
                    activeWorkingBlock.status = 'completed';
                    activeWorkingBlock.summary = summary;
                    activeWorkingBlock.completedAt = Date.now();
                    this.callbacks.sendToWebview({
                        type: 'workingBlockCompleted',
                        blockId: activeWorkingBlock.id,
                        summary,
                        completedAt: activeWorkingBlock.completedAt
                    });
                    activeWorkingBlock = null;
                    lastProgressGroup = null;
                }

                const block = this.createWorkingBlock(nextTitle);
                allWorkingPhases.push(block);
                activeWorkingBlock = block;
                lastProgressGroup = null;
                this.callbacks.sendToWebview({ type: 'workingBlockStarted', block });
                return block;
            };

            const appendWorkingText = (text?: string) => {
                const trimmed = text?.trim();
                if (!trimmed) { return; }
                const block = ensureWorkingBlock();
                const lastEntry = block.entries[block.entries.length - 1];
                if (lastEntry?.kind === 'progress' && lastEntry.text === trimmed) { return; }
                const entry = this.createWorkingProgressEntry(trimmed);
                block.entries.push(entry);
                this.callbacks.sendToWebview({ type: 'workingTextAppended', blockId: block.id, entry });
            };

            const addWorkingAction = (desc: ToolProgressDescriptor, status: WorkingBlockActionEntry['status'], toolName: string): WorkingBlockActionEntry | null => {
                if (!this.isVisibleWorkingTool(toolName)) { return null; }
                const block = ensureWorkingBlock();
                if (desc.progressText && lastProgressGroup !== desc.progressGroup) {
                    appendWorkingText(desc.progressText);
                    lastProgressGroup = desc.progressGroup;
                }
                const entry: WorkingBlockActionEntry = {
                    id: this.nextUiId('action'),
                    kind: 'action',
                    text: status === 'running' ? desc.label : desc.doneLabel,
                    createdAt: Date.now(),
                    actionType: desc.actionType,
                    status,
                    detail: desc.detail,
                    filePath: desc.filePath,
                    toolName,
                    icon: desc.icon
                };
                block.entries.push(entry);
                this.callbacks.sendToWebview({ type: 'workingActionAdded', blockId: block.id, entry });
                return entry;
            };

            const updateWorkingAction = (entry: WorkingBlockActionEntry | null, desc: ToolProgressDescriptor, status: WorkingBlockActionEntry['status']) => {
                if (!entry || !activeWorkingBlock) { return; }
                entry.status = status;
                entry.text = status === 'running' ? desc.label : desc.doneLabel;
                entry.detail = desc.detail;
                entry.filePath = desc.filePath;
                entry.icon = status === 'error' ? 'error' : desc.icon;
                this.callbacks.sendToWebview({
                    type: 'workingActionUpdated',
                    blockId: activeWorkingBlock.id,
                    entryId: entry.id,
                    status,
                    text: entry.text,
                    detail: entry.detail,
                    filePath: entry.filePath,
                    icon: entry.icon
                });
            };

            const completeActiveWorkingBlock = () => {
                if (!activeWorkingBlock || activeWorkingBlock.status !== 'in_progress') { return; }
                if (activeWorkingBlock.entries.length === 0) {
                    allWorkingPhases.pop();
                    this.callbacks.sendToWebview({
                        type: 'workingBlockCompleted',
                        blockId: activeWorkingBlock.id,
                        summary: '',
                        completedAt: Date.now()
                    });
                    activeWorkingBlock = null;
                    lastProgressGroup = null;
                    return;
                }
                activeWorkingBlock.status = 'completed';
                activeWorkingBlock.summary = this.buildWorkingSummary(activeWorkingBlock);
                activeWorkingBlock.completedAt = Date.now();
                this.callbacks.sendToWebview({
                    type: 'workingBlockCompleted',
                    blockId: activeWorkingBlock.id,
                    summary: activeWorkingBlock.summary,
                    completedAt: activeWorkingBlock.completedAt
                });
                activeWorkingBlock = null;
                lastProgressGroup = null;
            };

            /** Flush all accumulated working phases onto the last tool-using assistant message. */
            const storeWorkingPhases = () => {
                if (lastToolAssistantMsg && allWorkingPhases.length > 0) {
                    lastToolAssistantMsg.workingPhases = [...allWorkingPhases];
                }
            };

            while (iteration < this.maxIterations && this.running) {
                iteration++;
                this.callbacks.sendToWebview({ type: 'setStatus', status: 'Thinking...' });

                // Trim context if approaching the window limit
                this.messages = this.contextManager.trimIfNeeded(this.messages);

                // Validate the client
                const validation = await this.aoaiClient.validate();
                if (validation) {
                    this.callbacks.sendToWebview({ type: 'error', message: `Configuration error: ${validation}` });
                    break;
                }

                this.callbacks.sendToWebview({ type: 'setStatus', status: 'Thinking...' });

                let assistantText = '';
                let toolCalls: ToolCall[] = [];
                let assistantBubbleStarted = false;
                let toolCallDetected = false;
                let textAlreadyRendered = false;
                let pendingTextBuffer = '';
                let flushTimer: ReturnType<typeof setTimeout> | undefined;

                // Flush buffered text into a streaming chat bubble
                const flushBufferAsBubble = () => {
                    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
                    if (!assistantBubbleStarted && pendingTextBuffer) {
                        completeActiveWorkingBlock();
                        storeWorkingPhases();
                        this.callbacks.sendToWebview({ type: 'startAssistantMessage' });
                        assistantBubbleStarted = true;
                        this.callbacks.sendToWebview({ type: 'appendAssistantText', text: pendingTextBuffer });
                        pendingTextBuffer = '';
                    }
                };

                try {
                    const stream = this.aoaiClient.streamChat(
                        this.messages,
                        tools,
                        this.abortController.signal,
                        { reasoningMode }
                    );

                    for await (const chunk of stream) {
                        if (!this.running) { break; }

                        if (chunk.type === 'text') {
                            assistantText += chunk.text;
                            if (toolCallDetected) {
                                // Tool calls already detected — buffer silently for narration
                            } else if (assistantBubbleStarted) {
                                // Bubble already flushed — continue streaming into it
                                this.callbacks.sendToWebview({ type: 'appendAssistantText', text: chunk.text });
                            } else {
                                // Buffer text and schedule a flush after 250ms.
                                // If tool_calls arrive before the timer fires, the text
                                // becomes narration instead of a chat bubble.
                                pendingTextBuffer += chunk.text;
                                if (!flushTimer) {
                                    flushTimer = setTimeout(() => {
                                        flushTimer = undefined;
                                        flushBufferAsBubble();
                                    }, 250);
                                }
                            }
                        } else if (chunk.type === 'toolCallStarted') {
                            toolCallDetected = true;
                            // Cancel the flush timer — text will be narration, not a bubble
                            if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
                            if (assistantBubbleStarted) {
                                // Bubble already opened (timer fired before toolCallStarted).
                                // The text is already visible in the bubble — just close it
                                // and mark as rendered so we don't duplicate as narration.
                                this.callbacks.sendToWebview({ type: 'endAssistantMessage' });
                                assistantBubbleStarted = false;
                                textAlreadyRendered = true;
                            }
                        } else if (chunk.type === 'toolCalls') {
                            toolCalls = chunk.calls;
                        } else if (chunk.type === 'usage' && this.tokenTracker) {
                            this.tokenTracker.record('chat', chunk.usage);
                        }
                    }
                    // Clean up flush timer
                    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
                } catch (streamErr: any) {
                    // Clean up flush timer on error
                    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
                    // Detect invalid_prompt / context-too-large errors (400) and attempt recovery
                    const isInvalidPrompt = streamErr.statusCode === 400 &&
                        (streamErr.errorCode === 'invalid_prompt' ||
                         /invalid.prompt/i.test(streamErr.message));

                    if (isInvalidPrompt && contextRecoveryAttempts < MAX_CONTEXT_RECOVERY_ATTEMPTS) {
                        contextRecoveryAttempts++;

                        if (contextRecoveryAttempts === 1) {
                            // First attempt: emergency trim (context overflow)
                            this.callbacks.sendToWebview({
                                type: 'setStatus',
                                status: 'Prompt too large for model — trimming context...'
                            });
                            this.messages = this.contextManager.emergencyTrim(this.messages);
                        } else if (contextRecoveryAttempts === 2) {
                            // Second attempt: switch to reasoning-compatible params
                            // (system→developer role, drop temperature)
                            reasoningMode = true;
                            this.callbacks.sendToWebview({
                                type: 'setStatus',
                                status: 'Retrying with reasoning-compatible parameters...'
                            });
                        } else {
                            // Third attempt: fall back to a different deployment
                            const fallback = this.findFallbackDeployment();
                            if (fallback) {
                                this.aoaiClient.setDeploymentOverride(fallback.deploymentId);
                                reasoningMode = false; // reset — fallback model may be standard
                                this.messages = this.contextManager.emergencyTrim(this.messages);
                                const label = fallback.name || fallback.deploymentId;
                                this.callbacks.sendToWebview({
                                    type: 'setStatus',
                                    status: `Switching to ${label} to continue...`
                                });
                            } else {
                                // No fallback available — rethrow
                                throw streamErr;
                            }
                        }
                        continue; // retry the while-loop iteration
                    }
                    // Not recoverable — rethrow to the outer catch
                    throw streamErr;
                }
                // Reset recovery counter on successful streaming
                contextRecoveryAttempts = 0;

                if (!this.running) { break; }

                // Add assistant message to history
                const assistantMsg: ChatMessage = {
                    role: 'assistant',
                    content: assistantText || null
                };
                if (toolCalls.length > 0) {
                    assistantMsg.tool_calls = toolCalls;
                    lastToolAssistantMsg = assistantMsg;

                    // Show narration text alongside tool calls (GHCP-style).
                    // Skip if text was already rendered in a bubble (timer fired before toolCallStarted).
                    if (assistantText.trim() && !textAlreadyRendered) {
                        completeActiveWorkingBlock();
                        this.callbacks.sendToWebview({ type: 'narrationText', text: assistantText.trim() });
                    }
                }
                this.messages.push(assistantMsg);

                // If no tool calls, check autofix FIRST so intermediate text
                // can be shown as a narration row instead of a final chat bubble.
                if (toolCalls.length === 0) {
                    let autofixContinue = false;
                    if (autofixCycles < MAX_AUTOFIX_CYCLES && this.editedFiles.size > 0) {
                        const errorSummary = await this.checkEditedFileDiagnostics();
                        if (errorSummary) {
                            autofixContinue = true;
                            autofixCycles++;
                            this.messages.push({
                                role: 'system',
                                content: `[Auto-fix] The following errors were detected in files you edited. Please fix them before finishing:\n${errorSummary}`
                            });
                        }
                    }

                    if (autofixContinue) {
                        // The agent is continuing — render any text as an inline narration row
                        if (assistantBubbleStarted) {
                            this.callbacks.sendToWebview({ type: 'endAssistantMessage' });
                        } else if (assistantText.trim()) {
                            completeActiveWorkingBlock();
                            this.callbacks.sendToWebview({ type: 'narrationText', text: assistantText.trim() });
                        }
                        this.callbacks.sendToWebview({ type: 'setStatus', status: `Auto-fixing errors (cycle ${autofixCycles}/${MAX_AUTOFIX_CYCLES})...` });
                        continue;
                    }

                    // Done — show final text as a full chat bubble
                    if (assistantBubbleStarted) {
                        // Bubble was opened during streaming — just close it
                        this.callbacks.sendToWebview({ type: 'endAssistantMessage' });
                    } else if (assistantText) {
                        // Text was buffered (short response or timer hadn't fired)
                        completeActiveWorkingBlock();
                        storeWorkingPhases();
                        this.callbacks.sendToWebview({ type: 'startAssistantMessage' });
                        this.callbacks.sendToWebview({ type: 'appendAssistantText', text: assistantText });
                        this.callbacks.sendToWebview({ type: 'endAssistantMessage' });
                    }
                    break;
                }

                // Tools that are safe to run concurrently (read-only, no side effects)
                const READ_ONLY_TOOLS = new Set([
                    'read_file', 'list_directory', 'search_files', 'grep_search',
                    'semantic_search', 'get_file_tree', 'find_symbol', 'get_symbol_detail',
                    'go_to_definition', 'find_references', 'get_diagnostics', 'get_open_editors',
                    'set_plan', 'update_plan_step'
                ]);

                const allReadOnly = toolCalls.every(tc => READ_ONLY_TOOLS.has(tc.function.name));

                if (allReadOnly && toolCalls.length > 1) {
                    // ── Parallel execution for read-only tool calls ──
                    this.callbacks.sendToWebview({ type: 'setStatus', status: `Reading ${toolCalls.length} files...` });
                    if (toolCalls.some(tc => this.isVisibleWorkingTool(tc.function.name))) {
                        appendWorkingText('Reviewing the relevant files and symbols for this phase.');
                    }

                    const actionEntries = new Map<string, WorkingBlockActionEntry | null>();

                    // Show all tool calls and emit progress steps
                    for (const tc of toolCalls) {
                        let args: Record<string, unknown>;
                        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
                        this.callbacks.sendToWebview({
                            type: 'toolCall', name: tc.function.name, args: tc.function.arguments, id: tc.id
                        });
                        const desc = this.describeToolForProgress(tc.function.name, args);
                        actionEntries.set(tc.id, addWorkingAction(desc, 'running', tc.function.name));
                    }

                    // Execute all in parallel (with cancellation check)
                    const results = await Promise.all(toolCalls.map(async (tc) => {
                        if (this.cancelled) {
                            return { tc, result: { success: false, result: 'Cancelled by user.' } };
                        }
                        let args: Record<string, unknown>;
                        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
                        const result = await this.executeToolWithRetry(tc.function.name, args);
                        return { tc, result };
                    }));

                    // Report results and add to history
                    for (const { tc, result } of results) {
                        this.callbacks.sendToWebview({
                            type: 'toolResult', id: tc.id, result: result.result, success: result.success
                        });
                        let args: Record<string, unknown>;
                        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
                        // Track edited files for auto-fix
                        if (result.success && WRITE_TOOLS.has(tc.function.name) && typeof args.path === 'string') {
                            this.editedFiles.add(args.path);
                        }
                        const desc = this.describeToolForProgress(tc.function.name, args);
                        updateWorkingAction(actionEntries.get(tc.id) || null, desc, result.success ? 'done' : 'error');
                        this.messages.push({
                            role: 'tool', content: result.result, tool_call_id: tc.id, name: tc.function.name
                        });
                    }
                } else {
                    // ── Sequential execution (writes / mixed / single tool) ──
                    // Pre-create working block so toolCall events are suppressed in the webview
                    if (toolCalls.some(tc => this.isVisibleWorkingTool(tc.function.name))) {
                        ensureWorkingBlock();
                    }
                    for (const tc of toolCalls) {
                        if (!this.running) { break; }

                        const friendlyStatus = this.friendlyToolStatus(tc.function.name);
                        this.callbacks.sendToWebview({ type: 'setStatus', status: friendlyStatus });

                        let args: Record<string, unknown>;
                        try {
                            args = JSON.parse(tc.function.arguments);
                        } catch {
                            args = {};
                        }

                        this.callbacks.sendToWebview({
                            type: 'toolCall',
                            name: tc.function.name,
                            args: tc.function.arguments,
                            id: tc.id
                        });

                        // Emit progress step as "running"
                        const desc = this.describeToolForProgress(tc.function.name, args);
                        const actionEntry = addWorkingAction(desc, 'running', tc.function.name);

                        const result = await this.executeToolWithRetry(tc.function.name, args);

                        // Track edited files for auto-fix
                        if (result.success && WRITE_TOOLS.has(tc.function.name) && typeof args.path === 'string') {
                            this.editedFiles.add(args.path);
                        }

                        this.callbacks.sendToWebview({
                            type: 'toolResult',
                            id: tc.id,
                            result: result.result,
                            success: result.success
                        });

                        // Update the last progress step with the result
                        updateWorkingAction(actionEntry, desc, result.success ? 'done' : 'error');

                        // Add tool result to history
                        this.messages.push({
                            role: 'tool',
                            content: result.result,
                            tool_call_id: tc.id,
                            name: tc.function.name
                        });
                    }
                }

                // DON'T complete the working block here — let it persist across iterations
                // so actions group together under one block per plan phase.

                // When hitting the iteration limit, ask the user if they want to continue
                if (iteration >= this.maxIterations && this.running) {
                    this.callbacks.sendToWebview({ type: 'continueIteration', iterationCount: iteration });
                    this.callbacks.sendToWebview({ type: 'setStatus', status: `Paused at ${iteration} iterations — waiting for your decision...` });

                    const shouldContinue = await new Promise<boolean>(resolve => {
                        this.pendingContinuation = { resolve };
                    });

                    if (shouldContinue) {
                        // Reset the iteration counter so the agent gets another full batch
                        iteration = 0;
                        this.callbacks.sendToWebview({ type: 'setStatus', status: 'Continuing...' });
                    } else {
                        this.messages.push({
                            role: 'assistant',
                            content: `Paused after ${this.maxIterations} iterations.`
                        });
                        this.callbacks.sendToWebview({ type: 'startAssistantMessage' });
                        this.callbacks.sendToWebview({ type: 'appendAssistantText', text: `Paused after ${this.maxIterations} iterations.` });
                        this.callbacks.sendToWebview({ type: 'endAssistantMessage' });
                        break;
                    }
                }

            }
            // End of while loop — ensure any open working block is completed and phases stored
            completeActiveWorkingBlock();
            storeWorkingPhases();
        } catch (e: unknown) {
            if (!this.cancelled && (e as Error).name !== 'AbortError') {
                this.callbacks.sendToWebview({
                    type: 'error',
                    message: `Agent error: ${e instanceof Error ? e.message : String(e)}`
                });
            }
        } finally {
            // Clear any deployment override so subsequent runs use the configured model
            this.aoaiClient.setDeploymentOverride(undefined);
            // Mark any remaining pending/in-progress plan steps as completed
            for (const step of this.planSteps) {
                if (step.status === 'in_progress' || step.status === 'pending') {
                    step.status = 'completed';
                }
            }
            if (this.planSteps.length > 0) {
                this.callbacks.sendToWebview({ type: 'agentPlan', steps: [...this.planSteps] });
            }
            this.running = false;
            this.abortController = null;
            this.callbacks.sendToWebview({ type: 'agentDone' });
            this.callbacks.sendToWebview({ type: 'setStatus', status: '' });
        }
    }

    private getAllToolDefinitions(): ToolDefinition[] {
        const builtin = this.builtinTools.getDefinitions();
        const mcp = this.mcpClient.getToolDefinitions();
        return [...builtin, ...mcp];
    }

    /**
     * Find a fallback deployment from the configured deployments list.
     * Returns the first deployment that isn't the currently active one, or null.
     */
    private findFallbackDeployment(): { name: string; deploymentId: string } | null {
        const deployments = getSetting<Array<{ name: string; deploymentId: string }>>('azureOpenAI.deployments') || [];
        const active = this.aoaiClient.getEffectiveDeployment();
        for (const d of deployments) {
            if (d.deploymentId && d.deploymentId !== active) {
                return d;
            }
        }
        return null;
    }

    /**
     * Check diagnostics on all files edited during this run.
     * Returns a summary string of Error-level diagnostics, or null if clean.
     */
    private async checkEditedFileDiagnostics(): Promise<string | null> {
        if (this.editedFiles.size === 0) { return null; }

        // Wait briefly for language servers to process changes
        await new Promise(r => setTimeout(r, 800));

        const errors: string[] = [];
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return null; }

        for (const relPath of this.editedFiles) {
            const absPath = path.resolve(root, relPath);
            const uri = vscode.Uri.file(absPath);
            try {
                const diags = vscode.languages.getDiagnostics(uri);
                for (const d of diags) {
                    if (d.severity === vscode.DiagnosticSeverity.Error) {
                        errors.push(`${relPath}:${d.range.start.line + 1}: [Error] ${d.message}`);
                    }
                }
            } catch {
                // File may have been deleted — skip
            }
        }

        if (errors.length === 0) { return null; }
        // Cap at 20 errors to avoid bloating context
        const capped = errors.slice(0, 20);
        if (errors.length > 20) {
            capped.push(`... and ${errors.length - 20} more errors.`);
        }
        return capped.join('\n');
    }

    private async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        // Bail early if the run was cancelled
        if (this.cancelled) {
            return { success: false, result: 'Cancelled by user.' };
        }

        // Validate arguments against the tool's schema
        const toolDef = this.toolSchemaMap.get(name);
        if (toolDef) {
            const validation = validateToolArgs(toolDef, args);
            if (!validation.valid) {
                return { success: false, result: `Invalid arguments: ${validation.errors.join(' ')}` };
            }
        }

        // Check built-in tools first
        const handler = this.builtinTools.getHandler(name);
        if (handler) {
            return handler(args);
        }

        // Check MCP tools (prefixed with "mcp_")
        if (name.startsWith('mcp_')) {
            return this.mcpClient.callTool(name, args);
        }

        return { success: false, result: `Unknown tool: ${name}` };
    }

    /**
     * Execute a tool with automatic retry on failure.
     * Retries once after a short delay unless the tool is in the no-retry set
     * or the failure indicates user cancellation.
     */
    private async executeToolWithRetry(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        const result = await this.executeTool(name, args);

        if (result.success) { return result; }

        // Don't retry certain tools or user-declined actions
        if (NO_RETRY_TOOLS.has(name)) { return result; }
        if (result.result.includes('User declined')) { return result; }
        if (result.result.includes('Invalid path')) { return result; }

        // Retry once
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        const retry = await this.executeTool(name, args);
        if (!retry.success) {
            retry.result = `[Retry also failed] ${retry.result}`;
        }
        return retry;
    }

    /**
     * Build a concise context snapshot to inject before the first model call.
     * Gives the model awareness of open files, diagnostics, and workspace shape
     * without requiring extra tool calls.
     */
    private buildContextPack(): string {
        const sections: string[] = [];

        // 1. Open editors
        try {
            const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
            const openFiles = tabs
                .map(t => {
                    const input = t.input as { uri?: vscode.Uri } | undefined;
                    return input?.uri ? vscode.workspace.asRelativePath(input.uri, false) : null;
                })
                .filter(Boolean);
            if (openFiles.length > 0) {
                sections.push('Open editors:\n' + openFiles.map(f => `  ${f}`).join('\n'));
            }
        } catch { /* ignore */ }

        // 2. Active diagnostics (errors and warnings only, capped)
        try {
            const allDiags = vscode.languages.getDiagnostics() as [vscode.Uri, vscode.Diagnostic[]][];
            const important: string[] = [];
            for (const [uri, diags] of allDiags) {
                for (const d of diags) {
                    if (d.severity > vscode.DiagnosticSeverity.Warning) { continue; }
                    const relPath = vscode.workspace.asRelativePath(uri, false);
                    const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
                    important.push(`  ${relPath}:${d.range.start.line + 1}: [${sev}] ${d.message}`);
                }
                if (important.length >= 20) { break; }
            }
            if (important.length > 0) {
                sections.push('Active diagnostics:\n' + important.join('\n'));
            }
        } catch { /* ignore */ }

        // 3. Active file (the focused editor)
        try {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                const relPath = vscode.workspace.asRelativePath(activeEditor.document.uri, false);
                const line = activeEditor.selection.active.line + 1;
                sections.push(`Active file: ${relPath} (cursor at line ${line})`);
            }
        } catch { /* ignore */ }

        // 4. Workspace name
        try {
            const wsName = vscode.workspace.workspaceFolders?.[0]?.name;
            if (wsName) {
                sections.push(`Workspace: ${wsName}`);
            }
        } catch { /* ignore */ }

        if (sections.length === 0) { return ''; }
        return '[Context Snapshot]\n' + sections.join('\n\n');
    }
}


