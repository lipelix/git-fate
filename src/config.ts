import * as vscode from 'vscode';

export type DateFormat = 'relative' | 'absolute';

export interface Config {
  currentLineEnabled: boolean;
  currentLineFormat: string;
  statusBarEnabled: boolean;
  hoverDiff: boolean;
  heatmap: boolean;
  dateFormat: DateFormat;
  historyLimit: number;
  worktreesWatch: boolean;
  worktreesBaseBranch: string;
  worktreesActiveMinutes: number;
}

export function readConfig(): Config {
  const c = vscode.workspace.getConfiguration('gitFate');
  return {
    currentLineEnabled: c.get<boolean>('currentLine.enabled', true),
    currentLineFormat: c.get<string>('currentLine.format', '${author}, ${ago} • ${message}'),
    statusBarEnabled: c.get<boolean>('statusBar.enabled', true),
    hoverDiff: c.get<boolean>('hover.diff', true),
    heatmap: c.get<boolean>('fileBlame.heatmap', true),
    dateFormat: c.get<DateFormat>('dateFormat', 'relative'),
    historyLimit: c.get<number>('history.limit', 200),
    worktreesWatch: c.get<boolean>('worktrees.watch', true),
    worktreesBaseBranch: c.get<string>('worktrees.baseBranch', '').trim(),
    worktreesActiveMinutes: c.get<number>('worktrees.activeMinutes', 10),
  };
}

/** Path of the git binary: VS Code's own `git.path` setting when set, else `git` on PATH. */
export function gitPath(): string {
  const configured = vscode.workspace.getConfiguration('git').get<string | string[] | null>('path');
  if (typeof configured === 'string' && configured) {
    return configured;
  }
  if (Array.isArray(configured) && configured.length > 0) {
    return configured[0];
  }
  return 'git';
}
