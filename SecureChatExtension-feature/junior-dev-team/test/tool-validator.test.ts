import { describe, expect, it } from 'vitest';
import { buildToolSchemaMap, validateToolArgs } from '../src/toolValidator';
import { ToolDefinition } from '../src/types';

function tool(name: string, parameters: ToolDefinition['function']['parameters']): ToolDefinition {
    return {
        type: 'function',
        function: { name, description: '', parameters },
    };
}

describe('validateToolArgs — required parameters', () => {
    const def = tool('read_file', {
        type: 'object',
        properties: {
            path: { type: 'string' },
            startLine: { type: 'number' },
        },
        required: ['path'],
    });

    it('reports missing required parameter', () => {
        const r = validateToolArgs(def, {});
        expect(r.valid).toBe(false);
        expect(r.errors[0]).toMatch(/Missing required parameter "path"/);
    });

    it('reports null as missing required parameter', () => {
        const r = validateToolArgs(def, { path: null });
        expect(r.valid).toBe(false);
        expect(r.errors[0]).toMatch(/Missing required parameter "path"/);
    });

    it('passes when required parameter is present', () => {
        const r = validateToolArgs(def, { path: 'src/x.ts' });
        expect(r.valid).toBe(true);
        expect(r.errors).toEqual([]);
    });
});

describe('validateToolArgs — type checking', () => {
    const def = tool('t', {
        type: 'object',
        properties: {
            s: { type: 'string' },
            n: { type: 'number' },
            b: { type: 'boolean' },
            a: { type: 'array' },
            o: { type: 'object' },
        },
    });

    it('rejects wrong primitive types', () => {
        const r = validateToolArgs(def, { s: 42 });
        expect(r.valid).toBe(false);
        expect(r.errors[0]).toMatch(/expected type "string", got "number"/);
    });

    it('coerces numeric strings to numbers (model serialization quirk)', () => {
        const r = validateToolArgs(def, { n: '42' });
        expect(r.valid).toBe(true);
    });

    it('rejects non-numeric string for number type', () => {
        const r = validateToolArgs(def, { n: 'forty-two' });
        expect(r.valid).toBe(false);
        expect(r.errors[0]).toMatch(/expected type "number"/);
    });

    it('coerces "true"/"false" strings to boolean', () => {
        expect(validateToolArgs(def, { b: 'true' }).valid).toBe(true);
        expect(validateToolArgs(def, { b: 'false' }).valid).toBe(true);
    });

    it('rejects arbitrary string for boolean type', () => {
        const r = validateToolArgs(def, { b: 'maybe' });
        expect(r.valid).toBe(false);
        expect(r.errors[0]).toMatch(/expected type "boolean"/);
    });

    it('rejects object where array is expected', () => {
        const r = validateToolArgs(def, { a: { foo: 'bar' } });
        expect(r.valid).toBe(false);
        expect(r.errors[0]).toMatch(/expected type "array"/);
    });

    it('rejects array where object is expected', () => {
        const r = validateToolArgs(def, { o: [1, 2, 3] });
        expect(r.valid).toBe(false);
        expect(r.errors[0]).toMatch(/expected type "object"/);
    });

    it('skips type checks for null/undefined values', () => {
        const r = validateToolArgs(def, { s: undefined as unknown as string, n: null as unknown as number });
        expect(r.valid).toBe(true);
    });
});

describe('validateToolArgs — enum constraints', () => {
    const def = tool('set_mode', {
        type: 'object',
        properties: {
            mode: { type: 'string', enum: ['read', 'write', 'execute'] },
        },
        required: ['mode'],
    });

    it('accepts valid enum value', () => {
        expect(validateToolArgs(def, { mode: 'read' }).valid).toBe(true);
    });

    it('rejects invalid enum value with helpful message', () => {
        const r = validateToolArgs(def, { mode: 'delete' });
        expect(r.valid).toBe(false);
        expect(r.errors[0]).toMatch(/must be one of \[read, write, execute\]/);
        expect(r.errors[0]).toMatch(/got "delete"/);
    });
});

describe('validateToolArgs — nested array of objects', () => {
    const def = tool('set_plan', {
        type: 'object',
        properties: {
            steps: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['title', 'status'],
                },
            },
        },
        required: ['steps'],
    });

    it('passes when each item has required fields', () => {
        const r = validateToolArgs(def, {
            steps: [
                { title: 'one', status: 'pending' },
                { title: 'two', status: 'pending' },
            ],
        });
        expect(r.valid).toBe(true);
    });

    it('reports per-index missing field', () => {
        const r = validateToolArgs(def, {
            steps: [
                { title: 'one', status: 'pending' },
                { title: 'two' },
            ],
        });
        expect(r.valid).toBe(false);
        expect(r.errors[0]).toMatch(/steps\[1\].+missing required field "status"/);
    });
});

describe('validateToolArgs — extras and edge cases', () => {
    const def = tool('t', {
        type: 'object',
        properties: { known: { type: 'string' } },
    });

    it('ignores unknown parameters silently', () => {
        const r = validateToolArgs(def, { known: 'ok', surprise: 123 });
        expect(r.valid).toBe(true);
    });

    it('aggregates multiple errors', () => {
        const def2 = tool('t2', {
            type: 'object',
            properties: {
                a: { type: 'string' },
                b: { type: 'number' },
            },
            required: ['a', 'b'],
        });
        const r = validateToolArgs(def2, { a: 1, b: 'nope' });
        expect(r.valid).toBe(false);
        expect(r.errors.length).toBe(2);
    });
});

describe('buildToolSchemaMap', () => {
    it('keys tools by function name', () => {
        const t1 = tool('read_file', { type: 'object', properties: {} });
        const t2 = tool('write_file', { type: 'object', properties: {} });
        const map = buildToolSchemaMap([t1, t2]);
        expect(map.size).toBe(2);
        expect(map.get('read_file')).toBe(t1);
        expect(map.get('write_file')).toBe(t2);
        expect(map.get('missing')).toBeUndefined();
    });
});
