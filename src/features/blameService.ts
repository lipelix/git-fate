import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { BlameCommit, BlameLine, BlameResult, isUncommitted } from '../git/types';
import { CommitRef } from './commit';

export interface DocumentBlame {
  root: string;
  relPath: string;
  result: BlameResult;
  userEmail: string | undefined;
}

export interface LineBlame {
  blame: DocumentBlame;
  line: BlameLine;
  commit: BlameCommit;
}

interface CacheEntry {
  version: number;
  promise: Promise<DocumentBlame | undefined>;
}

/** Blames text documents with git and caches the result per document version. */
export class BlameService implements vscode.Disposable {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when cached blame became stale for reasons other than a document edit (commit, checkout). */
  readonly onDidInvalidate = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly git: Git) {
    this.disposables.push(
      this.changed,
      vscode.workspace.onDidCloseTextDocument((doc) => this.cache.delete(doc.uri.toString())),
      vscode.workspace.onDidSaveTextDocument((doc) => this.cache.delete(doc.uri.toString())),
    );
  }

  invalidate(): void {
    this.cache.clear();
    this.git.clearCaches();
    this.changed.fire();
  }

  async relativePath(uri: vscode.Uri): Promise<{ root: string; relPath: string } | undefined> {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const root = await this.git.repoRoot(uri.fsPath);
    if (!root) {
      return undefined;
    }
    // rev-parse resolves symlinks; compare against the real path of the file as well.
    let relPath = path.relative(root, uri.fsPath);
    if (relPath.startsWith('..')) {
      relPath = path.relative(root, await fs.promises.realpath(uri.fsPath));
    }
    return { root, relPath: relPath.split(path.sep).join('/') };
  }

  getBlame(document: vscode.TextDocument): Promise<DocumentBlame | undefined> {
    const key = document.uri.toString();
    const cached = this.cache.get(key);
    if (cached && cached.version === document.version) {
      return cached.promise;
    }
    const promise = this.compute(document);
    this.cache.set(key, { version: document.version, promise });
    return promise;
  }

  async getLineBlame(document: vscode.TextDocument, line: number): Promise<LineBlame | undefined> {
    const blame = await this.getBlame(document);
    if (!blame) {
      return undefined;
    }
    const lines = blame.result.lines;
    const entry = lines[line]?.line === line ? lines[line] : lines.find((l) => l.line === line);
    const commit = entry && blame.result.commits.get(entry.sha);
    return entry && commit ? { blame, line: entry, commit } : undefined;
  }

  private async compute(document: vscode.TextDocument): Promise<DocumentBlame | undefined> {
    const location = await this.relativePath(document.uri);
    if (!location) {
      return undefined;
    }
    try {
      const contents = document.isDirty ? document.getText() : undefined;
      const [result, userEmail] = await Promise.all([
        this.git.blame(location.root, location.relPath, contents),
        this.git.userEmail(location.root),
      ]);
      return { ...location, result, userEmail };
    } catch {
      // Untracked, ignored or binary file.
      return undefined;
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Ref for acting on the commit that last changed a blamed line. */
export function refFromLineBlame(lb: LineBlame): CommitRef {
  const { blame, line, commit } = lb;
  if (isUncommitted(commit.sha)) {
    return {
      root: blame.root,
      sha: commit.sha,
      relPath: blame.relPath,
      previous: { sha: 'HEAD', relPath: blame.relPath },
      summary: commit.summary,
      line: line.line,
    };
  }
  return {
    root: blame.root,
    sha: commit.sha,
    relPath: commit.path || blame.relPath,
    previous: commit.previous
      ? { sha: commit.previous.sha, relPath: commit.previous.path }
      : undefined,
    summary: commit.summary,
    line: line.originalLine,
  };
}
