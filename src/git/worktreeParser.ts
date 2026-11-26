import { FileStatus } from './types';

export interface WorktreeEntry {
  /** Absolute path of the working tree. */
  path: string;
  /** Commit checked out; empty in a repository without commits. */
  head: string;
  /** Short branch name, absent when HEAD is detached. */
  branch?: string;
  bare: boolean;
  /** Lock reason; an empty string when locked without one. */
  locked?: string;
  /** Why git would prune this worktree (its directory is gone). */
  prunable?: string;
}

const ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '"': '"',
  '\\': '\\',
};

/** Undoes git's C-style quoting (`core.quotePath`); plain values pass through unchanged. */
export function unquoteC(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\' || i === body.length - 1) {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[++i];
    if (/[0-7]/.test(next)) {
      const octal = body.slice(i, i + 3);
      bytes.push(parseInt(octal, 8));
      i += octal.length - 1;
    } else {
      bytes.push(...Buffer.from(ESCAPES[next] ?? next, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Parses `git worktree list --porcelain`. The main worktree comes first. */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const line of output.split('\n')) {
    if (!line) {
      current = undefined;
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') {
      current = { path: unquoteC(value), head: '', bare: false };
      entries.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    switch (key) {
      case 'HEAD':
        current.head = value;
        break;
      case 'branch':
        current.branch = value.replace(/^refs\/heads\//, '');
        break;
      case 'bare':
        current.bare = true;
        break;
      case 'locked':
        current.locked = unquoteC(value);
        break;
      case 'prunable':
        current.prunable = unquoteC(value) || 'gone';
        break;
    }
  }
  return entries;
}

export interface StatusFile {
  /** Status letter of the change, `?` for an untracked file. */
  status: FileStatus | '?';
  path: string;
  originalPath?: string;
}

/** Picks the most telling letter from a porcelain v2 `XY` field (index, then worktree). */
function statusLetter(xy: string): FileStatus {
  for (const ch of [xy[1], xy[0]]) {
    if (ch === 'D' || ch === 'A' || ch === 'R' || ch === 'C' || ch === 'T' || ch === 'U') {
      return ch;
    }
  }
  return 'M';
}

/** Parses `git status --porcelain=v2 -z`: changed, unmerged and untracked files. */
export function parseStatusV2(output: string): StatusFile[] {
  const files: StatusFile[] = [];
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) {
      continue;
    }
    const kind = record[0];
    if (kind === '1') {
      // 1 XY sub mH mI mW hH hI path
      const fields = record.split(' ');
      files.push({ status: statusLetter(fields[1]), path: fields.slice(8).join(' ') });
    } else if (kind === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next record
      const fields = record.split(' ');
      files.push({
        status: fields[1].includes('C') ? 'C' : 'R',
        path: fields.slice(9).join(' '),
        originalPath: records[++i],
      });
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      files.push({ status: 'U', path: record.split(' ').slice(10).join(' ') });
    } else if (kind === '?') {
      files.push({ status: '?', path: record.slice(2) });
    }
  }
  return files;
}

/** Parses `git diff --name-status -z`. */
export function parseNameStatusZ(output: string): StatusFile[] {
  const files: StatusFile[] = [];
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const code = records[i];
    if (!/^[AMDRCTU]\d*$/.test(code)) {
      continue;
    }
    const status = code[0] as FileStatus;
    if (status === 'R' || status === 'C') {
      files.push({ status, originalPath: records[i + 1], path: records[i + 2] });
      i += 2;
    } else {
      files.push({ status, path: records[++i] });
    }
  }
  return files;
}
