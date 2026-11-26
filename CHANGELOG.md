# Changelog

## 0.3.0

- **Worktrees** view: every worktree of the repository with its task (lock reason or branch description), commits ahead of the base branch, changed files and last activity. Built for several agents working on one repository at once.
- Files changed in more than one worktree get a warning in the view, in the status bar and on top of the file in the editor, with a diff against the other worktree's version.
- **Set Worktree Task** writes the lock reason (`git worktree lock --reason`) or, for the main worktree, the branch description.

## 0.2.0

- The blame hover previews the change that touched the line: removed and added lines with a little context, like a small diff. Turn it off with `gitFate.hover.diff`.

## 0.1.1

- Icon has transparent rounded corners instead of a white square.

## 0.1.0

- Current line blame at the end of the line, with a hover that shows the full message and actions.
- Blame in the status bar.
- File blame gutter with an age heatmap (`Alt+B`).
- File History view that follows renames, with uncommitted changes on top.
- Line History view for the selected lines.
- Diffs of a commit, the file at a revision, commit files, copy SHA or message, open the commit on GitHub, GitLab, Bitbucket or Azure DevOps.
