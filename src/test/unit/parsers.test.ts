import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBlamePorcelain } from '../../git/blameParser';
import { LOG_FORMAT, parseLog } from '../../git/logParser';
import { commitWebUrl, parseRemoteUrl } from '../../git/remote';
import { UNCOMMITTED_SHA } from '../../git/types';
import { fromNow, heat, interpolate, truncate } from '../../util/format';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('parseBlamePorcelain', () => {
  it('reads commits once and assigns every line', () => {
    const out = [
      `${A} 1 1 2`,
      'author Alice',
      'author-mail <alice@example.com>',
      'author-time 1700000000',
      'author-tz +0100',
      'committer Alice',
      'committer-mail <alice@example.com>',
      'committer-time 1700000000',
      'committer-tz +0100',
      'summary First commit',
      'boundary',
      'filename src/a.ts',
      '\tline one',
      `${A} 2 2`,
      '\tline two',
      `${B} 5 3 1`,
      'author Bob',
      'author-mail <bob@example.com>',
      'author-time 1700001000',
      'committer Bob',
      'committer-mail <bob@example.com>',
      'committer-time 1700001000',
      'summary Second: tweak',
      `previous ${A} src/old name.ts`,
      'filename src/a.ts',
      '\tline three',
      '',
    ].join('\n');
    const r = parseBlamePorcelain(out);
    assert.equal(r.lines.length, 3);
    assert.deepEqual(
      r.lines.map((l) => [l.line, l.originalLine, l.sha]),
      [
        [0, 0, A],
        [1, 1, A],
        [2, 4, B],
      ],
    );
    const a = r.commits.get(A)!;
    assert.equal(a.author, 'Alice');
    assert.equal(a.authorEmail, 'alice@example.com');
    assert.equal(a.authorTime, 1700000000000);
    assert.equal(a.previous, undefined);
    const b = r.commits.get(B)!;
    assert.equal(b.summary, 'Second: tweak');
    assert.deepEqual(b.previous, { sha: A, path: 'src/old name.ts' });
  });

  it('labels uncommitted lines', () => {
    const out = [
      `${UNCOMMITTED_SHA} 1 1 1`,
      'author Not Committed Yet',
      'author-mail <not.committed.yet>',
      'author-time 1700000000',
      'summary Version of a.ts from a.ts',
      'filename a.ts',
      '\tnew',
    ].join('\n');
    const r = parseBlamePorcelain(out);
    assert.equal(r.commits.get(UNCOMMITTED_SHA)!.summary, 'Uncommitted changes');
  });

  it('does not treat a content line that looks like a header as a header', () => {
    const out = [`${A} 1 1 1`, 'author X', 'summary s', 'filename f', `\t${B} 1 1 1`].join('\n');
    const r = parseBlamePorcelain(out);
    assert.equal(r.lines.length, 1);
    assert.equal(r.commits.size, 1);
  });
});

describe('parseLog', () => {
  const rec = (sha: string, parents: string, message: string, tail: string): string =>
    `\x1e${sha}\x1f${parents}\x1fAlice\x1falice@example.com\x1f1700000000\x1fAlice\x1falice@example.com\x1f1700000000\x1f${message}\x1d${tail}`;

  it('exposes the format string', () => {
    assert.match(LOG_FORMAT, /^--format=/);
  });

  it('parses name-status with renames and multi-line messages', () => {
    const out =
      rec(B, A, 'Rename file\n\nBody line', `\n\nR087\told.ts\tnew.ts\n`) +
      rec(A, '', 'Initial', `\n\nA\told.ts\n`);
    const entries = parseLog(out);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].summary, 'Rename file');
    assert.equal(entries[0].message, 'Rename file\n\nBody line');
    assert.deepEqual(entries[0].parents, [A]);
    assert.deepEqual(entries[0].changes, [{ status: 'R', originalPath: 'old.ts', path: 'new.ts' }]);
    assert.deepEqual(entries[1].parents, []);
    assert.deepEqual(entries[1].changes, [{ status: 'A', path: 'old.ts' }]);
  });

  it('parses patch headers from git log -L', () => {
    const patch = [
      '',
      'diff --git a/old.ts b/new.ts',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1,2 +1,2 @@',
      '--- removed sql comment',
      '+++ added line',
      '',
    ].join('\n');
    const added = [
      '',
      'diff --git a/x.ts b/x.ts',
      '--- /dev/null',
      '+++ b/x.ts',
      '@@ -0,0 +1 @@',
      '+x',
    ].join('\n');
    const entries = parseLog(rec(B, A, 'Move', patch) + rec(A, '', 'Add', added));
    assert.deepEqual(entries[0].changes, [{ status: 'R', originalPath: 'old.ts', path: 'new.ts' }]);
    assert.deepEqual(entries[1].changes, [{ status: 'A', path: 'x.ts' }]);
  });
});

describe('remote', () => {
  it('parses scp-like, ssh and https urls', () => {
    assert.deepEqual(parseRemoteUrl('git@github.com:owner/repo.git'), {
      host: 'github.com',
      path: 'owner/repo',
    });
    assert.deepEqual(parseRemoteUrl('ssh://git@gitlab.example.com:2222/group/sub/repo.git'), {
      host: 'gitlab.example.com',
      path: 'group/sub/repo',
    });
    assert.deepEqual(parseRemoteUrl('https://user@bitbucket.org/team/repo'), {
      host: 'bitbucket.org',
      path: 'team/repo',
    });
    assert.equal(parseRemoteUrl('/local/path/repo.git'), undefined);
  });

  it('builds commit urls per host', () => {
    assert.equal(
      commitWebUrl('git@github.com:o/r.git', 'abc'),
      'https://github.com/o/r/commit/abc',
    );
    assert.equal(
      commitWebUrl('https://gitlab.com/g/r.git', 'abc'),
      'https://gitlab.com/g/r/-/commit/abc',
    );
    assert.equal(
      commitWebUrl('git@bitbucket.org:t/r.git', 'abc'),
      'https://bitbucket.org/t/r/commits/abc',
    );
    assert.equal(
      commitWebUrl('git@ssh.dev.azure.com:v3/org/proj/repo', 'abc'),
      'https://dev.azure.com/org/proj/_git/repo/commit/abc',
    );
  });
});

describe('format', () => {
  const now = Date.UTC(2026, 10, 24, 12);
  it('formats relative times', () => {
    assert.equal(fromNow(now - 10_000, now), 'just now');
    assert.equal(fromNow(now - 5 * 60_000, now), '5 minutes ago');
    assert.equal(fromNow(now - 3 * 24 * 3600_000, now), '3 days ago');
    assert.equal(fromNow(now - 400 * 24 * 3600_000, now), 'last year');
  });
  it('interpolates known tokens only', () => {
    assert.equal(interpolate('${a} • ${b} ${c}', { a: '1', b: '2' }), '1 • 2 ${c}');
  });
  it('truncates with ellipsis', () => {
    assert.equal(truncate('abcdef', 4), 'abc…');
    assert.equal(truncate('abc', 4), 'abc');
  });
  it('maps age to heat between 0 and 1', () => {
    assert.equal(heat(100, 0, 100), 1);
    assert.equal(heat(0, 0, 100 * 3600_000), 0);
    const mid = heat(50 * 3600_000, 0, 100 * 3600_000);
    assert.ok(mid > 0 && mid < 1);
  });
});
