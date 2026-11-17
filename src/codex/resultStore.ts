import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { acquireStorageControl } from '../storage/controlLease';
import { missingFile, ownedStoragePath, removeOwnedStorage } from '../storage/ownedStorage';
import type { CodexOutputItem, CodexTaskRecord, CodexTaskResult } from './protocol';
import { CodexWorkspaceLease } from './workspaceLease';
import { exportCodexTaskChanges } from './resultExporter';
import { restoreCodexResultChanges, type CodexManualWorkspace } from './resultRestore';
import { evaluateCriteria, validValidationAttempts, validWorkContext, validWorkId } from './workContext';
import type { ValidationAttempt, WorkContext } from './workContextProtocol';
import { isLocalWikiQualityReceipt } from '../workspace/localWikiQuality';
import { parseProjectWikiSeed, projectWikiSeedFromDraft, projectWikiSeedScope, PROJECT_WIKI_SEED_PATH, type ProjectWikiSeed } from './projectWikiSeed';
import type { CodexTaskOrigin } from './workflowProtocol';
import { CODEX_RESULT_MAX_BYTES, CODEX_RESULT_MAX_FILES, CODEX_RESULT_SCHEMA, resultPathKey, safeResultPath, validResultId,
  type CodexArtifact, type CodexResultConfirmationAudit, type CodexResultDelivery, type CodexResultManifest, type CodexResultOrigin, type CodexResultReason } from './resultProtocol';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const same = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
function text(value: unknown, limit = 8000): string {
  return (typeof value === 'string' ? value : '').slice(0, limit)
    .replace(/\b(Bearer\s+)[A-Za-z0-9_.~+/-]+=*/gi, '$1[redacted]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|private[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1')
    .replace(/([?&](?:access_token|private_token|token|api_key|key)=)[^&#\s]+/gi, '$1[redacted]');
}
function url(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const parsed = new URL(value); if (!['https:', 'http:'].includes(parsed.protocol)) return;
    parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''; return parsed.toString();
  } catch { return; }
}
function origin(record: CodexTaskRecord): CodexResultOrigin | undefined {
  const value = record.spec.origin; if (!value) return;
  return { kind: value.kind, projectId: value.projectId, projectPath: text(value.projectPath, 1000), webUrl: url(value.webUrl) ?? '',
    repositoryRoot: value.repositoryRoot, sourceBranch: text(value.sourceBranch, 1000), sourceSha: value.sourceSha,
    ...(value.iid === undefined ? {} : { iid: value.iid }), ...(value.targetBranch ? { targetBranch: text(value.targetBranch, 1000) } : {}),
    ...(value.targetSha ? { targetSha: value.targetSha } : {}), ...(value.branch ? { branch: text(value.branch, 1000) } : {}),
    ...(value.intent ? { intent: value.intent } : {}) };
}
function delivery(record: CodexTaskRecord): CodexResultDelivery | undefined {
  const value = (record as CodexTaskRecord & { delivery?: Record<string, any> }).delivery;
  if (!value || typeof value.state !== 'string') return;
  const receipts = Array.isArray(value.steps) ? value.steps.filter((step: any) => step && step.state === 'confirmed').map((step: any) => ({
    action: text(step.action ?? step.kind ?? step.name, 100), state: 'confirmed',
    ...(typeof step.key === 'string' ? { key: text(step.key, 200) } : {}),
    ...(Number.isSafeInteger(step.resourceId) ? { resourceId: step.resourceId } : {}),
    ...(typeof step.sha === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(step.sha) ? { commitSha: step.sha } : {}),
    ...(typeof step.bodyHash === 'string' && /^[a-f0-9]{64}$/.test(step.bodyHash) ? { bodyHash: step.bodyHash } : {}),
    ...(url(step.url) ? { url: url(step.url) } : {}) })).slice(0, 100) : [];
  return { state: text(value.state, 100), ...(typeof value.deliveredCommitSha === 'string' ? { deliveredCommitSha: value.deliveredCommitSha } : {}),
    ...(url(value.url) ? { url: url(value.url) } : {}), ...(receipts.length ? { receipts } : {}) };
}
function cleanResult(value: CodexTaskResult | undefined, clean: (value: unknown, limit?: number) => string): CodexTaskResult | undefined {
  if (!value) return;
  return { state: value.state, summary: clean(value.summary),
    ...(value.files ? { files: value.files.map(file => safeResultPath(file)) } : {}),
    ...(value.tests ? { tests: value.tests.slice(0, 100).map(test => ({ command: clean(test.command, 2000), exitCode: test.exitCode })) } : {}),
    ...(url(value.url) ? { url: url(value.url) } : {}),
    ...(value.replyDrafts ? { replyDrafts: value.replyDrafts.map(reply => ({ discussionId: text(reply.discussionId, 200), body: clean(reply.body, 50_000) })) } : {}),
    ...(value.followUps ? { followUps: value.followUps.slice(0, 100).map(item => ({ kind: item.kind, projectId: item.projectId,
      ...(typeof item.scope === 'string' && /^[a-f0-9]{64}$/.test(item.scope) ? { scope: item.scope } : {}),
      ...(item.iid === undefined ? {} : { iid: item.iid }), url: url(item.url) ?? '', title: clean(item.title, 1000) })) } : {}),
    ...(value.evidence ? { evidence: { sourceSha: value.evidence.sourceSha, branch: text(value.evidence.branch, 1000), digest: value.evidence.digest, verifiedAt: value.evidence.verifiedAt } } : {}) };
}
function wikiAttachmentReferences(markdown: string, page: string): string[] {
  const attachments = new Set<string>();
  const visible = markdown.replace(/(^```[^\n]*\n[\s\S]*?^```\s*$|^~~~[^\n]*\n[\s\S]*?^~~~\s*$)/gm, '').replace(/`[^`\r\n]*`/g, '');
  for (const match of visible.matchAll(/!?\[[^\]\r\n]*\]\((?:<([^>\r\n]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g)) {
    let target = match[1] ?? match[2];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) continue;
    try { target = decodeURIComponent(target.split(/[?#]/, 1)[0]); } catch { throw new Error('Wiki 附件連結包含無效編碼。'); }
    if (!/\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico|drawio|mmd|mermaid)$/i.test(target)) continue;
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(page), target));
    if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) continue;
    attachments.add(safeResultPath(relative));
  }
  return [...attachments];
}
async function writeDurable(file: string, bytes: Buffer): Promise<void> {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function safeFile(root: string, file: string, limit = CODEX_RESULT_MAX_BYTES): Promise<Buffer> {
  if (!await ownedStoragePath(root, file)) throw new Error('成果檔案遺失。');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('成果檔案格式或容量無法驗證。');
  const bytes = await readFile(file); if (bytes.length !== info.size) throw new Error('成果檔案在讀取期間變更。'); return bytes;
}
/** Results are immutable and separate from execution storage. Failure never removes source data. */
export class CodexResultStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = path.resolve(directory); }
  private async ensure(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !same(await realpath(this.directory), this.directory)) throw new Error('成果儲存區不可重新導向。');
  }
  private resultRoot(id: string): string {
    if (!validResultId(id)) throw new Error('成果識別無效。'); return path.join(this.directory, id);
  }
  async seal(record: CodexTaskRecord, outputs: readonly CodexOutputItem[], reason: CodexResultReason): Promise<CodexResultManifest> {
    return this.sealRecord(record, outputs, reason, false);
  }
  /** Preserve a stopped task when publication is unresolved; never register a final result or clean its sources. */
  async exportPendingTo(record: CodexTaskRecord, outputs: readonly CodexOutputItem[], destination: string): Promise<CodexResultManifest> {
    await this.ensure();
    const temporary = path.join(this.directory, '.handoff-' + randomUUID());
    await mkdir(temporary, { mode: 0o700 });
    try {
      const store = new CodexResultStore(temporary);
      await store.sealRecord(structuredClone(record), structuredClone(outputs), 'manual', true, path.dirname(this.directory));
      await store.exportTo(record.id, destination);
      const target = path.resolve(destination), manifest = JSON.parse((await safeFile(target, path.join(target, 'manifest.json'), 8 * 1024 * 1024)).toString('utf8')) as CodexResultManifest;
      this.validate(manifest, record.id, target); return manifest;
    } finally { await removeOwnedStorage(this.directory, temporary); }
  }
  private async sealRecord(record: CodexTaskRecord, outputs: readonly CodexOutputItem[], reason: CodexResultReason, provisional: boolean, sourceStorage = path.dirname(this.directory)): Promise<CodexResultManifest> {
    if (!validResultId(record.id) || !['completed', 'manual', 'deleted'].includes(reason)) throw new Error('成果識別或保存原因無效。');
    await this.ensure();
    const lock = await acquireStorageControl(path.join(this.directory, record.id + '.seal.control'), 'codex-results');
    let stage: string | undefined;
    try {
      const destination = this.resultRoot(record.id);
      if (await ownedStoragePath(this.directory, destination)) {
        const saved = await this.read(record.id);
        if (!!saved.provisional !== provisional) throw new Error('暫存交接成果不能取代正式成果。');
        return saved;
      }
      if (!provisional && (record.publication?.state === 'pending' || Object.values(record.publications ?? {}).some(item => item.state === 'pending') ||
        record.result?.state === 'uncertain' || record.delivery?.steps.some(step => ['sending', 'uncertain'].includes(step.state)))) throw new Error('發布結果仍待核對，尚不能封存成果。');
      if (['queued', 'starting', 'running', 'waiting', 'pausing'].includes(record.status) && !record.lease) throw new Error('缺少程序停止證據，尚不能封存成果。');
      if (record.lease && record.lease.released !== true) {
        const receipt = record.lease.receipt;
        let confirmed = false;
        if (receipt && /^[a-z0-9-]{16,128}$/i.test(receipt.nonce) && receipt.path === record.lease.directory + '.stopped-' + receipt.nonce + '.json') {
          try {
            const info = await lstat(receipt.path);
            if (info.isFile() && !info.isSymbolicLink() && info.size <= 1024) {
              const value = JSON.parse(await readFile(receipt.path, 'utf8'));
              confirmed = value.schema === 'GitLabWorkspaceCodexProcess/v1' && value.nonce === receipt.nonce && value.processTreeConfirmed === true &&
                await CodexWorkspaceLease.inspect(record.lease.directory, receipt) === 'confirmed';
            }
          } catch { /* A missing or corrupt proof cannot authorize cleanup. */ }
        }
        if (!confirmed) throw new Error('缺少程序停止證據，尚不能封存成果。');
      }
      stage = path.join(this.directory, '.stage-' + record.id + '-' + randomUUID()); await mkdir(stage, { mode: 0o700 });
      const artifacts: CodexArtifact[] = [], paths = new Set<string>(); let total = 0;
      const sourceFiles = new Map<string, { root: string; hash: string }>();
      const snapshotSource = async (root: string, file: string, limit = CODEX_RESULT_MAX_BYTES): Promise<Buffer> => {
        const bytes = await safeFile(root, file, limit); sourceFiles.set(file, { root, hash: sha256(bytes) }); return bytes;
      };
      const add = async (relative: string, bytes: Buffer, mediaType: string, name = relative): Promise<CodexArtifact> => {
        safeResultPath(relative); const key = resultPathKey(relative);
        if (paths.has(key)) throw new Error('成果檔案路徑重複。');
        if (total + bytes.length > CODEX_RESULT_MAX_BYTES || artifacts.length >= CODEX_RESULT_MAX_FILES) throw new Error('完整成果超過保存限制；保留原工作目錄。');
        const file = path.join(stage!, ...relative.split('/')); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        if (path.dirname(file) !== stage) await ownedStoragePath(stage!, path.dirname(file));
        await writeDurable(file, bytes);
        const artifact: CodexArtifact = { id: createHash('sha256').update(relative).digest('hex').slice(0, 32), path: relative,
          name: text(name, 1000), mediaType, size: bytes.length, sha256: sha256(bytes) };
        if (sha256(await safeFile(stage!, file)) !== artifact.sha256) throw new Error('成果寫入後的 hash 不符。');
        total += bytes.length; paths.add(key); artifacts.push(artifact); return artifact;
      };
      const group = (record.spec as typeof record.spec & { groupAnalysis?: { outputRoot: string; runtimeRoot: string; repositories?: Array<{ id: string; sha: string; snapshotPath: string }> } }).groupAnalysis;
      const temporaryValues = [record.threadId, ...(record.routingThreadIds ?? []), record.spec.workflow?.runtimeRoot,
        record.spec.workflow?.worktree?.path, record.spec.workflow?.managedClone?.path, record.spec.review?.requestId, record.spec.prompt, group?.runtimeRoot,
        ...(group?.repositories?.map(repo => repo.snapshotPath) ?? [])].filter((value): value is string => !!value);
      const clean = (value: unknown, limit = 8000): string => {
        let output = text(value, limit); for (const temporary of temporaryValues) output = output.split(temporary).join('[已清理的執行資料]'); return output;
      };
      const summary = clean(record.result?.summary ?? [...outputs].reverse().find(item => item.kind === 'agent' && item.text)?.text ?? '已保留目前可核對的成果。');
      const manifest: CodexResultManifest = { schema: CODEX_RESULT_SCHEMA, id: record.id, title: text(record.title, 200), root: record.root,
        status: record.status, createdAt: record.createdAt, updatedAt: new Date().toISOString(), reason, summary,
        origin: origin(record), result: cleanResult(record.result, clean), delivery: delivery(record), artifacts };
      if (record.result?.wikiQuality !== undefined) {
        const receipt = record.result.wikiQuality;
        if (!isLocalWikiQualityReceipt(receipt)) throw new Error('Wiki 品質收據無法核對；保留執行資料。');
        await add('validation/wiki-quality.json', Buffer.from(JSON.stringify({ schema: 'GitLabWorkspaceLocalWikiQualityArtifact/v1',
          historicalOnly: true, authorizesDelivery: false, receipt: { ...receipt,
            findings: receipt.findings.map(item => ({ ...item, message: clean(item.message, 8192) })),
            checks: receipt.checks.map(item => ({ ...item, command: clean(item.command, 2048) })),
            ...(receipt.coverage ? { coverage: { ...receipt.coverage, errors: receipt.coverage.errors.map(item => clean(item, 8192)) } } : {})
          } }, null, 2) + '\n'), 'application/json', '完整 Wiki 品質檢查收據');
        // Shared local Wiki is permanent user data; retain this task's actual page bytes too.
        const wikiRoot = path.join(record.spec.root, 'wiki');
        const attachments = new Set<string>();
        for (const page of receipt.changedPages) {
          const file = path.join(wikiRoot, ...safeResultPath(page).split('/'));
          try {
            const bytes = await snapshotSource(wikiRoot, file);
            await add('wiki/' + page, bytes, 'text/markdown', page);
            for (const relative of wikiAttachmentReferences(bytes.toString('utf8'), page)) attachments.add(relative);
          }
          catch (error) { if (!missingFile(error) && !(error instanceof Error && error.message === '成果檔案遺失。')) throw error; }
        }
        if (attachments.size > 128) throw new Error('本次 Wiki 附件超過保存上限，保留工作區供縮小範圍。');
        for (const relative of attachments) await add('wiki/' + relative,
          await snapshotSource(wikiRoot, path.join(wikiRoot, ...relative.split('/')), 16 * 1024 * 1024),
          /\.svg$/i.test(relative) ? 'image/svg+xml' : 'application/octet-stream', relative);
      }
      const context = (record.spec as typeof record.spec & { workContext?: WorkContext }).workContext;
      const attempts = (record as typeof record & { validationAttempts?: ValidationAttempt[] }).validationAttempts;
      if (context !== undefined) {
        if (!validWorkContext(context)) throw new Error('需求來源與驗證設定無法核對；保留執行資料。');
        if (context.workId) manifest.workId = context.workId;
        const requirement = context.requirement, source = requirement.source;
        const snapshot = { source: { kind: source.kind, identityDigest: sha256(Buffer.from(source.identity)),
          ...(url(source.url) ? { url: url(source.url) } : {}), ...(source.revision ? { revision: clean(source.revision, 4096) } : {}) },
          title: clean(requirement.title, 4096), description: clean(requirement.description, 128_000),
          ...(requirement.supplement === undefined ? {} : { supplement: clean(requirement.supplement, 32_000) }),
          capturedAt: requirement.capturedAt, contentDigest: requirement.contentDigest,
          criteria: requirement.criteria.map(item => ({ id: item.id, text: clean(item.text, 4096), contentDigest: item.contentDigest })) };
        const profile = context.verification;
        await add('provenance/work-context.json', Buffer.from(JSON.stringify({ schema: 'GitLabWorkspaceWorkProvenance/v1', historicalOnly: true, authorizesDelivery: false,
          workId: context.workId ?? null, requirement: snapshot,
          verification: profile ? { ...profile, commands: profile.commands.map(command => clean(command, 4096)), manualChecks: profile.manualChecks.map(item => clean(item, 4096)),
            ...(profile.reason ? { reason: clean(profile.reason, 4096) } : {}) } : null,
          criteria: evaluateCriteria(requirement, record.validation?.manual && record.validation.requirementDigest === requirement.contentDigest
            ? requirement.criteria.filter(item => record.validation!.manual!.checks.includes(item.text)).map(item => ({ criterionId: item.id,
              criterionDigest: item.contentDigest, state: 'passed' as const, evidence: ['human-verification:' + record.validation!.manual!.confirmedAt] })) : []),
          digestUse: 'original-host-snapshot-before-redaction; historical-evidence-only' }, null, 2) + '\n'),
        'application/json', '來源需求、驗證設定與驗收證據摘要');
      }
      if (attempts !== undefined) {
        if (!validValidationAttempts(attempts)) throw new Error('驗證嘗試紀錄無法核對；保留執行資料。');
        await add('validation/attempts.json', Buffer.from(JSON.stringify({ schema: 'GitLabWorkspaceValidationAttempts/v1', historicalOnly: true, authorizesDelivery: false,
          attempts: attempts.map(attempt => ({ id: attempt.id, cycle: attempt.cycle, startedAt: attempt.startedAt,
            ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}), cwd: clean(attempt.cwd, 4096),
            ...(attempt.artifactDigest ? { artifactDigest: attempt.artifactDigest } : {}), ...(attempt.requirementDigest ? { requirementDigest: attempt.requirementDigest } : {}),
            ...(attempt.profileDigest ? { profileDigest: attempt.profileDigest } : {}), state: attempt.state, ...(attempt.reason ? { reason: clean(attempt.reason, 8000) } : {}),
            commands: attempt.commands.map(command => ({ command: clean(command.command, 8192), ...(command.cwd ? { cwd: clean(command.cwd, 4096) } : {}),
              ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }), ...(command.signal ? { signal: clean(command.signal, 100) } : {}),
              ...(command.startedAtMs === undefined ? {} : { startedAtMs: command.startedAtMs }), ...(command.completedAtMs === undefined ? {} : { completedAtMs: command.completedAtMs }) })) })) }, null, 2) + '\n'),
        'application/json', '各次驗證結果與失敗紀錄');
      }
      const operation = (value: { kind: string; state: string; key: string; resourceId?: number; sha?: string; url?: string; bodyHash?: string }) => ({
        kind: text(value.kind, 100), state: text(value.state, 100), operationKeyHash: sha256(Buffer.from(value.key)),
        ...(Number.isSafeInteger(value.resourceId) ? { resourceId: value.resourceId } : {}),
        ...(typeof value.sha === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.sha) ? { commitSha: value.sha } : {}),
        ...(typeof value.bodyHash === 'string' && /^[a-f0-9]{64}$/.test(value.bodyHash) ? { bodyHash: value.bodyHash } : {}),
        ...(url(value.url) ? { url: url(value.url) } : {}) });
      const operations: Array<Record<string, unknown>> = [...(record.publication ? [record.publication] : []),
        ...Object.values(record.publications ?? {}), ...(record.delivery?.steps ?? [])].map(operation);
      if (provisional) {
        manifest.provisional = true;
        manifest.result = { ...(manifest.result ?? { summary }), state: 'uncertain' };
      }
      const readSource = async (file: string): Promise<Buffer> => {
        const allowed = [record.root, record.spec.executionRoot, record.spec.origin?.repositoryRoot, record.spec.workflow?.runtimeRoot,
          record.spec.groupAnalysis?.outputRoot, record.spec.bmadArtifacts?.outputRoot].filter((value): value is string => !!value);
        for (const root of allowed) {
          const relative = path.relative(root, file);
          if (relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) return snapshotSource(root, file);
        }
        throw new Error('成果來源超出本次已授權目錄。');
      };
      if (record.result?.reportPath) {
        const report = await add('reports/' + safeResultPath(path.basename(record.result.reportPath)), await readSource(record.result.reportPath), 'text/markdown');
        manifest.result!.reportPath = path.join(destination, ...report.path.split('/'));
      }
      const copyMarkdown = async (root: string, prefix: string, required = false, structured = false): Promise<void> => {
        let info;
        try { info = await lstat(root); } catch (error) { if (!required && missingFile(error)) return; throw error; }
        if (!info.isDirectory() || info.isSymbolicLink() || !same(await realpath(root), root)) throw new Error('文件成果目錄不可重新導向。');
        let visited = 0;
        const walk = async (relative = '', depth = 0): Promise<void> => {
          if (depth > 64) throw new Error('文件成果目錄過深。');
          for (const item of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            if (++visited > CODEX_RESULT_MAX_FILES) throw new Error('文件成果清單超過限制；保留原工作目錄。');
            const next = relative ? relative + '/' + item.name : item.name; safeResultPath(next);
            if (item.isSymbolicLink()) throw new Error('文件成果包含重新導向，保留原件。');
            if (item.isDirectory()) await walk(next, depth + 1);
            else if (item.isFile() && (/\.md$/i.test(item.name) || structured && /\.(?:ya?ml|json|toml|txt)$/i.test(item.name))) await add(prefix + '/' + next,
              await snapshotSource(root, path.join(root, ...next.split('/'))), /\.md$/i.test(item.name) ? 'text/markdown' : /\.json$/i.test(item.name) ? 'application/json' : 'text/plain', next);
            else if (!item.isFile()) throw new Error('文件成果包含不支援的檔案類型。');
          }
        };
        await walk();
      };
      if (group) {
        if (!path.isAbsolute(group.outputRoot) || !path.isAbsolute(group.runtimeRoot)) throw new Error('Group 文件成果綁定無效。');
        // Manual takeover can happen before the model writes sources.json.
        // Preserve the Host-captured bases independently of generated documents.
        const repositories = (record.spec.groupAnalysis?.repositories ?? []).map(repo => ({ id: text(repo.id, 200),
          name: text(repo.name ?? repo.id, 1000), sha: repo.sha,
          ...(typeof repo.projectPath === 'string' ? { projectPath: text(repo.projectPath, 1000) } : {}),
          ...(typeof repo.path === 'string' && path.isAbsolute(repo.path) ? { originalRepository: repo.path } : {}) }));
        await add('documents/repositories.json', Buffer.from(JSON.stringify({ schema: 'GitLabWorkspaceCodexGroupSources/v1', repositories }, null, 2) + '\n'),
          'application/json', 'Group 固定來源與基準（含未完成分析的 Repo）');
        await copyMarkdown(group.outputRoot, 'documents', reason === 'completed');
        if (group.issueDrafts) {
          try { await add('documents/issues.json', await snapshotSource(group.outputRoot, path.join(group.outputRoot, 'issues.json'), 256 * 1024), 'application/json', 'Issue 草稿'); }
          catch (error) { if (reason === 'completed' || !missingFile(error) && !(error instanceof Error && error.message === '成果檔案遺失。')) throw error; }
          try { await add('documents/source-inventory.json', await snapshotSource(group.runtimeRoot, path.join(group.runtimeRoot, 'source-inventory.json'), 16 * 1024 * 1024), 'application/json', 'Host 固定來源檔案指紋'); }
          catch (error) { if (reason === 'completed' || !missingFile(error) && !(error instanceof Error && error.message === '成果檔案遺失。')) throw error; }
          const receiptRoot = path.join(sourceStorage, 'group-issue-publications');
          try {
            const bytes = await snapshotSource(receiptRoot, path.join(receiptRoot, group.id + '.json'), 2 * 1024 * 1024);
            const journal = JSON.parse(bytes.toString('utf8'));
            if (journal.schema !== 'GitLabWorkspaceGroupIssues/v1' || journal.analysisId !== group.id || !journal.receipts ||
              typeof journal.receipts !== 'object' || Array.isArray(journal.receipts)) throw new Error('Issue 發布收據無法驗證，保留原環境。');
            if (Object.values(journal.receipts).some((receipt: any) => !receipt || !['prepared', 'sending', 'confirmed', 'unknown'].includes(receipt.state))) throw new Error('Issue 發布收據狀態無法驗證，保留原環境。');
            const pending = Object.values(journal.receipts).filter((receipt: any) => ['sending', 'unknown'].includes(receipt?.state)) as Array<Record<string, unknown>>;
            if (pending.length && !provisional) throw new Error('Issue 建立結果尚待核對，不能正式封存或清理；可先匯出暫存交接成果。');
            for (const receipt of pending) operations.push({ action: 'create-issue', state: 'pending', outcome: receipt.state,
              draftId: text(receipt.draftId, 128), projectId: receipt.projectId, ...(typeof receipt.iid === 'number' ? { resourceId: receipt.iid } : {}) });
            await add('delivery/group-issues.json', bytes, 'application/json', '逐張 Issue 發布收據');
          }
          catch (error) { if (!missingFile(error) && !(error instanceof Error && error.message === '成果檔案遺失。')) throw error; }
        }
        if (record.result?.files?.includes('sources.json')) {
          const evidence = JSON.parse((await snapshotSource(group.outputRoot, path.join(group.outputRoot, 'sources.json'), 2 * 1024 * 1024)).toString('utf8'));
          if (!Array.isArray(evidence.repositories) || evidence.repositories.length > 100) throw new Error('Group 成果的固定來源證據無法驗證。');
          const repositories = evidence.repositories.map((item: any) => {
            if (!item || !group.repositories?.some(repo => repo.id === item.id && repo.sha === item.sha) || !Array.isArray(item.evidence) || item.evidence.length > CODEX_RESULT_MAX_FILES) throw new Error('Group 成果來源與固定 Repo/SHA 不符。');
            return { id: text(item.id, 200), sha: item.sha, evidence: item.evidence.map((entry: any) => {
              if (!entry || typeof entry.path !== 'string' || typeof entry.claim !== 'string') throw new Error('Group 成果證據格式無效。');
              return { path: safeResultPath(entry.path), claim: clean(entry.claim, 8000) };
            }) };
          });
          await add('documents/sources.json', Buffer.from(JSON.stringify({ repositories }, null, 2) + '\n'), 'application/json', '固定 Repo/SHA 與檔案證據');
        }
      }
      if (record.spec.origin?.kind === 'project-wiki' && record.spec.workflow) {
        const draftRoot = path.join(sourceStorage, 'project-wiki-drafts'), draftFile = path.join(draftRoot, record.spec.workflow.id + '.json');
        let saved = false;
        try {
          const draft = JSON.parse((await snapshotSource(draftRoot, draftFile, 8 * 1024 * 1024)).toString('utf8'));
          if (draft.schema !== 'GitLabWorkspaceProjectWiki/v1' || draft.id !== record.spec.workflow.id || !Array.isArray(draft.pages) ||
            draft.origin?.projectId !== record.spec.origin.projectId || draft.origin?.sourceSha !== record.spec.origin.sourceSha) throw new Error('Wiki 成果草稿與本次來源不符。');
          for (const page of draft.pages) {
            if (!page || typeof page.content !== 'string' || page.sending && !provisional) throw new Error('Wiki 發布或成果內容仍待核對。');
            const relative = typeof page.file === 'string' ? page.file : String(page.slug) + '.md';
            if (!/\.md$/i.test(relative)) throw new Error('Wiki 成果檔名無效。');
            operations.push({ kind: 'wiki', state: page.sending ? 'uncertain' : page.published ? 'confirmed' : 'prepared',
              path: safeResultPath(relative), bodyHash: sha256(Buffer.from(page.content)), ...(url(page.url) ? { url: url(page.url) } : {}) });
            await add('wiki/' + safeResultPath(relative), Buffer.from(page.content), 'text/markdown', relative);
          }
          if (!provisional) {
            const seed = projectWikiSeedFromDraft(draft, record.spec.origin);
            manifest.wikiSeedArtifactId = (await add(PROJECT_WIKI_SEED_PATH, Buffer.from(JSON.stringify(seed, null, 2) + '\n'),
              'application/json', 'Wiki 固定來源、頁面映射與發布收據')).id;
            manifest.wikiSeedScope = seed.origin.scope;
          }
          saved = true;
        } catch (error) {
          if (!missingFile(error) && !(error instanceof Error && error.message === '成果檔案遺失。')) throw error;
        }
        if (!saved) await copyMarkdown(path.join(record.spec.workflow.sourceRoot ?? path.dirname(record.spec.executionRoot!), 'wiki'), 'wiki', !!record.result?.draftId);
      }
      if (record.spec.workflow?.worktree) await copyMarkdown(path.join(record.spec.workflow.worktree.path, '_bmad-output'), 'documents');
      if (record.spec.workflow?.managedClone) await copyMarkdown(path.join(record.spec.workflow.managedClone.path, '_bmad-output'), 'documents', false, true);
      if (record.spec.bmadArtifacts) await copyMarkdown(record.spec.bmadArtifacts.outputRoot, 'documents', false, true);
      manifest.restore = await exportCodexTaskChanges(record, stage, add);
      if (record.delivery?.confirmation) {
        const value = record.delivery.confirmation, artifactDigest = record.delivery.artifactDigest ?? record.validation?.artifactDigest;
        const oid = (sha: string) => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha), digest = (sha: string) => /^[a-f0-9]{64}$/.test(sha);
        if (!digest(value.digest) || !Number.isFinite(Date.parse(value.confirmedAt)) || value.headSha !== undefined && !oid(value.headSha) ||
          value.targetSha !== undefined && !oid(value.targetSha) || value.issueDigest !== undefined && !digest(value.issueDigest) ||
          artifactDigest !== undefined && !digest(artifactDigest) || record.delivery.deliveredCommitSha !== undefined && !oid(record.delivery.deliveredCommitSha)) {
          throw new Error('成果的歷史人工確認紀錄無法驗證；保留原任務。');
        }
        const audit: CodexResultConfirmationAudit = { schema: 'GitLabWorkspaceCodexDeliveryConfirmationAudit/v1', historicalOnly: true, authorizesDelivery: false,
          taskId: record.id, source: manifest.origin, confirmation: { digest: value.digest, confirmedAt: value.confirmedAt,
            ...(value.headSha === undefined ? {} : { headSha: value.headSha }), ...(value.targetSha === undefined ? {} : { targetSha: value.targetSha }),
            ...(value.issueDigest === undefined ? {} : { issueDigest: value.issueDigest }) },
          ...(artifactDigest === undefined ? {} : { artifactDigest }),
          ...(record.delivery.deliveredCommitSha === undefined ? {} : { deliveredCommitSha: record.delivery.deliveredCommitSha }),
          ...(manifest.restore?.commitBundleArtifactId ? { commitBundleArtifactId: manifest.restore.commitBundleArtifactId } : {}) };
        await add('delivery/confirmation-audit.json', Buffer.from(JSON.stringify(audit, null, 2) + '\n'), 'application/json', '歷史人工確認紀錄（不授權接續發布）');
      }
      if (provisional || operations.length || record.delivery) await add(provisional ? 'delivery/pending-operations.json' : 'delivery/operations.json',
        Buffer.from(JSON.stringify({ provisional, state: record.delivery?.state ?? 'not-configured', operations }, null, 2) + '\n'), 'application/json', '已知發布操作狀態');
      const skills = [record.spec.skill ? { ...record.spec.skill, required: true } : undefined,
        ...(record.spec.additionalSkills ?? []).map(skill => ({ ...skill, required: false }))].filter((skill): skill is NonNullable<typeof skill> => !!skill)
        .map(skill => ({ name: clean(skill.name, 200), required: skill.required,
          fingerprint: typeof skill.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(skill.fingerprint) ? skill.fingerprint : null }));
      const testCommands = (record.spec.delivery?.testCommands ?? record.spec.source.testCommands ?? []).slice(0, 100).map(command => clean(command, 2000));
      const plan = (record.progress?.plan ?? []).slice(0, 200).map(item => ({ step: clean(item.step, 2000), status: item.status }));
      const intent = [record.spec.requirementSummary, record.spec.source.requirement ?? (record.spec.source.kind === 'free' ? record.spec.source.prompt : undefined)].filter(Boolean).join('\n\n');
      let requirementSummary = text(intent, 8000);
      for (const temporary of temporaryValues.filter(value => value !== record.spec.prompt)) requirementSummary = requirementSummary.split(temporary).join('[已清理的執行資料]');
      const validation = record.validation ? { cwd: text(record.validation.cwd, 4096), cwdUse: 'historical-evidence-only',
        artifactDigest: record.validation.artifactDigest, testedAt: record.validation.testedAt,
        ...(record.validation.requirementDigest ? { requirementDigest: record.validation.requirementDigest } : {}),
        ...(record.validation.profileDigest ? { profileDigest: record.validation.profileDigest } : {}),
        ...(record.validation.manual ? { manual: { confirmedAt: record.validation.manual.confirmedAt,
          checks: record.validation.manual.checks.map(check => clean(check, 4096)) } } : {}),
        ...(record.validation.noChanges ? { noChanges: true } : {}),
        commands: record.validation.commands.slice(0, 100).map(item => ({ command: clean(item.command, 2000), exitCode: item.exitCode,
          ...(item.cwd ? { cwd: text(item.cwd, 4096) } : {}),
          ...(Number.isSafeInteger(item.startedAtMs) ? { startedAtMs: item.startedAtMs } : {}),
          ...(Number.isSafeInteger(item.completedAtMs) ? { completedAtMs: item.completedAtMs } : {}) })) } : undefined;
      await add('task-summary.json', Buffer.from(JSON.stringify({ schema: 'GitLabWorkspaceCodexTaskSummary/v1',
        requirementSummary: requirementSummary || null, skills, testCommands, plan, validation: validation ?? null,
        dependencies: '在新的工作目錄依目前專案文件重新安裝依賴；不包含舊環境的套件快取、憑證或執行設定。',
        restorePrerequisite: manifest.restore ? { originalRepository: manifest.restore.originalRepository, baseSha: manifest.restore.baseSha } : null,
        unknown: [...(!requirementSummary ? ['原需求摘要未提供'] : []), ...(!skills.length ? ['必要 Skills 未記錄'] : []),
          ...(skills.some(skill => !skill.fingerprint) ? ['部分 Skills 執行時 fingerprint 未記錄，接續前須重新核對'] : []),
          ...(!testCommands.length && !validation?.manual ? ['指定的測試命令未記錄'] : []), ...(!plan.length ? ['已完成與待辦計畫未記錄'] : []), ...(!validation ? ['最後驗證證據未記錄'] : [])] }, null, 2) + '\n'),
      'application/json', '需求、Skills、測試與已完成待辦摘要');
      const handoff = ['# ' + manifest.title, '', manifest.summary, '',
        ...(provisional ? ['這是暫存交接成果，發布結果尚未核對。原工作環境仍須保留；先依 delivery/pending-operations.json 在 GitLab 核對已送出的操作，確認後才人工繼續，避免重複發布。這份套件不授權清理或恢復自動發布。', ''] : []),
        '## 已保存的成果', '',
        ...artifacts.map(artifact => `- [${artifact.name.replace(/[[\]]/g, '')}](${artifact.path.split('/').map(encodeURIComponent).join('/')})`), '',
        '## 接續前核對', '',
        ...(skills.length ? skills.map(skill => `- ${skill.required ? '必要' : '額外'} Skill：${skill.name}；fingerprint：${skill.fingerprint ?? '未知，須重新核對'}`) : ['- 必要 Skills 未記錄；須依目前專案重新確認。']),
        ...(testCommands.length ? testCommands.map(command => '- 指定測試：' + command) : validation?.manual ? ['- 本次文件變更採人工驗收；未執行自動檢查。'] : ['- 指定測試命令未知；須依目前專案確認。']),
        ...(plan.length ? plan.map(item => `- ${item.status === 'completed' ? '已完成' : item.status === 'inProgress' ? '進行中' : '待辦'}：${item.step}`) : ['- 已完成與待辦計畫未記錄；請先核對現有成果。']),
        validation ? `- 最後${validation.manual ? '人工驗收' : '驗證'}時間：${validation.testedAt}；來源 digest：${validation.artifactDigest}。task-summary.json 的 cwd 僅為歷史執行證據，接續請使用新工作目錄。` : '- 最後驗證證據未記錄；接續後須重新驗證。',
        '- 在新工作目錄依目前專案文件重新安裝依賴。', '',
        ...(manifest.restore ? ['## 手動接續', '', `保留的原 Repo：${JSON.stringify(manifest.restore.originalRepository)}`,
          `必要基礎版本：\`${manifest.restore.baseSha}\`。這份套件只包含本次變更，不是整個 Repo 的備份。`, '',
          '在原 Repo 核對上述基礎版本，另建乾淨工作目錄及新分支；依 code/changes.patch 套用 Git 變更，再依 code/inventory.json 將 write 項目的 artifact 原始 bytes 還原至相對路徑，並保留其 mode。不要覆寫原工作目錄。', ''] : []),
        '後續使用新的 Codex CLI 對話，在你準備的新工作目錄接續。依目前專案重新解析 Skills 與測試命令；此成果不恢復舊的執行程序或發布排程。',
        ...(manifest.delivery?.url ? ['', '已確認的交付：' + manifest.delivery.url] : []), ''].join('\n');
      const handoffArtifact = await add('handoff.md', Buffer.from(handoff), 'text/markdown', '手動接續說明');
      if (manifest.result) manifest.result.handoffPath = path.join(destination, handoffArtifact.path);
      for (const [file, source] of sourceFiles) if (sha256(await safeFile(source.root, file)) !== source.hash) throw new Error('文件成果在封存期間變更；保留原件。');
      for (const privateFile of ['.changes.patch', '.empty-git-config']) await removeOwnedStorage(stage, path.join(stage, privateFile));
      const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
      if (manifestBytes.length > 8 * 1024 * 1024) throw new Error('成果清單超過容量限制；保留原工作目錄。');
      await writeDurable(path.join(stage, 'manifest.json'), manifestBytes);
      await this.verify(stage, manifest);
      await rename(stage, destination); stage = undefined;
      return this.read(record.id);
    } finally {
      try { if (stage) await removeOwnedStorage(this.directory, stage); } finally { await lock.release(); }
    }
  }
  private validate(manifest: CodexResultManifest, id: string, expectedRoot = this.resultRoot(id)): void {
    if (!manifest || manifest.schema !== CODEX_RESULT_SCHEMA || manifest.id !== id || !validResultId(id) || !path.isAbsolute(manifest.root) ||
      typeof manifest.title !== 'string' || manifest.title.length > 200 || typeof manifest.summary !== 'string' || manifest.summary.length > 8000 ||
      !['completed', 'manual', 'deleted'].includes(manifest.reason) || !Array.isArray(manifest.artifacts) || manifest.artifacts.length > CODEX_RESULT_MAX_FILES) throw new Error('成果清單格式無法驗證。');
    if (manifest.provisional !== undefined && (manifest.provisional !== true || manifest.result?.state !== 'uncertain')) throw new Error('暫存交接成果狀態無法驗證。');
    if (manifest.workId !== undefined && !validWorkId(manifest.workId)) throw new Error('成果工作關聯識別無效。');
    const allowed = new Set(['schema', 'id', 'title', 'root', 'status', 'createdAt', 'updatedAt', 'reason', 'provisional', 'summary', 'workId', 'origin', 'result', 'delivery', 'restore', 'wikiSeedArtifactId', 'wikiSeedScope', 'artifacts']);
    if (Object.keys(manifest).some(key => !allowed.has(key))) throw new Error('成果清單含非成果資料。');
    const forbidden = new Set(['prompt', 'threadId', 'turnId', 'runtimeRoot', 'requestId', 'transcript', 'accountKey', 'baseUrl', 'spec', 'ownerPid']);
    const inspect = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) { if (forbidden.has(key)) throw new Error('成果清單含非成果資料。'); inspect(child); }
    };
    inspect(manifest);
    const paths = new Set<string>(), ids = new Set<string>(); let total = 0;
    for (const artifact of manifest.artifacts) {
      if (!artifact || typeof artifact.path !== 'string' || artifact.path === 'manifest.json' || typeof artifact.id !== 'string' || !/^[a-f0-9]{32}$/.test(artifact.id) ||
        artifact.id !== createHash('sha256').update(artifact.path).digest('hex').slice(0, 32) || typeof artifact.name !== 'string' || typeof artifact.mediaType !== 'string' ||
        !Number.isSafeInteger(artifact.size) || artifact.size < 0 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('成果檔案描述無法驗證。');
      const key = resultPathKey(artifact.path); if (paths.has(key) || ids.has(artifact.id)) throw new Error('成果清單含重複路徑。');
      paths.add(key); ids.add(artifact.id); total += artifact.size;
    }
    if (total > CODEX_RESULT_MAX_BYTES) throw new Error('成果容量超過限制。');
    if (manifest.wikiSeedArtifactId !== undefined && (!manifest.artifacts.some(item => item.id === manifest.wikiSeedArtifactId && item.path === PROJECT_WIKI_SEED_PATH) ||
        manifest.origin?.kind !== 'project-wiki' || manifest.provisional)) throw new Error('Wiki 更新來源成果綁定無效。');
    if (manifest.wikiSeedScope !== undefined && (typeof manifest.wikiSeedScope !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.wikiSeedScope) ||
        !manifest.wikiSeedArtifactId || manifest.origin?.kind !== 'project-wiki' || manifest.provisional)) throw new Error('Wiki 更新來源索引無效。');
    if (manifest.result?.reportPath && !manifest.artifacts.some(artifact => artifact.path.startsWith('reports/') &&
      same(manifest.result!.reportPath!, path.join(expectedRoot, ...artifact.path.split('/'))))) throw new Error('報告路徑不屬於已保存成果。');
    if (manifest.result?.handoffPath && !same(manifest.result.handoffPath, path.join(expectedRoot, 'handoff.md'))) throw new Error('交接說明路徑不屬於已保存成果。');
    if (manifest.restore && (manifest.restore.schema !== 'GitLabWorkspaceCodexChanges/v1' || !path.isAbsolute(manifest.restore.originalRepository) ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(manifest.restore.baseSha) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(manifest.restore.headSha) ||
      !['sha1', 'sha256'].includes(manifest.restore.objectFormat) || !ids.has(manifest.restore.patchArtifactId) || !ids.has(manifest.restore.inventoryArtifactId) ||
      manifest.restore.commitBundleArtifactId !== undefined && !manifest.artifacts.some(artifact => artifact.id === manifest.restore!.commitBundleArtifactId && artifact.path === 'code/commits.bundle'))) throw new Error('成果還原綁定無法驗證。');
  }
  private async verify(root: string, manifest: CodexResultManifest, expectedRoot = this.resultRoot(manifest.id)): Promise<void> {
    this.validate(manifest, manifest.id, expectedRoot);
    for (const artifact of manifest.artifacts) {
      const bytes = await safeFile(root, path.join(root, ...artifact.path.split('/')));
      if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) throw new Error('成果內容與封存 hash 不符；保留執行資料。');
    }
  }
  private async load(id: string, verifyAll: boolean): Promise<CodexResultManifest> {
    const root = this.resultRoot(id);
    if (!same(await realpath(this.directory), this.directory)) throw new Error('成果儲存區不可重新導向。');
    if (!await ownedStoragePath(this.directory, root)) throw new Error('找不到已保存成果。');
    const manifest = JSON.parse((await safeFile(root, path.join(root, 'manifest.json'), 8 * 1024 * 1024)).toString('utf8')) as CodexResultManifest;
    this.validate(manifest, id); if (verifyAll) await this.verify(root, manifest); return structuredClone(manifest);
  }
  async read(id: string): Promise<CodexResultManifest> { return this.load(id, true); }
  async has(id: string): Promise<boolean> { return ownedStoragePath(this.directory, this.resultRoot(id)); }
  async list(): Promise<CodexResultManifest[]> {
    try {
      const entries = await readdir(this.directory, { withFileTypes: true }), results: CodexResultManifest[] = [];
      for (const entry of entries) if (validResultId(entry.name) && entry.isDirectory()) results.push(await this.load(entry.name, false));
      return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch (error) { if (missingFile(error)) return []; throw error; }
  }
  async readArtifact(taskId: string, artifactId: string): Promise<{ artifact: CodexArtifact; bytes: Buffer }> {
    const manifest = await this.load(taskId, false), artifact = manifest.artifacts.find(item => item.id === artifactId);
    if (!artifact) throw new Error('此成果沒有要求的檔案。');
    const bytes = await safeFile(this.resultRoot(taskId), path.join(this.resultRoot(taskId), ...artifact.path.split('/')));
    if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) throw new Error('成果檔案已變更。');
    return { artifact: structuredClone(artifact), bytes };
  }
  /** Legacy results without a seed return undefined so callers explicitly choose full regeneration. */
  async readWikiSeed(taskId: string, origin: CodexTaskOrigin): Promise<ProjectWikiSeed | undefined> {
    const manifest = await this.load(taskId, false);
    if (manifest.provisional || manifest.origin?.kind !== 'project-wiki' || manifest.origin.projectId !== origin.projectId ||
        manifest.origin.sourceSha !== origin.sourceSha || manifest.origin.projectPath !== origin.projectPath) throw new Error('Wiki 成果不屬於目前專案或固定版本。');
    if (!manifest.wikiSeedArtifactId) return;
    const { bytes } = await this.readArtifact(taskId, manifest.wikiSeedArtifactId);
    const seed = parseProjectWikiSeed(JSON.parse(bytes.toString('utf8')), origin);
    if (manifest.wikiSeedScope !== undefined && manifest.wikiSeedScope !== seed.origin.scope) throw new Error('Wiki 更新來源索引與成果不符。');
    return seed;
  }
  /** Find the latest confirmed source for this project/branch, including an earlier source SHA. */
  async latestWikiSeed(origin: CodexTaskOrigin): Promise<{ taskId: string; seed: ProjectWikiSeed } | undefined> {
    const scope = projectWikiSeedScope(origin);
    const candidates = (await this.list()).filter(manifest => manifest.wikiSeedScope === scope && !manifest.provisional &&
      manifest.origin?.kind === 'project-wiki' && manifest.origin.projectId === origin.projectId && manifest.origin.projectPath === origin.projectPath &&
      manifest.origin.sourceBranch === origin.sourceBranch && manifest.result?.state === 'published');
    const latest = candidates[0]; if (!latest) return;
    const seed = await this.readWikiSeed(latest.id, { ...origin, sourceSha: latest.origin!.sourceSha });
    if (!seed || seed.pages.some(page => !page.published)) throw new Error('已發布的 Wiki 更新來源缺少完整發布收據。');
    return { taskId: latest.id, seed };
  }
  restoreTo(taskId: string, originalRepository: string, destination: string): Promise<CodexManualWorkspace> {
    return restoreCodexResultChanges(this, taskId, originalRepository, destination);
  }
  /** Export to a new directory; never merge into or overwrite user files. */
  async exportTo(taskId: string, destination: string): Promise<void> {
    const manifest = await this.read(taskId), target = path.resolve(destination), parent = path.dirname(target);
    if (!same(await realpath(parent), parent)) throw new Error('匯出目的地不可重新導向。');
    try { await lstat(target); throw new Error('請選擇尚未存在的成果匯出目錄。'); } catch (error) { if (!missingFile(error)) throw error; }
    const stage = path.join(parent, '.codex-result-export-' + randomUUID()); await mkdir(stage, { mode: 0o700 });
    let moved = false;
    try {
      for (const artifact of manifest.artifacts) {
        const bytes = await safeFile(this.resultRoot(taskId), path.join(this.resultRoot(taskId), ...artifact.path.split('/'))), file = path.join(stage, ...artifact.path.split('/'));
        if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) throw new Error('匯出期間成果檔案已變更。');
        await mkdir(path.dirname(file), { recursive: true }); await writeDurable(file, bytes);
      }
      if (manifest.result?.reportPath) {
        const artifact = manifest.artifacts.find(item => item.path.startsWith('reports/')); if (artifact) manifest.result.reportPath = path.join(target, ...artifact.path.split('/'));
      }
      if (manifest.result?.handoffPath) manifest.result.handoffPath = path.join(target, 'handoff.md');
      await writeDurable(path.join(stage, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
      await this.verify(stage, manifest, target); await rename(stage, target); moved = true;
    } finally { if (!moved) await removeOwnedStorage(parent, stage); }
  }
}
