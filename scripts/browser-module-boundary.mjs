import path from 'node:path';
import { builtinModules } from 'node:module';

// These modules contain browser-safe contracts, data and pure operations. They are
// checked by the same rule, so a later Host dependency cannot enter transitively.
export const browserSharedModules = [
  'src/codex/documentationVerification.ts',
  'src/codex/forms.ts', 'src/codex/historyBudget.ts', 'src/codex/launchProtocol.ts', 'src/codex/protocol.ts',
  'src/codex/transcript.ts', 'src/codex/uiDraftProtocol.ts', 'src/connection/accountProtocol.ts',
  'src/notifications/notificationProtocol.ts',
  'src/git/gitDiffSelection.ts', 'src/git/gitGraphLayout.ts', 'src/git/gitProtocol.ts', 'src/issues/builtInIssueTemplates.ts',
  'src/workspace/actionController.ts', 'src/workspace/actionPolicy.ts', 'src/workspace/bmadEntrypoints.ts',
  'src/workspace/bmadGuide.ts', 'src/workspace/bmadKit.ts', 'src/workspace/issueGraph.ts', 'src/workspace/operations.ts',
  'src/workspace/outputStyle.ts', 'src/workspace/repositorySelection.ts', 'src/workspace/reviewLaunchProtocol.ts',
  'src/workspace/reviewSessionProtocol.ts', 'src/workspace/workflowKitCompatibility.ts', 'src/workspace/workflowKitVersion.ts',
  'src/workspace/workflowNavigation.ts', 'src/workspace/workspaceCapabilities.ts', 'src/workspace/workspaceProtocol.ts'
];
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const key = value => path.resolve(value).replaceAll('\\', '/').toLowerCase();
const typeOnly = node => node.importKind === 'type' || node.exportKind === 'type' || node.specifiers?.length > 0 &&
  node.specifiers.every(item => item.importKind === 'type' || item.exportKind === 'type');
export const browserModuleBoundary = {
  meta: { type: 'problem', schema: [], messages: { host: 'Browser runtime must not import {{module}}; use a browser-safe shared module or a type-only import.',
    computed: 'Browser runtime imports must use a literal module specifier so their dependencies can be checked.' } },
  create(context) {
    const root = context.cwd ?? context.getCwd(), shared = new Set(browserSharedModules.map(file => key(path.join(root, file))));
    const webview = key(path.join(root, 'src/webview')) + '/';
    const check = (node, source) => {
      if (typeof source !== 'string') { context.report({ node, messageId: 'computed' }); return; }
      let forbidden = source === 'vscode' || source.startsWith('node:') || builtins.has(source);
      if (source.startsWith('.')) {
        const resolved = key(path.resolve(path.dirname(context.filename ?? context.getFilename()), source.split('?')[0]));
        forbidden ||= !resolved.startsWith(webview) && ![resolved, resolved + '.ts', resolved + '.tsx', resolved + '/index.ts'].some(file => shared.has(file));
      } else if (path.isAbsolute(source)) forbidden = true;
      if (forbidden) context.report({ node, messageId: 'host', data: { module: source } });
    };
    return {
      ImportDeclaration(node) { if (!typeOnly(node)) check(node, node.source.value); },
      ExportNamedDeclaration(node) { if (node.source && !typeOnly(node)) check(node, node.source.value); },
      ExportAllDeclaration(node) { if (!typeOnly(node)) check(node, node.source.value); },
      ImportExpression(node) { check(node, node.source.value); },
      CallExpression(node) { if (node.callee.type === 'Identifier' && node.callee.name === 'require') check(node, node.arguments[0]?.value); },
      TSImportEqualsDeclaration(node) { if (node.importKind !== 'type') check(node, node.moduleReference.expression?.value); }
    };
  }
};
