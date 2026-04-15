/**
 * Session restore — stateless helpers for replaying persisted chat sessions
 * back into the webview UI.
 *
 * Extracted from ChatViewProvider to keep the 300+ line transcript replay
 * and tool-description logic in a focused module.
 */
import {
    ChatMessage,
    ExtensionMessage,
    WorkingBlock,
    WorkingBlockActionEntry,
    WorkingActionType,
} from './types';

/**
 * Replay persisted session messages into the webview using the working-block
 * protocol. This is the fallback path when no persisted transcript exists.
 */
export function replaySessionMessages(
    messages: ChatMessage[],
    sendToWebview: (msg: ExtensionMessage) => void,
): void {
    // Build a map of tool_call_id → success for completed tool results
    const toolResults = new Map<string, boolean>();
    for (const msg of messages) {
        if ((msg as any).role === 'tool' && (msg as any).tool_call_id) {
            const content = String((msg as any).content || '');
            const failed = content.startsWith('Error') || content.startsWith('Failed') || content.startsWith('VALIDATION');
            toolResults.set((msg as any).tool_call_id, !failed);
        }
    }

    // Check if any assistant message has workingPhases — if so, those phases
    // already cover ALL the tool-calling iterations, so skip the fallback path.
    const hasStoredPhases = messages.some(
        m => m.role === 'assistant' && m.workingPhases && m.workingPhases.length > 0
    );

    // Replay messages to the webview for restoration
    let pendingBlock: WorkingBlock | null = null;
    let pendingEntries: WorkingBlockActionEntry[] = [];

    const pendingNarrations: string[] = [];

    const flushPendingBlock = () => {
        if (!pendingBlock || pendingEntries.length === 0) {
            pendingBlock = null;
            pendingEntries = [];
            return;
        }
        sendToWebview({ type: 'workingBlockStarted', block: pendingBlock });
        for (const entry of pendingEntries) {
            sendToWebview({ type: 'workingActionAdded', blockId: pendingBlock.id, entry });
        }
        sendToWebview({
            type: 'workingBlockCompleted',
            blockId: pendingBlock.id,
            summary: buildRestoreSummaryFromEntries(pendingEntries),
            completedAt: Date.now()
        });
        pendingBlock = null;
        pendingEntries = [];
    };

    for (const msg of messages) {
        if (msg.role === 'user' && msg.content) {
            flushPendingBlock();
            const display = (msg as any).displayText;
            if (Array.isArray(msg.content)) {
                let text = '';
                const images: string[] = [];
                for (const part of msg.content) {
                    if (part.type === 'text') { text = part.text; }
                    else if (part.type === 'image_url') { images.push(part.image_url.url); }
                }
                sendToWebview({ type: 'addUserMessage', text: display || text, images: images.length > 0 ? images : undefined });
            } else {
                sendToWebview({ type: 'addUserMessage', text: display || msg.content });
            }
        } else if (msg.role === 'assistant') {
            if (msg.workingPhases && msg.workingPhases.length > 0) {
                if (msg.tool_calls && msg.tool_calls.length > 0
                    && msg.content && typeof msg.content === 'string' && msg.content.trim()) {
                    pendingNarrations.push(msg.content.trim());
                }

                flushPendingBlock();
                for (let i = 0; i < msg.workingPhases.length; i++) {
                    const phase = msg.workingPhases[i];
                    if (i < pendingNarrations.length && pendingNarrations[i]) {
                        sendToWebview({ type: 'narrationText', text: pendingNarrations[i] });
                    }
                    const block: WorkingBlock = {
                        ...phase,
                        entries: []
                    };
                    sendToWebview({ type: 'workingBlockStarted', block });
                    for (const entry of phase.entries) {
                        if (entry.kind === 'progress') {
                            sendToWebview({ type: 'workingTextAppended', blockId: phase.id, entry });
                        } else if (entry.kind === 'terminal') {
                            for (const line of entry.text.split(/\r?\n/)) {
                                if (!line) { continue; }
                                sendToWebview({ type: 'terminalOutput', line });
                            }
                        } else {
                            sendToWebview({ type: 'workingActionAdded', blockId: phase.id, entry });
                        }
                    }
                    sendToWebview({
                        type: 'workingBlockCompleted',
                        blockId: phase.id,
                        summary: phase.summary || phase.title,
                        completedAt: phase.completedAt || phase.startedAt
                    });
                }
                for (let i = msg.workingPhases.length; i < pendingNarrations.length; i++) {
                    if (pendingNarrations[i]) {
                        sendToWebview({ type: 'narrationText', text: pendingNarrations[i] });
                    }
                }
                pendingNarrations.length = 0;
            } else if (hasStoredPhases && msg.tool_calls && msg.tool_calls.length > 0) {
                if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
                    pendingNarrations.push(msg.content.trim());
                }
            } else if (!hasStoredPhases && msg.tool_calls && msg.tool_calls.length > 0) {
                if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
                    flushPendingBlock();
                    sendToWebview({ type: 'narrationText', text: msg.content.trim() });
                }

                const realCalls = msg.tool_calls.filter((tc: any) =>
                    tc.function.name !== 'set_plan' && tc.function.name !== 'update_plan_step'
                );
                if (realCalls.length > 0) {
                    if (!pendingBlock) {
                        pendingBlock = createRestoreWorkingBlock('Working');
                    }
                    for (const tc of realCalls) {
                        let args: Record<string, unknown> = {};
                        try { args = JSON.parse(tc.function.arguments); } catch {}
                        const success = toolResults.get(tc.id) !== false;
                        const entry = describeToolForRestore(tc.function.name, args, success);
                        pendingEntries.push(entry);
                    }
                }
            }

            if ((!msg.workingPhases || msg.workingPhases.length === 0)
                && (!msg.tool_calls || msg.tool_calls.length === 0)
                && msg.content && typeof msg.content === 'string') {
                flushPendingBlock();
                sendToWebview({ type: 'startAssistantMessage' });
                sendToWebview({ type: 'appendAssistantText', text: msg.content });
                sendToWebview({ type: 'endAssistantMessage' });
            }
        }
    }
    flushPendingBlock();
}

export function createRestoreWorkingBlock(title: string): WorkingBlock {
    return {
        id: `restore_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        status: 'completed',
        title,
        summary: title,
        entries: [],
        startedAt: Date.now(),
        completedAt: Date.now()
    };
}

export function buildRestoreSummaryFromEntries(entries: WorkingBlockActionEntry[]): string {
    if (entries.length === 0) { return 'Working'; }

    const counts = new Map<WorkingActionType, number>();
    for (const e of entries) {
        counts.set(e.actionType, (counts.get(e.actionType) || 0) + 1);
    }

    const describeBucket = (at: WorkingActionType, count: number): string => {
        switch (at) {
            case 'read': case 'review':
                return `Reviewed ${count} file${count === 1 ? '' : 's'}`;
            case 'search':
                return count === 1 ? 'Ran 1 search' : `Ran ${count} searches`;
            case 'create': {
                if (count === 1) {
                    const single = entries.find(e => e.actionType === at);
                    return single?.text || 'Created 1 file';
                }
                return `Created ${count} files`;
            }
            case 'edit': {
                if (count === 1) {
                    const single = entries.find(e => e.actionType === at);
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
    for (const e of entries) {
        if (seen.has(e.actionType)) { continue; }
        seen.add(e.actionType);
        parts.push(describeBucket(e.actionType, counts.get(e.actionType) || 0));
        if (parts.length >= 2) { break; }
    }

    return parts.length > 0 ? parts.join(' and ') : 'Working';
}

export function describeToolForRestore(name: string, args: Record<string, unknown>, success: boolean): WorkingBlockActionEntry {
    const shortPath = (p: unknown): string => {
        if (typeof p !== 'string') { return ''; }
        const parts = p.replace(/\\/g, '/').split('/');
        return parts.length > 3 ? parts.slice(-3).join('/') : p;
    };
    const trunc = (s: string, max: number) => s.length <= max ? s : s.slice(0, max) + '...';
    const choose = (doneText: string, failText: string) => success ? doneText : failText;

    const buildEntry = (
        text: string,
        actionType: WorkingBlockActionEntry['actionType'],
        icon: WorkingBlockActionEntry['icon'],
        detail?: string,
        filePath?: string
    ): WorkingBlockActionEntry => ({
        id: `restore_entry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'action',
        text,
        createdAt: Date.now(),
        actionType,
        status: success ? 'done' : 'error',
        detail,
        filePath,
        toolName: name,
        icon: success ? icon : 'error'
    });

    switch (name) {
        case 'grep_search':
            return buildEntry(choose(`Searched for regex ${typeof args.pattern === 'string' ? `\`${args.pattern}\`` : ''}`, `Search failed for regex ${typeof args.pattern === 'string' ? `\`${args.pattern}\`` : ''}`), 'search', 'search', typeof args.include === 'string' ? `(${args.include})` : undefined);
        case 'search_files':
            return buildEntry(choose(`Searched files: ${args.query || ''}`, `File search failed: ${args.query || ''}`), 'search', 'search');
        case 'semantic_search':
            return buildEntry(choose(`Semantic search: ${args.query || ''}`, `Semantic search failed: ${args.query || ''}`), 'search', 'search');
        case 'find_symbol':
            return buildEntry(choose(`Found symbol: ${args.name || ''}`, `Symbol lookup failed: ${args.name || ''}`), 'search', 'search');
        case 'read_file':
            return buildEntry(choose(`Read ${shortPath(args.path)}`, `Failed to read ${shortPath(args.path)}`), 'read', 'read', args.startLine ? `lines ${args.startLine} to ${args.endLine || ''}` : undefined, typeof args.path === 'string' ? args.path : undefined);
        case 'list_directory':
            return buildEntry(choose(`Listed ${shortPath(args.path) || '.'}`, `Failed to list ${shortPath(args.path) || '.'}`), 'review', 'read');
        case 'get_file_tree':
            return buildEntry(choose('Loaded workspace file tree', 'Failed to load workspace file tree'), 'review', 'read');
        case 'get_diagnostics':
            return buildEntry(choose(`Checked diagnostics${args.path ? ' for ' + shortPath(args.path) : ''}`, `Failed to check diagnostics${args.path ? ' for ' + shortPath(args.path) : ''}`), 'check', 'check', undefined, typeof args.path === 'string' ? args.path : undefined);
        case 'write_file':
            return buildEntry(choose(`Created ${shortPath(args.path)}`, `Failed to create ${shortPath(args.path)}`), 'create', 'edit', undefined, typeof args.path === 'string' ? args.path : undefined);
        case 'edit_file':
            return buildEntry(choose(`Edited ${shortPath(args.path)}`, `Failed to edit ${shortPath(args.path)}`), 'edit', 'edit', undefined, typeof args.path === 'string' ? args.path : undefined);
        case 'replace_lines': {
            const rlStart = Number(args.start_line) || 1;
            const rlNewLines = typeof args.new_content === 'string' ? args.new_content.split('\n').length : 0;
            const rlEnd = rlStart + Math.max(rlNewLines, 1) - 1;
            return buildEntry(choose(`Rewrote lines ${rlStart}–${rlEnd} in ${shortPath(args.path)}`, `Failed to rewrite lines ${rlStart}–${rlEnd} in ${shortPath(args.path)}`), 'edit', 'edit', undefined, typeof args.path === 'string' ? args.path : undefined);
        }
        case 'delete_file':
            return buildEntry(choose(`Deleted ${shortPath(args.path)}`, `Failed to delete ${shortPath(args.path)}`), 'edit', 'edit', undefined, typeof args.path === 'string' ? args.path : undefined);
        case 'run_terminal_command':
            return buildEntry(choose(`Ran: ${trunc(String(args.command || ''), 60)}`, `Command failed: ${trunc(String(args.command || ''), 60)}`), 'run', 'run');
        case 'check_terminal_output':
            return buildEntry(choose(`Checked terminal: ${args.process_id || ''}`, `Failed terminal check: ${args.process_id || ''}`), 'check', 'check');
        default:
            if (name.startsWith('mcp_')) {
                return buildEntry(`MCP: ${name.replace(/^mcp_/, '')}`, 'other', 'run');
            }
            return buildEntry(`Ran: ${name}`, 'other', 'loading');
    }
}
