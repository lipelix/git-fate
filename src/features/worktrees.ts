import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { LogEntry } from '../git/types';
import { fromNow, shortSha, truncate } from '../util/format';
import { CommitRef } from './commit';
import { revisionUri } from './revision';
import { WorktreeFile, WorktreeService, WorktreeSnapshot, WorktreeState } from './worktreeService';

/** Letters as the Source Control view shows them. */
const STATUS_LABEL: Record<string, string> = { '?': 'U', U: '!' };

function letter(file: WorktreeFile): string {
  return STATUS_LABEL[file.status] ?? file.status;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

/** One line telling what a worktree is about: its task, else its last commit. */
function doing(wt: WorktreeState): string | undefined {
  return wt.task ?? wt.head?.summary;
}

export class WorktreeItem extends vscode.TreeItem {
  constructor(readonly worktree: WorktreeState) {
    super(worktree.name);
  }
}

export class WorktreeFileItem extends vscode.TreeItem {
  constructor(
    readonly worktree: WorktreeState,
    readonly file: WorktreeFile,
  ) {
    super(path.posix.basename(file.path.replace(/\/$/, '')));
  }
}

class CommitsItem extends vscode.TreeItem {
  constructor(readonly worktree: WorktreeState) {
    super('', vscode.TreeItemCollapsibleState.Collapsed);
  }
}

export class WorktreeCommitItem extends vscode.TreeItem {
  constructor(
    readonly ref: CommitRef,
    readonly entry: LogEntry,
  ) {
    super(entry.summary || '(no message)');
  }
}

class MessageItem extends vscode.TreeItem {}

export type WorktreeTreeItem =
  WorktreeItem | WorktreeFileItem | CommitsItem | WorktreeCommitItem | MessageItem;

/** The Worktrees view: every worktree of the repository and what it changes. */
export class WorktreesProvider
  implements vscode.TreeDataProvider<WorktreeTreeItem>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<WorktreeTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.TreeView<WorktreeTreeItem> | undefined;

  constructor(private readonly service: WorktreeService) {
    this.disposables.push(
      this.emitter,
      service.onDidChange((snapshot) => {
        this.describe(snapshot);
        this.emitter.fire(undefined);
      }),
    );
  }

  attach(view: vscode.TreeView<WorktreeTreeItem>): void {
    this.view = view;
    this.service.viewVisible = view.visible;
    this.disposables.push(
      view.onDidChangeVisibility((e) => {
        this.service.viewVisible = e.visible;
        if (e.visible) {
          void this.service.refresh();
        }
      }),
    );
    this.describe(this.service.snapshot);
  }

  private describe(snapshot: WorktreeSnapshot | undefined): void {
    if (!this.view) {
      return;
    }
    this.view.description = snapshot?.base ? `vs ${snapshot.base}` : undefined;
    const overlaps = snapshot?.overlaps.size ?? 0;
    this.view.badge = overlaps
      ? {
          value: overlaps,
          tooltip: `${plural(overlaps, 'file')} changed in more than one worktree`,
        }
      : undefined;
  }

  getTreeItem(element: WorktreeTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WorktreeTreeItem): WorktreeTreeItem[] {
    const snapshot = this.service.snapshot;
    if (!snapshot) {
      return [];
    }
    if (!element) {
      const items: WorktreeTreeItem[] = snapshot.worktrees.map((wt) =>
        this.worktreeItem(wt, snapshot),
      );
      if (snapshot.worktrees.length === 1) {
        const hint = new MessageItem('Only one worktree.');
        hint.description = 'Others appear here after git worktree add.';
        hint.iconPath = new vscode.ThemeIcon('info');
        items.push(hint);
      }
      return items;
    }
    if (element instanceof WorktreeItem) {
      return this.worktreeChildren(element.worktree, snapshot);
    }
    if (element instanceof CommitsItem) {
      return element.worktree.commits.map((c) => this.commitItem(element.worktree, c));
    }
    return [];
  }

  private worktreeItem(wt: WorktreeState, snapshot: WorktreeSnapshot): WorktreeItem {
    const item = new WorktreeItem(wt);
    item.id = `worktree:${wt.path}`;
    const overlapping = wt.files.filter((f) => snapshot.overlaps.has(f.path)).length;
    const parts: string[] = [];
    if (wt.isCurrent) {
      parts.push('this window');
    }
    if (wt.error) {
      parts.push(wt.error);
    } else {
      const what = doing(wt);
      if (what) {
        parts.push(truncate(what, 60));
      }
      if (wt.lastActivity) {
        parts.push(fromNow(wt.lastActivity));
      }
      if (overlapping) {
        parts.push(`⚠ ${overlapping}`);
      }
    }
    item.description = parts.join(' · ');
    item.iconPath = wt.error
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : wt.active
        ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
        : new vscode.ThemeIcon('circle-outline');
    item.collapsibleState =
      wt.error || (!snapshot.detailed && wt.files.length === 0)
        ? vscode.TreeItemCollapsibleState.None
        : wt.active && !wt.isCurrent
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;
    item.contextValue = wt.error ? 'gitFate.worktree.missing' : 'gitFate.worktree';
    item.tooltip = this.worktreeTooltip(wt, snapshot, overlapping);
    return item;
  }

  private worktreeTooltip(
    wt: WorktreeState,
    snapshot: WorktreeSnapshot,
    overlapping: number,
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    const state = wt.error ? '$(warning)' : wt.active ? '$(circle-filled)' : '$(circle-outline)';
    md.appendMarkdown(`${state} **${escapeMarkdown(wt.name)}**`);
    if (wt.isMain) {
      md.appendMarkdown(' · main worktree');
    }
    if (wt.isCurrent) {
      md.appendMarkdown(' · this window');
    }
    md.appendMarkdown('\n\n');
    if (wt.task) {
      const source = wt.taskSource === 'lock' ? 'lock reason' : 'branch description';
      md.appendMarkdown(`$(tasklist) ${escapeMarkdown(wt.task)} _(${source})_\n\n`);
    }
    md.appendMarkdown(`$(folder) \`${wt.path}\`\n\n`);
    if (wt.error) {
      md.appendMarkdown(escapeMarkdown(wt.error));
      return md;
    }
    if (wt.head) {
      md.appendMarkdown(
        `$(git-commit) \`${shortSha(wt.head.sha)}\` ${escapeMarkdown(wt.head.summary)}\n\n`,
      );
    }
    const counts: string[] = [];
    if (snapshot.base) {
      counts.push(`${plural(wt.ahead, 'commit')} ahead of \`${snapshot.base}\``);
    }
    const uncommitted = wt.files.filter((f) => f.uncommitted).length;
    counts.push(`${plural(wt.files.length, 'file')} changed, ${uncommitted} uncommitted`);
    md.appendMarkdown(`${counts.join(' · ')}\n\n`);
    if (wt.lastActivity) {
      md.appendMarkdown(
        `Last change ${fromNow(wt.lastActivity)}${wt.active ? ' (active)' : ' (idle)'}`,
      );
    }
    if (overlapping) {
      md.appendMarkdown(
        `\n\n$(warning) ${plural(overlapping, 'file')} also changed in another worktree`,
      );
    }
    return md;
  }

  private worktreeChildren(wt: WorktreeState, snapshot: WorktreeSnapshot): WorktreeTreeItem[] {
    const items: WorktreeTreeItem[] = [];
    if (wt.task) {
      // The description of the worktree row is cut in a narrow sidebar; here the task has room.
      const task = new MessageItem(wt.task);
      task.id = `worktree:${wt.path}:task`;
      task.iconPath = new vscode.ThemeIcon('tasklist');
      const source = wt.taskSource === 'lock' ? 'lock reason' : 'branch description';
      task.tooltip = `${wt.task} (${source})`;
      task.accessibilityInformation = { label: `Task: ${wt.task}` };
      items.push(task);
    }
    if (wt.ahead > 0) {
      const commits = new CommitsItem(wt);
      commits.id = `worktree:${wt.path}:commits`;
      commits.label = `${plural(wt.ahead, 'commit')} ahead of ${snapshot.base}`;
      commits.iconPath = new vscode.ThemeIcon('git-commit');
      items.push(commits);
    }
    const files = [...wt.files].sort(
      (a, b) => Number(snapshot.overlaps.has(b.path)) - Number(snapshot.overlaps.has(a.path)),
    );
    for (const file of files) {
      items.push(this.fileItem(wt, file, snapshot));
    }
    if (items.length === 0) {
      const empty = new MessageItem(
        snapshot.base ? `No changes against ${snapshot.base}.` : 'No uncommitted changes.',
      );
      items.push(empty);
    }
    return items;
  }

  private fileItem(
    wt: WorktreeState,
    file: WorktreeFile,
    snapshot: WorktreeSnapshot,
  ): WorktreeFileItem {
    const item = new WorktreeFileItem(wt, file);
    item.id = `worktree:${wt.path}:file:${file.path}`;
    item.resourceUri = vscode.Uri.file(path.join(wt.path, file.path));
    const others = (snapshot.overlaps.get(file.path) ?? []).filter((o) => o !== wt);
    const dir = path.posix.dirname(file.path.replace(/\/$/, ''));
    const where = dir === '.' ? '' : dir;
    if (others.length) {
      item.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('list.warningForeground'),
      );
      item.description = `${letter(file)} · also in ${others.map((o) => o.name).join(', ')}`;
    } else {
      item.iconPath = vscode.ThemeIcon.File;
      item.description = where ? `${where} · ${letter(file)}` : letter(file);
    }
    const md = new vscode.MarkdownString('', true);
    md.appendMarkdown(`\`${file.path}\`\n\n`);
    const state = [file.committed && 'committed', file.uncommitted && 'uncommitted'].filter(
      Boolean,
    );
    md.appendMarkdown(`${letter(file)} · ${state.join(' and ')} in **${escapeMarkdown(wt.name)}**`);
    for (const other of others) {
      const what = doing(other);
      md.appendMarkdown(
        `\n\n$(warning) Also changed in **${escapeMarkdown(other.name)}**${what ? `: ${escapeMarkdown(what)}` : ''}`,
      );
    }
    item.tooltip = md;
    item.contextValue = 'gitFate.worktreeFile';
    item.command = {
      title: 'Open Changes',
      command: 'gitFate.openWorktreeFile',
      arguments: [item],
    };
    return item;
  }

  private commitItem(wt: WorktreeState, entry: LogEntry): WorktreeCommitItem {
    const ref: CommitRef = { root: wt.path, sha: entry.sha, relPath: '', summary: entry.summary };
    const item = new WorktreeCommitItem(ref, entry);
    item.id = `worktree:${wt.path}:commit:${entry.sha}`;
    item.description = `${entry.author}, ${fromNow(entry.authorTime)}`;
    item.iconPath = new vscode.ThemeIcon('git-commit');
    item.tooltip = `${shortSha(entry.sha)} ${entry.message}`;
    item.contextValue = 'gitFate.worktreeCommit';
    item.command = { title: 'Show Commit', command: 'gitFate.showCommit', arguments: [ref] };
    return item;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** A line on top of a file another worktree is changing too. */
export class WorktreeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly service: WorktreeService) {
    this.subscription = service.onDidChange(() => this.emitter.fire());
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (document.uri.scheme !== 'file' || !this.service.watching) {
      return [];
    }
    const others = await otherWorktreesChanging(this.service, document.uri.fsPath);
    if (others.length === 0) {
      return [];
    }
    const top = new vscode.Range(0, 0, 0, 0);
    const relPath = others[0].relPath;
    const paths = others.map((o) => o.worktree.path);
    if (others.length === 1) {
      const { worktree } = others[0];
      const what = doing(worktree);
      return [
        new vscode.CodeLens(top, {
          title: `$(warning) Also changed in worktree ${worktree.name}${what ? `: ${truncate(what, 60)}` : ''}`,
          tooltip: 'Compare with the version in that worktree',
          command: 'gitFate.compareWithWorktree',
          arguments: [document.uri, paths, relPath],
        }),
      ];
    }
    return [
      new vscode.CodeLens(top, {
        title: `$(warning) Also changed in ${others.length} worktrees: ${others.map((o) => o.worktree.name).join(', ')}`,
        tooltip: 'Pick a worktree to compare with',
        command: 'gitFate.compareWithWorktree',
        arguments: [document.uri, paths, relPath],
      }),
    ];
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

/** Other worktrees that change the file at `filePath`, with its path in the repository. */
export async function otherWorktreesChanging(
  service: WorktreeService,
  filePath: string,
): Promise<{ worktree: WorktreeState; relPath: string }[]> {
  const real = await fs.promises.realpath(filePath).catch(() => filePath);
  const own = service.worktreeOf(real);
  const snapshot = service.snapshot;
  if (!own || !snapshot) {
    return [];
  }
  const relPath = path.relative(own.path, real).split(path.sep).join('/');
  return snapshot.worktrees
    .filter((wt) => wt !== own && wt.files.some((f) => f.path === relPath))
    .map((worktree) => ({ worktree, relPath }));
}

/** Count of worktrees and of files changed in more than one; click opens the view. */
export class WorktreeStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    'gitFate.worktrees',
    vscode.StatusBarAlignment.Left,
    0,
  );
  private readonly subscription: vscode.Disposable;

  constructor(private readonly service: WorktreeService) {
    this.item.name = 'Git Fate Worktrees';
    this.item.command = 'gitFate.worktrees.focus';
    this.subscription = service.onDidChange((s) => this.update(s));
  }

  private update(snapshot: WorktreeSnapshot | undefined): void {
    if (!snapshot || snapshot.worktrees.length < 2 || !this.service.watching) {
      this.item.hide();
      return;
    }
    const active = snapshot.worktrees.filter((w) => w.active).length;
    const overlaps = snapshot.overlaps.size;
    this.item.text = `$(git-branch) ${active}/${snapshot.worktrees.length}${overlaps ? ` $(warning) ${overlaps}` : ''}`;
    const md = new vscode.MarkdownString('', true);
    md.appendMarkdown(
      `**Worktrees**: ${active} active of ${snapshot.worktrees.length}${overlaps ? `, ${plural(overlaps, 'file')} changed in more than one` : ''}\n\n`,
    );
    for (const wt of snapshot.worktrees) {
      const what = doing(wt);
      md.appendMarkdown(
        `${wt.active ? '$(circle-filled)' : '$(circle-outline)'} ${escapeMarkdown(wt.name)}${what ? ` · ${escapeMarkdown(truncate(what, 50))}` : ''}  \n`,
      );
    }
    this.item.tooltip = md;
    this.item.backgroundColor = overlaps
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.item.show();
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}

function worktreeArg(arg: unknown, service: WorktreeService): WorktreeState | undefined {
  if (arg instanceof WorktreeItem) {
    return arg.worktree;
  }
  if (typeof arg === 'string') {
    return service.snapshot?.worktrees.find((w) => w.path === arg);
  }
  return undefined;
}

/** Left and right side of a file's changes in a worktree against where it forked. */
function fileSides(wt: WorktreeState, file: WorktreeFile): [vscode.Uri, vscode.Uri] {
  const base = wt.mergeBase ?? 'HEAD';
  const left =
    file.status === '?'
      ? revisionUri(wt.path, '', file.path)
      : revisionUri(wt.path, base, file.originalPath ?? file.path);
  const onDisk = path.join(wt.path, file.path);
  const right = fs.existsSync(onDisk)
    ? vscode.Uri.file(onDisk)
    : revisionUri(wt.path, '', file.path);
  return [left, right];
}

export function registerWorktreeCommands(service: WorktreeService, git: Git): vscode.Disposable[] {
  const pick = async (arg: unknown): Promise<WorktreeState | undefined> => {
    const given = worktreeArg(arg, service);
    if (given) {
      return given;
    }
    const snapshot = service.snapshot ?? (await service.refresh());
    const choice = await vscode.window.showQuickPick(
      (snapshot?.worktrees ?? []).map((wt) => ({
        label: wt.name,
        description: doing(wt),
        detail: wt.path,
        wt,
      })),
      { placeHolder: 'Pick a worktree' },
    );
    return choice?.wt;
  };

  return [
    vscode.commands.registerCommand('gitFate.refreshWorktrees', () => service.refresh()),
    vscode.commands.registerCommand('gitFate.openWorktree', async (arg: unknown) => {
      const wt = await pick(arg);
      if (wt) {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt.path), {
          forceNewWindow: true,
        });
      }
    }),
    vscode.commands.registerCommand('gitFate.openWorktreeTerminal', async (arg: unknown) => {
      const wt = await pick(arg);
      if (wt) {
        vscode.window.createTerminal({ name: wt.name, cwd: wt.path }).show();
      }
    }),
    vscode.commands.registerCommand('gitFate.copyWorktreePath', async (arg: unknown) => {
      const wt = await pick(arg);
      if (wt) {
        await vscode.env.clipboard.writeText(wt.path);
        vscode.window.setStatusBarMessage(`$(copy) Copied ${wt.path}`, 2000);
      }
    }),
    vscode.commands.registerCommand('gitFate.openWorktreeChanges', async (arg: unknown) => {
      const wt = await pick(arg);
      if (!wt) {
        return;
      }
      if (wt.files.length === 0) {
        void vscode.window.showInformationMessage(`${wt.name} has no changes.`);
        return;
      }
      const resources = wt.files.map((file) => {
        const [left, right] = fileSides(wt, file);
        return [vscode.Uri.file(path.join(wt.path, file.path)), left, right];
      });
      const base = service.snapshot?.base ?? 'HEAD';
      try {
        await vscode.commands.executeCommand('vscode.changes', `${wt.name} ↔ ${base}`, resources);
      } catch {
        // VS Code without the multi-file diff editor: let the user pick one file.
        const picked = await vscode.window.showQuickPick(
          wt.files.map((file) => ({ label: file.path, description: letter(file), file })),
          { placeHolder: `Changes of ${wt.name}` },
        );
        if (picked) {
          const [left, right] = fileSides(wt, picked.file);
          await vscode.commands.executeCommand('vscode.diff', left, right, picked.file.path);
        }
      }
    }),
    vscode.commands.registerCommand('gitFate.openWorktreeFile', async (arg: unknown) => {
      if (!(arg instanceof WorktreeFileItem)) {
        return;
      }
      const { worktree: wt, file } = arg;
      const [left, right] = fileSides(wt, file);
      const name = path.posix.basename(file.path);
      const base = wt.mergeBase ? shortSha(wt.mergeBase) : 'HEAD';
      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `${name} (${base}) ↔ (${wt.name})`,
        { preview: true },
      );
    }),
    vscode.commands.registerCommand(
      'gitFate.compareWithWorktree',
      async (uri: vscode.Uri, worktreePaths: string[], relPath: string) => {
        const candidates = (service.snapshot?.worktrees ?? []).filter((w) =>
          worktreePaths.includes(w.path),
        );
        const wt =
          candidates.length > 1
            ? (
                await vscode.window.showQuickPick(
                  candidates.map((w) => ({ label: w.name, description: doing(w), w })),
                  { placeHolder: `Compare ${path.posix.basename(relPath)} with the worktree…` },
                )
              )?.w
            : candidates[0];
        if (!wt) {
          return;
        }
        const worktreePath = wt.path;
        const theirs = path.join(worktreePath, relPath);
        const left = fs.existsSync(theirs)
          ? vscode.Uri.file(theirs)
          : revisionUri(worktreePath, '', relPath);
        await vscode.commands.executeCommand(
          'vscode.diff',
          left,
          uri,
          `${path.posix.basename(relPath)} (${wt.name}) ↔ (this window)`,
          { preview: true },
        );
      },
    ),
    vscode.commands.registerCommand('gitFate.setWorktreeTask', async (arg: unknown) => {
      const wt = await pick(arg);
      if (!wt) {
        return;
      }
      if (wt.isMain && !wt.entry.branch) {
        void vscode.window.showWarningMessage(
          'The main worktree has no branch to describe and git cannot lock it.',
        );
        return;
      }
      const text = await vscode.window.showInputBox({
        title: `Task of ${wt.name}`,
        prompt: wt.isMain
          ? 'Saved as the branch description (git branch --edit-description). Empty clears it.'
          : 'Saved as the lock reason (git worktree lock --reason). Empty unlocks the worktree.',
        value: wt.task ?? '',
      });
      if (text === undefined) {
        return;
      }
      const task = text.replace(/\s+/g, ' ').trim();
      try {
        if (wt.isMain) {
          await git.setBranchDescription(wt.path, wt.entry.branch ?? '', task);
        } else {
          await git.setWorktreeLock(wt.path, wt.path, task);
        }
      } catch (e) {
        void vscode.window.showErrorMessage(
          `Could not save the task: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      await service.refresh();
    }),
  ];
}
