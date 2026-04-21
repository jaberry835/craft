/**
 * Utilities for line-level diff statistics.
 */

/**
 * Count added/deleted lines using an LCS dynamic-programming diff.
 * This preserves order and duplicates, unlike Set-based comparisons.
 */
export function countLineChanges(oldContent: string, newContent: string): { additions: number; deletions: number } {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    const m = oldLines.length;
    const n = newLines.length;

    const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    const lcs = dp[m][n];
    return {
        additions: n - lcs,
        deletions: m - lcs
    };
}
