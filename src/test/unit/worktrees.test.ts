import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Git } from '../../git/git';
import {
  parseNameStatusZ,
  parseStatusV2,
  parseWorktreeList,
  unquoteC,
} from '../../git/worktreeParser';
import { createFixtureRepo, FixtureRepo, git as run } from '../fixtureRepo';

describe('parseWorktreeList', () => {
  it('reads branches, detached and bare worktrees, lock reasons and prunable ones', () => {
    const out = [
      'worktree /repo',
      'HEAD aaaa',
      'branch refs/heads/main',
      '',
      'worktree /repo/.worktrees/agent a',
      'HEAD bbbb',
      'branch refs/heads/feat/agent-a',
      'locked "line1\\nline \\"2\\" \\305\\276"',
      '',
      'worktree /gone',
      'HEAD cccc',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree /bare.git',
      'bare',
      '',
      'worktree /plain-lock',
      'HEAD dddd',
      'branch refs/heads/x',
      'locked',
      '',
    ].join('\n');
    const list = parseWorktreeList(out);
    assert.deepEqual(list, [
      { path: '/repo', head: 'aaaa', branch: 'main', bare: false },
      {
        path: '/repo/.worktrees/agent a',
        head: 'bbbb',
        branch: 'feat/agent-a',
        bare: false,
        locked: 'line1\nline "2" ž',
      },
      {
        path: '/gone',
        head: 'cccc',
        bare: false,
        prunable: 'gitdir file points to non-existent location',
      },
      { path: '/bare.git', head: '', bare: true },
      { path: '/plain-lock', head: 'dddd', branch: 'x', bare: false, locked: '' },
    ]);
  });

  it('leaves unquoted values alone', () => {
    assert.equal(unquoteC('agent: fix "this"'), 'agent: fix "this"');
    assert.equal(unquoteC('"tab\\there"'), 'tab\there');
  });
});

describe('parseStatusV2', () => {
  it('reads changed, renamed, unmerged and untracked files', () => {
    const out = [
      '1 .M N... 100644 100644 100644 aaa aaa src/a file.ts',
      '1 D. N... 100644 000000 000000 aaa 000 gone.ts',
      '1 A. N... 000000 100644 100644 000 bbb added.ts',
      '2 R. N... 100644 100644 100644 aaa aaa R100 new.ts',
      'old.ts',
      'u UU N... 100644 100644 100644 100644 a b c both.ts',
      '? n é.txt',
      '',
    ].join('\0');
    assert.deepEqual(parseStatusV2(out), [
      { status: 'M', path: 'src/a file.ts' },
      { status: 'D', path: 'gone.ts' },
      { status: 'A', path: 'added.ts' },
      { status: 'R', path: 'new.ts', originalPath: 'old.ts' },
      { status: 'U', path: 'both.ts' },
      { status: '?', path: 'n é.txt' },
    ]);
  });
});

describe('parseNameStatusZ', () => {
  it('reads plain and renamed entries', () => {
    const out = ['M', 'a.ts', 'R087', 'old.ts', 'new.ts', 'A', 'b c.ts', ''].join('\0');
    assert.deepEqual(parseNameStatusZ(out), [
      { status: 'M', path: 'a.ts' },
      { status: 'R', originalPath: 'old.ts', path: 'new.ts' },
      { status: 'A', path: 'b c.ts' },
    ]);
  });
});

describe('Git worktrees against a real repository', () => {
  let repo: FixtureRepo;
  let agent: string;
  const git = new Git(() => 'git');

  before(() => {
    repo = createFixtureRepo();
    agent = path.join(repo.root, '.worktrees', 'agent-a');
    run(repo.root, ['worktree', 'add', '-q', '-b', 'feat/agent-a', agent]);
    fs.writeFileSync(path.join(agent, 'src', 'greeter.ts'), 'changed\n');
    fs.writeFileSync(path.join(agent, 'src', 'extra.ts'), 'extra\n');
    run(agent, ['add', 'src/extra.ts']);
    run(agent, ['commit', '-q', '-m', 'Add extra']);
    fs.writeFileSync(path.join(agent, 'notes.md'), 'todo\n');
  });
  after(() => repo.cleanup());

  it('lists both worktrees, the main one first', async () => {
    const list = await git.worktrees(agent);
    assert.deepEqual(
      list.map((w) => [w.path, w.branch]),
      [
        [repo.root, 'main'],
        [agent, 'feat/agent-a'],
      ],
    );
  });

  it('reads the changes of a worktree against the base branch', async () => {
    const mergeBase = await git.mergeBase(agent, 'main', 'HEAD');
    assert.equal(mergeBase, repo.shas.fourth);
    assert.deepEqual(await git.changedFiles(agent, mergeBase!, 'HEAD'), [
      { status: 'A', path: 'src/extra.ts' },
    ]);
    assert.equal(await git.countCommits(agent, mergeBase!, 'HEAD'), 1);
    const commits = await git.commitsBetween(agent, mergeBase!, 'HEAD', 10);
    assert.deepEqual(
      commits.map((c) => c.summary),
      ['Add extra'],
    );
    assert.deepEqual(await git.workingStatus(agent), [
      { status: 'M', path: 'src/greeter.ts' },
      { status: '?', path: 'notes.md' },
    ]);
  });

  it('stores the task as lock reason or branch description', async () => {
    await git.setWorktreeLock(repo.root, agent, 'agent-a · fix the greeter');
    assert.equal((await git.worktrees(repo.root))[1].locked, 'agent-a · fix the greeter');
    await git.setWorktreeLock(agent, agent, 'second task');
    assert.equal((await git.worktrees(repo.root))[1].locked, 'second task');
    await git.setWorktreeLock(repo.root, agent, '');
    assert.equal((await git.worktrees(repo.root))[1].locked, undefined);

    await git.setBranchDescription(repo.root, 'main', 'Release prep');
    assert.equal(await git.branchDescription(repo.root, 'main'), 'Release prep');
    await git.setBranchDescription(repo.root, 'main', '');
    assert.equal(await git.branchDescription(repo.root, 'main'), undefined);
  });

  it('finds the base branch', async () => {
    assert.equal(await git.remoteDefaultBranch(repo.root), undefined);
    assert.equal(await git.refExists(repo.root, 'main'), true);
    assert.equal(await git.refExists(repo.root, 'master'), false);
  });
});
