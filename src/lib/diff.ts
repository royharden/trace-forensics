export interface DiffLine {
  type: "add" | "remove" | "context";
  text: string;
}

export function computeDiff(before: string, after: string): DiffLine[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const result: DiffLine[] = [];

  // Simple line-by-line LCS diff
  const m = beforeLines.length;
  const n = afterLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (beforeLines[i - 1] === afterLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack
  let i = m, j = n;
  const tmp: DiffLine[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && beforeLines[i - 1] === afterLines[j - 1]) {
      tmp.unshift({ type: "context", text: beforeLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      tmp.unshift({ type: "add", text: afterLines[j - 1] });
      j--;
    } else if (i > 0) {
      tmp.unshift({ type: "remove", text: beforeLines[i - 1] });
      i--;
    }
  }

  return tmp.length > 0 ? tmp : result;
}

export function hasBeforeAfter(args: Record<string, unknown> | null): boolean {
  if (!args) return false;
  return typeof args.before === "string" && typeof args.after === "string";
}
