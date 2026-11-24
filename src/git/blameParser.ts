import { BlameCommit, BlameLine, BlameResult, UNCOMMITTED_SHA } from './types';

const HEADER = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;

function emptyCommit(sha: string): BlameCommit {
  return {
    sha,
    parents: [],
    author: '',
    authorEmail: '',
    authorTime: 0,
    committer: '',
    committerEmail: '',
    committerTime: 0,
    summary: '',
    message: '',
    path: '',
  };
}

function stripMail(value: string): string {
  return value.replace(/^<|>$/g, '');
}

/** Parses the output of `git blame --porcelain`. */
export function parseBlamePorcelain(output: string): BlameResult {
  const commits = new Map<string, BlameCommit>();
  const lines: BlameLine[] = [];
  let current: BlameCommit | undefined;

  for (const raw of output.split('\n')) {
    if (raw.startsWith('\t')) {
      current = undefined;
      continue;
    }
    const header = HEADER.exec(raw);
    if (header) {
      const sha = header[1];
      let commit = commits.get(sha);
      if (!commit) {
        commit = emptyCommit(sha);
        commits.set(sha, commit);
      }
      current = commit;
      lines.push({ sha, originalLine: Number(header[2]) - 1, line: Number(header[3]) - 1 });
      continue;
    }
    if (!current || raw === '') {
      continue;
    }
    const space = raw.indexOf(' ');
    const key = space === -1 ? raw : raw.slice(0, space);
    const value = space === -1 ? '' : raw.slice(space + 1);
    switch (key) {
      case 'author':
        current.author = value;
        break;
      case 'author-mail':
        current.authorEmail = stripMail(value);
        break;
      case 'author-time':
        current.authorTime = Number(value) * 1000;
        break;
      case 'committer':
        current.committer = value;
        break;
      case 'committer-mail':
        current.committerEmail = stripMail(value);
        break;
      case 'committer-time':
        current.committerTime = Number(value) * 1000;
        break;
      case 'summary':
        current.summary = value;
        current.message = value;
        break;
      case 'previous': {
        const sep = value.indexOf(' ');
        current.previous = { sha: value.slice(0, sep), path: value.slice(sep + 1) };
        break;
      }
      case 'filename':
        current.path = value;
        break;
      default:
        break;
    }
  }

  const uncommitted = commits.get(UNCOMMITTED_SHA);
  if (uncommitted) {
    uncommitted.summary = 'Uncommitted changes';
    uncommitted.message = 'Uncommitted changes';
  }

  lines.sort((a, b) => a.line - b.line);
  return { lines, commits };
}
