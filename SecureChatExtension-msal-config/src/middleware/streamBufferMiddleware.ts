/**
 * StreamBufferMiddleware — AgentMiddleware that handles the text
 * buffering, narration vs chat bubble decision, and flush timer logic.
 *
 * Extracted from AgentLoop streaming flow (lines 789-859):
 * - Text chunks are buffered for 250ms
 * - If a tool call arrives before flush: text becomes narration
 * - If flush timer fires first: text becomes a chat bubble
 * - Subsequent text appends to the open bubble
 *
 * This middleware is somewhat unique — it doesn't wrap the standard
 * process(context, next) pattern cleanly because it needs to intercept
 * individual stream chunks. Instead, it provides helper methods that
 * the agent loop calls during streaming.
 */

import type { AgentCallbacks } from '../agentLoop';

export interface StreamBufferCallbacks {
    sendToWebview: AgentCallbacks['sendToWebview'];
    /**
     * Called just before flushing buffered text as a chat bubble.
     * The agent loop uses this to complete the active working block
     * and store working phases before the bubble opens.
     */
    onBeforeFlush?: () => void;
}

export class StreamBufferMiddleware {
    readonly name = 'stream-buffer';
    private callbacks: StreamBufferCallbacks;
    private flushDelayMs: number;

    // ── Buffer State ──
    private pendingTextBuffer = '';
    private flushTimer: ReturnType<typeof setTimeout> | undefined;
    private assistantBubbleStarted = false;
    private toolCallDetected = false;
    private textAlreadyRendered = false;
    private assistantText = '';

    constructor(callbacks: StreamBufferCallbacks, flushDelayMs = 250) {
        this.callbacks = callbacks;
        this.flushDelayMs = flushDelayMs;
    }

    /** Called when a text chunk arrives from the stream. */
    onTextChunk(text: string): void {
        this.assistantText += text;

        if (this.assistantBubbleStarted) {
            // Already showing a bubble — append directly
            this.callbacks.sendToWebview({ type: 'appendAssistantText', text });
            return;
        }

        // Accumulate only while we haven't committed to a rendering path
        this.pendingTextBuffer += text;

        if (this.toolCallDetected) {
            // Tool calls already detected — text is narration, don't flush as bubble
            return;
        }

        // Schedule flush if not already scheduled
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => this.flushBufferAsBubble(), this.flushDelayMs);
        }
    }

    /** Called when the first tool call delta is detected. */
    onToolCallDetected(): void {
        this.toolCallDetected = true;

        // Cancel pending flush — text becomes narration instead
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }

        // If bubble was already opened, close it
        if (this.assistantBubbleStarted) {
            this.callbacks.sendToWebview({ type: 'endAssistantMessage' });
            this.assistantBubbleStarted = false;
            this.textAlreadyRendered = true;
        }
    }

    /**
     * Called when streaming is complete.
     * Returns the narration text (if any) and the full assistant text.
     *
     * narrationText is non-null only when:
     *   1. Tool calls were detected (text precedes tool use)
     *   2. Text was NOT already rendered as a chat bubble
     *   3. There is actual buffered text to show
     */
    finalize(): { narrationText: string | null; assistantText: string; bubbleOpen: boolean; textAlreadyRendered: boolean } {
        // Cancel any pending flush
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }

        const narration = (this.toolCallDetected && !this.textAlreadyRendered && this.pendingTextBuffer.trim())
            ? this.pendingTextBuffer.trim()
            : null;

        return {
            narrationText: narration,
            assistantText: this.assistantText,
            bubbleOpen: this.assistantBubbleStarted,
            textAlreadyRendered: this.textAlreadyRendered,
        };
    }

    /** Reset state for a new iteration. */
    reset(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
        this.pendingTextBuffer = '';
        this.assistantBubbleStarted = false;
        this.toolCallDetected = false;
        this.textAlreadyRendered = false;
        this.assistantText = '';
    }

    /** Whether a chat bubble is currently open. */
    get isBubbleOpen(): boolean {
        return this.assistantBubbleStarted;
    }

    /** The accumulated assistant text. */
    get text(): string {
        return this.assistantText;
    }

    private flushBufferAsBubble(): void {
        this.flushTimer = undefined;
        if (!this.pendingTextBuffer) { return; }

        // Let the agent loop complete working blocks before opening the bubble
        this.callbacks.onBeforeFlush?.();
        this.callbacks.sendToWebview({ type: 'startAssistantMessage' });
        this.callbacks.sendToWebview({ type: 'appendAssistantText', text: this.pendingTextBuffer });
        this.assistantBubbleStarted = true;
        this.pendingTextBuffer = '';
    }
}
