import * as vscode from 'vscode';
import { Config, readConfig } from '../config';
import { isUncommitted } from '../git/types';
import { heat, heatColor, truncate } from '../util/format';
import { BlameService, refFromLineBlame } from './blameService';
import { commitMarkdown, displayAuthor, displayDate } from './commit';

const AUTHOR_WIDTH = 18;
const NBSP = ' ';

/** Whole-file blame in a gutter before each line, optionally colored by age (heatmap). */
export class FileBlame implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    before: {
      color: new vscode.ThemeColor('gitFate.gutterForeground'),
      backgroundColor: new vscode.ThemeColor('gitFate.gutterBackground'),
      margin: '0 1.5ch 0 0',
      fontWeight: 'normal',
      fontStyle: 'normal',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly active = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private config: Config = readConfig();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidToggle = this.changed.event;

  constructor(private readonly blame: BlameService) {
    this.disposables.push(
      this.decoration,
      this.changed,
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          if (this.isActive(editor)) {
            void this.render(editor);
          }
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0 && this.active.has(e.document.uri.toString())) {
          this.scheduleDocument(e.document, 800);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.active.delete(doc.uri.toString())),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitFate')) {
          this.config = readConfig();
          this.renderAll();
        }
      }),
      this.blame.onDidInvalidate(() => this.renderAll()),
    );
  }

  isActive(editor: vscode.TextEditor): boolean {
    return this.active.has(editor.document.uri.toString());
  }

  async toggle(editor: vscode.TextEditor): Promise<boolean> {
    const key = editor.document.uri.toString();
    if (this.active.has(key)) {
      this.active.delete(key);
      for (const e of this.editorsOf(editor.document)) {
        e.setDecorations(this.decoration, []);
      }
      this.changed.fire();
      return false;
    }
    this.active.add(key);
    this.changed.fire();
    await Promise.all(this.editorsOf(editor.document).map((e) => this.render(e)));
    return true;
  }

  private editorsOf(document: vscode.TextDocument): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter((e) => e.document === document);
  }

  private renderAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (this.isActive(editor)) {
        void this.render(editor);
      }
    }
  }

  private scheduleDocument(document: vscode.TextDocument, delay: number): void {
    const key = document.uri.toString();
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        for (const editor of this.editorsOf(document)) {
          void this.render(editor);
        }
      }, delay),
    );
  }

  private async render(editor: vscode.TextEditor): Promise<void> {
    const document = editor.document;
    const version = document.version;
    const blame = await this.blame.getBlame(document);
    if (!this.isActive(editor) || document.version !== version) {
      return;
    }
    if (!blame) {
      editor.setDecorations(this.decoration, []);
      void vscode.window.showInformationMessage(
        'Git Fate: this file is not tracked by git, so it has no blame.',
      );
      this.active.delete(document.uri.toString());
      this.changed.fire();
      return;
    }

    const now = Date.now();
    const times = [...blame.result.commits.values()].map((c) =>
      isUncommitted(c.sha) ? now : c.authorTime,
    );
    const oldest = Math.min(...times);
    const newest = Math.max(...times);

    const dates = new Map<string, string>();
    let dateWidth = 0;
    for (const commit of blame.result.commits.values()) {
      const text = isUncommitted(commit.sha)
        ? 'now'
        : displayDate(commit.authorTime, this.config.dateFormat);
      dates.set(commit.sha, text);
      dateWidth = Math.max(dateWidth, text.length);
    }
    const width = dateWidth + AUTHOR_WIDTH + 3;

    const decorations: vscode.DecorationOptions[] = [];
    let previous: string | undefined;
    for (const line of blame.result.lines) {
      if (line.line >= document.lineCount) {
        continue;
      }
      const commit = blame.result.commits.get(line.sha);
      if (!commit) {
        continue;
      }
      const first = line.sha !== previous;
      previous = line.sha;
      const author = isUncommitted(commit.sha)
        ? 'Uncommitted'
        : displayAuthor(commit, blame.userEmail);
      const label = first
        ? `${dates.get(commit.sha)!.padEnd(dateWidth, NBSP)}${NBSP}${NBSP}${truncate(author, AUTHOR_WIDTH)}`
        : '';
      const time = isUncommitted(commit.sha) ? now : commit.authorTime;
      const bar = this.config.heatmap
        ? `3px solid ${heatColor(heat(time, oldest, newest))}`
        : '3px solid transparent';
      const lineBlame = { blame, line, commit };
      decorations.push({
        range: new vscode.Range(line.line, 0, line.line, 0),
        hoverMessage: commitMarkdown(commit, refFromLineBlame(lineBlame), blame.userEmail),
        renderOptions: {
          before: {
            contentText: (label || NBSP).replace(/ /g, NBSP),
            width: `${width}ch`,
            textDecoration: `none; border-left: ${bar}; padding-left: 1ch; box-sizing: border-box; white-space: pre; vertical-align: top`,
          },
        },
      });
    }
    editor.setDecorations(this.decoration, decorations);
  }

  dispose(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.disposables.forEach((d) => d.dispose());
  }
}
