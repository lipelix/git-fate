import * as path from 'path';
import * as vscode from 'vscode';
import { Git } from '../git/git';

export const REVISION_SCHEME = 'gitfate';

interface RevisionQuery {
  root: string;
  /** Empty for "file does not exist on this side". */
  sha: string;
  relPath: string;
}

/** Read-only URI for a file at a git revision. Keeps the file name so syntax highlighting works. */
export function revisionUri(root: string, sha: string, relPath: string): vscode.Uri {
  const query: RevisionQuery = { root, sha, relPath };
  return vscode.Uri.from({
    scheme: REVISION_SCHEME,
    path: path.join(root, relPath),
    query: JSON.stringify(query),
  });
}

export function parseRevisionUri(uri: vscode.Uri): RevisionQuery {
  return JSON.parse(uri.query) as RevisionQuery;
}

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly git: Git) {}

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> | string {
    const { root, sha, relPath } = parseRevisionUri(uri);
    if (!sha) {
      return '';
    }
    return this.git.show(root, sha, relPath);
  }
}
