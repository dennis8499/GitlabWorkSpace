import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const evidence = path.join(directory, 'evidence');
const runs = path.join(root, '.gitlab-workspace-validation/optimization');
const json = filename => {
  try { return JSON.parse(readFileSync(filename, 'utf8')); }
  catch (error) { throw new Error(`Missing or invalid report input: ${filename} (${error.message})`); }
};
const requireEvidence = (condition, message) => { if (!condition) throw new Error(message); };
const sha = filename => createHash('sha256').update(readFileSync(filename)).digest('hex');
const copy = (source, destination) => { mkdirSync(path.dirname(destination), { recursive: true }); copyFileSync(source, destination); };
const finalRun = process.env.GLW_REPORT_VALIDATION_RUN ?? 'final-validation-7';
const validation = json(path.join(runs, finalRun, 'timings.json'));
requireEvidence(validation.success === true && validation.stages?.length > 0 && validation.stages.every(stage => stage.exitCode === 0),
  'The final complete validation must contain successful stages before creating the delivery report.');
for (const name of readdirSync(path.join(runs, finalRun))) copy(path.join(runs, finalRun, name), path.join(evidence, 'regression', name));
copy(path.join(runs, 'extension-1.90-final.log'), path.join(evidence, 'extension-1.90.log'));
copy(path.join(runs, 'ui-selector-baseline-interrupted.log'), path.join(evidence, 'packaged-ui-selector-interrupted.log'));
for (const [source, target] of [
  ['ui-baseline-delivery/baseline.json', 'packaged-ui-baseline.json'],
  ['ui-revision-delivery/revision.json', 'packaged-ui-revision.json'],
  ['ui-baseline-final/baseline.json', 'packaged-ui-pre-draft-baseline.json'],
  ['ui-revision-final/revision.json', 'packaged-ui-pre-draft-revision.json'],
  ['workspace-updates.json', 'workspace-updates.json'],
  ['ui-revision/revision.json', 'packaged-ui-initial-revision.json'],
  ['ui-baseline/baseline.json', 'packaged-ui-initial-baseline.json'],
  ['ui-refresh-diagnostic/revision.json', 'packaged-ui-initial-refresh-diagnostic.json']
]) copy(path.join(runs, source), path.join(evidence, target));
for (const run of ['ui-baseline-delivery', 'ui-revision-delivery']) for (const name of readdirSync(path.join(runs, run)).filter(name => name.endsWith('.png'))) copy(path.join(runs, run, name), path.join(evidence, name));
const baseline = json(path.join(evidence, 'packaged-ui-baseline.json'));
const ui = json(path.join(evidence, 'packaged-ui-revision.json'));
const initialUi = json(path.join(evidence, 'packaged-ui-initial-revision.json'));
const initialBaseline = json(path.join(evidence, 'packaged-ui-initial-baseline.json'));
const initialRefreshDiagnostic = json(path.join(evidence, 'packaged-ui-initial-refresh-diagnostic.json'));
const preDraftBaseline = json(path.join(evidence, 'packaged-ui-pre-draft-baseline.json'));
const preDraftUi = json(path.join(evidence, 'packaged-ui-pre-draft-revision.json'));
const snapshots = json(path.join(evidence, 'workspace-updates.json'));
const graphBefore = json(path.join(evidence, 'graph-renderer-baseline-idle.json'));
const graphAfter = json(path.join(evidence, 'graph-renderer-final.json'));
const native = json(path.join(evidence, 'git-gui-local.json'));
const confirmations = json(path.join(evidence, 'git-gui-local-native.json'));
const nativeGraphs = [json(path.join(evidence, 'worker-1.90-verified/git-gui-local.json')), json(path.join(evidence, 'local-graph-worker-report.json'))];
const nativeGraphObservationFailures = [
  { evidence: 'evidence/worker-1.90-final/git-gui-local.json', result: json(path.join(evidence, 'worker-1.90-final/git-gui-local.json')),
    explanation: '第一次觀測要求 browser Target.getTargets 列出 dedicated Blob Worker；該次未列出而失敗，前段真實 Worker 回覆、Canvas 與有限座標不代表完整生命週期已驗收。' },
  { evidence: 'evidence/worker-1.90-delivery/git-gui-local.json', result: json(path.join(evidence, 'worker-1.90-delivery/git-gui-local.json')),
    explanation: '第二次觀測已識別正確 owner context，但 hide 後未在 guest session 收到要求的 Runtime 銷毀事件而失敗；不能把此失敗改寫成該次清理已通過，也不能據此證明產品有延遲銷毀缺陷。' }
];
for (const value of nativeGraphObservationFailures) requireEvidence(value.result.status === 'FAIL', `Historical native observation failure must remain unchanged: ${value.evidence}`);
const artifactEquivalence = json(path.join(evidence, 'fixture-artifact-equivalence.json'));
requireEvidence(artifactEquivalence.schema === 'GitLabWorkspaceArtifactEquivalence/v1' && artifactEquivalence.status === 'PASS'
  && artifactEquivalence.checkedFiles > 0 && artifactEquivalence.checked?.length === artifactEquivalence.checkedFiles
  && Array.isArray(artifactEquivalence.mismatches) && artifactEquivalence.mismatches.length === 0
  && Array.isArray(artifactEquivalence.normalizedFiles) && artifactEquivalence.normalizedFiles.every(value => value.path === 'readme.md'
    && value.normalization === 'VSCE relative documentation links to repository blob/HEAD URLs'),
  'The native fixture rebuild must have complete artifact equivalence evidence; only the documented README link transformation is allowed.');
for (const [label, result] of [['baseline Renderer', baseline], ['candidate Renderer', ui],
  ['pre-draft baseline Renderer', preDraftBaseline], ['pre-draft candidate Renderer', preDraftUi]]) {
  requireEvidence(result.schema === 'GitLabWorkspacePackagedUiVerification/v2' && result.performanceStatus === 'MEASURED'
    && result.rounds?.length === 10 && result.rounds.every(round => round.warmNavigationMs?.samples.length === 30 && round.repoSearchMs?.samples.length === 30)
    && result.firstFeedback?.cases.length === 8 && result.firstFeedback.cases.every(value => value.sampleCount === 100 && Number.isFinite(value.firstFeedbackP95Ms))
    && ['PASS', 'FAIL'].includes(result.firstFeedback.status) && ['PASS', 'FAIL'].includes(result.smoke?.status),
  `${label} evidence is incomplete; wait for the complete 10 × 30 run, eight 100-sample feedback cases and smoke result.`);
}
requireEvidence(preDraftUi.comparison?.status === 'FAIL' && preDraftUi.comparison.metrics?.repoSearchP95Ms?.status === 'FAIL',
  'The completed pre-draft paired run must retain its observed search regression and FAIL result.');
requireEvidence(['PASS', 'FAIL'].includes(ui.comparison?.status) && ui.comparison.metrics && Object.keys(ui.comparison.metrics).length > 0,
  'The candidate Renderer comparison is missing, running or blocked; no completed delivery report can be generated.');
requireEvidence(ui.harnessSha256 === baseline.harnessSha256 && ui.fixtureSha256 === baseline.fixtureSha256
  && ui.browserVersion === baseline.browserVersion && JSON.stringify(ui.measurement) === JSON.stringify(baseline.measurement)
  && ui.artifact.sha256 !== baseline.artifact.sha256, 'The Renderer evidence must use distinct artifacts and matching harness, fixture, browser and method.');
for (const [label, result] of [['native Git GUI', native], ['native confirmations', confirmations],
  ['VS Code 1.90 graph Worker', nativeGraphs[0]], ['current VS Code graph Worker', nativeGraphs[1]]]) {
  requireEvidence(result.status === 'PASS', `${label} must pass before delivery; observed ${result.status ?? 'missing status'}: ${result.error ?? ''}`);
}
for (const [index, result] of nativeGraphs.entries()) {
  const graph = result.graphWorker, label = index === 0 ? 'VS Code 1.90 graph Worker' : 'current VS Code graph Worker';
  const layout = value => value && value.nodes === 2000 && value.live === 1 && value.responses > 0 && value.positions === 4000
    && value.finitePositions === true && value.canvasFrames > 0 && value.urls?.length > 0 && value.urls.every(url => typeof url === 'string' && url.startsWith('blob:'))
    && Array.isArray(value.errors) && value.errors.length === 0;
  requireEvidence(result.schema === 'GitLabWorkspaceNativeGraphWorkerEvidence/v1' && graph?.status === 'PASS' && graph.nodes === 2000 && graph.canvas === true
    && graph.apiDispatch === false && layout(graph.startup) && layout(graph.restored)
    && typeof graph.startup.contextId === 'string' && typeof graph.restored.contextId === 'string' && graph.startup.contextId !== graph.restored.contextId
    && typeof graph.startup.webviewTargetId === 'string' && typeof graph.restored.webviewTargetId === 'string'
    && graph.startup.webviewTargetId !== graph.restored.webviewTargetId
    && graph.restored.urls.every(url => !graph.startup.urls.includes(url))
    && graph.hidden?.destroyed === true && graph.hidden.strategy === 'browser-iframe-target-lifecycle'
    && graph.hidden.originalTarget?.targetId === graph.startup.webviewTargetId && graph.hidden.originalTarget.type === 'iframe'
    && typeof graph.hidden.originalTarget.url === 'string' && graph.hidden.originalTarget.url.startsWith('vscode-webview://')
    && graph.hidden.guestDebuggerDetachedBeforeHide === true && graph.hidden.originalTargetAbsent === true
    && graph.hidden.targetDestroyedEvent?.method === 'Target.targetDestroyed'
    && graph.hidden.targetDestroyedEvent.params?.targetId === graph.startup.webviewTargetId
    && Number.isFinite(Date.parse(graph.hidden.targetDestroyedEvent.observedAt))
    && Array.isArray(graph.targetEvents) && graph.targetEvents.some(event => event.method === 'Target.targetDestroyed'
      && event.params?.targetId === graph.startup.webviewTargetId && event.observedAt === graph.hidden.targetDestroyedEvent.observedAt)
    && graph.targetEvents.some(event => event.method === 'Target.targetCreated' && event.params?.targetInfo?.targetId === graph.restored.webviewTargetId
      && event.params.targetInfo.type === 'iframe')
    && graph.readyCount >= 2 && graph.cleanup?.live === 0 && graph.cleanup.created > 0 && graph.cleanup.terminated === graph.cleanup.created
    && graph.cleanup.contextId === graph.restored.contextId
    && Array.isArray(graph.cleanup.errors) && graph.cleanup.errors.length === 0,
  `${label} is missing required production Canvas/Blob response, native destruction/restoration or unmount evidence.`);
}
requireEvidence(nativeGraphs[0].vscodeVersion === '1.90.0' && nativeGraphs[1].vscodeVersion === '1.142.0',
  'Native graph Worker evidence must cover VS Code 1.90.0 and 1.142.0 separately.');
const feedbackP95Ms = Math.max(...ui.firstFeedback.cases.map(value => value.firstFeedbackP95Ms));
const idleChecks = native.idleChecks ?? native.gitGui?.idleChecks ?? [];
const idlePhases = ['open', 'select-file', 'stage', 'commit', 'hidden'];
const idleVerified = native.status === 'PASS' && idlePhases.every(phase => idleChecks.some(value => value.phase === phase))
  && idleChecks.every(value => value.idleMs >= 60_000 && ['commands', 'auxiliaryCommands', 'nativeApiCalls'].every(key => value.extensionDelta?.[key] === 0));
const acceptance = [
  { item: '按下操作後可見回饋', target: 'p95 ≤100 ms', measured: `${feedbackP95Ms} ms（8 類操作中最高 p95）`, status: ui.firstFeedback.status, scope: '封裝 Renderer + mock host' },
  { item: '已載入頁面暖切換', target: 'p95 ≤200 ms', measured: `${ui.metrics.warmNavigationP95Ms} ms`, status: ui.metrics.warmNavigationP95Ms <= 200 ? 'PASS' : 'FAIL', scope: '封裝 Renderer + mock host' },
  { item: '本機搜尋', target: 'p95 ≤100 ms', measured: `${ui.metrics.repoSearchP95Ms} ms`, status: ui.metrics.repoSearchP95Ms <= 100 ? 'PASS' : 'FAIL', scope: '20 Repo 封裝 sidebar；其他輸入未全面量測' },
  { item: '工作台骨架／離線入口', target: 'p95 ≤1 秒', measured: '待 10 次真實程序冷啟動量測', status: 'PENDING', scope: '原生 Host 功能可用已測；延遲分位數未測' },
  { item: '隱藏或取消後停止讀取', target: '≤1 秒', measured: '取消與程序樹清理回歸通過；全部 E2E 路徑未量測', status: 'PENDING', scope: '單元／Host 回歸與原生完整門檻分開' },
  { item: 'Git GUI extension 穩定閒置 60 秒', target: '不新增無關 Git 查詢', measured: idleVerified ? '開啟／選檔／暫存／提交／隱藏五個階段的 extension 三項增量皆為 0；VS Code 背景 Git 另列' : '未完整通過', status: idleVerified ? 'PASS' : 'PENDING', scope: '單次隔離本機 Git GUI；不含 VS Code 自身背景 Git 或所有功能的檔案讀取' },
  { item: '封裝 Renderer 延遲／GC 後保留記憶體回退', target: '同機同負載 ≤10%', measured: ui.comparison.status, status: ui.comparison.status, scope: 'VSIX Renderer＋mock host 的延遲與 GC 後 retained heap' },
  { item: '完整原生延遲／峰值記憶體回退', target: '同機同負載 ≤10%', measured: '未執行完整 10 次冷啟動、每輪 30 次暖切頁／搜尋與峰值記憶體量測', status: 'PENDING', scope: '包含 Extension Host、GitLab 網路與整個應用程式峰值；封裝 Renderer 結果不能代替' },
  { item: '所有功能的閒置檔案讀取', target: '穩定閒置 60 秒不新增不必要的檔案讀取', measured: '尚未覆蓋所有功能的檔案讀取觀測', status: 'PENDING', scope: 'Git GUI extension Git／native API 計數不能自動提升為全域檔案讀取驗收' }
];
const matrix = json(path.join(directory, 'feature-matrix.json'));
const artifact = path.join(root, 'dist/gitlab-workspace-0.26.0-responsiveness-candidate.vsix');
const sourceArtifact = path.join(root, 'dist/gitlab-workspace-0.26.0.vsix');
const candidateSha256 = sha(sourceArtifact);
if (ui.artifact.sha256 !== candidateSha256) throw new Error('The packaged UI evidence must match the delivered candidate VSIX.');
for (const result of [native, confirmations, ...nativeGraphs]) if (result.testedArtifact?.sha256 !== candidateSha256) throw new Error('Every native evidence run must match the delivered candidate VSIX.');
requireEvidence(artifactEquivalence.artifact?.sha256 === candidateSha256, 'The fixture equivalence report must match the delivered candidate VSIX.');
copy(sourceArtifact, artifact);
const unitLog = readFileSync(path.join(evidence, 'regression/unit.log'), 'utf8');
const uiLog = readFileSync(path.join(evidence, 'regression/behavior-node.log'), 'utf8');
const hostCounts = filename => {
  const log = readFileSync(filename, 'utf8');
  const passed = Number(log.match(/(\d+) passing/)?.[1]), pending = Number(log.match(/(\d+) pending/)?.[1] ?? 0);
  requireEvidence(Number.isFinite(passed) && passed > 0 && !/^\s*[1-9]\d* failing/m.test(log) && /Exit code:\s+0\b/.test(log), `Native Host log is incomplete or failed: ${filename}`);
  return { passed, pending };
};
const count = (log, label) => Number(log.match(new RegExp(`(?:ℹ |# )${label} (\\d+)`))?.[1] ?? NaN);
const unitTests = count(unitLog, 'tests'), unitPassed = count(unitLog, 'pass'), behaviorTests = count(uiLog, 'tests'), behaviorPassed = count(uiLog, 'pass');
requireEvidence([unitTests, unitPassed, behaviorTests, behaviorPassed].every(value => Number.isFinite(value) && value > 0)
  && unitTests === unitPassed && behaviorTests === behaviorPassed, 'Unit/behavior log totals are missing or do not show complete passing tests.');
const percentile = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const rounded = n => Math.round(n * 1000) / 1000;
const graph = [200, 2000].map(nodes => {
  const before = graphBefore.measurements.filter(value => value.count === nodes), after = graphAfter.measurements.filter(value => value.count === nodes);
  requireEvidence([before, after].every(rounds => rounds.length === 3 && rounds.every(value => value.selectionPaintMs?.length === 30
    && value.zoomPaintMs?.length === 15 && [...value.selectionPaintMs, ...value.zoomPaintMs].every(Number.isFinite)
    && ['mount', 'selection', 'zoom'].every(phase => Array.isArray(value.longTasksByPhase?.[phase])))),
  `The ${nodes}-node graph comparison requires three complete rounds with selection, zoom and phase long-task evidence.`);
  return { nodes, rounds: after.length, selectionP95BeforeMs: rounded(percentile(before.flatMap(value => value.selectionPaintMs))), selectionP95AfterMs: rounded(percentile(after.flatMap(value => value.selectionPaintMs))), zoomP95BeforeMs: rounded(percentile(before.flatMap(value => value.zoomPaintMs))), zoomP95AfterMs: rounded(percentile(after.flatMap(value => value.zoomPaintMs))), mountLongTasksAfterMs: after.flatMap(value => value.longTasksByPhase.mount), interactionLongTasksAfter: after.flatMap(value => [...value.longTasksByPhase.selection, ...value.longTasksByPhase.zoom]).length };
});
const report = {
  schema: 'GitLabWorkspaceResponsivenessDelivery/v1', generatedAt: new Date().toISOString(), timezone: 'Asia/Taipei',
  baseline: { commit: 'c4ad5d1bbb0e0a5f82e896be914e7be13cd3e906', artifactSha256: baseline.artifact.sha256 },
  candidate: { path: path.relative(root, artifact).replaceAll('\\', '/'), sha256: sha(artifact), bytes: readFileSync(artifact).length, version: '0.26.0', published: false, preparedInputsSha256: json(path.join(root, '.gitlab-workspace-validation/prepared.json')).inputs },
  regression: { status: 'PASS', stages: validation.stages.length, seconds: validation.seconds, durationMeaning: validation.durationMeaning, unitTests, unitPassed, behaviorTests, behaviorPassed, sourceRuns: validation.sourceRuns, methodology: validation.methodology, extensionHost: [{ vscode: '1.90.0', ...hostCounts(path.join(evidence, 'extension-1.90.log')) }, { vscode: '1.142.0', ...hostCounts(path.join(evidence, 'regression/extension.log')) }], note: 'Host 的 opt-in suite 不在一般測試執行；本機 Git GUI／圖譜另有獨立結果，真實 GitLab 未執行。' },
  packagedRenderer: { metrics: ui.metrics, comparison: ui.comparison, firstFeedback: { status: ui.firstFeedback.status, cases: ui.firstFeedback.cases.map(({ samples, ...value }) => value) }, smoke: ui.smoke.status, scope: ui.measurement.scope,
    harnessSha256: ui.harnessSha256, fixtureSha256: ui.fixtureSha256, measurement: ui.measurement },
  measurementCorrections: [{ evidence: 'evidence/packaged-ui-selector-interrupted.log', status: 'INCOMPLETE_TOOL_FAILURE', validForCompleteAcceptance: false,
    affectedPath: 'firstFeedback.navigation', productSourceChangedForCorrection: false,
    correction: 'The first-feedback navigation harness selected a button by index but omitted BMAD from its mode order. It now selects the visible label and asserts that the completed host.activeMode equals the requested destination. The interrupted baseline is retained as incomplete tool evidence; delivery baseline and revision are rerun with the same corrected harness.',
    historicalMetrics: 'Warm navigation and repository search already selected visible labels. The previously measured +11.111% repository-search FAIL remains valid historical evidence and is not reclassified by the first-feedback selector correction.' }],
  preDraftRendererObservation: { baselineArtifact: preDraftBaseline.artifact, revisionArtifact: preDraftUi.artifact,
    baseline: preDraftBaseline.metrics, revision: preDraftUi.metrics, comparison: preDraftUi.comparison,
    firstFeedback: { status: preDraftUi.firstFeedback.status, cases: preDraftUi.firstFeedback.cases.map(({ samples, ...value }) => value) },
    smoke: preDraftUi.smoke.status,
    note: '此中間候選配對量測的本機搜尋回退超過 10%，比較結果為 FAIL；暖切頁與搜尋當時已使用可見 label，原量測 FAIL 不受後來 first-feedback navigation 索引誤點影響。retained heap、舊工具記錄的 8×100 回饋與 smoke 結果保留，但舊 navigation 回饋不作完整驗收。搜尋回退原因尚未證實，後續程式修正與 delivery 新一輪量測不能覆寫本輪失敗，也不構成根因已定位的證據。' },
  initialRendererObservation: { baseline: initialBaseline.metrics, revision: initialUi.metrics, feedback: initialUi.firstFeedback.status, comparison: initialUi.comparison,
    refreshDiagnostic: { artifact: initialRefreshDiagnostic.artifact, status: initialRefreshDiagnostic.firstFeedback?.status,
      cases: initialRefreshDiagnostic.firstFeedback?.cases.map(({ samples, ...value }) => value) },
    note: '舊候選完整量測的 refresh 第 13 次未被量測到可見回饋；同一舊候選獨立 refresh 100 次診斷又通過，原失敗尚未完全重現定位。後續補強按鈕同步 busy/aria/text 與 100 輪回歸，不能以此宣稱舊失敗原因已證實。初次暖切頁 24.6→29.4 ms 的觀測保留，最終另以相鄰時段與同一量測程式比較，不覆寫舊結果。' },
  snapshotBenchmark: snapshots, graphBenchmark: graph,
  nativeGit: { status: native.status, confirmationStatus: confirmations.status, vscodeVersion: native.vscodeVersion, idleChecks,
    guiDecisionPath: { commit: native.gitGui?.commitConfirmation, push: native.gitGui?.pushConfirmation, interactiveConfirmationUI: native.interactiveConfirmationUI },
    standaloneConfirmation: { mode: confirmations.mode, status: confirmations.status, interactiveConfirmationUI: confirmations.interactiveConfirmationUI,
      commit: confirmations.gitGui?.commitConfirmation, push: confirmations.gitGui?.pushConfirmation },
    note: '單次隔離本機 bare remote；五段 extension commands／auxiliaryCommands／nativeApiCalls 增量與 VS Code 自身背景 Git log 分開列。一般 Git 流程決策採 test-adapter，原生確認互動由獨立 standalone Workbench 證據提供；不代表遠端 GitLab 效能或 10 次冷啟動驗收。' },
  nativeGraphWorkers: nativeGraphs.map(value => ({ vscodeVersion: value.vscodeVersion, status: value.status, graphWorker: value.graphWorker, testedArtifact: value.testedArtifact })),
  nativeGraphObservationFailures: nativeGraphObservationFailures.map(value => ({ evidence: value.evidence, status: value.result.status,
    error: value.result.error, testedArtifact: value.result.testedArtifact, validForAcceptance: false, explanation: value.explanation })),
  artifactEquivalence: { evidence: 'evidence/fixture-artifact-equivalence.json', schema: artifactEquivalence.schema, status: artifactEquivalence.status,
    artifact: artifactEquivalence.artifact, checkedFiles: artifactEquivalence.checkedFiles, normalizedFiles: artifactEquivalence.normalizedFiles,
    mismatches: artifactEquivalence.mismatches, scope: artifactEquivalence.scope },
  functionalMatrix: { features: matrix.features.length, completeOfflineScenarios: matrix.features.filter(value => value.offlineStatus === 'passed').length, pendingOfflineScenarios: matrix.features.filter(value => value.offlineStatus === 'pending').length },
  acceptance,
  pending: ['真實 GitLab CE 16.11.10 與其他實機環境的隔離測試帳號／群組讀寫、權限及未知寫入核對。', '各真實環境 10 次冷啟動、每輪 30 次暖切頁與搜尋；含 Extension Host、GitLab 網路及完整峰值記憶體。', '工作台骨架／離線入口 p95 ≤1 秒，以及全部隱藏／取消路徑 ≤1 秒的實機量測。', '矩陣中仍為 pending 的逐項取消、重試、範圍切換或恢復情境；完整測試通過不會自動提升這些狀態。'],
  limitations: ['封裝 Renderer 比較使用 20 Repo 的隔離 mock host，10 個新 Browser context，每輪 30 次暖切頁及搜尋；不是 10 次真實 VS Code 程序冷啟動。', 'Renderer 記憶體是 GC 後 retained heap；不等於 Extension Host 或整個應用程式峰值。', '工作台快照量測涵蓋 50/500/2000 Repo 與 100/1000/10000 Issue，僅量測 host 計算與 JSON 序列化；壓力負載只有 3 筆，未報 p95。', '圖譜比較每負載 3 輪，選取共 90 筆、縮放共 45 筆；2000 節點以 Canvas/Worker 執行，初始掛載仍可出現 >50 ms 長任務。', '早期 sandbox 啟動失敗、舊 fixture 及已修正的回歸失敗保留於原始 optimization 目錄；此報告引用最後完整通過的一輪。']
};
writeFileSync(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const cell = value => {
  const paths = typeof value === 'string' ? value.split(' / ') : [];
  return paths.length && paths.every(filename => /^evidence\/[\w./-]+$/.test(filename))
    ? paths.map(filename => `<a href="${escape(filename)}">${escape(filename)}</a>`).join(' / ') : escape(value);
};
const table = (headers, rows) => `<div class="table${headers.length >= 5 ? ' table-wide' : ''}"${headers.length >= 5 ? ' tabindex="0" role="region" aria-label="可左右捲動的資料表格"' : ''}><table><thead><tr>${headers.map(x => `<th>${escape(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(x => `<td>${cell(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const list = values => `<ul>${values.map(x => `<li>${escape(x)}</li>`).join('')}</ul>`;
const comparison = Object.entries(ui.comparison.metrics).map(([name, value]) => [name, value.baseline, value.revision, `${value.increasePercent}%`, value.status]);
const feedback = ui.firstFeedback.cases.map(value => [value.name ?? value.action ?? value.case, value.sampleCount, value.p95Ms ?? value.firstFeedbackP95Ms, value.status]);
const changes = [
  ['帳號／Group／專案', '登入不等待版本與能力探測；60 秒同範圍快取先呈現、背景更新；範圍／stream 版本拒收舊回覆；切換先清除舊遠端資料；首次 Repo 掃描識別修正。'],
  ['Issue／工時', '核心、權限、日期與討論獨立載入；關聯不再循環讀取；漸進留言 Markdown；共用子任務驗證；工時僅淘汰 posted，未完成容量滿時拒絕新增；欄位先驗證再原子更新。'],
  ['Git／MR／大清單', 'EOF/CRLF 部分暫存以實際 index bytes 驗證；本機查詢不取遠端憑證；四槽 fingerprint；分支、變更、提交檔案與 Diff 虛擬化；超過 1 MiB／20000 行改原生 Diff；MR 展開與捲動保存。'],
  ['取消／未知寫入', 'Clone／同步前置進度、取消／逾時與程序樹清理；API 寫入 30 秒期限、附件 5 分鐘；已開始但結果不明保留 unknown／鎖並要求核對，批次草稿遇 unknown 立即停止，禁止自動重送。'],
  ['草稿／圖譜', '單一草稿保存入口保留最後輸入；穩定 callbacks／keys；>500 節點 Worker 佈局、Canvas 視野裁切、搜尋與鍵盤；原生隱藏銷毀、恢復重建與卸載清理；主題色及高對比。'],
  ['Skills／BMAD／附件', '保留安裝交易復原；BMAD 可取消讀取、內容／解析快取與相關檔案索引，執行和人工確認前重新核對；附件 stat 後串流、50 MiB 上限與取消生命週期。'],
  ['日誌／通知／操作復原', '合併追加和清理、可重建段索引與取消查詢／匯出；通知去重有界；1000 筆記憶體操作歷史與 256 bucket 磁碟收據，保留 active／unknown，重啟核對不重送。'],
  ['工作台傳輸', '初始化／復原完整 snapshot，後續具 scope、stream、baseVersion/version 的 patch；缺版請求 resync；小變更不再重傳大型清單。']
];
writeFileSync(path.join(directory, 'report.html'), `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitLab Workspace 回應時間優化交付</title><style>html{font:16px/1.65 system-ui,"Microsoft JhengHei",sans-serif;color:#213047;background:#f3f5f8}body{max-width:1150px;margin:36px auto;padding:0 24px 64px}h1{font-size:30px;line-height:1.3}h2{font-size:22px;margin-top:36px}p,li{max-width:1050px}a{color:#145cb9}code{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;background:white;font-size:14px}td,th{border:1px solid #ccd5e1;padding:10px;text-align:left;vertical-align:top}th{background:#e8eef7}.table{overflow:auto}.notice{padding:18px;background:#fff1cf;border-left:5px solid #b67b11}.ok{padding:18px;background:#e4f4e9;border-left:5px solid #278150}small{color:#526075}@media(prefers-color-scheme:dark){html{background:#101824;color:#e0e8f3}a{color:#91bfff}table{background:#172335}th{background:#24354c}td,th{border-color:#40516a}.notice{background:#443720}.ok{background:#1b3c2b}small{color:#b4c2d6}}</style><h1>GitLab Workspace 全功能行為與效能優化</h1><p>候選版 0.26.0 · ${escape(report.generatedAt)} · 未發布</p><div class="ok">程式修正、完整離線回歸與兩版 VS Code Host 驗證已完成。請以以下分層證據判讀效能，不將合成測試當作真實 GitLab 結果。</div><p><a href="functional-matrix.html">57 項功能矩陣（可篩選）</a> · <a href="verification.json">機器可讀交付結果</a> · <a href="feature-matrix.json">功能矩陣 JSON</a> · <a href="../../../dist/gitlab-workspace-0.26.0-responsiveness-candidate.vsix">候選 VSIX</a></p><h2>修正與行為</h2>${table(['範圍', '結果'], changes)}<h2>完整回歸與真實 VS Code</h2>${table(['項目', '結果', '證據'], [['最終完整 npm test', `${validation.stages.length} stages PASS；${validation.seconds} 秒`, 'evidence/regression/timings.json'], ['單元測試', `${report.regression.unitPassed}/${report.regression.unitTests} PASS`, 'evidence/regression/unit.log'], ['介面 Node 行為測試', `${report.regression.behaviorPassed}/${report.regression.behaviorTests} PASS；另含 Cucumber`, 'evidence/regression/behavior-node.log'], ['VS Code 1.90.0 / 1.142.0', '各 12 PASS、2 opt-in pending', 'evidence/extension-1.90.log / evidence/regression/extension.log'], ['封裝本機 Git GUI', native.status, 'evidence/git-gui-local.json'], ['原生確認與未知結果核對', confirmations.status, 'evidence/git-gui-local-native.json']])}<p>完整回歸包含兩種型別檢查、資產與離線工具包建置、Extension Host、單元、介面、Cucumber、Python 發布檢查、VSIX 封裝及內容驗證。<a href="evidence/regression/timings.json">各階段紀錄</a>保留實際命令與結束碼。</p><h2>封裝 Renderer 前後比較</h2><p>同機 Chrome ${escape(ui.browserVersion)}，相同 fixture 與量測程式，基線和候選各 10 個新 context ×30 次暖切頁／搜尋。這一層只有 VSIX 資產與 mock host。</p>${table(['量測', '基線', '候選', '增加比例', '≤10%'], comparison)}<p>可見操作回饋：${escape(ui.firstFeedback.status)}；每種操作 100 筆。${escape(ui.smoke.status)}：窄畫面、高對比、鍵盤焦點與介面 smoke。<a href="evidence/packaged-ui-revision.json">完整樣本與定義</a>。</p>${table(['操作', '樣本', 'p95 ms', '結果'], feedback)}<h2>大型工作台快照</h2><p>production sendSnapshot 與真實 JSON 序列化，沒有 renderer、網路、Git 或磁碟 I/O。日常／中型各 30 筆；壓力僅 3 筆，僅報最大值。<a href="evidence/workspace-updates.json">原始結果</a>。</p>${table(['Repo / Issue', '樣本', '基線更新 p95 / max ms', '候選更新 p95 / max ms', '更新總 bytes：基線 → 候選'], snapshots.workloads.map(x => [`${x.repos} / ${x.issues}`, x.sampleCount, `${x.baseline.updateP95Ms ?? '—'} / ${x.baseline.updateMaxMs}`, `${x.revision.updateP95Ms ?? '—'} / ${x.revision.updateMaxMs}`, `${x.baseline.updateBytes} → ${x.revision.updateBytes}`]))}<h2>圖譜實際 Browser 量測</h2><p>每負載 3 輪；以下 p95 由所有選取／縮放樣本合併計算。大型圖譜使用 Worker／Canvas；小型保留 SVG。最後主題修正後已重測候選。<a href="evidence/graph-renderer-final.json">候選原始量測</a>、<a href="evidence/graph-renderer-baseline-idle.json">基線</a>。</p>${table(['節點', '選取 p95 ms 基線 → 候選', '縮放 p95 ms 基線 → 候選', '候選互動 >50 ms 長任務', '初始掛載長任務 ms'], graph.map(x => [x.nodes, `${x.selectionP95BeforeMs} → ${x.selectionP95AfterMs}`, `${x.zoomP95BeforeMs} → ${x.zoomP95AfterMs}`, x.interactionLongTasksAfter, x.mountLongTasksAfterMs.join(', ') || '0']))}<p><a href="evidence/graph-large-final.png">深色圖譜</a> · <a href="evidence/graph-large-light.png">淺色圖譜</a> · <a href="evidence/graph-large-highcontrast.png">高對比</a> · <a href="evidence/graph-visual-check.json">搜尋、Worker、鍵盤與主題驗證</a></p><h2>驗收限制與待驗</h2><div class="notice">缺少專用 GitLab Token；真實 GitLab 寫入與完整實機效能門檻維持待驗。功能矩陣有 ${report.functionalMatrix.completeOfflineScenarios} 項的六種離線情境已齊全，${report.functionalMatrix.pendingOfflineScenarios} 項仍有待驗情境。</div>${list(report.pending)}${list(report.limitations)}<h2>候選與重現</h2><p>候選 SHA256：<code>${report.candidate.sha256}</code><br>基線 commit：<code>${report.baseline.commit}</code><br>基線 SHA256：<code>${report.baseline.artifactSha256}</code><br>候選大小：${report.candidate.bytes} bytes；版本維持 0.26.0，未執行發布。</p><p>重現命令與原始紀錄見 <a href="verification.json">verification.json</a>、<a href="evidence/regression/timings.json">timings.json</a>；圖譜與快照量測程式位於 test/behavior/graph-renderer-benchmark.mjs 與 scripts/benchmark-workspace-updates.cjs。原生測試使用獨立使用者資料、隔離 Repo 與本機 bare remote，沒有對真實 GitLab 寫入。</p><small>報告由 render-report.mjs 依實際結果生成。功能矩陣不因整體套件成功而自動提升未測情境。</small></html>`);
const reportPath = path.join(directory, 'report.html');
const gateTable = `<h2>逐項回應時間門檻</h2>${table(['項目', '目標', '量測', '結果', '適用範圍'], acceptance.map(value => [value.item, value.target, value.measured, value.status, value.scope]))}`;
const screenshotLinks = `<p>封裝畫面：${ui.smoke.screenshots.map(name => `<a href="evidence/${escape(name)}">${escape(name)}</a>`).join(' · ')}</p>`;
const previousObservation = `<p>早期不同時段比較曾觀測暖切頁 24.6→29.4 ms（+19.5%），並在 refresh 第 13 次缺少可見回饋；該輪比較因樣本未齊而 BLOCKED。<a href="evidence/packaged-ui-initial-revision.json">失敗原始資料</a>與<a href="evidence/packaged-ui-initial-baseline.json">早期基線</a>保留。<a href="evidence/packaged-ui-initial-refresh-diagnostic.json">同一舊候選的獨立 refresh 診斷</a>結果為 ${escape(initialRefreshDiagnostic.firstFeedback?.status)}、${escape(initialRefreshDiagnostic.firstFeedback?.cases.find(value => value.action === 'refresh')?.sampleCount)} 筆；原失敗尚未完全重現定位。後續補強按鈕即時 busy／aria／文字狀態與 100 輪回歸，與舊失敗原因是否已定位分開判讀。本報告另列最終候選與相鄰時段基線的完整比較。</p>`;
const preDraftObservation = `<h2>中間候選已完成的配對量測</h2><div class="notice">此輪比較：${escape(preDraftUi.comparison.status)}；本機搜尋增加 ${escape(preDraftUi.comparison.metrics.repoSearchP95Ms.increasePercent)}%，超過 ≤10% 門檻。舊工具記錄的 8×100 操作回饋：${escape(preDraftUi.firstFeedback.status)}（navigation 索引誤點，該項不作完整驗收）；smoke：${escape(preDraftUi.smoke.status)}。暖切頁與搜尋路徑原本已使用可見 label，這次工具修正不會將搜尋 FAIL 改列通過。搜尋回退原因尚未證實，後續修正與交付量測不會覆寫本輪失敗。</div><p>中間候選 SHA256：<code>${escape(preDraftUi.artifact.sha256)}</code>。<a href="evidence/packaged-ui-pre-draft-baseline.json">此輪基線</a> · <a href="evidence/packaged-ui-pre-draft-revision.json">此輪候選完整樣本</a>。上方交付結果另讀 delivery 目錄，與此歷史結果分開。</p>${table(['量測', '此輪基線', '中間候選', '增加比例', '≤10%'], Object.entries(preDraftUi.comparison.metrics).map(([name, value]) => [name, value.baseline, value.revision, `${value.increasePercent}%`, value.status]))}`;
const harnessCorrection = `<p>本輪發現 first-feedback navigation 的量測工具以按鈕索引選頁，模式順序卻漏列 BMAD，造成誤點。工具已改用可見 label，並斷言操作完成後 host.activeMode 等於目的模式。<a href="evidence/packaged-ui-selector-interrupted.log">原中斷 baseline log</a>保留為工具失敗紀錄，不能作完整驗收；交付基線與候選以相同修正後工具重跑。此次選擇器修正未變更產品 source，另重做 prepare／package；warm navigation 與搜尋本來就以 label 選頁，歷史搜尋 +11.111% 的 FAIL 照實保留。</p>`;
const nativeIdleSection = `<h2>本機 Git 閒置與確認方式</h2><p>五個階段各閒置至少 60 秒，extension 的 commands、auxiliaryCommands、nativeApiCalls 增量逐項列於下表。VS Code 自身背景 Git log 獨立記錄；hidden 階段新增 ${escape(idleChecks.find(value => value.phase === 'hidden')?.vscodeGitLog?.backgroundDelta ?? '未記錄')} 筆，因此不宣稱整個 VS Code 都沒有 Git 活動。</p>${table(['階段', '閒置秒數', 'Extension commands', 'Extension auxiliaryCommands', 'Extension nativeApiCalls', 'VS Code 背景 Git log 增量'], idleChecks.map(value => [value.phase, (value.idleMs / 1000).toFixed(3), value.extensionDelta?.commands ?? '未記錄', value.extensionDelta?.auxiliaryCommands ?? '未記錄', value.extensionDelta?.nativeApiCalls ?? '未記錄', value.vscodeGitLog?.backgroundDelta ?? '未記錄']))}<p>一般 Git GUI 流程採用的決策路徑：Commit ${escape(native.gitGui?.commitConfirmation)}、Push ${escape(native.gitGui?.pushConfirmation)}。原生確認互動另由 standalone Workbench 驗證：Commit ${escape(confirmations.gitGui?.commitConfirmation)}、Push ${escape(confirmations.gitGui?.pushConfirmation)}，結果 ${escape(confirmations.status)}。<a href="evidence/git-gui-local.json">五段閒置與一般 Git 流程</a> · <a href="evidence/git-gui-local-native.json">standalone 原生確認與未知結果核對</a>。</p>`;
const hosts = report.regression.extensionHost.map(value => `${value.vscode}：${value.passed} PASS、${value.pending} opt-in pending`).join('；');
const nativeGraphTable = `<h2>真實 VS Code 圖譜 Worker</h2>${table(['VS Code', '結果', '驗證範圍'], nativeGraphs.map(value => [value.vscodeVersion, value.status, '正式 Dashboard、2000 節點／4000 有限座標、Blob URI、detach guest debugger 後原 iframe 仍存在、hide 後精確 targetDestroyed 且原 ID 消失、恢復新 target／context／Worker、切回清單全部 terminate、無 GitLab API']))}<p><a href="evidence/worker-1.90-verified/git-gui-local.json">1.90 通過原始證據</a> · <a href="evidence/worker-1.90-verified/native-graph-worker-lifecycle-target-events.json">1.90 原始 target 事件</a> · <a href="evidence/local-graph-worker-report.json">1.142 通過原始證據</a> · <a href="evidence/native-graph-worker-lifecycle-target-events.json">1.142 原始 target 事件</a> · <a href="evidence/graph-worker-smoke.json">嚴格 Blob CSP smoke</a>。產品維持 VS Code 預設的隱藏時銷毀 Webview 生命週期。</p>${table(['歷史觀測', '原結果', '原始證據', '判讀'], nativeGraphObservationFailures.map((value, index) => [index + 1, value.result.status, value.evidence, value.explanation]))}<p><a href="evidence/worker-1.90-final/native-graph-worker-failure.json">第一次詳細紀錄</a> · <a href="evidence/worker-1.90-delivery/native-graph-worker-failure.json">第二次詳細紀錄</a>。兩次失敗均保留；後續只調整 fixture，改以獨立 browser CDP 驗證精確 iframe target 的實際銷毀與重建，不宣稱產品因此修正。<a href="evidence/fixture-artifact-equivalence.json">fixture 重編譯後的逐檔等價證據</a>：${artifactEquivalence.checkedFiles} 個 VSIX extension/ 檔案核對為 ${escape(artifactEquivalence.status)}；執行檔與資源位元組一致，README 僅套用明列的 VSCE 文件連結轉換。套件 SHA256 維持 <code>${escape(artifactEquivalence.artifact.sha256)}</code>。</p>`;
const rendererPassed = ui.comparison.status === 'PASS' && ui.firstFeedback.status === 'PASS' && ui.smoke.status === 'PASS';
const summary = `<div class="${rendererPassed ? 'ok' : 'notice'}">分階段離線回歸：${escape(report.regression.status)}；原生 Git GUI：${escape(native.status)}；原生確認：${escape(confirmations.status)}；兩版原生圖譜：${nativeGraphs.map(value => `${escape(value.vscodeVersion)} ${escape(value.status)}`).join('／')}。Renderer 前後比較：${escape(ui.comparison.status)}；操作回饋：${escape(ui.firstFeedback.status)}；介面 smoke：${escape(ui.smoke.status)}。真實 GitLab 與完整原生效能門檻仍待驗。</div>`;
writeFileSync(reportPath, readFileSync(reportPath, 'utf8').replaceAll('最終完整 npm test', '最終分階段完整驗證').replaceAll('各 12 PASS、2 opt-in pending', escape(hosts)).replace('各階段紀錄</a>保留實際命令與結束碼。', '各階段紀錄</a>保留實際命令、來源批次與結束碼；秒數是各階段加總，包含平行工作，不是總牆鐘時間。最終 UI 回饋修正後重跑 behavior／Host／package；未改動的後端保留 497 項 unit 檢查，工具套件保留完整 release 檢查，並以相同工具包 SHA256 核對。').replace('<h2>驗收限制與待驗</h2>', gateTable + '<h2>驗收限制與待驗</h2>').replace('<h2>大型工作台快照</h2>', previousObservation + screenshotLinks + '<h2>大型工作台快照</h2>').replace('<h2>候選與重現</h2>', '<p>Worker 採用 Blob 載入以符合 <a href="https://code.visualstudio.com/api/extension-guides/webview#using-web-workers">VS Code Webview 官方限制</a>，另有嚴格 CSP smoke 與實際原生 Webview 驗證。</p><h2>候選與重現</h2>'));
writeFileSync(`${artifact}.sha256`, `${report.candidate.sha256}  ${path.basename(artifact)}\n`);
const finalHtml = readFileSync(reportPath, 'utf8').replace(/<div class="ok">[\s\S]*?<\/div>/, summary)
  .replace('</style>', '.table-wide:focus-visible{outline:2px solid #145cb9;outline-offset:2px}@media(max-width:600px){.table-wide::before{content:"表格可左右捲動 →";display:block;font-size:12px;margin-bottom:6px}.table-wide table{min-width:860px}}<\/style>')
  .replace('<h1>GitLab Workspace 全功能行為與效能優化</h1>', '<h1>GitLab Workspace 功能行為與回應時間優化報告</h1>')
  .replace('57 項功能矩陣（可篩選）', `${report.functionalMatrix.features} 項功能矩陣（可篩選）`)
  .replace('<h2>封裝 Renderer 前後比較</h2>', nativeIdleSection + '<h2>封裝 Renderer 前後比較</h2>' + harnessCorrection)
  .replace('<h2>大型工作台快照</h2>', preDraftObservation + '<h2>大型工作台快照</h2>')
  .replace('<h2>驗收限制與待驗</h2>', nativeGraphTable + '<h2>驗收限制與待驗</h2>');
for (const [, href] of finalHtml.matchAll(/href="([^"]+)"/g)) {
  if (/^(?:https?:|#)/.test(href)) continue;
  requireEvidence(existsSync(path.resolve(directory, href)), `The delivery report would contain a missing local link: ${href}`);
}
writeFileSync(reportPath, finalHtml);
console.log(JSON.stringify({ report: reportPath, regression: report.regression, candidate: report.candidate, renderer: ui.comparison.status, nativeGit: report.nativeGit.status, nativeConfirmations: report.nativeGit.confirmationStatus }, null, 2));
