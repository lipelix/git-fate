import * as vscode from 'vscode';
import { Config, readConfig } from '../config';
import { Git } from '../git/git';
import { excerptForLine, parseHunks } from '../git/diffParser';
import { isUncommitted } from '../git/types';
import { interpolate, shortSha, truncate } from '../util/format';
import { BlameService, LineBlame, refFromLineBlame } from './blameService';
import { CommitActions } from './commands';
import { CommitRef, commitMarkdown, displayAuthor, displayDate } from './commit';

interface Shown {
  uri: string;
  line: number;
  lineBlame: LineBlame;
}

/** Blame of the line under the cursor: end-of-line annotation, hover and status bar item. */
export class CurrentLineBlame implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('gitFate.inlineBlameForeground'),
      margin: '0 0 0 3em',
      fontWeight: 'normal',
      fontStyle: 'normal',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  private readonly statusBar = vscode.window.createStatusBarItem(
    'gitFate.blame',
    vscode.StatusBarAlignment.Right,
    1000,
  );
  private readonly disposables: vscode.Disposable[] = [];
  private config: Config = readConfig();
  private shown: Shown | undefined;
  private timer: NodeJS.Timeout | undefined;
  private token = 0;

  constructor(
    private readonly blame: BlameService,
    private readonly git: Git,
    private readonly actions: CommitActions,
    private readonly isFileBlameActive: (editor: vscode.TextEditor) => boolean,
  ) {
    this.statusBar.name = 'Git Fate Blame';
    this.disposables.push(
      this.decoration,
      this.statusBar,
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule(0)),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) {
          this.schedule(100);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && e.document === editor.document && e.contentChanges.length > 0) {
          this.clear(editor);
          this.schedule(800);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitFate')) {
          this.config = readConfig();
          this.schedule(0);
        }
      }),
      this.blame.onDidInvalidate(() => this.schedule(0)),
      vscode.languages.registerHoverProvider({ scheme: 'file' }, this),
    );
    this.schedule(0);
  }

  /** Re-render now (used after toggling the file blame). */
  refresh(): void {
    this.schedule(0);
  }

  /** Blame shown for the active editor's line, for tests and commands. */
  current(): LineBlame | undefined {
    return this.shown?.lineBlame;
  }

  private schedule(delay: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.update(), delay);
  }

  private clear(editor?: vscode.TextEditor): void {
    this.shown = undefined;
    editor?.setDecorations(this.decoration, []);
    this.statusBar.hide();
  }

  private async update(): Promise<void> {
    const token = ++this.token;
    const editor = vscode.window.activeTextEditor;
    for (const visible of vscode.window.visibleTextEditors) {
      if (visible !== editor) {
        visible.setDecorations(this.decoration, []);
      }
    }
    if (!editor || editor.document.uri.scheme !== 'file') {
      this.clear(editor);
      return;
    }
    const wantInline = this.config.currentLineEnabled && !this.isFileBlameActive(editor);
    if (!wantInline && !this.config.statusBarEnabled) {
      this.clear(editor);
      return;
    }

    const line = editor.selection.active.line;
    const lineBlame = await this.blame.getLineBlame(editor.document, line);
    if (token !== this.token) {
      return;
    }
    if (!lineBlame) {
      this.clear(editor);
      return;
    }
    this.shown = { uri: editor.document.uri.toString(), line, lineBlame };

    const { commit, blame } = lineBlame;
    const author = displayAuthor(commit, blame.userEmail);
    const when = displayDate(commit.authorTime, this.config.dateFormat);

    if (wantInline) {
      const text = isUncommitted(commit.sha)
        ? 'You • Uncommitted changes'
        : interpolate(this.config.currentLineFormat, {
            author,
            email: commit.authorEmail,
            ago: when,
            date: when,
            message: truncate(commit.summary, 80),
            sha: shortSha(commit.sha),
          });
      const end = editor.document.lineAt(line).range.end;
      editor.setDecorations(this.decoration, [
        { range: new vscode.Range(end, end), renderOptions: { after: { contentText: text } } },
      ]);
    } else {
      editor.setDecorations(this.decoration, []);
    }

    if (this.config.statusBarEnabled) {
      this.statusBar.text = isUncommitted(commit.sha)
        ? '$(git-commit) You, uncommitted'
        : `$(git-commit) ${author}, ${when}`;
      this.statusBar.tooltip = commitMarkdown(commit, refFromLineBlame(lineBlame), blame.userEmail);
      this.statusBar.command = {
        title: 'Show Commit',
        command: 'gitFate.showCommit',
        arguments: [refFromLineBlame(lineBlame)],
      };
      this.statusBar.show();
    } else {
      this.statusBar.hide();
    }
  }

  /** Hover over the end-of-line annotation: full message and actions. */
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const shown = this.shown;
    if (
      !shown ||
      !this.config.currentLineEnabled ||
      shown.uri !== document.uri.toString() ||
      shown.line !== position.line
    ) {
      return undefined;
    }
    const end = document.lineAt(position.line).range.end;
    if (position.character < end.character) {
      return undefined;
    }
    const { commit, blame } = shown.lineBlame;
    const ref = refFromLineBlame(shown.lineBlame);
    const [full, remote, diff] = await Promise.all([
      isUncommitted(commit.sha)
        ? undefined
        : this.git.commit(blame.root, commit.sha).catch(() => undefined),
      isUncommitted(commit.sha) ? undefined : this.actions.remoteUrl(blame.root),
      this.config.hoverDiff ? this.lineDiff(ref, document).catch(() => undefined) : undefined,
    ]);
    const md = commitMarkdown(full ?? commit, ref, blame.userEmail, {
      remote: Boolean(remote),
      diff,
    });
    return new vscode.Hover(md, new vscode.Range(end, end));
  }
  /** The part of the commit's diff that changed the hovered line. */
  private async lineDiff(ref: CommitRef, document: vscode.TextDocument) {
    if (ref.line === undefined) {
      return undefined;
    }
    let diff: string;
    if (isUncommitted(ref.sha)) {
      // Line numbers of an unsaved buffer do not match the working copy on disk.
      if (document.isDirty) {
        return undefined;
      }
      diff = await this.git.workingDiff(ref.root, ref.relPath);
    } else {
      diff = await this.git.fileDiff(ref.root, ref.sha, ref.relPath, ref.previous);
    }
    return excerptForLine(parseHunks(diff), ref.line + 1);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
