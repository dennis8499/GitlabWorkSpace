import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['node_modules/**', 'out/**', 'dist/**', '.*/**', 'docs/**', 'test/fixtures/**', 'test/overlays/**',
    'resources/issue-webview/**', 'resources/sidebar-webview/**', 'resources/offline-tools/**', 'resources/workflow-kit/**'] },
  { files: ['**/*.{js,cjs,mjs,ts,tsx}'], extends: [js.configs.recommended],
    languageOptions: { globals: globals.node }, rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-irregular-whitespace': ['error', { skipJSXText: true, skipTemplates: true }],
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }]
    } },
  { files: ['**/*.{ts,tsx}'], extends: [...tseslint.configs.recommended], rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
    '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }]
  } },
  { files: ['src/webview/**/*.{ts,tsx}'], languageOptions: { globals: globals.browser } },
  { files: ['test/**/*.{ts,js,cjs,mjs}'], languageOptions: { globals: { ...globals.node, ...globals.mocha } },
    rules: { '@typescript-eslint/no-require-imports': 'off' } },
  { files: ['**/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
  // Browser callbacks in these Node-based automation drivers execute in the page.
  { files: ['scripts/run-live-extension-tests.mjs', 'scripts/validate-packaged-ui.mjs',
    'scripts/verify-workflowkit-ui.mjs', 'test/behavior/graph-renderer-benchmark.mjs'], languageOptions: { globals: globals.browser } },
  // These validators deliberately reject control characters in Git paths and refs.
  { files: ['src/git/gitProtocol.ts', 'src/git/gitRepositoryService.ts', 'src/webview/skillsGuideData.ts', 'src/workspace/workspacePaths.ts'],
    rules: { 'no-control-regex': 'off' } }
);
