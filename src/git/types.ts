export const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000';

export interface Commit {
  sha: string;
  parents: string[];
  author: string;
  authorEmail: string;
  /** Author date, epoch milliseconds. */
  authorTime: number;
  committer: string;
  committerEmail: string;
  /** Committer date, epoch milliseconds. */
  committerTime: number;
  summary: string;
  /** Full message; equals summary when only blame data is known. */
  message: string;
}

export interface BlameCommit extends Commit {
  /** Previous revision of the file before this commit, if any. */
  previous?: { sha: string; path: string };
  /** Path of the file in this commit (may differ from the current path after a rename). */
  path: string;
}

export interface BlameLine {
  /** 0-based line in the current file. */
  line: number;
  /** 0-based line in the commit that introduced it. */
  originalLine: number;
  sha: string;
}

export interface BlameResult {
  lines: BlameLine[];
  commits: Map<string, BlameCommit>;
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface FileChange {
  status: FileStatus;
  path: string;
  /** Source path of a rename or copy. */
  originalPath?: string;
}

export interface LogEntry extends Commit {
  /** Changes in this commit (for file history: the tracked file only). */
  changes: FileChange[];
}

export function isUncommitted(sha: string): boolean {
  return sha === UNCOMMITTED_SHA;
}
