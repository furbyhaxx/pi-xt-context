import type { ContextText } from "./content.ts";

export interface FileChange {
  path: string;
  /** The text the agent was given; null when this process no longer holds it. */
  previous: string | null;
  current: ContextText;
}

/** Emitted +/- lines. */
const MAX_DIFF_LINES = 30;
/** Per-line cap, so one pathological line cannot blow up the notice. */
const MAX_LINE_CHARS = 120;
/** Per-side line cap for the LCS table; past it we report counts, not a diff. */
const MAX_TABLE_LINES = 400;

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

function changedOps(a: string[], b: string[]): Array<{ added: boolean; text: string }> {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops: Array<{ added: boolean; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ added: false, text: a[i++] });
    } else {
      ops.push({ added: true, text: b[j++] });
    }
  }
  while (i < n) ops.push({ added: false, text: a[i++] });
  while (j < m) ops.push({ added: true, text: b[j++] });
  return ops;
}

/** Line diff of the region that actually moved, bounded to MAX_DIFF_LINES. */
export function diffLines(previous: string, current: string): string {
  const a = previous.split("\n");
  const b = current.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let endA = a.length;
  let endB = b.length;
  while (endA > head && endB > head && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(head, endA);
  const midB = b.slice(head, endB);
  if (midA.length === 0 && midB.length === 0) return "";

  if (midA.length * midB.length > MAX_TABLE_LINES * MAX_TABLE_LINES) {
    return `… ${midA.length} line(s) replaced by ${midB.length} line(s) — diff omitted, change too large`;
  }

  const out: string[] = [];
  let dropped = 0;
  for (const op of changedOps(midA, midB)) {
    if (out.length >= MAX_DIFF_LINES) {
      dropped++;
      continue;
    }
    out.push((op.added ? "+" : "-") + clip(op.text));
  }
  if (dropped > 0) out.push(`… ${dropped} more changed line(s)`);
  return out.join("\n");
}

export function formatChangeNotice(path: string, change: FileChange): string {
  const lines = [
    "## Context File Changed",
    "",
    `${path} changed on disk after its contents reached your context. You already hold the previous copy, so this is the change, not a second copy of the file.`,
    "",
  ];
  if (change.previous === null) {
    lines.push(
      "The previous contents are not in this process (the session was restored, or the file changed while pi was not running), so no diff can be shown. Re-read the file if you need its current text.",
    );
  } else {
    lines.push("```diff", diffLines(change.previous, change.current.content), "```");
  }
  lines.push("", "Read the file only if this change affects your work.");
  return lines.join("\n");
}
