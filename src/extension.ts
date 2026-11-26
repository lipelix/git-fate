import * as vscode from 'vscode';
import { gitPath } from './config';
import { Git } from './git/git';
import { BlameService, refFromLineBlame } from './features/blameService';
import { CommitActions } from './features/commands';
import { CurrentLineBlame } from './features/currentLine';
import { FileBlame } from './features/fileBlame';
import { HistoryProvider } from './features/history';
import { REVISION_SCHEME, RevisionContentProvider } from './features/revision';
import { WorktreeService } from './features/worktreeService';
import {
  registerWorktreeCommands,
  WorktreeLensProvider,
  WorktreesProvider,
  WorktreeStatusBar,
} from './features/worktrees';

/** Returned from activate so integration tests can reach the internals. */
export interface ExtensionApi {
  git: Git;
  blame: BlameService;
  fileBlame: FileBlame;
  currentLine: CurrentLineBlame;
  fileHistory: HistoryProvider;
  lineHistory: HistoryProvider;
  worktrees: WorktreeService;
  worktreesView: WorktreesProvider;
}

interface BuiltinGitRepository {
  state: { HEAD?: { commit?: string; name?: string }; onDidChange: vscode.Event<void> };
}

interface BuiltinGitApi {
  repositories: BuiltinGitRepository[];
  onDidOpenRepository: vscode.Event<BuiltinGitRepository>;
}

/** Invalidate caches whenever VS Code's git extension sees HEAD move (commit, checkout, pull). */
async function watchRepositories(onChange: () => void): Promise<vscode.Disposable[]> {
  const extension = vscode.extensions.getExtension<{ getAPI(v: 1): BuiltinGitApi }>('vscode.git');
  if (!extension) {
    return [];
  }
  try {
    const api = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
    const disposables: vscode.Disposable[] = [];
    let timer: NodeJS.Timeout | undefined;
    const debounced = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(onChange, 300);
    };
    const watch = (repo: BuiltinGitRepository): void => {
      let head = repo.state.HEAD?.commit;
      disposables.push(
        repo.state.onDidChange(() => {
          const next = repo.state.HEAD?.commit;
          if (next !== head) {
            head = next;
            debounced();
          }
        }),
      );
    };
    api.repositories.forEach(watch);
    disposables.push(api.onDidOpenRepository(watch));
    return disposables;
  } catch {
    return [];
  }
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const git = new Git(gitPath);
  const blame = new BlameService(git);
  const actions = new CommitActions(git);
  const fileBlame = new FileBlame(blame);
  const currentLine = new CurrentLineBlame(blame, git, actions, (editor) =>
    fileBlame.isActive(editor),
  );
  const fileHistory = new HistoryProvider('file', git, blame);
  const lineHistory = new HistoryProvider('line', git, blame);

  const fileView = vscode.window.createTreeView('gitFate.fileHistory', {
    treeDataProvider: fileHistory,
    showCollapseAll: false,
  });
  const lineView = vscode.window.createTreeView('gitFate.lineHistory', {
    treeDataProvider: lineHistory,
  });
  fileHistory.attach(fileView);
  lineHistory.attach(lineView);

  const worktrees = new WorktreeService(git);
  const worktreesView = new WorktreesProvider(worktrees);
  const worktreeTree = vscode.window.createTreeView('gitFate.worktrees', {
    treeDataProvider: worktreesView,
    showCollapseAll: true,
  });
  worktreesView.attach(worktreeTree);
  const worktreeLens = new WorktreeLensProvider(worktrees);

  const lineCommand =
    (run: (ref: ReturnType<typeof refFromLineBlame>) => Promise<void>) =>
    async (): Promise<void> => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const lineBlame = await blame.getLineBlame(editor.document, editor.selection.active.line);
      if (!lineBlame) {
        void vscode.window.showInformationMessage('Git Fate: no blame for this line.');
        return;
      }
      await run(refFromLineBlame(lineBlame));
    };

  context.subscriptions.push(
    blame,
    fileBlame,
    currentLine,
    fileHistory,
    lineHistory,
    fileView,
    lineView,
    worktrees,
    worktreesView,
    worktreeTree,
    worktreeLens,
    new WorktreeStatusBar(worktrees),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, worktreeLens),
    ...registerWorktreeCommands(worktrees, git),
    vscode.workspace.registerTextDocumentContentProvider(
      REVISION_SCHEME,
      new RevisionContentProvider(git),
    ),
    ...actions.register(),
    fileBlame.onDidToggle(() => currentLine.refresh()),
    vscode.commands.registerCommand('gitFate.toggleFileBlame', async (uri?: vscode.Uri) => {
      let editor = vscode.window.activeTextEditor;
      if (uri instanceof vscode.Uri && editor?.document.uri.toString() !== uri.toString()) {
        editor = await vscode.window.showTextDocument(uri);
      }
      if (editor) {
        await fileBlame.toggle(editor);
      }
    }),
    vscode.commands.registerCommand('gitFate.toggleCurrentLineBlame', async () => {
      const config = vscode.workspace.getConfiguration('gitFate');
      await config.update(
        'currentLine.enabled',
        !config.get<boolean>('currentLine.enabled', true),
        vscode.ConfigurationTarget.Global,
      );
    }),
    vscode.commands.registerCommand('gitFate.showFileHistory', async (uri?: vscode.Uri) => {
      await vscode.commands.executeCommand('gitFate.fileHistory.focus');
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (target) {
        await fileHistory.setTarget(target);
      }
    }),
    vscode.commands.registerCommand('gitFate.showLineHistory', async () => {
      await vscode.commands.executeCommand('gitFate.lineHistory.focus');
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        await lineHistory.setTarget(editor.document.uri, editor.selection);
      }
    }),
    vscode.commands.registerCommand(
      'gitFate.showLineCommit',
      lineCommand((ref) => actions.showCommit(ref)),
    ),
    vscode.commands.registerCommand(
      'gitFate.openLineChanges',
      lineCommand((ref) => actions.openChanges(ref)),
    ),
    vscode.commands.registerCommand('gitFate.refresh', () => {
      actions.clearCaches();
      blame.invalidate();
    }),
  );

  void watchRepositories(() => {
    actions.clearCaches();
    blame.invalidate();
    worktrees.schedule(500);
  }).then((disposables) => context.subscriptions.push(...disposables));

  return { git, blame, fileBlame, currentLine, fileHistory, lineHistory, worktrees, worktreesView };
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
