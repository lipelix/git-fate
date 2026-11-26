import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Git } from '../../git/git';
import { UNCOMMITTED_SHA } from '../../git/types';
import { createFixtureRepo, FixtureRepo } from '../fixtureRepo';

describe('Git against a real repository', () => {
  let repo: FixtureRepo;
  const git = new Git(() => 'git');

  before(() => {
    repo = createFixtureRepo();
  });
  after(() => repo.cleanup());

  it('finds the repository root', async () => {
    assert.equal(await git.repoRoot(`${repo.root}/src/greeter.ts`), repo.root);
    assert.equal(await git.userEmail(repo.root), 'carol@example.com');
  });

  it('blames every line to the right commit across the rename', async () => {
    const r = await git.blame(repo.root, 'src/greeter.ts');
    const { initial, second, rename, fourth } = repo.shas;
    assert.deepEqual(
      r.lines.map((l) => l.sha),
      [initial, second, initial, rename, initial, fourth],
    );
    const first = r.commits.get(initial)!;
    assert.equal(first.author, 'Alice');
    assert.equal(first.path, 'src/old.ts');
    assert.equal(r.commits.get(second)!.summary, 'Tweak second line');
    assert.deepEqual(r.commits.get(rename)!.previous, { sha: second, path: 'src/old.ts' });
  });

  it('diffs one file of a commit across a rename and in the root commit', async () => {
    const { initial, second, rename } = repo.shas;
    const renamed = await git.fileDiff(repo.root, rename, 'src/greeter.ts', {
      sha: second,
      relPath: 'src/old.ts',
    });
    assert.match(renamed, /^-a4$/m);
    assert.match(renamed, /^\+c4$/m);
    assert.doesNotMatch(renamed, /^\+a1$/m, 'a rename must not show as a whole new file');
    const root = await git.fileDiff(repo.root, initial, 'src/old.ts');
    assert.match(root, /^\+a5$/m);
  });

  it('blames unsaved contents as uncommitted', async () => {
    const r = await git.blame(repo.root, 'src/greeter.ts', 'a1\nNEW\nb2\na3\nc4\na5\nd6\n');
    assert.equal(r.lines[1].sha, UNCOMMITTED_SHA);
    assert.equal(r.lines[2].sha, repo.shas.second);
  });

  it('lists file history following the rename', async () => {
    const log = await git.fileHistory(repo.root, 'src/greeter.ts', 50);
    assert.deepEqual(
      log.map((e) => e.summary),
      ['Append line', 'Rename to greeter', 'Tweak second line', 'Add greeter'],
    );
    assert.equal(log[1].changes[0].status, 'R');
    assert.equal(log[1].changes[0].originalPath, 'src/old.ts');
    assert.equal(log[2].changes[0].path, 'src/old.ts');
    assert.equal(log[2].message, 'Tweak second line\n\nLonger body\nwith two lines');
  });

  it('lists line history', async () => {
    const log = await git.lineHistory(repo.root, 'src/greeter.ts', 2, 2, 50);
    assert.deepEqual(
      log.map((e) => e.summary),
      ['Tweak second line', 'Add greeter'],
    );
    assert.equal(log[0].changes[0].path, 'src/old.ts');
  });

  it('shows contents at a revision and commit files', async () => {
    assert.equal(
      await git.show(repo.root, repo.shas.initial, 'src/old.ts'),
      'a1\na2\na3\na4\na5\n',
    );
    assert.equal(await git.show(repo.root, repo.shas.initial, 'src/missing.ts'), '');
    const files = await git.commitFiles(repo.root, repo.shas.rename);
    assert.deepEqual(files, [{ status: 'R', originalPath: 'src/old.ts', path: 'src/greeter.ts' }]);
    const root = await git.commitFiles(repo.root, repo.shas.initial);
    assert.deepEqual(root, [{ status: 'A', path: 'src/old.ts' }]);
  });

  it('reads the remote url and working changes', async () => {
    assert.equal(await git.remoteUrl(repo.root), 'git@github.com:example/fixture.git');
    assert.equal(await git.hasWorkingChanges(repo.root, 'src/greeter.ts'), false);
  });
});
