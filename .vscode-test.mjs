import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/extension/**/*.test.js',
  workspaceFolder: 'test/fixtures/host.code-workspace',
  launchArgs: ['--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    ...(process.env.GITLAB_WORKSPACE_TEST_TMP ? [`--user-data-dir=${process.env.GITLAB_WORKSPACE_TEST_TMP}/user-data`,
      `--extensions-dir=${process.env.GITLAB_WORKSPACE_TEST_TMP}/extensions`, `--logsPath=${process.env.GITLAB_WORKSPACE_TEST_TMP}/logs`] : []),
    ...(process.env.GLW_TEST_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-gpu', '--disable-gpu-sandbox'] : [])],
  version: process.env.VSCODE_TEST_VERSION || 'stable',
  ...(process.env.VSCODE_EXECUTABLE_PATH ? { useInstallation: { fromPath: process.env.VSCODE_EXECUTABLE_PATH } } : {}),
  mocha: {
    timeout: 20000
  }
});
