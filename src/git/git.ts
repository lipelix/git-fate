import { execFile } from 'child_process';
import * as path from 'path';
import { parseBlamePorcelain } from './blameParser';
import { LOG_FORMAT, parseLog, parseNameStatus } from './logParser';
import { BlameResult, FileChange, LogEntry } from './types';
import {
  parseNameStatusZ,
  parseStatusV2,
  parseWorktreeList,
  StatusFile,
  WorktreeEntry,
} from './worktreeParser';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | undefined,
  ) {
    super(message);
  }
}

export interface RunOptions {
  stdin?: string;
  /** Exit codes treated as success besides 0. */
  okCodes?: number[];
}

export interface RunResult {
  stdout: string;
  exitCode: number;
}

/** Thin wrapper over the git CLI. Holds no state besides caches of cheap lookups. */
export class Git {
  private readonly roots = new Map<string, Promise<string | undefined>>();
  private readonly emails = new Map<string, Promise<string | undefined>>();

  constructor(private readonly gitPath: () => string) {}

  run(cwd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.gitPath(),
        args,
        {
          cwd,
          maxBuffer: 256 * 1024 * 1024,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
        },
        (error, stdout, stderr) => {
          const exitCode = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
          if (error && !(options.okCodes ?? []).includes(exitCode)) {
            reject(
              new GitError(
                `git ${args[0]} failed: ${stderr.trim() || error.message}`,
                stderr,
                exitCode,
              ),
            );
            return;
          }
          resolve({ stdout, exitCode });
        },
      );
      if (options.stdin !== undefined) {
        child.stdin?.end(options.stdin);
      }
    });
  }

  /** Root of the working tree that contains `filePath`, or undefined outside git. */
  repoRoot(filePath: string): Promise<string | undefined> {
    const dir = path.dirname(filePath);
    let cached = this.roots.get(dir);
    if (!cached) {
      cached = this.run(dir, ['rev-parse', '--show-toplevel']).then(
        (r) => r.stdout.trim() || undefined,
        () => undefined,
      );
      this.roots.set(dir, cached);
    }
    return cached;
  }

  userEmail(root: string): Promise<string | undefined> {
    let cached = this.emails.get(root);
    if (!cached) {
      cached = this.run(root, ['config', 'user.email'], { okCodes: [1] }).then(
        (r) => r.stdout.trim() || undefined,
        () => undefined,
      );
      this.emails.set(root, cached);
    }
    return cached;
  }

  clearCaches(): void {
    this.roots.clear();
    this.emails.clear();
  }

  /** Blame of a file; pass `contents` to blame the unsaved editor buffer. */
  async blame(root: string, relPath: string, contents?: string): Promise<BlameResult> {
    const args = ['blame', '--porcelain', '-w'];
    if (contents !== undefined) {
      args.push('--contents', '-');
    }
    args.push('--', relPath);
    const { stdout } = await this.run(root, args, { stdin: contents });
    return parseBlamePorcelain(stdout);
  }

  /** Commits that touched a file, newest first, following renames. */
  async fileHistory(root: string, relPath: string, limit: number): Promise<LogEntry[]> {
    const { stdout } = await this.run(root, [
      'log',
      LOG_FORMAT,
      '--name-status',
      '--follow',
      '-M',
      `-n${limit}`,
      '--',
      relPath,
    ]);
    return parseLog(stdout);
  }

  /** Commits that touched lines `start..end` (1-based, inclusive) of a file. */
  async lineHistory(
    root: string,
    relPath: string,
    start: number,
    end: number,
    limit: number,
  ): Promise<LogEntry[]> {
    const { stdout } = await this.run(root, [
      'log',
      LOG_FORMAT,
      `-L${start},${end}:${relPath}`,
      `-n${limit}`,
    ]);
    return parseLog(stdout);
  }

  /** Files changed by a commit, compared with its first parent. */
  async commitFiles(root: string, sha: string): Promise<FileChange[]> {
    const { stdout } = await this.run(root, [
      'show',
      '--format=',
      '--name-status',
      '-M',
      '--first-parent',
      '-m',
      sha,
    ]);
    return parseNameStatus(stdout);
  }

  /** Full commit metadata. */
  async commit(root: string, sha: string): Promise<LogEntry | undefined> {
    const { stdout } = await this.run(root, ['log', LOG_FORMAT, '-n1', sha]);
    return parseLog(stdout)[0];
  }

  /** File contents at a revision; empty string when the file does not exist there. */
  async show(root: string, sha: string, relPath: string): Promise<string> {
    try {
      const { stdout } = await this.run(root, ['show', `${sha}:${relPath}`]);
      return stdout;
    } catch (e) {
      if (e instanceof GitError) {
        return '';
      }
      throw e;
    }
  }

  /**
   * Unified diff of one file in one commit. `previous` is the parent revision and the
   * file's path there; without it (an added file or a root commit) the commit is shown
   * against its parent by `git show`.
   */
  async fileDiff(
    root: string,
    sha: string,
    relPath: string,
    previous?: { sha: string; relPath: string },
  ): Promise<string> {
    const common = ['--no-color', '--no-ext-diff', '-U3', '-M'];
    const args = previous
      ? ['diff', ...common, previous.sha, sha, '--', previous.relPath, relPath]
      : ['show', '--format=', ...common, sha, '--', relPath];
    return (await this.run(root, args)).stdout;
  }

  /** Unified diff of the working copy of a file against HEAD. */
  async workingDiff(root: string, relPath: string): Promise<string> {
    const { stdout } = await this.run(root, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '-U3',
      'HEAD',
      '--',
      relPath,
    ]);
    return stdout;
  }

  /** True when the working copy of the file differs from HEAD. */
  async hasWorkingChanges(root: string, relPath: string): Promise<boolean> {
    const { exitCode } = await this.run(root, ['diff', '--quiet', 'HEAD', '--', relPath], {
      okCodes: [1],
    });
    return exitCode === 1;
  }

  /** Worktrees of the repository that contains `cwd`; the main worktree comes first. */
  async worktrees(cwd: string): Promise<WorktreeEntry[]> {
    const { stdout } = await this.run(cwd, ['worktree', 'list', '--porcelain']);
    return parseWorktreeList(stdout);
  }

  /** Uncommitted changes of a working tree, untracked files listed one by one. */
  async workingStatus(root: string): Promise<StatusFile[]> {
    const { stdout } = await this.run(root, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=all',
    ]);
    return parseStatusV2(stdout);
  }

  /** Files that differ between two commits, renames detected. */
  async changedFiles(root: string, from: string, to: string): Promise<StatusFile[]> {
    const { stdout } = await this.run(root, ['diff', '--name-status', '-z', '-M', from, to]);
    return parseNameStatusZ(stdout);
  }

  /** Commits reachable from `to` but not from `from`, newest first. */
  async commitsBetween(root: string, from: string, to: string, limit: number): Promise<LogEntry[]> {
    const { stdout } = await this.run(root, ['log', LOG_FORMAT, `-n${limit}`, `${from}..${to}`]);
    return parseLog(stdout);
  }

  async countCommits(root: string, from: string, to: string): Promise<number> {
    const { stdout } = await this.run(root, ['rev-list', '--count', `${from}..${to}`]);
    return Number(stdout.trim()) || 0;
  }

  async mergeBase(root: string, a: string, b: string): Promise<string | undefined> {
    const { stdout, exitCode } = await this.run(root, ['merge-base', a, b], { okCodes: [1, 128] });
    return exitCode === 0 ? stdout.trim() || undefined : undefined;
  }

  /** `refs/remotes/origin/HEAD` as `origin/main`, when the clone knows it. */
  async remoteDefaultBranch(root: string): Promise<string | undefined> {
    const { stdout, exitCode } = await this.run(
      root,
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      { okCodes: [1, 128] },
    );
    return exitCode === 0 ? stdout.trim() || undefined : undefined;
  }

  /** True when `ref` names a commit. */
  async refExists(root: string, ref: string): Promise<boolean> {
    const { exitCode } = await this.run(
      root,
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      { okCodes: [1, 128] },
    );
    return exitCode === 0;
  }

  async branchDescription(root: string, branch: string): Promise<string | undefined> {
    const { stdout } = await this.run(root, ['config', `branch.${branch}.description`], {
      okCodes: [1],
    });
    return stdout.trim() || undefined;
  }

  async setBranchDescription(root: string, branch: string, text: string): Promise<void> {
    const key = `branch.${branch}.description`;
    await this.run(root, text ? ['config', key, text] : ['config', '--unset', key], {
      okCodes: [5],
    });
  }

  /** Locks a linked worktree with `reason`, or unlocks it when the reason is empty. */
  async setWorktreeLock(root: string, worktree: string, reason: string): Promise<void> {
    const entry = (await this.worktrees(root)).find((w) => w.path === worktree);
    if (entry?.locked !== undefined) {
      await this.run(root, ['worktree', 'unlock', worktree]);
    }
    if (reason) {
      await this.run(root, ['worktree', 'lock', '--reason', reason, worktree]);
    }
  }

  /** URL of the upstream remote of HEAD, else `origin`, else the first remote. */
  async remoteUrl(root: string): Promise<string | undefined> {
    const remotes = (await this.run(root, ['remote'])).stdout.split('\n').filter(Boolean);
    if (remotes.length === 0) {
      return undefined;
    }
    let name = remotes.includes('origin') ? 'origin' : remotes[0];
    const upstream = await this.run(
      root,
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      { okCodes: [128] },
    );
    const remote = upstream.stdout.trim().split('/')[0];
    if (upstream.exitCode === 0 && remotes.includes(remote)) {
      name = remote;
    }
    return (await this.run(root, ['remote', 'get-url', name])).stdout.trim() || undefined;
  }
}
