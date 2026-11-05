// Exercise the actual Host message entrypoint with in-memory VS Code adapters.
// No real clipboard, persisted settings, GitLab request or filesystem mutation is invoked.
const path = require('node:path');
const fs = require('node:fs');
const loader = require('node:module');
const root = path.resolve(__dirname, '../../..');
const calls = [];
const vscode = {
  workspace: { workspaceFolders: [], isTrusted: true },
  env: { clipboard: { writeText: async value => { calls.push({ adapter: 'clipboard', valueType: typeof value, value }); } } },
  window: {}
};
const original = loader._load;
loader._load = (name, parent, main) => name === 'vscode' ? vscode : original(name, parent, main);
let WorkspacePanel;
try { ({ WorkspacePanel } = require(path.join(root, 'out/src/workspace/workspacePanel.js'))); }
finally { loader._load = original; }
const { OperationTracker } = require(path.join(root, 'out/src/workspace/operations.js'));
const { NotificationCenter } = require(path.join(root, 'out/src/notifications/notificationCenter.js'));
const operations = new OperationTracker(() => {});
const host = Object.assign(Object.create(WorkspacePanel.prototype), {
  session: { connectionEpoch: 1, activeAccountId: 'audit-account', baseUrl: 'https://gitlab.example.test', selectedGroup: { id: 1 } },
  currentUser: { id: 1 }, projectContext: { root: 'C:/synthetic-workspace', revision: 'audit-root' },
  operationTracker: operations, notificationCenter: new NotificationCenter(),
  context: { globalState: { update: async (key, value) => { calls.push({ adapter: 'globalState', key, valueType: typeof value, value }); } } },
  panel: { visible: true, webview: { postMessage: async () => true } },
  webviewReady: true, webviewMessagesSent: 0, webviewMessagesReceived: 0, viewGeneration: 0,
  viewReadAbort: new AbortController(), writesInFlight: 0, accountTransitionBusy: false, disposed: false,
  withCodexWriteGuard: async (_request, task) => task(),
  runLogged: async (_action, task) => task(), sendSnapshot: () => {},
  pendingViewNotices: [], gitWriteReceipts: new Map(), repositoryScan: { status: 'idle', errors: [] }
});
(async () => {
  const results = [];
  for (const request of [
    { type: 'copy', text: 'Synthetic valid copy' },
    { type: 'copy', text: { invalid: 'object instead of string' } },
    { type: 'selectProject', projectId: { invalid: 'object instead of numeric project identity' } }
  ]) {
    const before = calls.length;
    try { await host.handleMessage(request); results.push({ request, rejected: false, adapterCalls: calls.slice(before) }); }
    catch (error) { results.push({ request, rejected: true, error: error.message, adapterCalls: calls.slice(before) }); }
  }
  const color = rgb => rgb.map(value => { const unit = value / 255; return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const foreground = color([134, 182, 250]), background = color([248, 248, 248]);
  const report = { schema: 'GitLabWorkspaceUxProtocolProbe/v1', checkedAt: new Date().toISOString(),
    limitations: ['In-memory VS Code adapters; does not establish an exploitable path or real clipboard API acceptance', 'Physical Codex write admission is stubbed, as in existing lifecycle tests; these probes use local copy/selection only'],
    results, baselineDiffHunkContrast: { note: 'Historical baseline only; current colors are measured by probe.mjs UX_DIFF_ONLY=1.', foreground: '#86b6fa', background: '#f8f8f8', ratio: Number(((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)).toFixed(3)) } };
  const evidence = process.env.UX_EVIDENCE_DIR ? path.resolve(root, process.env.UX_EVIDENCE_DIR) : path.join(__dirname, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'protocol-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
