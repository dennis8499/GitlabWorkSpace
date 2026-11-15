import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { CodexTaskResult, CodexTaskSpec } from '../codex/protocol';
import { captureGitProcess } from '../git/gitProcess';
import type { PythonRuntime } from './pythonRuntime';
import type { WikiPageDigest, LocalWikiBaseline, WikiFinding, LocalWikiQualityReceipt } from './localWikiQualityProtocol';
export type { LocalWikiBaseline, LocalWikiQualityReceipt } from './localWikiQualityProtocol';
export type LocalWikiHelperRunner = (script: string, args: string[], root: string, python: PythonRuntime) => Promise<{ code: number; stdout: string }>;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const maxPages = 2000, maxPageBytes = 8 * 1024 * 1024, maxTotalBytes = 64 * 1024 * 1024, maxBaselineBytes = 512 * 1024;
const safePage = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
  !/[\\:]/.test(value) && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
  !value.startsWith('/') && value.split('/').every(part => part !== '.' && part !== '..' && part.length > 0) && /\.md$/i.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const knownFields = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).every(key => fields.includes(key));
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const count = (value: unknown, max: number): boolean => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;

/** Host-only validation of stored evidence. Missing legacy receipts remain optional at the caller. */
export function isLocalWikiQualityReceipt(value: unknown): value is LocalWikiQualityReceipt {
  try {
    if (!isObject(value) || !knownFields(value, ['schema', 'scope', 'changedPages', 'findings', 'unrelatedFindings', 'coverage', 'checks']) ||
        value.schema !== 'GitLabWorkspaceLocalWikiQuality/v1' || !['partial', 'full', 'inspection'].includes(String(value.scope)) ||
        !Array.isArray(value.changedPages) || value.changedPages.length > maxPages || !value.changedPages.every(safePage) || new Set(value.changedPages).size !== value.changedPages.length ||
        !Array.isArray(value.findings) || value.findings.length > 2000 || !count(value.unrelatedFindings, 20000) ||
        !Array.isArray(value.checks) || value.checks.length > 2 || Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) return false;
    if (!value.findings.every(item => isObject(item) && knownFields(item, ['severity', 'code', 'message', 'page']) &&
        ['critical', 'warning', 'info'].includes(String(item.severity)) && boundedText(item.code, 160) && boundedText(item.message, 8192) &&
        (item.page === undefined || safePage(item.page)))) return false;
    if (!value.checks.every(item => isObject(item) && knownFields(item, ['command', 'exitCode']) && boundedText(item.command, 2048) && count(item.exitCode, 255))) return false;
    return value.coverage === undefined || value.scope === 'full' && isObject(value.coverage) && knownFields(value.coverage, ['ok', 'status', 'errors']) &&
      typeof value.coverage.ok === 'boolean' && (value.coverage.status === undefined || boundedText(value.coverage.status, 100)) &&
      Array.isArray(value.coverage.errors) && value.coverage.errors.length <= 2000 && value.coverage.errors.every(item => boundedText(item, 8192));
  } catch { return false; }
}

export function isLocalWikiBaseline(value: unknown): value is LocalWikiBaseline {
  if (!isObject(value) || Object.keys(value).some(key => !['schema', 'binding', 'pages'].includes(key)) ||
      value.schema !== 'GitLabWorkspaceLocalWikiBaseline/v1' || typeof value.binding !== 'string' || !/^[a-f0-9]{64}$/.test(value.binding) ||
      !Array.isArray(value.pages) || value.pages.length > maxPages || Buffer.byteLength(JSON.stringify(value)) > maxBaselineBytes) return false;
  const seen = new Set<string>();
  let total = 0;
  return value.pages.every(page => {
    if (!isObject(page) || Object.keys(page).some(key => !['path', 'sha256', 'size', 'notes'].includes(key)) || !safePage(page.path) || seen.has(page.path) ||
        typeof page.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(page.sha256) || !Number.isSafeInteger(page.size) || Number(page.size) < 0 || Number(page.size) > maxPageBytes) return false;
    if (page.notes !== undefined && (!Array.isArray(page.notes) || page.notes.length > 32 || !page.notes.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)))) return false;
    seen.add(page.path); total += Number(page.size); return total <= maxTotalBytes;
  });
}
function operation(spec: CodexTaskSpec): 'update' | 'inspection' | undefined {
  if (spec.source.kind !== 'skill' || spec.skill?.name !== 'codebase-wiki') return;
  if (spec.source.featureId === 'ingest' || spec.source.featureId === 'lint' && spec.source.inputs['lint.operation'] === '重建索引') return 'update';
  if (spec.source.featureId === 'lint') return 'inspection';
}
const binding = (spec: CodexTaskSpec) => hash(JSON.stringify([path.resolve(spec.root), spec.source.kind === 'skill' ?
  [spec.source.featureId, spec.source.inputs] : spec.source.kind]));
function noteDigests(bytes: Buffer): string[] {
  const notes = [...bytes.toString('utf8').matchAll(/<!-- codebase-wiki:(user-notes|visualization-notes):start -->[\s\S]*?<!-- codebase-wiki:\1:end -->/g)].map(match => hash(match[0]));
  if (notes.length > 32) throw new Error('Wiki 人工備註區塊超過檢查範圍。');
  return notes;
}

async function pageDigests(root: string): Promise<WikiPageDigest[]> {
  const wiki = path.join(await realpath(root), 'wiki');
  try {
    const info = await lstat(wiki);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Wiki 目錄不可重新導向。');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const pages: WikiPageDigest[] = [];
  let total = 0;
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > 32) throw new Error('Wiki 目錄層級超過檢查範圍。');
    for (const item of await readdir(path.join(wiki, relative), { withFileTypes: true })) {
      const file = path.posix.join(relative, item.name), absolute = path.join(wiki, file), info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error('Wiki 不能包含符號連結。');
      if (info.isDirectory()) { await visit(file, depth + 1); continue; }
      if (!/\.md$/i.test(file)) continue;
      if (!info.isFile() || !safePage(file) || info.size > maxPageBytes || pages.length >= maxPages || total + info.size > maxTotalBytes) throw new Error('Wiki 超過本次安全檢查範圍，請縮小工作區。');
      const bytes = await readFile(absolute);
      if (bytes.length !== info.size) throw new Error('Wiki 在讀取時已變更，請重試檢查。');
      const notes = noteDigests(bytes);
      total += bytes.length; pages.push({ path: file, sha256: hash(bytes), size: bytes.length, ...(notes.length ? { notes } : {}) });
    }
  };
  await visit('', 0);
  return pages.sort((a, b) => a.path.localeCompare(b.path));
}

/** No Wiki scan occurs for Query or ordinary development/review tasks. */
export async function captureLocalWikiBaseline(spec: CodexTaskSpec): Promise<LocalWikiBaseline | undefined> {
  if (operation(spec) !== 'update') return;
  const baseline: LocalWikiBaseline = { schema: 'GitLabWorkspaceLocalWikiBaseline/v1', binding: binding(spec), pages: await pageDigests(spec.root) };
  if (!isLocalWikiBaseline(baseline)) throw new Error('Wiki 檢查基線超過保存限制。');
  return baseline;
}

const defaultRunner: LocalWikiHelperRunner = async (script, args, root, python) => captureGitProcess(python.executable,
  [...python.args, '-X', 'utf8', '-B', script, ...args], { cwd: root, env: { ...python.env, PYTHONDONTWRITEBYTECODE: '1' }, network: false, timeoutMs: 30_000, maxStdoutBytes: 4 * 1024 * 1024 });

/** Reuse the installed Wiki helper; the injected runner keeps subprocess boundaries testable. */
export async function inspectLocalWikiQuality(spec: CodexTaskSpec, python: PythonRuntime, baseline?: LocalWikiBaseline,
  run: LocalWikiHelperRunner = defaultRunner): Promise<{ result: CodexTaskResult; receipt: LocalWikiQualityReceipt } | undefined> {
  const kind = operation(spec);
  if (!kind) return;
  const full = spec.source.kind === 'skill' && spec.source.featureId === 'ingest' && spec.source.inputs['ingest.scope'] === '全部專案';
  const receipt: LocalWikiQualityReceipt = { schema: 'GitLabWorkspaceLocalWikiQuality/v1', scope: kind === 'inspection' ? 'inspection' : full ? 'full' : 'partial', changedPages: [], findings: [], unrelatedFindings: 0, checks: [] };
  const issue = (code: string, message: string, page?: string) => receipt.findings.push({ severity: 'critical', code, message, ...(page ? { page } : {}) });
  try {
    const current = await pageDigests(spec.root);
    if (kind === 'update') {
      if (!isLocalWikiBaseline(baseline) || baseline.binding !== binding(spec)) throw new Error('缺少本次 Wiki 更新的有效基線；保留成果，重新準備後核對。');
      const previous = new Map(baseline.pages.map(page => [page.path, page]));
      const now = new Map(current.map(page => [page.path, page]));
      receipt.changedPages = [...new Set([...previous.keys(), ...now.keys()])].filter(file => previous.get(file)?.sha256 !== now.get(file)?.sha256).sort();
      for (const [file, page] of previous) {
        const updated = now.get(file);
        if (!updated) issue('page_deleted', '知識更新不得刪除既有頁面；請保留原頁並明確處理改名或刪除。', file);
        else if (page.notes?.some(digest => !updated.notes?.includes(digest))) issue('manual_notes_changed', '既有人工備註區塊被修改或移除，請先還原並核對差異。', file);
      }
      const oldLog = previous.get('log.md');
      if (oldLog) {
        const log = now.get('log.md');
        if (!log || log.size < oldLog.size || hash((await readFile(path.join(spec.root, 'wiki', 'log.md'))).subarray(0, oldLog.size)) !== oldLog.sha256) issue('log_rewritten', '既有 Wiki 日誌被改寫，必須先還原原有內容。', 'log.md');
      }
      if (receipt.changedPages.length) {
        if (!now.has('index.md')) issue('missing_index', 'Wiki 更新缺少索引。', 'index.md');
        if (!now.has('log.md') || previous.get('log.md')?.sha256 === now.get('log.md')?.sha256) issue('missing_log_append', 'Wiki 更新尚未追加本次日誌。', 'log.md');
      } else if (!full) return { result: { state: 'ready', summary: '本次未變更 Wiki；沒有執行全量掃描或更新。', files: [], wikiQuality: receipt }, receipt };
    }
    const scripts = path.join(path.dirname(spec.skill!.path), 'scripts');
    const lint = await run(path.join(scripts, 'lint-wiki.py'), [path.join(spec.root, 'wiki'), '--repo-root', spec.root, '--format', 'json'], spec.root, python);
    receipt.checks.push({ command: 'Codebase Wiki lint', exitCode: lint.code });
    const parsed: unknown = JSON.parse(lint.stdout);
    if (![0, 1, 2].includes(lint.code) || !isObject(parsed) || !isObject(parsed.summary) || !Array.isArray(parsed.findings) || parsed.findings.length > 20000 ||
        !['critical', 'warning', 'pass'].includes(String(parsed.deterministic_status))) throw new Error('Wiki helper 未回傳完整的機器檢查結果。');
    for (const item of parsed.findings) {
      if (!isObject(item) || !['critical', 'warning', 'info'].includes(String(item.severity)) || typeof item.code !== 'string' || typeof item.message !== 'string' || item.page !== undefined && !safePage(item.page)) throw new Error('Wiki helper 問題清單格式無效。');
      if (kind === 'update' && !full && (typeof item.page !== 'string' || !receipt.changedPages.includes(item.page))) { receipt.unrelatedFindings++; continue; }
      receipt.findings.push({ severity: item.severity as WikiFinding['severity'], code: item.code, message: item.message, ...(typeof item.page === 'string' ? { page: item.page } : {}) });
    }
    if (full) {
      const coverageArgs = ['validate', '--root', spec.root, '--ledger', path.join(spec.root, 'wiki', 'ingest-coverage.json')];
      // A full Group ingest keeps the original Group scope, including unmapped local Repos.
      if (spec.source.kind === 'skill' && spec.source.inputs['wiki.profile'] === 'group') coverageArgs.push('--scope', 'group');
      const coverage = await run(path.join(scripts, 'ingest-coverage.py'), coverageArgs, spec.root, python);
      receipt.checks.push({ command: 'Codebase Wiki full-ingest coverage', exitCode: coverage.code });
      const value: unknown = JSON.parse(coverage.stdout);
      if (!isObject(value) || typeof value.ok !== 'boolean' || value.errors !== undefined && !Array.isArray(value.errors)) throw new Error('Wiki coverage helper 結果格式無效。');
      receipt.coverage = { ok: value.ok && coverage.code === 0, ...(typeof value.status === 'string' ? { status: value.status } : {}), errors: Array.isArray(value.errors) ? value.errors.map(error => String(error)) : [] };
    }
    const after = await pageDigests(spec.root);
    if (JSON.stringify(after) !== JSON.stringify(current)) issue('wiki_drift', 'Wiki 在機器檢查期間變更，請重新核對。');
  } catch (error) { issue('verification_unavailable', error instanceof Error ? error.message : String(error)); }
  if (!isLocalWikiQualityReceipt(receipt)) throw new Error('Wiki 品質收據格式無效或超過 512 KiB 保存上限；未截斷證據，請縮小更新範圍後重試。');
  const blocking = receipt.findings.filter(item => item.severity === 'critical' || ['stale_source', 'missing_source'].includes(item.code));
  const failed = receipt.findings.some(item => item.code === 'verification_unavailable') || kind === 'update' && (blocking.length > 0 || receipt.coverage?.ok === false);
  const summary = [`本地 Wiki ${receipt.scope === 'full' ? '全量更新' : receipt.scope === 'partial' ? '局部更新' : '品質檢查'}：${receipt.changedPages.length} 頁變更，${receipt.findings.filter(item => item.severity === 'critical').length} 項 critical、${receipt.findings.filter(item => item.severity === 'warning').length} 項 warning。`,
    receipt.unrelatedFindings ? `其他既有頁面另有 ${receipt.unrelatedFindings} 項問題，不阻擋本次局部更新。` : '',
    ...receipt.findings.slice(0, 12).map(item => `${item.page ? item.page + '：' : ''}${item.message}`),
    receipt.findings.length > 12 ? `其餘 ${receipt.findings.length - 12} 項詳見完整 Wiki 品質收據。` : '',
    receipt.coverage?.ok === false ? '全量 coverage 尚未完整，保留現有 Wiki 與缺口。' : '',
    '機器結果不代替來源事實與內容語意核對。'].filter(Boolean).join('\n');
  return { result: { state: failed ? 'needs-work' : 'ready', summary, files: receipt.changedPages.map(file => 'wiki/' + file), tests: receipt.checks, wikiQuality: receipt }, receipt };
}

export async function collectLocalWikiQuality(spec: CodexTaskSpec, python: PythonRuntime, baseline?: LocalWikiBaseline,
  run?: LocalWikiHelperRunner): Promise<CodexTaskResult | undefined> {
  return (await inspectLocalWikiQuality(spec, python, baseline, run))?.result;
}
