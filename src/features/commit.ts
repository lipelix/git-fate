import * as vscode from 'vscode';
import { Commit, isUncommitted } from '../git/types';
import { DiffExcerpt } from '../git/diffParser';
import { DateFormat } from '../config';
import { absoluteDate, fromNow, shortSha } from '../util/format';

/** Everything needed to act on one commit of one file. Passed as command argument. */
export interface CommitRef {
  root: string;
  sha: string;
  /** Path of the file in this commit. */
  relPath: string;
  /** Parent revision and the path the file had there; absent for an added file. */
  previous?: { sha: string; relPath: string };
  /** True when the file was deleted in this commit. */
  deleted?: boolean;
  summary?: string;
  /** 0-based line to reveal when opening the changes. */
  line?: number;
}

/** Tree items carry the ref; commands accept either. */
export function toCommitRef(arg: unknown): CommitRef | undefined {
  if (!arg || typeof arg !== 'object') {
    return undefined;
  }
  const value = arg as { ref?: CommitRef; sha?: string; root?: string };
  if (value.ref && typeof value.ref.sha === 'string') {
    return value.ref;
  }
  if (typeof value.sha === 'string' && typeof value.root === 'string') {
    return value as CommitRef;
  }
  return undefined;
}

export function displayAuthor(commit: Commit, userEmail: string | undefined): string {
  if (isUncommitted(commit.sha)) {
    return 'You';
  }
  if (userEmail && commit.authorEmail.toLowerCase() === userEmail.toLowerCase()) {
    return 'You';
  }
  return commit.author;
}

export function displayDate(time: number, format: DateFormat): string {
  return format === 'absolute' ? absoluteDate(time) : fromNow(time);
}

function commandLink(label: string, command: string, ref: CommitRef, title: string): string {
  const args = encodeURIComponent(JSON.stringify([ref]));
  return `[${label}](command:${command}?${args} "${title}")`;
}

export const HOVER_COMMANDS = [
  'gitFate.showCommit',
  'gitFate.openCommitChanges',
  'gitFate.openFileAtRevision',
  'gitFate.copySha',
  'gitFate.openCommitOnRemote',
];

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

/** A ```diff block; the fence is longer than any backtick run in the code. */
function diffBlock(diff: DiffExcerpt): string {
  const code = diff.lines.join('\n');
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}diff\n${code}\n${fence}`;
}

/** Rich commit details for hovers and tooltips. */
export function commitMarkdown(
  commit: Commit,
  ref: CommitRef,
  userEmail: string | undefined,
  options: { remote?: boolean; actions?: boolean; diff?: DiffExcerpt } = {},
): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = { enabledCommands: HOVER_COMMANDS };
  md.supportHtml = false;

  if (isUncommitted(commit.sha)) {
    md.appendMarkdown('$(edit) **You** · Uncommitted changes\n\n');
    md.appendMarkdown('Working tree changes that are not committed yet.');
    if (options.diff) {
      md.appendMarkdown('\n\n');
      md.appendMarkdown(diffBlock(options.diff));
    }
    if (options.actions !== false && ref.previous) {
      md.appendMarkdown('\n\n---\n\n');
      md.appendMarkdown(
        commandLink(
          '$(compare-changes) Open Changes',
          'gitFate.openCommitChanges',
          ref,
          'Compare with HEAD',
        ),
      );
    }
    return md;
  }

  const author = displayAuthor(commit, userEmail);
  const email = commit.authorEmail ? ` <${escapeMarkdown(commit.authorEmail)}>` : '';
  md.appendMarkdown(
    `$(account) **${escapeMarkdown(author)}**${email} · ${fromNow(commit.authorTime)} (${absoluteDate(commit.authorTime)})\n\n`,
  );
  const message = commit.message || commit.summary;
  md.appendMarkdown(
    escapeMarkdown(message)
      .split('\n')
      .map((l) => l.trimEnd())
      .join('  \n'),
  );
  if (options.diff) {
    md.appendMarkdown('\n\n');
    md.appendMarkdown(diffBlock(options.diff));
  }

  if (options.actions !== false) {
    md.appendMarkdown('\n\n---\n\n');
    const links = [
      commandLink(
        `$(git-commit) \`${shortSha(commit.sha)}\``,
        'gitFate.showCommit',
        ref,
        'Show files changed in this commit',
      ),
      commandLink(
        '$(compare-changes) Open Changes',
        'gitFate.openCommitChanges',
        ref,
        'Open the changes of this commit',
      ),
      commandLink(
        '$(go-to-file) Open File',
        'gitFate.openFileAtRevision',
        ref,
        'Open the file at this revision',
      ),
      commandLink('$(copy) Copy SHA', 'gitFate.copySha', ref, 'Copy the commit SHA'),
    ];
    if (options.remote) {
      links.push(
        commandLink(
          '$(link-external) Open on Remote',
          'gitFate.openCommitOnRemote',
          ref,
          'Open the commit on the remote host',
        ),
      );
    }
    md.appendMarkdown(links.join('&nbsp;&nbsp;|&nbsp;&nbsp;'));
  }
  return md;
}
