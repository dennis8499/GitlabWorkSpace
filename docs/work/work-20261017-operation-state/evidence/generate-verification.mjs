// Evidence-only verifier. Run after final-v3, both formal benchmarks, both GUI
// runs and visual-qa-v3.json are complete. No build, test, network or Git action.
// Missing or inconsistent evidence writes FAIL_LOCAL_VALIDATION and exits 1.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fingerprint, preparationInputs } from '../../../../scripts/validation-runtime.mjs';

const evidenceDir = path.dirname(fileURLToPath(import.meta.url));
const workDir = path.resolve(evidenceDir, '..');
const repoDir = path.resolve(evidenceDir, '../../../..');
const outputFile = path.join(workDir, 'verification.json');
const validationDir = 'evidence/validation-v3';
const originalBaselineSha = 'dd1194e9266441f25c66d2355cc487890d5e38cb4eb90d17a93868eae18433dd';
const expectedActions = ['navigation', 'issue-selection', 'mr-selection', 'refresh', 'skills-check', 'account-submit', 'git-read', 'git-write'];
const metricNames = ['warmNavigationP95Ms', 'repoSearchP95Ms', 'rendererRetainedHeapP95Bytes', 'rendererRetainedHeapMaxBytes'];
const requiredStages = ['compile', 'typecheck-webview', 'build-dashboard', 'build-sidebar', 'build-kit', 'build-issue-tests',
  'extension', 'unit', 'behavior-node', 'behavior-issues', 'behavior-connect', 'release-tooling', 'package', 'verify-package'];
const expectedPreparedOutputs = ['out', 'out/src/extension.js', 'resources/issue-webview', 'resources/sidebar-webview',
  'resources/issue-webview/dashboard.js', 'resources/sidebar-webview/sidebar.js', 'resources/offline-tools/workflow-kit.tar.xz',
  'resources/offline-tools/manifest.json', 'dist/gitlab-workspace-kit-0.25.0.zip', 'resources/issue-webview/issue-test.js'];
const checks = [];
const manifest = new Map();
const textCache = new Map();
const summaries = {};
const slash = value => value.replaceAll('\\', '/');
const digest = value => createHash('sha256').update(value).digest('hex');
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const gitSha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const empty = value => Array.isArray(value) && value.length === 0;
const p95 = values => Number([...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]?.toFixed(3));

function check(id, condition, reason = 'Required evidence is missing or inconsistent.') {
  checks.push({ id, status: condition ? 'PASS' : 'FAIL', ...(condition ? {} : { reason }) });
  return Boolean(condition);
}
function safeWorkPath(relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) return undefined;
  const absolute = path.resolve(workDir, relative);
  const resolved = path.relative(workDir, absolute);
  return resolved && !resolved.startsWith('..') && !path.isAbsolute(resolved) ? absolute : undefined;
}
async function readEvidence(relative, id = relative) {
  const absolute = safeWorkPath(relative);
  if (!absolute) { check(`input:${id}`, false, 'Evidence path must remain inside this work directory.'); return undefined; }
  if (textCache.has(absolute)) return textCache.get(absolute);
  try {
    const bytes = await readFile(absolute);
    const result = { text: bytes.toString('utf8').replace(/^\uFEFF/, ''), sha256: digest(bytes), bytes: bytes.length };
    textCache.set(absolute, result);
    manifest.set(slash(path.relative(repoDir, absolute)), { sha256: result.sha256, bytes: result.bytes });
    check(`input:${id}`, bytes.length > 0, 'Evidence file is empty.');
    return result;
  } catch {
    check(`input:${id}`, false, 'Evidence file is missing or unreadable.');
    return undefined;
  }
}
async function jsonEvidence(relative, id) {
  const input = await readEvidence(relative, id);
  if (!input) return undefined;
  try {
    const value = JSON.parse(input.text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Object required');
    return value;
  } catch { check(`json:${id}`, false, 'Evidence is not a JSON object.'); return undefined; }
}
async function artifact(relative, id) {
  const absolute = path.resolve(repoDir, relative);
  try {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(absolute)) { hash.update(chunk); bytes += chunk.length; }
    const result = { path: slash(relative), bytes, sha256: hash.digest('hex') };
    check(`artifact:${id}`, bytes > 0);
    return result;
  } catch { check(`artifact:${id}`, false, 'Artifact is missing or unreadable.'); return undefined; }
}
function cleanLog(text = '') { return text.replace(/\x1b\[[0-9;]*m/g, '').replaceAll('\r', ''); }
function last(text, expression) { return [...text.matchAll(expression)].at(-1); }
function nodeCounts(text, id) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const found = last(cleanLog(text), new RegExp(`^(?:ℹ|#)\\s+${key}\\s+(\\d+)\\s*$`, 'gm'));
    counts[key] = found ? Number(found[1]) : undefined;
  }
  check(`suite:${id}`, positive(counts.tests) && counts.pass === counts.tests &&
    ['fail', 'cancelled', 'skipped', 'todo'].every(key => counts[key] === 0), 'Suite totals must be present, complete and all passing.');
  return counts;
}
function cucumberCounts(text, id) {
  const log = cleanLog(text);
  const result = {};
  for (const kind of ['scenarios', 'steps']) {
    const found = last(log, new RegExp(`^(\\d+) ${kind} \\(([^\\n]*)\\)\\s*$`, 'gm'));
    const passed = found?.[2].match(/^(\d+) passed$/);
    result[kind] = found ? Number(found[1]) : undefined;
    check(`suite:${id}:${kind}`, positive(result[kind]) && Number(passed?.[1]) === result[kind], 'BDD summary must contain passing totals only.');
  }
  return result;
}

async function verifyFullRun() {
  const timings = await jsonEvidence(`${validationDir}/timings.json`, 'timings');
  const prepared = await jsonEvidence(`${validationDir}/prepared.json`, 'prepared');
  check('full-run:complete', timings?.schema === 'gitlab-workspace-validation/v1' && timings.mode === 'all' &&
    timings.status === 'success' && timings.success === true && positive(timings.seconds) && positive(timings.workers), 'A completed successful mode=all run is required.');
  const validPrepared = check('full-run:prepared', prepared?.schema === 'gitlab-workspace-prepared/v1' && sha256(prepared.inputs) && sha256(prepared.outputSha256) &&
    ['compile', 'webview', 'kit', 'issue'].every(stage => prepared.stages?.includes(stage)), 'A complete preparation receipt is required.');
  const outputs = Array.isArray(prepared?.outputs) ? prepared.outputs : [];
  const validOutputs = check('full-run:prepared-output-paths', outputs.length === expectedPreparedOutputs.length && new Set(outputs).size === outputs.length &&
    expectedPreparedOutputs.every(output => outputs.includes(output)) && outputs.every(output => {
      if (typeof output !== 'string' || !expectedPreparedOutputs.includes(output) || path.isAbsolute(output) || path.win32.isAbsolute(output)) return false;
      const relative = path.relative(repoDir, path.resolve(repoDir, output));
      return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }), 'Preparation outputs must be the exact release allowlist of paths inside this repository.');
  let currentInputs, currentOutputs;
  if (validPrepared && validOutputs) {
    try {
      // fingerprint rejects symlinks and only reads bytes. Work evidence is
      // excluded by preparationInputs, matching the actual build receipt.
      [currentInputs, currentOutputs] = await Promise.all([
        fingerprint(repoDir, preparationInputs()), fingerprint(repoDir, outputs)
      ]);
    } catch (error) { check('full-run:prepared-freshness-readable', false, `Current preparation files cannot be fingerprinted (${error?.name ?? 'Error'}).`); }
  }
  check('full-run:prepared-fresh-inputs', sha256(currentInputs) && currentInputs === prepared?.inputs, 'Current source inputs must match the completed full-run preparation receipt.');
  check('full-run:prepared-fresh-outputs', sha256(currentOutputs) && currentOutputs === prepared?.outputSha256, 'Current compiled/package outputs must match the completed full-run preparation receipt.');
  const stages = Array.isArray(timings?.stages) ? timings.stages : [];
  check('full-run:stages', stages.length > 0 && new Set(stages.map(stage => stage.id)).size === stages.length &&
    requiredStages.every(id => stages.some(stage => stage.id === id)) && stages.every(stage => stage.exitCode === 0 && !stage.signal), 'All required stages must be present, unique, completed and exit 0.');
  const logs = new Map();
  for (const stage of stages) {
    if (!/^[a-z][a-z0-9_-]*$/.test(stage.id ?? '')) { check('full-run:stage-id', false); continue; }
    const input = await readEvidence(`${validationDir}/${stage.id}.log`, `stage:${stage.id}`);
    logs.set(stage.id, input?.text ?? '');
  }
  summaries.fullRun = { status: timings?.status, seconds: timings?.seconds, workers: timings?.workers,
    sourceRun: '.gitlab-workspace-validation/runs/2026-10-17-operation-state-final-v3',
    inputFingerprint: prepared?.inputs, outputFingerprint: prepared?.outputSha256,
    currentInputFingerprint: currentInputs, currentOutputFingerprint: currentOutputs,
    stages: stages.map(stage => ({ id: stage.id, exitCode: stage.exitCode, seconds: stage.seconds })) };
  summaries.suites = { unit: nodeCounts(logs.get('unit'), 'unit'), browser: nodeCounts(logs.get('behavior-node'), 'browser'),
    releaseTooling: nodeCounts(logs.get('release-tooling'), 'release-tooling'),
    issueBdd: cucumberCounts(logs.get('behavior-issues'), 'issue-bdd'), connectBdd: cucumberCounts(logs.get('behavior-connect'), 'connect-bdd') };
  const host = cleanLog(logs.get('extension'));
  const passing = Number(last(host, /^\s*(\d+) passing(?:\s|$)/gm)?.[1]);
  const pending = Number(last(host, /^\s*(\d+) pending(?:\s|$)/gm)?.[1]);
  check('suite:host', positive(passing) && pending === 2 && !/^\s*[1-9]\d* failing(?:\s|$)/m.test(host), 'Host must pass with exactly the two documented opt-in pending cases.');
  summaries.suites.host = { passing: Number.isFinite(passing) ? passing : undefined, optInPending: Number.isFinite(pending) ? pending : undefined,
    warnings: { invalidModelForLabelChange: [...host.matchAll(/Invalid\s*model\s*for\s*label\s*change/gi)].length,
      fileWatcherEperm: [...host.matchAll(/^.*(?:file.?watcher|fs\.watch).*EPERM.*$/gim)].length,
      utilityCrash: [...host.matchAll(/^.*(?:UtilityProcess|fileWatcher).*crash.*$/gim)].length,
      warningOrErrorLines: [...host.matchAll(/^.*(?:\bwarn(?:ing)?\b|\berror\b|EPERM|crashed|Invalid\s*model).*$/gim)].length } };
  const pythonStages = stages.filter(stage => stage.id?.startsWith('release-') && stage.id !== 'release-tooling');
  check('suite:python-suite-count', pythonStages.length === 14, 'All 14 Python release suites must be represented.');
  const python = pythonStages.map(stage => {
    const log = cleanLog(logs.get(stage.id));
    const ran = last(log, /^Ran (\d+) tests? in [^\n]+$/gm);
    const ok = last(log, /^OK(?: \(skipped=(\d+)\))?\s*$/gm);
    const tests = ran ? Number(ran[1]) : undefined;
    const skipped = ok ? Number(ok[1] ?? 0) : undefined;
    const allowedSkip = skipped === 0 || stage.id === 'release-output_style' && skipped === 1 && /Symbolic links are unavailable.*WinError 1314/.test(log);
    check(`suite:${stage.id}`, positive(tests) && Boolean(ok) && !/^FAILED\b/m.test(log) && allowedSkip, 'Python suite must be OK; only the documented WinError 1314 symlink skip is permitted.');
    return { id: stage.id, tests, passed: tests === undefined || skipped === undefined ? undefined : tests - skipped, skipped };
  });
  const sum = key => python.reduce((total, suite) => total + (suite[key] ?? 0), 0);
  summaries.suites.python = { suites: python.length, tests: sum('tests'), passed: sum('passed'), skipped: sum('skipped'),
    skipReason: sum('skipped') ? 'Windows symbolic-link privilege unavailable (WinError 1314).' : undefined, breakdown: python };
  check('suite:python-documented-skip', sum('skipped') === 1, 'The expected single documented symlink skip must be explicitly accounted for.');
}

async function verifyPerformance(vsix, baselineArtifact) {
  const baseline = await jsonEvidence('evidence/baseline-v3/baseline.json', 'baseline-v3');
  const revision = await jsonEvidence('evidence/revision-v3/revision.json', 'revision-v3');
  const harness = await readEvidence('evidence/harness-v2.mjs', 'formal-harness');
  check('performance:artifact-identity', sha256(vsix?.sha256) && revision?.artifact?.sha256 === vsix.sha256 &&
    baseline?.artifact?.sha256 === baselineArtifact?.sha256 && baselineArtifact?.sha256 === originalBaselineSha && vsix.sha256 !== baselineArtifact.sha256,
  'Formal reports must identify the current VSIX and immutable original baseline.');
  check('performance:paired-method', baseline?.schema === 'GitLabWorkspacePackagedUiVerification/v2' && revision?.schema === baseline.schema &&
    baseline?.measurement?.methodVersion === 'browser-capture-readiness/v2' && revision?.measurement?.methodVersion === baseline.measurement.methodVersion &&
    sha256(baseline?.fixtureSha256) && baseline.fixtureSha256 === revision.fixtureSha256 &&
    baseline?.harnessSha256 === harness?.sha256 && revision?.harnessSha256 === harness?.sha256 &&
    typeof baseline?.browserVersion === 'string' && baseline.browserVersion === revision?.browserVersion &&
    JSON.stringify(baseline?.measurement) === JSON.stringify(revision?.measurement) && JSON.stringify(baseline?.platform) === JSON.stringify(revision?.platform),
  'Both artifacts must use the same recorded harness, fixture, browser, platform and measurement method.');
  check('performance:fixed-feedback-method', [baseline, revision].every(report => report?.measurement?.firstFeedback?.samplesPerAction === 100 &&
    report.measurement.firstFeedback.limitP95Ms === 100 && report.measurement.firstFeedback.mockAcknowledgementDelayMs === 160 &&
    report.measurement.firstFeedback.mockCompletionDelayMs === 220), 'Both reports must retain the fixed 100-sample/100ms feedback contract and 160ms/220ms mock delays.');
  for (const [role, report] of [['baseline', baseline], ['revision', revision]]) {
    const rounds = Array.isArray(report?.rounds) ? report.rounds : [];
    check(`performance:${role}:rounds`, report?.measurement?.rounds === 10 && report?.measurement?.samplesPerRound === 30 && rounds.length === 10 &&
      rounds.every((round, index) => round.round === index + 1) &&
      rounds.every(round => round.warmNavigationMs?.samples?.length === 30 && round.repoSearchMs?.samples?.length === 30 &&
        round.warmNavigationMs.samples.every(positive) && round.repoSearchMs.samples.every(positive) &&
        round.rendererHeap?.length === 3 && round.rendererHeap.every(sample => positive(sample.usedSize)) &&
        empty(round.runtimeErrors) && empty(round.blockedNetworkRequests) && empty(round.mockedRequests?.unexpected)), 'Exactly 10×30 complete navigation and search samples with zero runtime/network/unexpected-request errors are required.');
    const rawHeap = rounds.flatMap(round => round.rendererHeap?.map(sample => sample.usedSize) ?? []);
    check(`performance:${role}:raw-metrics`, report?.metrics?.warmNavigationP95Ms === p95(rounds.flatMap(round => round.warmNavigationMs?.samples ?? [])) &&
      report?.metrics?.repoSearchP95Ms === p95(rounds.flatMap(round => round.repoSearchMs?.samples ?? [])) &&
      report?.metrics?.rendererRetainedHeapP95Bytes === p95(rawHeap) && report?.metrics?.rendererRetainedHeapMaxBytes === Math.max(...rawHeap),
    'Summary metrics must agree with the actual raw samples.');
    const cases = Array.isArray(report?.firstFeedback?.cases) ? report.firstFeedback.cases : [];
    check(`performance:${role}:feedback`, cases.length === expectedActions.length && new Set(cases.map(item => item.action)).size === expectedActions.length &&
      expectedActions.every(action => cases.some(item => item.action === action)) && cases.every(item => item.sampleCount === 100 && item.requiredSamples === 100 && item.samples?.length === 100 &&
        item.samples.every(sample => positive(sample.firstFeedbackMs) && positive(sample.mockCompletionMs)) &&
        item.firstFeedbackP95Ms === p95(item.samples.map(sample => sample.firstFeedbackMs)) && item.mockCompletionP95Ms === p95(item.samples.map(sample => sample.mockCompletionMs)) &&
        ['PASS', 'FAIL'].includes(item.status) && positive(item.firstFeedbackP95Ms) && positive(item.mockCompletionP95Ms) && empty(item.runtimeErrors) && empty(item.blockedNetworkRequests)),
    'All eight actions must have 100 actual samples; baseline threshold failures remain recorded, while incomplete/error cases are rejected.');
    check(`performance:${role}:smoke`, report?.smoke?.status === 'PASS' && report.smoke.checks?.length === 8 && report.smoke.checks.every(item => item.status === 'PASS') &&
      empty(report.smoke.runtimeErrors) && empty(report.smoke.blockedNetworkRequests), 'All eight smoke checks must pass without runtime or network errors.');
  }
  check('performance:revision-feedback-gate', revision?.firstFeedback?.status === 'PASS' && revision.firstFeedback.cases?.every(item => item.status === 'PASS' && item.firstFeedbackP95Ms <= 100), 'Every revision action must pass the 100ms P95 target.');
  check('performance:comparison-gate', revision?.comparison?.status === 'PASS' && metricNames.every(name => {
    const comparison = revision.comparison.metrics?.[name];
    const base = baseline?.metrics?.[name], value = revision?.metrics?.[name];
    const increase = (value / base - 1) * 100;
    return positive(base) && positive(value) && comparison?.status === 'PASS' && comparison.baseline === base && comparison.revision === value &&
      comparison.limitPercent === 10 && Number.isFinite(comparison.increasePercent) && Math.abs(comparison.increasePercent - increase) <= 0.002 && increase <= 10;
  }), 'All four independently recomputed comparison metrics must agree and stay within 10%.');
  const sampleCounts = report => ({ firstFeedback: report?.firstFeedback?.cases?.reduce((total, item) => total + (item.sampleCount ?? 0), 0),
    navigation: report?.rounds?.reduce((total, round) => total + (round.warmNavigationMs?.samples?.length ?? 0), 0),
    search: report?.rounds?.reduce((total, round) => total + (round.repoSearchMs?.samples?.length ?? 0), 0) });
  const selectedMetrics = report => Object.fromEntries(metricNames.map(name => [name, report?.metrics?.[name]]));
  summaries.performance = { methodVersion: revision?.measurement?.methodVersion, harnessSha256: revision?.harnessSha256,
    fixtureSha256: revision?.fixtureSha256, browserVersion: revision?.browserVersion,
    samplesPerArtifact: { baseline: sampleCounts(baseline), revision: sampleCounts(revision) },
    smokeChecks: { baseline: baseline?.smoke?.checks?.length, revision: revision?.smoke?.checks?.length },
    baselineMetrics: selectedMetrics(baseline), revisionMetrics: selectedMetrics(revision),
    comparison: Object.fromEntries(metricNames.map(name => [name, revision?.comparison?.metrics?.[name]])),
    firstFeedback: expectedActions.map(action => { const base = baseline?.firstFeedback?.cases?.find(item => item.action === action); const value = revision?.firstFeedback?.cases?.find(item => item.action === action);
      return { action, baselineP95Ms: base?.firstFeedbackP95Ms, revisionP95Ms: value?.firstFeedbackP95Ms, baselineMockCompletionP95Ms: base?.mockCompletionP95Ms, revisionMockCompletionP95Ms: value?.mockCompletionP95Ms }; }),
    limit: 'Fixed mock acknowledgement 160ms/completion 220ms; no claim about real GitLab/network completion.' };
  return { baseline, revision };
}

async function verifyRegularFixtureDriver() {
  const relativeDriver = 'evidence/git-gui-final-v5/fixture-driver.mjs';
  const correction = await jsonEvidence('evidence/git-gui-final-v5/fixture-scope-correction.json', 'regular-fixture-correction');
  const driver = await readEvidence(relativeDriver, 'regular-fixture-driver');
  const canonicalPath = 'scripts/run-live-extension-tests.mjs';
  let canonical;
  try {
    const bytes = await readFile(path.join(repoDir, canonicalPath));
    canonical = { text: bytes.toString('utf8'), sha256: digest(bytes), bytes: bytes.length };
    manifest.set(canonicalPath, { sha256: canonical.sha256, bytes: canonical.bytes });
  } catch { check('regular-fixture:canonical-readable', false, 'The frozen canonical driver must remain readable.'); }
  const expectedReplacements = [
    { kind: 'root', from: "const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');", to: `const ROOT = ${JSON.stringify(repoDir)};` },
    { kind: 'helper-import', from: "import { compareLiveBenchmarks } from './live-benchmark-comparison.mjs';",
      to: `import { compareLiveBenchmarks } from ${JSON.stringify(pathToFileURL(path.join(repoDir, 'scripts/live-benchmark-comparison.mjs')).href)};` },
    { kind: 'helper-import', from: "import { sameFilesystemPath, createLiveTestProfile } from './live-test-paths.mjs';",
      to: `import { sameFilesystemPath, createLiveTestProfile } from ${JSON.stringify(pathToFileURL(path.join(repoDir, 'scripts/live-test-paths.mjs')).href)};` },
    { kind: 'workspace-folder', from: "writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: repository }] }, null, 2), 'utf8');",
      to: "writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: workspaceRoot }] }, null, 2), 'utf8');" }
  ];
  let expectedDriver = canonical?.text;
  for (const replacement of expectedReplacements) {
    const count = expectedDriver?.split(replacement.from).length - 1;
    check(`regular-fixture:canonical-replacement:${replacement.kind}:${expectedReplacements.indexOf(replacement)}`, count === 1,
      'Each allowed fixture correction must occur exactly once in the canonical driver.');
    if (count === 1) expectedDriver = expectedDriver.replace(replacement.from, replacement.to);
  }
  check('regular-fixture:exact-corrected-driver', typeof expectedDriver === 'string' && driver?.sha256 === digest(Buffer.from(expectedDriver, 'utf8')),
    'The docs-only driver may change only ROOT, the two canonical helper imports and the owned demo workspace boundary.');
  const replacements = Array.isArray(correction?.replacements) ? correction.replacements : [];
  check('regular-fixture:manifest', correction?.schema === 'WorkspaceScopeFixtureCorrection/v1' && correction.status === 'PREPARED' &&
    correction.formalAcceptance === true && correction.fullRunRequired === true && correction.canonical?.path === canonicalPath &&
    correction.corrected?.path === slash(path.relative(repoDir, safeWorkPath(relativeDriver))) &&
    correction.canonical?.sha256 === canonical?.sha256 && correction.canonical?.bytes === canonical?.bytes &&
    correction.corrected?.sha256 === driver?.sha256 && correction.corrected?.bytes === driver?.bytes &&
    replacements.length === expectedReplacements.length && expectedReplacements.every(expected => replacements.filter(item => item.kind === expected.kind && item.count === 1 &&
      typeof item.from === 'string' && item.from.trim() === expected.from && typeof item.to === 'string' && item.to.trim() === expected.to).length === 1),
  'The preparation manifest must match both actual driver hashes and exactly the independently allowed corrections.');
  const failureInput = await readEvidence('evidence/git-gui-final-v4/git-gui-local.json', 'preserved-regular-v4-failure');
  check('regular-fixture:preserved-failure', correction?.failureEvidence?.status === 'FAIL' && correction.failureEvidence.sha256 === failureInput?.sha256,
    'The previous boundary failure must remain preserved at its recorded content hash.');
  summaries.regularFixture = { canonicalDriverSha256: canonical?.sha256, correctedDriverSha256: driver?.sha256,
    correction: 'Only docs-driver relocation and the owned demo workspace boundary change; canonical source, compiled tests, VSIX and five 60-second idle checks are unchanged.' };
}

async function verifyRegularGui(vsix) {
  await verifyRegularFixtureDriver();
  const gui = await jsonEvidence('evidence/git-gui-final-v5/git-gui-local.json', 'regular-gui');
  check('regular-gui:status-artifact', gui?.status === 'PASS' && gui.mode === 'local-only' && gui.vscodeVersion === '1.90.0' && gui.remoteKind === 'isolated-local-bare-repository' &&
    sha256(vsix?.sha256) && gui.testedArtifact?.sha256 === vsix.sha256 && gui.gitGui?.committed === true && gui.gitGui?.pushedWithUpstream === true, 'Regular local GUI must pass on VS Code 1.90 using the current VSIX and isolated local remote.');
  const idle = Array.isArray(gui?.idleChecks) ? gui.idleChecks : [];
  const phases = ['open', 'select-file', 'stage', 'commit', 'hidden'];
  check('regular-gui:five-idle-phases', idle.length === phases.length && phases.every(phase => idle.filter(item => item.phase === phase).length === 1) && idle.every(item => item.idleMs >= 60_000 &&
    ['commands', 'auxiliaryCommands', 'nativeApiCalls'].every(key => item.extensionDelta?.[key] === 0 && typeof item.before?.[key] === 'number' && item.after?.[key] === item.before[key])),
  'All five 60-second phases must record zero extension command/API deltas; native VS Code background logs are reported separately.');
  const compatibility = ['tags', 'detachedHead', 'emptyRepo', 'rapidRepoSwitching', 'worktree', 'submodule', 'hiddenRestoredDraft'];
  check('regular-gui:compatibility', compatibility.every(name => gui?.compatibility?.[name] === 'PASS'), 'Every recorded compatibility and hidden restoration check must pass.');
  const unknown = gui?.gitGui?.advancedActions?.forceWithLease?.unknownOutcome;
  check('regular-gui:unknown-held', unknown?.terminalStatus === 'failed' && unknown.effect === 'unknown' && unknown.ui?.writeBlocked === true && unknown.ui?.readAllowed === true &&
    unknown.refreshAllowedWithoutResend === true && unknown.writeLockRetained === true && unknown.pushStartsUnchanged === true &&
    unknown.confirmationValidation === 'separate-standalone-native-run' && gitSha(unknown.localHeadBefore) && unknown.localHeadBefore === unknown.rejectedLocalHead &&
    gitSha(unknown.raceCommit) && unknown.raceCommit === unknown.rejectedRemoteSha, 'The final regular lease-race check must retain its unknown lock, allow reads, preserve both heads and avoid resending Push.');
  summaries.regularGui = { status: gui?.status, vscodeVersion: gui?.vscodeVersion,
    compatibility: Object.fromEntries(compatibility.map(name => [name, gui?.compatibility?.[name]])),
    idleChecks: idle.map(item => ({ phase: item.phase, idleMs: item.idleMs, extensionDelta: item.extensionDelta, nativeGitBackgroundDelta: item.vscodeGitLog?.backgroundDelta })),
    unknownWrite: { effect: unknown?.effect, writeLockRetained: unknown?.writeLockRetained, refreshAllowedWithoutResend: unknown?.refreshAllowedWithoutResend,
      manualConfirmation: 'Covered separately by the standalone native GUI run.' } };
  return gui;
}

async function verifyNativeGui(vsix) {
  const native = await jsonEvidence('evidence/git-gui-native-v3/git-gui-local-native.json', 'native-gui');
  const unknown = native?.gitGui?.unknownWrite;
  check('native-gui:status-artifact', native?.status === 'PASS' && native.mode === 'local-only-native-confirmation' && native.vscodeVersion === '1.142.0' &&
    native.remoteKind === 'isolated-local-bare-repository' && sha256(vsix?.sha256) && native.testedArtifact?.sha256 === vsix.sha256 && native.interactiveConfirmationUI === 'PASS' &&
    native.gitGui?.commitConfirmation === 'workbench-dom' && native.gitGui?.pushConfirmation === 'workbench-dom', 'Native confirmation must pass against the current VSIX through real Workbench DOM.');
  const counts = unknown?.pushCounts;
  check('native-gui:unknown-manual-resolution', unknown?.status === 'PASS' && unknown.stage === 'manual-result-confirmed' &&
    counts?.beforeRace === 1 && counts.afterUnknown === 2 && counts.afterRefresh === 2 && counts.afterManualConfirmation === 2 &&
    unknown.noAutomaticResend === true && unknown.manualConfirmation === 'workbench-dom' && unknown.confirmedOutcome === 'none' &&
    [unknown.unknownState, unknown.refreshedState].every(state => state?.writeBlocked === true && state.readAllowed === true) &&
    unknown.resolvedState?.writeBlocked === false && unknown.resolvedState?.readAllowed === true &&
    gitSha(unknown.localBefore) && unknown.confirmedLocalSha === unknown.localBefore && unknown.rejectedLocalSha === unknown.localBefore &&
    gitSha(unknown.raceCommit) && unknown.confirmedRemoteSha === unknown.raceCommit && unknown.rejectedRemoteSha === unknown.raceCommit,
  'The real modal must resolve none without resending; Push counts must be 1→2→2→2 and both Git heads must remain unchanged.');
  const traceInput = await readEvidence('evidence/git-gui-native-v3/native-vscode-git-trace2.jsonl', 'native-git-trace');
  let trace = [];
  try { trace = (traceInput?.text ?? '').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch { check('native-gui:trace-json', false, 'Native Git trace contains malformed JSONL.'); }
  const pushes = trace.filter(event => event.event === 'start' && event.argv?.includes('push'));
  const invocations = unknown?.pushInvocations;
  const refresh = unknown?.refreshCommand;
  check('native-gui:trace-pushes', pushes.length === 2 && invocations?.length === 2 && pushes.every(event => invocations.some(item => item.sid === event.sid && JSON.stringify(item.argv) === JSON.stringify(event.argv))), 'Raw Git trace must contain exactly the two recorded Push starts.');
  check('native-gui:trace-refresh-exit-zero', typeof refresh?.sid === 'string' && refresh.argv?.includes('status') &&
    trace.some(event => event.event === 'start' && event.sid === refresh.sid && event.argv?.includes('status')) &&
    trace.some(event => event.event === 'exit' && event.sid === refresh.sid && event.code === 0), 'The read refresh needs a matching actual Git status start and successful exit.');
  const firstPushExit = trace.find(event => event.event === 'exit' && event.sid === pushes[0]?.sid);
  const forcePush = pushes[1];
  const forcePushExit = trace.find(event => event.event === 'exit' && event.sid === forcePush?.sid);
  const refreshStart = trace.find(event => event.event === 'start' && event.sid === refresh?.sid);
  check('native-gui:trace-rejected-lease-before-refresh', firstPushExit?.code === 0 && gitSha(unknown?.remoteBefore) &&
    unknown.remoteBefore === unknown.localBefore && typeof native?.gitGui?.branch === 'string' &&
    forcePush?.argv?.includes(`--force-with-lease=refs/heads/${native.gitGui.branch}:${unknown.remoteBefore}`) &&
    forcePush.argv.includes(`HEAD:refs/heads/${native.gitGui.branch}`) && Number.isInteger(forcePushExit?.code) && forcePushExit.code !== 0 &&
    Number.isFinite(Date.parse(forcePushExit.time)) && Number.isFinite(Date.parse(refreshStart?.time)) &&
    Date.parse(refreshStart.time) > Date.parse(forcePushExit.time), 'Raw trace must show a successful initial Push, the failed exact preflight lease, and a later actual read refresh.');
  summaries.nativeGui = { status: native?.status, vscodeVersion: native?.vscodeVersion, elapsedMs: native?.elapsedMs,
    confirmations: 'Test driver clicked real Workbench DOM dialogs; this is not human input.',
    unknownWrite: { status: unknown?.status, pushCounts: counts, noAutomaticResend: unknown?.noAutomaticResend,
      confirmedOutcome: unknown?.confirmedOutcome, manualConfirmation: unknown?.manualConfirmation,
      readRefreshExitZero: trace.some(event => event.event === 'exit' && event.sid === refresh?.sid && event.code === 0) } };
  return native;
}

async function verifyVisual(vsix, revision, native) {
  const visual = await jsonEvidence('evidence/visual-qa-v3.json', 'visual-qa');
  const reviewChecks = Array.isArray(visual?.checks) ? visual.checks : [];
  check('visual:status-artifact', visual?.status === 'PASS' && visual.reviewedBy === 'Codex visual image inspection' &&
    sha256(vsix?.sha256) && visual.testedArtifact?.sha256 === vsix.sha256 && reviewChecks.length > 0 && reviewChecks.every(item => item.status === 'PASS'), 'Codex visual inspection must explicitly pass for the current artifact.');
  const files = [...new Set(reviewChecks.flatMap(item => typeof item.evidence === 'string' ? [item.evidence] : Array.isArray(item.evidence) ? item.evidence : []))];
  const required = [
    ...(revision?.smoke?.screenshots ?? []).map(name => `evidence/revision-v3/${name}`),
    ...(native?.screenshots ?? []).map(name => `evidence/git-gui-native-v3/${name}`)
  ];
  check('visual:coverage', revision?.smoke?.screenshots?.length === 6 && native?.screenshots?.length >= 8 && files.length >= 14 &&
    required.every(file => files.includes(file)), 'At least all six formal UI screenshots and all eight native screenshots must be inspected.');
  for (const [index, file] of files.entries()) {
    if (!safeWorkPath(file) || !/\.(?:png|jpe?g|webp)$/i.test(file)) { check(`visual:file:${index}`, false, 'Visual evidence must be a relative image file inside the work directory.'); continue; }
    await readEvidence(file, `visual-image:${index}`);
  }
  summaries.visual = { status: visual?.status, reviewedBy: visual?.reviewedBy, checks: reviewChecks.length, images: files.length,
    limit: 'High-contrast theme uses fixture classes/tokens; not an operating-system assistive-technology test.' };
}

async function main() {
  const [vsix, kit, baselineArtifact] = await Promise.all([
    artifact('dist/gitlab-workspace-0.25.0.vsix', 'current-vsix'),
    artifact('dist/gitlab-workspace-kit-0.25.0.zip', 'current-kit'),
    artifact('docs/work/work-20261017-operation-state/baseline/gitlab-workspace-0.25.0.vsix', 'original-baseline')
  ]);
  check('artifact:immutable-baseline', baselineArtifact?.sha256 === originalBaselineSha, 'The original baseline artifact must match its immutable SHA-256.');
  let sums = '';
  try {
    const sumBytes = await readFile(path.join(repoDir, 'dist/SHA256SUMS'));
    sums = sumBytes.toString('utf8');
    manifest.set('dist/SHA256SUMS', { sha256: digest(sumBytes), bytes: sumBytes.length });
  }
  catch { check('artifact:sha256sums-present', false); }
  const sumEntries = new Map([...sums.matchAll(/^([a-f0-9]{64})\s+\*?([^\r\n]+)$/gm)].map(match => [match[2].trim(), match[1]]));
  check('artifact:release-sums', sha256(vsix?.sha256) && sha256(kit?.sha256) && sumEntries.get(path.basename(vsix.path)) === vsix.sha256 && sumEntries.get(path.basename(kit.path)) === kit.sha256,
    'Current VSIX and kit bytes must match the release SHA256SUMS.');
  summaries.artifacts = { vsix, kit, originalBaseline: baselineArtifact };
  await verifyFullRun();
  const { revision } = await verifyPerformance(vsix, baselineArtifact);
  await verifyRegularGui(vsix);
  const native = await verifyNativeGui(vsix);
  await verifyVisual(vsix, revision, native);
}

try { await main(); }
catch (error) { check('generator:unexpected-error', false, `Verifier did not complete (${error?.name ?? 'Error'}).`); }
const failed = checks.filter(item => item.status === 'FAIL');
const report = {
  schema: 'GitLabWorkspaceLocalVerification/v1', generatedAt: new Date().toISOString(),
  status: failed.length ? 'FAIL_LOCAL_VALIDATION' : 'PASS_LOCAL_VALIDATION',
  scope: 'Local automated and Codex visual verification only; no real GitLab credentials or remote GitLab validation.',
  ...summaries,
  realGitLab: { status: 'NOT_RUN', reason: 'No real GitLab credentials; no claim about real server permissions, network latency or remote write success.' },
  checks: { passed: checks.length - failed.length, failed: failed.length, results: checks },
  evidence: [...manifest].map(([file, metadata]) => ({ path: file, ...metadata }))
};
await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${report.status}; ${checks.length - failed.length}/${checks.length} evidence checks passed; verification.json written.\n`);
if (failed.length) process.exitCode = 1;
