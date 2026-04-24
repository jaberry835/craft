import { describe, expect, it } from 'vitest';
import { countLineChanges } from '../src/diffUtils';

describe('countLineChanges', () => {
    it('reports zero changes for identical content', () => {
        const text = 'a\nb\nc';
        expect(countLineChanges(text, text)).toEqual({ additions: 0, deletions: 0 });
    });

    it('counts pure additions', () => {
        const oldT = 'a\nb';
        const newT = 'a\nb\nc\nd';
        expect(countLineChanges(oldT, newT)).toEqual({ additions: 2, deletions: 0 });
    });

    it('counts pure deletions', () => {
        const oldT = 'a\nb\nc\nd';
        const newT = 'a\nd';
        expect(countLineChanges(oldT, newT)).toEqual({ additions: 0, deletions: 2 });
    });

    it('counts a single-line modification as 1 add + 1 delete', () => {
        const oldT = 'a\nb\nc';
        const newT = 'a\nB\nc';
        expect(countLineChanges(oldT, newT)).toEqual({ additions: 1, deletions: 1 });
    });

    it('handles full replacement', () => {
        const oldT = 'a\nb\nc';
        const newT = 'x\ny\nz';
        expect(countLineChanges(oldT, newT)).toEqual({ additions: 3, deletions: 3 });
    });

    it('handles old empty', () => {
        // '' splits to [''] (1 line), 'a\nb' splits to ['a','b'] (2 lines).
        // No lines match, so LCS = 0 -> additions = 2, deletions = 1.
        expect(countLineChanges('', 'a\nb')).toEqual({ additions: 2, deletions: 1 });
    });

    it('handles new empty', () => {
        // 'a\nb' -> [''] : LCS=0, add=1, del=2
        expect(countLineChanges('a\nb', '')).toEqual({ additions: 1, deletions: 2 });
    });

    it('handles both empty', () => {
        expect(countLineChanges('', '')).toEqual({ additions: 0, deletions: 0 });
    });

    it('preserves duplicate lines (does not dedupe like a Set)', () => {
        // old has one 'a', new has three 'a's: 2 additions, 0 deletions
        expect(countLineChanges('a', 'a\na\na')).toEqual({ additions: 2, deletions: 0 });
    });

    it('preserves order — moved lines count as add+delete', () => {
        // Both have {a,b,c} but in different order. LCS is 2 (e.g. a,c or b,c).
        const oldT = 'a\nb\nc';
        const newT = 'c\nb\na';
        const r = countLineChanges(oldT, newT);
        // Either way, one line is "moved" -> 1 add + 1 delete
        expect(r.additions).toBeGreaterThanOrEqual(1);
        expect(r.deletions).toBeGreaterThanOrEqual(1);
    });

    it('counts an insertion in the middle as additions only', () => {
        const oldT = 'a\nb\nc';
        const newT = 'a\nX\nY\nb\nc';
        expect(countLineChanges(oldT, newT)).toEqual({ additions: 2, deletions: 0 });
    });

    it('handles trailing newline difference correctly', () => {
        // 'a\nb' -> ['a','b'], 'a\nb\n' -> ['a','b',''] : LCS=2, add=1, del=0
        expect(countLineChanges('a\nb', 'a\nb\n')).toEqual({ additions: 1, deletions: 0 });
    });
});
