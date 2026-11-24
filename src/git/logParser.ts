import { FileChange, FileStatus, LogEntry } from './types';

const RS = '\x1e';
const FS = '\x1f';
const END = '\x1d';

/**
 * `--format` for `git log` understood by {@link parseLog}. The record starts with RS,
 * fields are separated by FS and the message ends with END; anything after END is
 * the `--name-status` or patch output of that commit.
 */
export const LOG_FORMAT = `--format=${RS}%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%cn${FS}%ce${FS}%ct${FS}%B${END}`;

export function parseNameStatus(text: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const line of text.split('\n')) {
    if (!line) {
      continue;
    }
    const parts = line.split('\t');
    const code = parts[0];
    if (!/^[AMDRCTU]\d*$/.test(code)) {
      continue;
    }
    const status = code[0] as FileStatus;
    if ((status === 'R' || status === 'C') && parts.length >= 3) {
      changes.push({ status, originalPath: parts[1], path: parts[2] });
    } else if (parts.length >= 2) {
      changes.push({ status, path: parts[1] });
    }
  }
  return changes;
}

function unquotePatchPath(value: string): string | undefined {
  if (value === '/dev/null') {
    return undefined;
  }
  let path = value;
  if (path.startsWith('"') && path.endsWith('"')) {
    path = JSON.parse(path) as string;
  }
  return path.replace(/^[ab]\//, '');
}

/** Extracts the file changes from patch output (`git log -L` always prints one). */
function parsePatch(text: string): FileChange[] {
  const changes: FileChange[] = [];
  let from: string | undefined;
  let inHeader = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      continue;
    }
    if (line.startsWith('@@')) {
      inHeader = false;
      continue;
    }
    if (!inHeader) {
      continue;
    }
    if (line.startsWith('--- ')) {
      from = unquotePatchPath(line.slice(4).trim());
    } else if (line.startsWith('+++ ')) {
      const to = unquotePatchPath(line.slice(4).trim());
      if (to === undefined && from !== undefined) {
        changes.push({ status: 'D', path: from });
      } else if (to !== undefined && from === undefined) {
        changes.push({ status: 'A', path: to });
      } else if (to !== undefined && from !== undefined && from !== to) {
        changes.push({ status: 'R', path: to, originalPath: from });
      } else if (to !== undefined) {
        changes.push({ status: 'M', path: to });
      }
      from = undefined;
    }
  }
  return changes;
}

/** Parses `git log` output produced with {@link LOG_FORMAT}. */
export function parseLog(output: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const record of output.split(RS)) {
    if (!record.trim()) {
      continue;
    }
    const end = record.indexOf(END);
    const head = end === -1 ? record : record.slice(0, end);
    const tail = end === -1 ? '' : record.slice(end + 1);
    const f = head.split(FS);
    if (f.length < 9) {
      continue;
    }
    const message = f.slice(8).join(FS).trim();
    const changes = /^diff --git /m.test(tail) ? parsePatch(tail) : parseNameStatus(tail);
    entries.push({
      sha: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      author: f[2],
      authorEmail: f[3],
      authorTime: Number(f[4]) * 1000,
      committer: f[5],
      committerEmail: f[6],
      committerTime: Number(f[7]) * 1000,
      message,
      summary: message.split('\n')[0],
      changes,
    });
  }
  return entries;
}
