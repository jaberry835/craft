import { describe, expect, it } from 'vitest';
import {
    buildRestoreSummaryFromEntries,
    createRestoreWorkingBlock,
    describeToolForRestore,
} from '../src/sessionRestore';
import { WorkingBlockActionEntry } from '../src/types';

function entry(actionType: WorkingBlockActionEntry['actionType'], text = ''): WorkingBlockActionEntry {
    return {
        id: `e_${Math.random()}`,
        kind: 'action',
        text,
        createdAt: Date.now(),
        actionType,
        status: 'done',
        icon: 'edit',
    };
}

describe('createRestoreWorkingBlock', () => {
    it('creates a completed working block with id, title, summary, and timestamps', () => {
        const b = createRestoreWorkingBlock('Replaying');
        expect(b.id).toBeTruthy();
        expect(b.title).toBe('Replaying');
        expect(b.summary).toBe('Replaying');
        expect(b.status).toBe('completed');
        expect(b.entries).toEqual([]);
        expect(typeof b.startedAt).toBe('number');
        expect(typeof b.completedAt).toBe('number');
    });
});

describe('buildRestoreSummaryFromEntries', () => {
    it('returns "Working" for empty entries', () => {
        expect(buildRestoreSummaryFromEntries([])).toBe('Working');
    });

    it('summarizes a single read action', () => {
        const r = buildRestoreSummaryFromEntries([entry('read')]);
        expect(r).toBe('Reviewed 1 file');
    });

    it('pluralizes correctly', () => {
        const r = buildRestoreSummaryFromEntries([
            entry('read'),
            entry('read'),
            entry('read'),
        ]);
        expect(r).toBe('Reviewed 3 files');
    });

    it('joins two distinct action types with " and "', () => {
        const r = buildRestoreSummaryFromEntries([
            entry('read'),
            entry('edit'),
        ]);
        // Order follows first-seen order: read first, then edit
        expect(r).toBe('Reviewed 1 file and Updated 1 file');
    });

    it('caps summary to 2 buckets even with more action types', () => {
        const r = buildRestoreSummaryFromEntries([
            entry('search'),
            entry('read'),
            entry('edit'),
            entry('run'),
        ]);
        // First two: search then read
        expect(r).toBe('Ran 1 search and Reviewed 1 file');
    });

    it('uses the entry text for a single create when present', () => {
        const r = buildRestoreSummaryFromEntries([entry('create', 'Created src/foo.ts')]);
        expect(r).toBe('Created src/foo.ts');
    });

    it('falls back to generic count when many creates', () => {
        const r = buildRestoreSummaryFromEntries([
            entry('create', 'Created a'),
            entry('create', 'Created b'),
        ]);
        expect(r).toBe('Created 2 files');
    });
});

describe('describeToolForRestore — common tools', () => {
    it('describes successful read_file with shortened path', () => {
        const e = describeToolForRestore('read_file', { path: '/very/deep/nested/folder/structure/foo.ts' }, true);
        expect(e.actionType).toBe('read');
        expect(e.status).toBe('done');
        expect(e.icon).toBe('read');
        expect(e.text).toMatch(/structure\/foo\.ts/);
        expect(e.filePath).toBe('/very/deep/nested/folder/structure/foo.ts');
    });

    it('describes failed read_file', () => {
        const e = describeToolForRestore('read_file', { path: 'src/x.ts' }, false);
        expect(e.status).toBe('error');
        expect(e.icon).toBe('error');
        expect(e.text).toMatch(/Failed to read/);
    });

    it('describes write_file as a create action', () => {
        const e = describeToolForRestore('write_file', { path: 'src/new.ts' }, true);
        expect(e.actionType).toBe('create');
        expect(e.text).toMatch(/Created/);
    });

    it('describes edit_file as an edit action', () => {
        const e = describeToolForRestore('edit_file', { path: 'src/old.ts' }, true);
        expect(e.actionType).toBe('edit');
        expect(e.text).toMatch(/Edited/);
    });

    it('describes grep_search and includes the pattern', () => {
        const e = describeToolForRestore('grep_search', { pattern: 'TODO|FIXME' }, true);
        expect(e.actionType).toBe('search');
        expect(e.text).toContain('TODO|FIXME');
    });

    it('describes run_terminal_command and truncates long commands', () => {
        const longCmd = 'echo ' + 'x'.repeat(200);
        const e = describeToolForRestore('run_terminal_command', { command: longCmd }, true);
        expect(e.actionType).toBe('run');
        expect(e.text.length).toBeLessThan(longCmd.length + 50);
        expect(e.text).toContain('...');
    });

    it('describes replace_lines with computed end line', () => {
        const e = describeToolForRestore('replace_lines', {
            path: 'a.ts',
            start_line: 10,
            new_content: 'one\ntwo\nthree',
        }, true);
        expect(e.actionType).toBe('edit');
        // start=10, 3 new lines -> end=12
        expect(e.text).toMatch(/lines 10–12/);
    });

    it('falls back to "Ran: <name>" for unknown tools', () => {
        const e = describeToolForRestore('mystery_tool', {}, true);
        expect(e.actionType).toBe('other');
        expect(e.text).toBe('Ran: mystery_tool');
    });

    it('prefixes MCP tools with "MCP: "', () => {
        const e = describeToolForRestore('mcp_github_search', {}, true);
        expect(e.actionType).toBe('other');
        expect(e.text).toBe('MCP: github_search');
    });
});
