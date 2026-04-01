/**
 * ResponseStream — async iterable with transform/finalize hooks.
 *
 * Inspired by Microsoft Agent Framework's ResponseStream<UpdateT, FinalT>.
 * Provides a composable streaming abstraction that supports:
 *   - Async iteration (for await...of)
 *   - Transform hooks (modify chunks in flight)
 *   - Result hooks (run when the final response is available)
 *   - Cleanup hooks (always run, even on error)
 *   - Getting the final aggregated response
 */

/**
 * A stream of updates that resolves to a final result.
 *
 * @typeParam U - The update/chunk type emitted during streaming.
 * @typeParam F - The final result type available after the stream completes.
 */
export class ResponseStream<U, F> implements AsyncIterable<U> {
    private source: AsyncGenerator<U>;
    private finalResult: F | undefined;
    private completed = false;
    private transformHooks: Array<(chunk: U) => U | null> = [];
    private resultHooks: Array<(result: F) => void> = [];
    private cleanupHooks: Array<() => void | Promise<void>> = [];
    private finalizerFn?: (chunks: U[]) => F;

    /**
     * @param source - The underlying async generator producing updates.
     * @param finalizer - Optional function to derive the final result from
     *                    all collected chunks. If not provided, call
     *                    `setFinalResult()` manually.
     */
    constructor(source: AsyncGenerator<U>, finalizer?: (chunks: U[]) => F) {
        this.source = source;
        this.finalizerFn = finalizer;
    }

    /**
     * Create a ResponseStream from an async function that produces
     * the final result directly (no streaming).
     */
    static fromAwaitable<U, F>(awaitable: Promise<F>): ResponseStream<U, F> {
        async function* empty(): AsyncGenerator<U> {
            // No chunks — result comes from the awaitable
        }
        const stream = new ResponseStream<U, F>(empty());
        awaitable.then(result => stream.setFinalResult(result));
        return stream;
    }

    /**
     * Create a ResponseStream from an array of chunks + a final result.
     * Useful for testing.
     */
    static fromArray<U, F>(chunks: U[], result: F): ResponseStream<U, F> {
        async function* gen(): AsyncGenerator<U> {
            for (const chunk of chunks) {
                yield chunk;
            }
        }
        const stream = new ResponseStream<U, F>(gen());
        stream.setFinalResult(result);
        return stream;
    }

    /**
     * Add a transform hook that can modify or filter chunks.
     * Return null to skip/suppress a chunk.
     */
    withTransformHook(hook: (chunk: U) => U | null): this {
        this.transformHooks.push(hook);
        return this;
    }

    /** Add a hook called when the final result is available. */
    withResultHook(hook: (result: F) => void): this {
        this.resultHooks.push(hook);
        return this;
    }

    /** Add a cleanup hook called after iteration completes (success or error). */
    withCleanupHook(hook: () => void | Promise<void>): this {
        this.cleanupHooks.push(hook);
        return this;
    }

    /** Manually set the final result (for deferred finalization). */
    setFinalResult(result: F): void {
        this.finalResult = result;
        this.completed = true;
        for (const hook of this.resultHooks) {
            try { hook(result); } catch { /* swallow */ }
        }
    }

    /** Get the final result. Throws if not yet available. */
    getFinalResult(): F {
        if (!this.completed || this.finalResult === undefined) {
            throw new Error('ResponseStream has not completed yet');
        }
        return this.finalResult;
    }

    /** Whether the stream has completed and a final result is available. */
    get isCompleted(): boolean {
        return this.completed;
    }

    /** Async iteration protocol. */
    async *[Symbol.asyncIterator](): AsyncGenerator<U> {
        const collectedChunks: U[] = [];
        try {
            for await (const raw of this.source) {
                // Apply transform hooks
                let chunk: U | null = raw;
                for (const hook of this.transformHooks) {
                    chunk = hook(chunk);
                    if (chunk === null) { break; }
                }
                if (chunk !== null) {
                    collectedChunks.push(chunk);
                    yield chunk;
                }
            }

            // If a finalizer function was provided, derive the final result
            if (this.finalizerFn && !this.completed) {
                this.setFinalResult(this.finalizerFn(collectedChunks));
            }
        } finally {
            // Run cleanup hooks
            for (const hook of this.cleanupHooks) {
                try { await hook(); } catch { /* swallow */ }
            }
        }
    }

    /**
     * Consume the entire stream and return the final result.
     * All chunks are discarded (but transform hooks still run).
     */
    async drain(): Promise<F> {
        for await (const _ of this) {
            // consume
        }
        return this.getFinalResult();
    }

    /**
     * Collect all chunks into an array and return them with the final result.
     */
    async collect(): Promise<{ chunks: U[]; result: F }> {
        const chunks: U[] = [];
        for await (const chunk of this) {
            chunks.push(chunk);
        }
        return { chunks, result: this.getFinalResult() };
    }
}
