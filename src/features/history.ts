import * as path from 'path';
import * as vscode from 'vscode';
import { Config, readConfig } from '../config';
import { Git } from '../git/git';
import { LogEntry, UNCOMMITTED_SHA } from '../git/types';
import { fromNow } from '../util/format';
import { BlameService } from './blameService';
import { CommitRef, commitMarkdown, displayAuthor, displayDate } from './commit';

export type HistoryMode = 'file' | 'line';

interface Target {
  uri: vscode.Uri;
  root: string;
  relPath: string;
  /** 1-based inclusive line range for line history. */
  lines?: { start: number; end: number };
}

export class CommitItem extends vscode.TreeItem {
  constructor(
    readonly ref: CommitRef,
    readonly entry: LogEntry | undefined,
    label: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

class MessageItem extends vscode.TreeItem {}

type Item = CommitItem | MessageItem;

/** File History and Line History: commits of the active file (or selected lines). */
export class HistoryProvider implements vscode.TreeDataProvider<Item>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private target: Target | undefined;
  private config: Config = readConfig();
  private view: vscode.TreeView<Item> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private loading: Promise<Item[]> | undefined;
  private pendingTarget = false;

  constructor(
    readonly mode: HistoryMode,
    private readonly git: Git,
    private readonly blame: BlameService,
  ) {
    this.disposables.push(
      this.emitter,
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule(50)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitFate')) {
          this.config = readConfig();
          this.refresh();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.target && doc.uri.toString() === this.target.uri.toString()) {
          this.refresh();
        }
      }),
      this.blame.onDidInvalidate(() => this.refresh()),
    );
    if (mode === 'line') {
      this.disposables.push(
        vscode.window.onDidChangeTextEditorSelection((e) => {
          if (e.textEditor === vscode.window.activeTextEditor) {
            this.schedule(400);
          }
        }),
      );
    }
  }

  attach(view: vscode.TreeView<Item>): void {
    this.view = view;
    this.disposables.push(
      view.onDidChangeVisibility((e) => {
        if (e.visible && this.pendingTarget) {
          this.schedule(0);
        }
      }),
    );
    this.schedule(0);
  }

  refresh(): void {
    this.loading = undefined;
    this.emitter.fire(undefined);
  }

  private schedule(delay: number): void {
    if (this.view && !this.view.visible) {
      this.pendingTarget = true;
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.followEditor(), delay);
  }

  private async followEditor(): Promise<void> {
    this.pendingTarget = false;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    await this.setTarget(editor.document.uri, editor.selection);
  }

  /** Shows the history of a file (and for line mode the selected lines). */
  async setTarget(uri: vscode.Uri, selection?: vscode.Selection): Promise<void> {
    const location = await this.blame.relativePath(uri);
    if (!location) {
      return;
    }
    let lines: Target['lines'];
    if (this.mode === 'line') {
      const sel = selection ?? new vscode.Selection(0, 0, 0, 0);
      let endLine = sel.end.line;
      if (sel.end.character === 0 && endLine > sel.start.line) {
        endLine -= 1;
      }
      lines = { start: sel.start.line + 1, end: endLine + 1 };
    }
    const prev = this.target;
    if (
      prev &&
      prev.uri.toString() === uri.toString() &&
      prev.lines?.start === lines?.start &&
      prev.lines?.end === lines?.end
    ) {
      return;
    }
    this.target = { uri, ...location, lines };
    this.updateDescription();
    this.refresh();
  }

  private updateDescription(): void {
    if (!this.view || !this.target) {
      return;
    }
    const name = path.posix.basename(this.target.relPath);
    const lines = this.target.lines;
    this.view.description = lines
      ? `${name}:${lines.start}${lines.end !== lines.start ? `–${lines.end}` : ''}`
      : name;
  }

  getTreeItem(element: Item): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Item): Promise<Item[]> | Item[] {
    if (element) {
      return [];
    }
    if (!this.target) {
      return [];
    }
    if (!this.loading) {
      this.loading = this.load(this.target);
    }
    return this.loading;
  }

  private async load(target: Target): Promise<Item[]> {
    const { root, relPath } = target;
    let entries: LogEntry[];
    try {
      entries =
        this.mode === 'line' && target.lines
          ? await this.git.lineHistory(
              root,
              relPath,
              target.lines.start,
              target.lines.end,
              this.config.historyLimit,
            )
          : await this.git.fileHistory(root, relPath, this.config.historyLimit);
    } catch (e) {
      const item = new MessageItem(
        this.mode === 'line'
          ? 'No history for these lines (uncommitted or untracked).'
          : 'No history (file is not committed yet).',
      );
      item.tooltip = e instanceof Error ? e.message : String(e);
      return [item];
    }

    const userEmail = await this.git.userEmail(root);
    const items: Item[] = [];
    if (
      this.mode === 'file' &&
      (await this.git.hasWorkingChanges(root, relPath).catch(() => false))
    ) {
      const ref: CommitRef = {
        root,
        sha: UNCOMMITTED_SHA,
        relPath,
        previous: { sha: 'HEAD', relPath },
      };
      const item = new CommitItem(ref, undefined, 'Uncommitted changes');
      item.description = 'Working Tree';
      item.iconPath = new vscode.ThemeIcon('edit');
      item.contextValue = 'gitFate.working';
      item.command = {
        title: 'Open Changes',
        command: 'gitFate.openCommitChanges',
        arguments: [ref],
      };
      items.push(item);
    }

    // `git log --follow` reports the path per commit; track it so renames diff correctly.
    let currentPath = relPath;
    for (const entry of entries) {
      const change =
        entry.changes.find((c) => c.path === currentPath) ??
        entry.changes.find((c) => c.originalPath === currentPath) ??
        entry.changes[0];
      const pathAtCommit = change?.path ?? currentPath;
      const parent = entry.parents[0];
      const previousPath = change?.originalPath ?? pathAtCommit;
      const ref: CommitRef = {
        root,
        sha: entry.sha,
        relPath: pathAtCommit,
        deleted: change?.status === 'D',
        previous:
          parent && change?.status !== 'A' ? { sha: parent, relPath: previousPath } : undefined,
        summary: entry.summary,
      };
      currentPath = previousPath;

      const item = new CommitItem(ref, entry, entry.summary || '(no message)');
      const author = displayAuthor(entry, userEmail);
      item.id = `${this.mode}:${entry.sha}`;
      item.description = `${author}, ${this.config.dateFormat === 'relative' ? fromNow(entry.authorTime) : displayDate(entry.authorTime, 'absolute')}`;
      item.iconPath = new vscode.ThemeIcon(
        change?.status === 'A'
          ? 'diff-added'
          : change?.status === 'R'
            ? 'diff-renamed'
            : change?.status === 'D'
              ? 'diff-removed'
              : 'git-commit',
      );
      const tooltip = commitMarkdown(entry, ref, userEmail, { actions: false });
      if (change?.originalPath && change.originalPath !== change.path) {
        tooltip.appendMarkdown(`\n\n$(diff-renamed) Renamed from \`${change.originalPath}\``);
      }
      item.tooltip = tooltip;
      item.contextValue = 'gitFate.commit';
      item.command = {
        title: 'Open Changes',
        command: 'gitFate.openCommitChanges',
        arguments: [ref],
      };
      items.push(item);
    }
    if (items.length === 0) {
      items.push(new MessageItem('No commits found.'));
    }
    return items;
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
