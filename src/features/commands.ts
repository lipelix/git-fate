import * as path from 'path';
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { commitWebUrl } from '../git/remote';
import { FileChange, isUncommitted } from '../git/types';
import { shortSha } from '../util/format';
import { CommitRef, toCommitRef } from './commit';
import { revisionUri } from './revision';

/** Actions on commits shared by hovers, the status bar and the history views. */
export class CommitActions {
  private readonly remotes = new Map<string, Promise<string | undefined>>();

  constructor(private readonly git: Git) {}

  remoteUrl(root: string): Promise<string | undefined> {
    let cached = this.remotes.get(root);
    if (!cached) {
      cached = this.git.remoteUrl(root).catch(() => undefined);
      this.remotes.set(root, cached);
    }
    return cached;
  }

  clearCaches(): void {
    this.remotes.clear();
  }

  /** Diff of the file between the commit's parent and the commit (or HEAD and the working copy). */
  async openChanges(ref: CommitRef): Promise<void> {
    const name = path.posix.basename(ref.relPath);
    let left: vscode.Uri;
    let right: vscode.Uri;
    let title: string;

    if (isUncommitted(ref.sha)) {
      left = revisionUri(ref.root, 'HEAD', ref.previous?.relPath ?? ref.relPath);
      right = vscode.Uri.file(path.join(ref.root, ref.relPath));
      title = `${name} (HEAD) ↔ (Working Tree)`;
    } else {
      const prev = ref.previous;
      left = prev
        ? revisionUri(ref.root, prev.sha, prev.relPath)
        : revisionUri(ref.root, '', ref.relPath);
      right = revisionUri(ref.root, ref.deleted ? '' : ref.sha, ref.relPath);
      title = prev
        ? `${name} (${shortSha(prev.sha)}) ↔ (${shortSha(ref.sha)})`
        : `${name} (added in ${shortSha(ref.sha)})`;
    }

    const options: vscode.TextDocumentShowOptions = { preview: true };
    if (ref.line !== undefined) {
      options.selection = new vscode.Range(ref.line, 0, ref.line, 0);
    }
    await vscode.commands.executeCommand('vscode.diff', left, right, title, options);
  }

  async openFileAtRevision(ref: CommitRef): Promise<void> {
    const uri = isUncommitted(ref.sha)
      ? vscode.Uri.file(path.join(ref.root, ref.relPath))
      : revisionUri(ref.root, ref.sha, ref.relPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const options: vscode.TextDocumentShowOptions = { preview: true };
    if (ref.line !== undefined) {
      options.selection = new vscode.Range(ref.line, 0, ref.line, 0);
    }
    await vscode.window.showTextDocument(doc, options);
  }

  async copySha(ref: CommitRef): Promise<void> {
    await vscode.env.clipboard.writeText(ref.sha);
    vscode.window.setStatusBarMessage(`$(copy) Copied ${shortSha(ref.sha)}`, 2000);
  }

  async copyMessage(ref: CommitRef): Promise<void> {
    const commit = await this.git.commit(ref.root, ref.sha);
    await vscode.env.clipboard.writeText(commit?.message ?? ref.summary ?? '');
    vscode.window.setStatusBarMessage('$(copy) Copied commit message', 2000);
  }

  async openOnRemote(ref: CommitRef): Promise<void> {
    const remote = await this.remoteUrl(ref.root);
    const url = remote && commitWebUrl(remote, ref.sha);
    if (!url) {
      void vscode.window.showWarningMessage('This repository has no remote with a known web URL.');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /** Quick pick with the commit's actions and changed files; picking a file opens its diff. */
  async showCommit(ref: CommitRef): Promise<void> {
    if (isUncommitted(ref.sha)) {
      await this.openChanges(ref);
      return;
    }
    const [commit, files, remote] = await Promise.all([
      this.git.commit(ref.root, ref.sha),
      this.git.commitFiles(ref.root, ref.sha),
      this.remoteUrl(ref.root),
    ]);
    if (!commit) {
      void vscode.window.showErrorMessage(`Commit ${shortSha(ref.sha)} not found.`);
      return;
    }

    type Item = vscode.QuickPickItem & { run?: () => Promise<void> };
    const statusIcon: Record<string, string> = {
      A: '$(diff-added)',
      D: '$(diff-removed)',
      R: '$(diff-renamed)',
      C: '$(diff-added)',
    };
    const fileItem = (change: FileChange): Item => ({
      label: `${statusIcon[change.status] ?? '$(diff-modified)'} ${path.posix.basename(change.path)}`,
      description: change.originalPath
        ? `${change.originalPath} → ${change.path}`
        : path.posix.dirname(change.path),
      run: () =>
        this.openChanges({
          root: ref.root,
          sha: commit.sha,
          relPath: change.path,
          deleted: change.status === 'D',
          previous:
            change.status === 'A' || commit.parents.length === 0
              ? undefined
              : { sha: commit.parents[0], relPath: change.originalPath ?? change.path },
        }),
    });

    const items: Item[] = [
      {
        label: `$(copy) Copy SHA`,
        description: shortSha(commit.sha),
        run: () => this.copySha(ref),
      },
      { label: '$(copy) Copy Message', run: () => this.copyMessage(ref) },
    ];
    if (remote && commitWebUrl(remote, commit.sha)) {
      items.push({ label: '$(link-external) Open on Remote', run: () => this.openOnRemote(ref) });
    }
    items.push({
      label: `${files.length} file${files.length === 1 ? '' : 's'} changed`,
      kind: vscode.QuickPickItemKind.Separator,
    });
    const current = files.find((f) => f.path === ref.relPath);
    for (const change of current ? [current, ...files.filter((f) => f !== current)] : files) {
      items.push(fileItem(change));
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: `${shortSha(commit.sha)} · ${commit.author} · ${commit.summary}`,
      placeHolder: 'Pick a file to see its changes',
      matchOnDescription: true,
    });
    await picked?.run?.();
  }

  register(): vscode.Disposable[] {
    const wrap =
      (fn: (ref: CommitRef) => Promise<void>) =>
      async (arg: unknown): Promise<void> => {
        const ref = toCommitRef(arg);
        if (ref) {
          await fn(ref);
        }
      };
    return [
      vscode.commands.registerCommand(
        'gitFate.openCommitChanges',
        wrap((r) => this.openChanges(r)),
      ),
      vscode.commands.registerCommand(
        'gitFate.openFileAtRevision',
        wrap((r) => this.openFileAtRevision(r)),
      ),
      vscode.commands.registerCommand(
        'gitFate.showCommit',
        wrap((r) => this.showCommit(r)),
      ),
      vscode.commands.registerCommand(
        'gitFate.copySha',
        wrap((r) => this.copySha(r)),
      ),
      vscode.commands.registerCommand(
        'gitFate.copyMessage',
        wrap((r) => this.copyMessage(r)),
      ),
      vscode.commands.registerCommand(
        'gitFate.openCommitOnRemote',
        wrap((r) => this.openOnRemote(r)),
      ),
    ];
  }
}
