import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface FixtureRepo {
  root: string;
  shas: { initial: string; second: string; rename: string; fourth: string };
  cleanup(): void;
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      ...env,
    },
  }).trim();
}

function commit(
  root: string,
  message: string,
  author: string,
  email: string,
  date: string,
): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message], {
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: date,
  });
  return git(root, ['rev-parse', 'HEAD']);
}

/**
 * Repo with four commits on one file:
 * 1. Alice adds `src/old.ts` (lines a1..a5)
 * 2. Bob changes line 2
 * 3. Alice renames it to `src/greeter.ts` and changes line 4
 * 4. Carol (the configured user) appends line 6
 */
export function createFixtureRepo(): FixtureRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-fate-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Carol']);
  git(root, ['config', 'user.email', 'carol@example.com']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['remote', 'add', 'origin', 'git@github.com:example/fixture.git']);
  fs.mkdirSync(path.join(root, 'src'));
  const file = (name: string, lines: string[]): void =>
    fs.writeFileSync(path.join(root, 'src', name), `${lines.join('\n')}\n`);

  file('old.ts', ['a1', 'a2', 'a3', 'a4', 'a5']);
  const initial = commit(root, 'Add greeter', 'Alice', 'alice@example.com', '2024-01-10T10:00:00Z');
  file('old.ts', ['a1', 'b2', 'a3', 'a4', 'a5']);
  const second = commit(
    root,
    'Tweak second line\n\nLonger body\nwith two lines',
    'Bob',
    'bob@example.com',
    '2025-03-05T10:00:00Z',
  );
  fs.renameSync(path.join(root, 'src', 'old.ts'), path.join(root, 'src', 'greeter.ts'));
  file('greeter.ts', ['a1', 'b2', 'a3', 'c4', 'a5']);
  const rename = commit(
    root,
    'Rename to greeter',
    'Alice',
    'alice@example.com',
    '2026-06-01T10:00:00Z',
  );
  file('greeter.ts', ['a1', 'b2', 'a3', 'c4', 'a5', 'd6']);
  const fourth = commit(root, 'Append line', 'Carol', 'carol@example.com', '2026-11-20T10:00:00Z');
  return {
    root: fs.realpathSync(root),
    shas: { initial, second, rename, fourth },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
