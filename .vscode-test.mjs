import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/extension/**/*.test.js',
  workspaceFolder: 'test/fixtures/host.code-workspace',
  launchArgs: ['--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
  version: process.env.VSCODE_TEST_VERSION || 'stable',
  mocha: {
    timeout: 20000
  }
});
