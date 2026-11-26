import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../../extension';
import type { CommitItem } from '../../../features/history';
import type { WorktreeFileItem, WorktreeItem } from '../../../features/worktrees';
import { UNCOMMITTED_SHA } from '../../../git/types';
import { git } from '../../fixtureRepo';
import * as fs from 'node:fs';

interface Fixture {
  root: string;
  shas: { initial: string; second: string; rename: string; fourth: string };
}

function fixture(): Fixture {
  const raw = process.env.GIT_FATE_FIXTURE;
  if (!raw) {
    throw new Error('Missing required environment variable: GIT_FATE_FIXTURE');
  }
  return JSON.parse(raw) as Fixture;
}

async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined && value !== false) {
      return value;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function hoverText(hovers: vscode.Hover[]): string {
  return hovers
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : c.value))
    .join('\n');
}

describe('Git Fate', () => {
  const fx = fixture();
  const file = vscode.Uri.file(path.join(fx.root, 'src', 'greeter.ts'));
  let api: ExtensionApi;
  let editor: vscode.TextEditor;

  before(async () => {
    const ext = vscode.extensions.getExtension<ExtensionApi>('lipelix.git-fate');
    assert.ok(ext, 'extension is installed');
    api = await ext.activate();
    editor = await vscode.window.showTextDocument(file);
  });

  it('shows the blame of the current line', async () => {
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    const lb = await waitFor(() => {
      const c = api.currentLine.current();
      return c?.line.line === 1 ? c : undefined;
    }, 'current line blame');
    assert.equal(lb.commit.sha, fx.shas.second);
    assert.equal(lb.commit.author, 'Bob');
  });

  it('marks lines by the configured user as You and shows a hover with the full message', async () => {
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    await waitFor(() => api.currentLine.current()?.line.line === 1 || undefined, 'line 1');
    const end = editor.document.lineAt(1).range.end;
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      file,
      end,
    );
    const text = hoverText(hovers);
    assert.match(text, /Bob/);
    assert.match(text, /Longer body/);
    assert.match(text, /command:gitFate\.openCommitChanges/);
    assert.match(text, /Open on Remote/);
    assert.match(text, /```diff\n a1\n-a2\n\+b2\n a3\n a4\n```/, 'diff of the line in the hover');

    editor.selection = new vscode.Selection(5, 0, 5, 0);
    const own = await waitFor(() => {
      const c = api.currentLine.current();
      return c?.line.line === 5 ? c : undefined;
    }, 'line 5');
    assert.equal(own.commit.sha, fx.shas.fourth);
    assert.equal(own.blame.userEmail, 'carol@example.com');
  });

  it('does not show the annotation hover inside the line text', async () => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      file,
      new vscode.Position(5, 0),
    );
    assert.doesNotMatch(hoverText(hovers), /Append line/);
  });

  it('toggles the file blame', async () => {
    await vscode.commands.executeCommand('gitFate.toggleFileBlame');
    assert.equal(api.fileBlame.isActive(editor), true);
    await vscode.commands.executeCommand('gitFate.toggleFileBlame');
    assert.equal(api.fileBlame.isActive(editor), false);
  });

  it('lists the file history across the rename', async () => {
    await vscode.commands.executeCommand('gitFate.showFileHistory', file);
    const items = (await api.fileHistory.getChildren()) as CommitItem[];
    assert.deepEqual(
      items.map((i) => i.label),
      ['Append line', 'Rename to greeter', 'Tweak second line', 'Add greeter'],
    );
    const rename = items[1].ref;
    assert.equal(rename.relPath, 'src/greeter.ts');
    assert.deepEqual(rename.previous, { sha: fx.shas.second, relPath: 'src/old.ts' });
    const older = items[2].ref;
    assert.equal(older.relPath, 'src/old.ts');
    assert.equal(items[3].ref.previous, undefined);
  });

  it('lists the line history of the selection', async () => {
    editor = await vscode.window.showTextDocument(file);
    editor.selection = new vscode.Selection(3, 0, 3, 2);
    await vscode.commands.executeCommand('gitFate.showLineHistory');
    const items = (await api.lineHistory.getChildren()) as CommitItem[];
    assert.deepEqual(
      items.map((i) => i.label),
      ['Rename to greeter', 'Add greeter'],
    );
  });

  it('opens the changes of a commit as a diff of revisions', async () => {
    const items = (await api.fileHistory.getChildren()) as CommitItem[];
    await vscode.commands.executeCommand('gitFate.openCommitChanges', items[1]);
    const tab = await waitFor(() => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputTextDiff ? input : undefined;
    }, 'diff tab');
    assert.equal(tab.original.scheme, 'gitfate');
    const left = await vscode.workspace.openTextDocument(tab.original);
    const right = await vscode.workspace.openTextDocument(tab.modified);
    assert.equal(left.getText(), 'a1\nb2\na3\na4\na5\n');
    assert.equal(right.getText(), 'a1\nb2\na3\nc4\na5\n');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it('opens a file at a revision', async () => {
    const items = (await api.fileHistory.getChildren()) as CommitItem[];
    await vscode.commands.executeCommand('gitFate.openFileAtRevision', items[3]);
    const doc = vscode.window.activeTextEditor?.document;
    assert.equal(doc?.uri.scheme, 'gitfate');
    assert.equal(doc?.getText(), 'a1\na2\na3\na4\na5\n');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it('blames unsaved edits as uncommitted and shows working changes in history', async () => {
    editor = await vscode.window.showTextDocument(file);
    await editor.edit((e) => e.insert(new vscode.Position(1, 0), 'inserted\n'));
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    const lb = await waitFor(() => {
      const c = api.currentLine.current();
      return c?.line.line === 1 && c.commit.sha === UNCOMMITTED_SHA ? c : undefined;
    }, 'uncommitted blame');
    assert.equal(lb.commit.summary, 'Uncommitted changes');
    const next = await api.blame.getLineBlame(editor.document, 2);
    assert.equal(next?.commit.sha, fx.shas.second);

    await editor.document.save();
    api.fileHistory.refresh();
    const items = (await api.fileHistory.getChildren()) as CommitItem[];
    assert.equal(items[0].label, 'Uncommitted changes');
    await vscode.commands.executeCommand('gitFate.openCommitChanges', items[0]);
    const tab = await waitFor(() => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputTextDiff ? input : undefined;
    }, 'working diff tab');
    assert.equal(tab.modified.scheme, 'file');
  });

  describe('Worktrees', () => {
    let agent: string;

    before(() => {
      // The main worktree still has the saved edit of src/greeter.ts from the tests above.
      agent = path.join(fx.root, '.worktrees', 'agent-a');
      git(fx.root, ['worktree', 'add', '-q', '-b', 'feat/agent-a', agent]);
      git(fx.root, ['worktree', 'lock', '--reason', 'agent-a · rewrite the greeter', agent]);
      fs.writeFileSync(path.join(agent, 'src', 'extra.ts'), 'extra\n');
      git(agent, ['add', 'src/extra.ts']);
      git(agent, ['commit', '-q', '-m', 'Add extra']);
      fs.writeFileSync(path.join(agent, 'src', 'greeter.ts'), 'rewritten\n');
    });

    it('reads every worktree, its task and the files two of them change', async () => {
      const snapshot = await api.worktrees.refresh();
      assert.ok(snapshot);
      assert.equal(snapshot.base, 'main');
      const [main, other] = snapshot.worktrees;
      assert.equal(main.name, 'main');
      assert.equal(main.isCurrent, true);
      assert.deepEqual(
        main.files.map((f) => f.path),
        ['src/greeter.ts'],
        'the nested worktree is not an untracked change of the main one',
      );
      assert.equal(other.name, 'feat/agent-a');
      assert.equal(other.task, 'agent-a · rewrite the greeter');
      assert.equal(other.taskSource, 'lock');
      assert.equal(other.ahead, 1);
      assert.equal(other.active, true);
      assert.deepEqual(
        other.files.map((f) => [f.path, f.status, f.committed, f.uncommitted]),
        [
          ['src/extra.ts', 'A', true, false],
          ['src/greeter.ts', 'M', false, true],
        ],
      );
      assert.deepEqual([...snapshot.overlaps.keys()], ['src/greeter.ts']);
    });

    it('shows the worktrees in the view with the overlap first', async () => {
      const roots = api.worktreesView.getChildren() as WorktreeItem[];
      assert.deepEqual(
        roots.map((r) => r.label),
        ['main', 'feat/agent-a'],
      );
      assert.match(String(roots[1].description), /agent-a · rewrite the greeter · .* · ⚠ 1/);
      assert.match(String(roots[0].description), /^this window · /);
      const children = api.worktreesView.getChildren(roots[1]);
      assert.deepEqual(
        children.map((c) => c.label),
        ['agent-a · rewrite the greeter', '1 commit ahead of main', 'greeter.ts', 'extra.ts'],
      );
      assert.match(String(children[2].description), /also in main/);
      const commits = api.worktreesView.getChildren(children[1]);
      assert.deepEqual(
        commits.map((c) => c.label),
        ['Add extra'],
      );
    });

    it('warns on top of a file another worktree changes too', async () => {
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider',
        file,
      );
      const titles = lenses.map((l) => l.command?.title ?? '');
      assert.ok(
        titles.some((t) => /feat\/agent-a: agent-a · rewrite the greeter/.test(t)),
        titles.join('\n'),
      );
      const lens = lenses.find((l) => l.command?.command === 'gitFate.compareWithWorktree')!;
      await vscode.commands.executeCommand(lens.command!.command, ...lens.command!.arguments!);
      const tab = await waitFor(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputTextDiff ? input : undefined;
      }, 'compare with worktree tab');
      assert.equal(tab.original.fsPath, path.join(agent, 'src', 'greeter.ts'));
      assert.equal(tab.modified.fsPath, file.fsPath);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    it('opens the changes of a file in a worktree against its base', async () => {
      const roots = api.worktreesView.getChildren() as WorktreeItem[];
      const greeter = api.worktreesView
        .getChildren(roots[1])
        .find((c) => c.label === 'greeter.ts') as WorktreeFileItem;
      await vscode.commands.executeCommand('gitFate.openWorktreeFile', greeter);
      const tab = await waitFor(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputTextDiff ? input : undefined;
      }, 'worktree diff tab');
      const left = await vscode.workspace.openTextDocument(tab.original);
      assert.equal(left.getText(), 'a1\nb2\na3\nc4\na5\nd6\n');
      assert.equal(tab.modified.fsPath, path.join(agent, 'src', 'greeter.ts'));
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

      await vscode.commands.executeCommand('gitFate.openWorktreeChanges', roots[1]);
      const label = await waitFor(() => {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        return tab?.label.includes('feat/agent-a') ? tab.label : undefined;
      }, 'multi diff tab');
      assert.match(label, /feat\/agent-a ↔ main/);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });
  });
});
