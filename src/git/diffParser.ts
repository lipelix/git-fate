/** One `@@` hunk of a unified diff. `lines` keep their ' ', '+' or '-' prefix. */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Hunks of a single-file unified diff (`git diff` or `git show` output). */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of diff.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('diff --git')) {
      current = undefined;
      continue;
    }
    const kind = line[0];
    if (kind === ' ' || kind === '+' || kind === '-') {
      current.lines.push(line);
    } else if (kind === '\\') {
      // "\ No newline at end of file"
      continue;
    }
  }
  return hunks;
}

/** Index into `hunk.lines` of the new-side line `line` (1-based), or -1. */
function indexOfNewLine(hunk: Hunk, line: number): number {
  let n = hunk.newStart;
  for (let i = 0; i < hunk.lines.length; i++) {
    const kind = hunk.lines[i][0];
    if (kind === '-') {
      continue;
    }
    if (n === line) {
      return i;
    }
    n++;
  }
  return -1;
}

export interface DiffExcerpt {
  /** Lines with their diff prefix, ready for a ```diff block. */
  lines: string[];
  /** True when lines of the change were left out to keep the excerpt short. */
  truncated: boolean;
}

/**
 * The part of a diff that changed new-side line `line` (1-based): the block of
 * added and removed lines around it plus a little context, at most `maxLines`.
 */
export function excerptForLine(
  hunks: Hunk[],
  line: number,
  options: { context?: number; maxLines?: number; maxWidth?: number } = {},
): DiffExcerpt | undefined {
  const context = options.context ?? 2;
  const maxLines = options.maxLines ?? 14;
  const maxWidth = options.maxWidth ?? 120;
  for (const hunk of hunks) {
    const target = indexOfNewLine(hunk, line);
    if (target < 0) {
      continue;
    }
    const changed = (i: number) => hunk.lines[i][0] !== ' ';
    // The contiguous block of changed lines that holds the target line.
    let start = target;
    let end = target;
    while (start > 0 && changed(start - 1)) {
      start--;
    }
    while (end < hunk.lines.length - 1 && changed(end + 1)) {
      end++;
    }
    if (!changed(target)) {
      // Blame ignores whitespace; the line may be context here. Show its surroundings.
      start = end = target;
    }
    start = Math.max(0, start - context);
    end = Math.min(hunk.lines.length - 1, end + context);
    let truncated = false;
    if (end - start + 1 > maxLines) {
      truncated = true;
      const half = Math.floor(maxLines / 2);
      start = Math.max(start, Math.min(target - half, end - maxLines + 1));
      end = start + maxLines - 1;
    }
    const lines = hunk.lines
      .slice(start, end + 1)
      .map((l) => (l.length > maxWidth ? `${l.slice(0, maxWidth - 1)}…` : l));
    return { lines, truncated };
  }
  return undefined;
}
