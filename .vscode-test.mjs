import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/extension/**/*.test.js',
  version: process.env.VSCODE_TEST_VERSION || 'stable',
  mocha: {
    timeout: 20000
  }
});
