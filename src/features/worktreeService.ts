import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Config, readConfig } from '../config';
import { Git } from '../git/git';
import { FileStatus, LogEntry } from '../git/types';
import { StatusFile, WorktreeEntry } from '../git/worktreeParser';

/** Commits listed per worktree; the count of commits ahead is exact regardless. */
const COMMIT_LIMIT = 50;
/** Files whose modification time is read to tell when the worktree last changed. */
const STAT_LIMIT = 200;
const POLL_MS = 15_000;

export interface WorktreeFile {
  path: string;
  originalPath?: string;
  /** Letter of the change; `?` for an untracked file. */
  status: FileStatus | '?';
  committed: boolean;
  uncommitted: boolean;
}

export type TaskSource = 'lock' | 'description';

export interface WorktreeState {
  entry: WorktreeEntry;
  path: string;
  /** Branch name, or `detached at abc1234`. */
  name: string;
  isMain: boolean;
  /** The worktree this window works in. */
  isCurrent: boolean;
  /** What is being done here: the lock reason or the branch description. */
  task?: string;
  taskSource?: TaskSource;
  head?: LogEntry;
  /** Commit the branch forked from the base branch. */
  mergeBase?: string;
  ahead: number;
  commits: LogEntry[];
  files: WorktreeFile[];
  /** Newest of the HEAD commit and the modification times of changed files, epoch ms. */
  lastActivity: number;
  active: boolean;
  error?: string;
}

export interface WorktreeSnapshot {
  /** Root of the worktree the scan started from. */
  anchor: string;
  /** Branch the worktrees are compared with, e.g. `origin/main`. */
  base?: string;
  worktrees: WorktreeState[];
  /** Files changed in more than one worktree, by repository-relative path. */
  overlaps: Map<string, WorktreeState[]>;
  /** False when only the worktree list was read (nothing to compare). */
  detailed: boolean;
}

function shortName(entry: WorktreeEntry): string {
  if (entry.branch) {
    return entry.branch;
  }
  return entry.head ? `detached at ${entry.head.slice(0, 7)}` : '(no commits)';
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function mergeFiles(committed: StatusFile[], working: StatusFile[]): WorktreeFile[] {
  const files = new Map<string, WorktreeFile>();
  for (const f of committed) {
    files.set(f.path, { ...f, committed: true, uncommitted: false });
  }
  for (const f of working) {
    const known = files.get(f.path);
    if (known) {
      known.uncommitted = true;
      // A file added on the branch and edited since is still new compared with the base.
      if (known.status !== 'A' || f.status === 'D') {
        known.status = f.status;
      }
    } else {
      files.set(f.path, { ...f, committed: false, uncommitted: true });
    }
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Reads every worktree of the repository open in the editor: what it works on, what it
 * changed against the base branch, how recently, and which files more than one touches.
 * Plain git only, so it shows worktrees made by any tool or agent.
 */
export class WorktreeService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<WorktreeSnapshot | undefined>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private config: Config = readConfig();
  private current: WorktreeSnapshot | undefined;
  private running: Promise<WorktreeSnapshot | undefined> | undefined;
  private queued: Promise<WorktreeSnapshot | undefined> | undefined;
  private poll: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  /** Set by the view: a visible view needs details even for a single worktree. */
  viewVisible = false;

  constructor(private readonly git: Git) {
    this.disposables.push(
      this.emitter,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitFate.worktrees')) {
          this.config = readConfig();
          this.restartPolling();
          this.schedule(0);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule(200)),
      vscode.workspace.onDidSaveTextDocument(() => this.schedule(1000)),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          this.schedule(0);
        }
      }),
    );
    this.restartPolling();
    this.schedule(0);
  }

  get snapshot(): WorktreeSnapshot | undefined {
    return this.current;
  }

  get watching(): boolean {
    return this.config.worktreesWatch;
  }

  private restartPolling(): void {
    if (this.poll) {
      clearInterval(this.poll);
    }
    this.poll = setInterval(() => {
      if (vscode.window.state.focused && (this.config.worktreesWatch || this.viewVisible)) {
        void this.refresh();
      }
    }, POLL_MS);
  }

  /** Rescans after `delay` ms; bursts of events end in one scan. */
  schedule(delay: number): void {
    if (!this.config.worktreesWatch && !this.viewVisible) {
      return;
    }
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => void this.refresh(), delay);
  }

  /**
   * Scans now. A call while a scan runs resolves with one more scan started after it,
   * so the result always reflects the state at the time of the call.
   */
  refresh(): Promise<WorktreeSnapshot | undefined> {
    if (this.running) {
      this.queued ??= this.running.then(() => {
        this.queued = undefined;
        return this.refresh();
      });
      return this.queued;
    }
    this.running = this.scan()
      .catch(() => undefined)
      .then((snapshot) => {
        this.current = snapshot;
        this.emitter.fire(snapshot);
        return snapshot;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  /** Worktree root of the active editor's file, else of the first workspace folder. */
  private async anchor(): Promise<string | undefined> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === 'file') {
      const root = await this.git.repoRoot(uri.fsPath);
      if (root) {
        return root;
      }
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      // repoRoot looks in the directory of the path it gets: point it at the folder itself.
      const root = await this.git.repoRoot(path.join(folder.uri.fsPath, '_'));
      if (root) {
        return root;
      }
    }
    return undefined;
  }

  private async resolveBase(anchor: string, main: WorktreeEntry): Promise<string | undefined> {
    const configured = this.config.worktreesBaseBranch;
    if (configured) {
      return (await this.git.refExists(anchor, configured)) ? configured : undefined;
    }
    const remote = await this.git.remoteDefaultBranch(anchor);
    if (remote) {
      return remote;
    }
    for (const name of ['main', 'master']) {
      if (await this.git.refExists(anchor, name)) {
        return name;
      }
    }
    return main.branch;
  }

  private async scan(): Promise<WorktreeSnapshot | undefined> {
    const anchor = await this.anchor();
    if (!anchor) {
      return undefined;
    }
    const entries = await this.git.worktrees(anchor);
    const realAnchor = await fs.promises.realpath(anchor).catch(() => anchor);
    const detailed = this.viewVisible || entries.length > 1;
    const base = detailed && entries[0] ? await this.resolveBase(anchor, entries[0]) : undefined;
    const others = entries.map((e) => e.path);
    const worktrees = await Promise.all(
      entries
        .filter((e) => !e.bare)
        .map((entry, index) =>
          this.inspect(entry, {
            isMain: index === 0,
            isCurrent: entry.path === anchor || entry.path === realAnchor,
            base: detailed ? base : undefined,
            nested: others.filter((p) => p !== entry.path && isInside(p, entry.path)),
          }),
        ),
    );

    const byPath = new Map<string, WorktreeState[]>();
    for (const wt of worktrees) {
      for (const f of wt.files) {
        byPath.set(f.path, [...(byPath.get(f.path) ?? []), wt]);
      }
    }
    const overlaps = new Map([...byPath].filter(([, list]) => list.length > 1));
    return { anchor, base, worktrees, overlaps, detailed };
  }

  private async inspect(
    entry: WorktreeEntry,
    options: { isMain: boolean; isCurrent: boolean; base?: string; nested: string[] },
  ): Promise<WorktreeState> {
    const state: WorktreeState = {
      entry,
      path: entry.path,
      name: shortName(entry),
      isMain: options.isMain,
      isCurrent: options.isCurrent,
      ahead: 0,
      commits: [],
      files: [],
      lastActivity: 0,
      active: false,
    };
    if (entry.locked) {
      state.task = entry.locked;
      state.taskSource = 'lock';
    }
    if (entry.prunable) {
      state.error = `Missing: ${entry.prunable}`;
      return state;
    }
    const root = entry.path;
    try {
      const [working, head, description] = await Promise.all([
        this.git.workingStatus(root),
        entry.head ? this.git.commit(root, 'HEAD') : undefined,
        !state.task && entry.branch
          ? this.git.branchDescription(root, entry.branch)
          : Promise.resolve(undefined),
      ]);
      state.head = head;
      if (description) {
        state.task = description;
        state.taskSource = 'description';
      }

      let committed: StatusFile[] = [];
      if (options.base && entry.head) {
        state.mergeBase = await this.git.mergeBase(root, options.base, 'HEAD');
        if (state.mergeBase && state.mergeBase !== entry.head) {
          const [files, commits, ahead] = await Promise.all([
            this.git.changedFiles(root, state.mergeBase, 'HEAD'),
            this.git.commitsBetween(root, state.mergeBase, 'HEAD', COMMIT_LIMIT),
            this.git.countCommits(root, state.mergeBase, 'HEAD'),
          ]);
          committed = files;
          state.commits = commits;
          state.ahead = ahead;
        }
      }
      // A worktree nested in this one shows up as an untracked folder; it is not a change.
      const own = working.filter(
        (f) => !options.nested.some((n) => isInside(path.join(root, f.path.replace(/\/$/, '')), n)),
      );
      state.files = mergeFiles(committed, own);

      const times = await Promise.all(
        own
          .filter((f) => f.status !== 'D')
          .slice(0, STAT_LIMIT)
          .map((f) =>
            fs.promises.stat(path.join(root, f.path)).then(
              (s) => s.mtimeMs,
              () => 0,
            ),
          ),
      );
      state.lastActivity = Math.max(head?.committerTime ?? 0, ...times);
      state.active = Date.now() - state.lastActivity < this.config.worktreesActiveMinutes * 60_000;
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
    }
    return state;
  }

  /** Worktree that contains an absolute file path; nested worktrees win over their parent. */
  worktreeOf(file: string): WorktreeState | undefined {
    let best: WorktreeState | undefined;
    for (const wt of this.current?.worktrees ?? []) {
      if (isInside(file, wt.path) && (!best || wt.path.length > best.path.length)) {
        best = wt;
      }
    }
    return best;
  }

  dispose(): void {
    if (this.poll) {
      clearInterval(this.poll);
    }
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
