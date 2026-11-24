import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { createFixtureRepo } from '../fixtureRepo';

async function main(): Promise<void> {
  // Set when tests are started from a VS Code terminal; it would make the test instance run as plain node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const repo = createFixtureRepo();
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite');
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [repo.root, '--disable-extensions', '--disable-workspace-trust'],
      extensionTestsEnv: {
        GIT_FATE_FIXTURE: JSON.stringify({ root: repo.root, shas: repo.shas }),
      },
    });
  } finally {
    repo.cleanup();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
