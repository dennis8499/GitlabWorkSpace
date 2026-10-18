import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import { parse as parseToml } from '@iarna/toml';
import { parseDocument } from 'yaml';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import type {
  BmadArtifact, BmadCatalogNode, BmadConfirmation, BmadConfirmationRequest, BmadDiagnostic,
  BmadProgressStatus, BmadStoryProgress, BmadWorkflowSnapshot
} from './bmadProtocol';

export interface ReadBmadWorkflowOptions {
  root?: string;
  /** CSV text shipped with the extension; never a path supplied by the webview. */
  bundledCatalog: string;
  confirmations?: readonly BmadConfirmation[];
  maxArtifactBytes?: number;
  signal?: AbortSignal;
  cache?: BmadReadCache;
}
const CONFIG_PATHS = ['_bmad/config.toml', '_bmad/config.user.toml', '_bmad/custom/config.toml', '_bmad/custom/config.user.toml'];
const MAX_FILES = 2000;
const MAX_DEPTH = 5;
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const inside = (root: string, target: string): boolean => { const relative = path.relative(root, target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
const missing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');
const splitRefs = (value: string): string[] => value.split(/[,;|]/).map(part => part.trim()).filter(Boolean);

/** RFC 4180 quoting, including embedded commas, quotes, and newlines. */
export function parseBmadCatalog(csv: string): BmadCatalogNode[] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false;
  const source = csv.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { field += '"'; index++; }
      else if (quoted || !field) quoted = !quoted;
      else throw new Error('BMAD catalog 引號格式不正確。');
    } else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[index + 1] === '\n') index++;
      row.push(field); if (row.some(value => value.trim())) rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (quoted) throw new Error('BMAD catalog 尚未寫完（引號未結束）。');
  row.push(field); if (row.some(value => value.trim())) rows.push(row);
  const header = rows.shift()?.map(value => value.trim()) ?? [];
  if (new Set(header).size !== header.length) throw new Error('BMAD catalog 欄位名稱重複。');
  for (const required of ['module', 'skill', 'display-name', 'phase', 'output-location', 'outputs']) {
    if (!header.includes(required)) throw new Error(`BMAD catalog 缺少 ${required} 欄位。`);
  }
  const result: BmadCatalogNode[] = []; const seen = new Set<string>();
  for (const values of rows) {
    if (values.length !== header.length) throw new Error('BMAD catalog 欄位數不一致。');
    const entry = Object.fromEntries(header.map((name, index) => [name, values[index].trim()]));
    if (entry.skill === '_meta' || !entry.skill) continue;
    if (!/^[a-z][a-z0-9-]*$/.test(entry.skill) || (entry.action && !/^[a-zA-Z0-9_-]+$/.test(entry.action))) throw new Error('BMAD catalog 包含無效的 skill 或 action。');
    if (!['', 'true', 'false'].includes(entry.required ?? '')) throw new Error('BMAD catalog required 必須為 true 或 false。');
    const id = `${entry.module}:${entry.skill}:${entry.action ?? ''}`;
    if (seen.has(id)) throw new Error(`BMAD catalog 重複節點 ${id}。`); seen.add(id);
    result.push({ id, module: entry.module, skill: entry.skill, displayName: entry['display-name'] || entry.skill,
      menuCode: entry['menu-code'] ?? '', description: entry.description ?? '', action: entry.action ?? '', args: entry.args ?? '',
      phase: entry.phase || 'anytime', required: entry.required === 'true', precededBy: splitRefs(entry['preceded-by'] ?? ''),
      followedBy: splitRefs(entry['followed-by'] ?? ''), outputLocation: entry['output-location'] ?? '', outputs: splitRefs(entry.outputs ?? '') });
  }
  return result;
}

function yamlValue(text: string): unknown {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors[0].message);
  return document.toJS({ maxAliasCount: 20 });
}
function yaml(text: string): Record<string, unknown> { return object(yamlValue(text)); }
function merge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('BMAD 設定包含不允許的欄位名稱。');
    if (value && typeof value === 'object' && !Array.isArray(value)) { const nested = object(target[key]); target[key] = nested; merge(nested, object(value)); }
    else target[key] = value;
  }
}
function flatten(value: Record<string, unknown>, result: Map<string, string>, prefix = ''): void {
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof item === 'string') { result.set(name, item); if (!prefix || prefix === 'core' || prefix === 'modules.bmm') result.set(key, item); }
    else if (item && typeof item === 'object' && !Array.isArray(item)) flatten(object(item), result, name);
  }
}
function frontmatter(content: string): Record<string, unknown> {
  content = content.replace(/^\uFEFF/, '');
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return {};
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error('Markdown frontmatter 尚未寫完。');
  return yaml(match[1]);
}
interface ReadFile { content: string; fingerprint: string; observedAt: string }
/** Only bounded file contents are cached. Every hit still verifies path and file identity. */
export class BmadReadCache {
  private readonly values = new Map<string, { stamp: string; value: ReadFile; bytes: number }>();
  private bytes = 0;
  private readonly derived = new Map<string, { value: unknown; bytes: number }>();
  private derivedBytes = 0;
  constructor(private readonly maxBytes = 16 * 1024 * 1024) {}
  clear(): void { this.values.clear(); this.bytes = 0; this.derived.clear(); this.derivedBytes = 0; }
  derive<T>(key: string, sourceBytes: number, compute: () => T): T {
    const cached = this.derived.get(key);
    if (cached) { this.derived.delete(key); this.derived.set(key, cached); return cached.value as T; }
    const value = compute(), bytes = sourceBytes * 32 + 256;
    if (bytes > this.maxBytes) return value;
    this.derived.set(key, { value, bytes }); this.derivedBytes += bytes;
    while (this.derivedBytes > this.maxBytes || this.derived.size > 2048) {
      const oldest = this.derived.keys().next().value!; this.derivedBytes -= this.derived.get(oldest)!.bytes; this.derived.delete(oldest);
    }
    return value;
  }
  get(file: string, stamp: string): ReadFile | undefined {
    const cached = this.values.get(file);
    if (!cached || cached.stamp !== stamp) return undefined;
    this.values.delete(file); this.values.set(file, cached); return cached.value;
  }
  set(file: string, stamp: string, value: ReadFile): void {
    const old = this.values.get(file); if (old) { this.bytes -= old.bytes; this.values.delete(file); }
    const bytes = Buffer.byteLength(value.content) * 2;
    if (bytes > this.maxBytes) return;
    this.values.set(file, { stamp, value, bytes }); this.bytes += bytes;
    while (this.bytes > this.maxBytes || this.values.size > 2048) {
      const key = this.values.keys().next().value!; this.bytes -= this.values.get(key)!.bytes; this.values.delete(key);
    }
  }
}
interface Reader {
  read(file: string, optional?: boolean): Promise<ReadFile | undefined>;
  metadata(data: ReadFile): Record<string, unknown>;
  value(data: ReadFile): unknown;
  diagnostic(code: string, message: string, file?: string): void;
}
function makeReader(root: string, diagnostics: BmadDiagnostic[], limit: number, signal?: AbortSignal, cache = new BmadReadCache()): Reader {
  const diagnostic = (code: string, message: string, file?: string): void => { diagnostics.push({ code, message, path: file }); };
  return { diagnostic,
    metadata: data => cache.derive('frontmatter:' + data.fingerprint, Buffer.byteLength(data.content), () => frontmatter(data.content)),
    value: data => cache.derive('yaml:' + data.fingerprint, Buffer.byteLength(data.content), () => yamlValue(data.content)),
    async read(file, optional = true) {
    signal?.throwIfAborted();
    try {
      if (!inside(root, file)) throw new Error('路徑超出目前專案根目錄。');
      const before = await fs.lstat(file);
      if (before.isSymbolicLink() || !before.isFile()) throw new Error('不讀取符號連結或非一般檔案。');
      if (!inside(root, await fs.realpath(file))) throw new Error('實際路徑超出目前專案根目錄。');
      if (before.size > limit) throw new Error(`檔案超過 ${limit} bytes，未讀取。`);
      signal?.throwIfAborted();
      const stamp = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
      const cached = cache.get(file, stamp); if (cached) return cached;
      const handle = await fs.open(file, 'r');
      try {
        const opened = await handle.stat();
        if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile()) throw new Error('檔案身分已變更；請稍後重新整理。');
        if (opened.size > limit) throw new Error(`檔案超過 ${limit} bytes，未讀取。`);
        const buffer = Buffer.alloc(Math.min(limit + 1, before.size + 1)); let length = 0;
        while (length < buffer.length) { signal?.throwIfAborted(); const result = await handle.read(buffer, length, buffer.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
        if (length > limit) throw new Error(`檔案超過 ${limit} bytes，未讀取。`);
        const after = await handle.stat(); const current = await fs.lstat(file);
        if (current.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== current.ino || before.dev !== current.dev) throw new Error('檔案寫入中；請稍後重新整理。');
        const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
        signal?.throwIfAborted();
        const value = { content, fingerprint: hash(buffer.subarray(0, length)), observedAt: before.mtime.toISOString() }; cache.set(file, stamp, value); return value;
      } finally { await handle.close(); }
    } catch (error) { if (signal?.aborted) throw error; if (missing(error) && optional) return undefined; diagnostic('read-failed', (error as Error).message, file); return undefined; }
  } };
}

const NAMES: Record<string, RegExp> = {
  'bmad-project-context': /^AGENTS\.md$/i,
  'bmad-brainstorming': /^(?:\.memlog|brainstorm.*)\.md$/i,
  'bmad-product-brief': /^(?:product-brief(?:-.+)?|brief)\.md$/i,
  'bmad-prfaq': /^prfaq(?!.*-distillate\.md$).*\.md$/i,
  'bmad-prd': /^prd(?:-.+)?\.md$/i,
  'bmad-ux': /^(?:DESIGN|EXPERIENCE)\.md$/i,
  'bmad-architecture': /^ARCHITECTURE-SPINE\.md$/i,
  'bmad-create-epics-and-stories': /^epics\.md$/i,
  'bmad-sprint-planning': /^sprint-status\.ya?ml$/i,
  'bmad-spec': /^SPEC\.md$/i,
  'bmad-build': /^spec-.+\.md$/i,
  'bmad-retrospective': /retro(?:spective)?.*\.md$/i
};
const FINAL_SKILLS = new Set(['bmad-prd', 'bmad-ux', 'bmad-architecture', 'bmad-create-epics-and-stories']);
const STORY_STATUSES = new Set(['draft', 'backlog', 'ready-for-dev', 'in-progress', 'review', 'in-review', 'done']);
const PHASE_LABELS: Record<string, string> = { plan: '規劃與設計', '2-planning': '需求規劃', ship: '實作與交付', anytime: '隨時可用' };
const WORK_STAGES: Record<string, string> = { draft: '草稿', backlog: '待開始', 'ready-for-dev': '待實作',
  'in-progress': '進行中', review: '待審查', 'in-review': '審查中', done: '已完成', final: '正式完成', incomplete: '未完成' };
const BUILD_STAGES: Record<string, string> = { draft: '規劃草稿', 'ready-for-dev': '待實作', 'in-progress': '實作中', 'in-review': 'Build 內建審查中', done: 'Build 已完成' };
const PRFAQ_STAGES: Record<string, string> = { ignition: '構想釐清', 'press-release': '新聞稿', 'customer-faq': '客戶 FAQ', 'internal-faq': '內部 FAQ', complete: '結論完成' };
const RETRO_VERDICTS: Record<string, string> = { accepted: '驗收通過', 'accepted-with-open-items': '驗收通過，仍有待辦', rejected: '驗收未通過' };

function buildStage(status: string, route?: unknown): string | undefined {
  return status === 'in-progress' && route === 'oneshot' ? '實作與內建審查中' : BUILD_STAGES[status] ?? WORK_STAGES[status];
}

function artifactState(node: BmadCatalogNode, content: string, fm = frontmatter(content)): Pick<BmadArtifact, 'status' | 'reason' | 'marker' | 'canConfirm' | 'nativeStatus' | 'stage'> {
  const raw = fm.status;
  if (raw !== undefined && typeof raw !== 'string') return { status: 'error', reason: 'status 不是字串，無法判讀。', canConfirm: false };
  const status = typeof raw === 'string' ? raw.toLowerCase().trim() : undefined;
  const native = { nativeStatus: status, stage: status ? node.skill === 'bmad-build' ? buildStage(status, fm.route) : WORK_STAGES[status] : undefined };
  if (node.skill === 'bmad-prfaq' && status && PRFAQ_STAGES[status]) return { ...native, stage: PRFAQ_STAGES[status],
    status: status === 'complete' ? 'complete' : 'draft', reason: `PRFAQ 正式狀態：${status}。`, marker: `status: ${status}`, canConfirm: false };
  if (node.skill === 'bmad-brainstorming' && status === 'complete') return { ...native, stage: '腦力激盪完成', status: 'complete', reason: 'Brainstorm 記錄明確標示 complete。', marker: 'status: complete', canConfirm: false };
  if (node.skill === 'bmad-retrospective' && fm.verdict !== undefined) {
    if (typeof fm.verdict !== 'string' || !RETRO_VERDICTS[fm.verdict]) return { ...native, status: 'error', reason: 'Retrospective verdict 無法判讀。', canConfirm: false };
    if (!status) return { status: 'needs-confirmation', nativeStatus: fm.verdict, stage: RETRO_VERDICTS[fm.verdict],
      reason: `已記錄回顧結論「${RETRO_VERDICTS[fm.verdict]}」；verdict 不代表回顧流程已完成。`, marker: `verdict: ${fm.verdict}`, canConfirm: true };
  }
  if (node.skill === 'bmad-build' && status === 'done') return { ...native, status: 'complete', reason: 'Build 產物明確標示 done；Story 審查狀態另依正式追蹤來源顯示。', marker: 'status: done', canConfirm: false };
  if (status === 'final' && FINAL_SKILLS.has(node.skill)) return { ...native, status: 'complete', reason: 'BMAD 正式完成標記。', marker: 'status: final', canConfirm: false };
  if (['draft', 'in-progress', 'incomplete', 'ready-for-dev', 'review', 'in-review', 'backlog'].includes(status ?? '')) return { ...native, status: 'draft', reason: `產物明確標示 ${status}。`, marker: `status: ${status}`, canConfirm: false };
  if (status && !['final', 'done', 'complete', 'completed'].includes(status)) return { ...native, status: 'error', reason: `未支援的 status: ${status}；不能自行確認覆寫。`, marker: `status: ${status}`, canConfirm: false };
  return { ...native, status: 'needs-confirmation', reason: '已偵測產物，但沒有此流程可驗證的完成標記。', marker: status ? `status: ${status}` : undefined, canConfirm: true };
}

function stepStatus(artifacts: BmadArtifact[], node: BmadCatalogNode): { status: BmadProgressStatus; summary: string } {
  if (!artifacts.length) return { status: 'not-observed', summary: '未偵測到可歸屬的產物；不代表尚未執行。' };
  if (artifacts.some(artifact => artifact.status === 'error')) return { status: 'error', summary: '部分產物無法安全判讀，請查看診斷。' };
  if (node.skill === 'bmad-ux') {
    const folders = new Map<string, BmadArtifact[]>();
    for (const artifact of artifacts) { const directory = path.dirname(artifact.path); folders.set(directory, [...folders.get(directory) ?? [], artifact]); }
    if ([...folders.values()].some(group => !['design.md', 'experience.md'].every(name => group.some(artifact => path.basename(artifact.path).toLowerCase() === name)))) return { status: 'draft', summary: 'UX 需同一輸出範圍的 DESIGN.md 與 EXPERIENCE.md 均完成。' };
  }
  const completed = artifacts.filter(artifact => artifact.status === 'complete').length;
  if (artifacts.some(artifact => artifact.status === 'draft')) return { status: 'draft', summary: `已完成 ${completed}/${artifacts.length} 份產物；仍有草稿待續作。` };
  if (artifacts.some(artifact => artifact.status === 'needs-confirmation')) return { status: 'needs-confirmation', summary: `已完成 ${completed}/${artifacts.length} 份產物；其餘完成狀態待確認。` };
  return { status: 'complete', summary: `已確認 ${artifacts.length} 份產物完成。` };
}

export function createBmadConfirmation(snapshot: BmadWorkflowSnapshot, request: BmadConfirmationRequest, now = new Date()): BmadConfirmation {
  if (!snapshot.root || request.revision !== snapshot.revision) throw new Error('BMAD 狀態已變更，請重新整理後確認。');
  const artifact = snapshot.steps.find(step => step.id === request.stepId)?.artifacts.find(item => item.id === request.artifactId);
  if (!artifact || !artifact.canConfirm || artifact.status !== 'needs-confirmation') throw new Error('只能確認目前無法判定完成狀態的個別產物；明確未完成或無效產物不可覆寫。');
  return { root: snapshot.root, stepId: request.stepId, artifactId: artifact.id, fingerprint: artifact.fingerprint, confirmedAt: now.toISOString() };
}
export function revokeBmadConfirmation(confirmations: readonly BmadConfirmation[], root: string, stepId: string, artifactId: string): BmadConfirmation[] {
  return confirmations.filter(item => !(item.root === root && item.stepId === stepId && item.artifactId === artifactId));
}

export async function readBmadWorkflow(options: ReadBmadWorkflowOptions): Promise<BmadWorkflowSnapshot> {
  options.signal?.throwIfAborted();
  const diagnostics: BmadDiagnostic[] = []; let nodes: BmadCatalogNode[] = [];
  try { nodes = parseBmadCatalog(options.bundledCatalog); } catch (error) { diagnostics.push({ code: 'bundled-catalog-invalid', message: (error as Error).message }); }
  const snapshot: BmadWorkflowSnapshot = { root: options.root ? path.resolve(options.root) : undefined, revision: '',
    installation: { state: 'missing', reason: options.root ? '此根目錄尚未安裝 BMAD。' : '請先選擇專案根目錄。' },
    catalogSource: 'bundled', nodes, phases: [], edges: [], steps: [], stories: [], currentCandidates: [], recommendations: [], watchDirectories: [], diagnostics };
  if (snapshot.root) {
    try { snapshot.root = await fs.realpath(snapshot.root); } catch (error) { diagnostics.push({ code: 'root-unavailable', message: (error as Error).message, path: snapshot.root }); snapshot.installation = { state: 'error', reason: '專案根目錄無法讀取。' }; }
    options.signal?.throwIfAborted();
    const root = snapshot.root!; const reader = makeReader(root, diagnostics, options.maxArtifactBytes ?? 1024 * 1024, options.signal, options.cache);
    snapshot.watchDirectories = [root, path.join(root, '_bmad'), path.join(root, '_bmad', '_config'), path.join(root, '_bmad', 'custom')];
    const manifestFile = path.join(root, '_bmad', '_config', 'manifest.yaml');
    const manifest = await reader.read(manifestFile);
    if (manifest) {
      try {
        const data = object(reader.value(manifest)); const installation = object(data.installation);
        const version = installation.version ?? data.version;
        snapshot.version = typeof version === 'string' ? version : undefined;
        snapshot.installation = snapshot.version === '6.12.4'
          ? { state: 'ready', reason: `已偵測 BMAD ${snapshot.version}。` }
          : { state: 'unsupported', reason: `目前支援 BMAD 6.12.4；偵測版本：${snapshot.version ?? '不明'}。` };
      } catch (error) { snapshot.installation = { state: 'error', reason: 'BMAD 安裝 manifest 無法判讀。' }; reader.diagnostic('manifest-invalid', (error as Error).message, manifestFile); }
    } else if (diagnostics.some(item => item.path === manifestFile)) snapshot.installation = { state: 'error', reason: 'BMAD 安裝 manifest 無法讀取。' };
    if (snapshot.installation.state === 'ready') {
      const catalog = await reader.read(path.join(root, '_bmad', '_config', 'bmad-help.csv'));
      if (catalog) {
        try { snapshot.nodes = parseBmadCatalog(catalog.content); snapshot.catalogSource = 'installed'; }
        catch (error) { snapshot.installation = { state: 'error', reason: '已安裝 catalog 無法判讀；顯示隨附流程。' }; reader.diagnostic('catalog-invalid', (error as Error).message); }
      } else { snapshot.installation = { state: 'error', reason: '已安裝 BMAD 缺少 catalog；顯示隨附流程。' }; }
      if (snapshot.installation.state === 'ready') await readProgress(snapshot, options, reader);
    }
  }
  const phaseOrder = ['plan', '2-planning', 'ship', 'anytime'];
  const phaseIds = [...new Set(snapshot.nodes.map(node => node.phase))].sort((a, b) => { const ai = phaseOrder.indexOf(a), bi = phaseOrder.indexOf(b); return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi); });
  snapshot.phases = phaseIds.map(id => ({ id, label: PHASE_LABELS[id] ?? id, nodeIds: snapshot.nodes.filter(node => node.phase === id).map(node => node.id) }));
  const edgeKeys = new Set<string>();
  const addEdge = (from: string, to: string): void => { if (from !== to && !edgeKeys.has(`${from}|${to}`)) { edgeKeys.add(`${from}|${to}`); snapshot.edges.push({ from, to }); } };
  for (const node of snapshot.nodes) {
    const resolve = (reference: string): BmadCatalogNode | undefined => snapshot.nodes.find(other => other.module === node.module && `${other.skill}${other.action ? `:${other.action}` : ''}` === reference);
    for (const reference of node.precededBy) { const previous = resolve(reference); if (previous) addEdge(previous.id, node.id); }
    for (const reference of node.followedBy) { const next = resolve(reference); if (next) addEdge(node.id, next.id); }
  }
  if (!snapshot.steps.length) snapshot.steps = snapshot.nodes.map(node => ({ id: node.id, artifacts: [], ...stepStatus([], node) }));
  const pending = snapshot.steps.filter(step => ['draft', 'needs-confirmation', 'conflict'].includes(step.status));
  snapshot.currentCandidates = pending.flatMap(step => step.artifacts.filter(artifact => artifact.status !== 'complete').map(artifact => ({ stepId: step.id, artifactId: artifact.id, label: artifact.relativePath, reason: artifact.reason })));
  const build = snapshot.nodes.find(node => node.skill === 'bmad-build');
  const review = snapshot.nodes.find(node => node.skill === 'bmad-code-review');
  const help = snapshot.nodes.find(node => node.skill === 'bmad-help');
  const storyNode = (story: BmadStoryProgress): BmadCatalogNode | undefined => story.status === 'conflict' || story.association === 'unconfirmed' || story.association === 'ambiguous' ? help ?? build
    : story.mode === 'spec' ? build : ['review', 'in-review'].includes(story.status) ? review ?? build : build;
  for (const story of snapshot.stories.filter(story => story.status !== 'done' && story.status !== 'backlog')) {
    const node = storyNode(story); if (node) snapshot.currentCandidates.push({ stepId: node.id, storyId: story.id, label: story.label, reason: story.reason });
  }
  const storyRecommendations = snapshot.stories.filter(story => story.status !== 'done').map(storyNode).filter((node): node is BmadCatalogNode => !!node);
  const suggestedIds = [...new Set(storyRecommendations.length ? storyRecommendations.map(node => node.id) : snapshot.currentCandidates.map(item => item.stepId))];
  if (!suggestedIds.length) { const next = help ?? build; if (next) suggestedIds.push(next.id); }
  snapshot.recommendations = suggestedIds.map(stepId => ({ stepId, reason: storyRecommendations.some(node => node.id === stepId)
    ? '依 Story 正式記錄提供續作或審查候選；啟動後仍由 BMAD 核對適用輸入。'
    : pending.some(step => step.id === stepId) ? '有待續作或待確認的產物；請先確認目前內容。' : '產物不足以確定路徑；請讓 BMAD 核對目前位置與適合的下一步。' }));
  if (snapshot.root) {
    const root = snapshot.root;
    for (const directory of [...new Set(snapshot.watchDirectories)]) {
      let ancestor = directory;
      while (inside(root, ancestor)) {
        try {
          const stat = await fs.lstat(ancestor);
          if (stat.isDirectory() && !stat.isSymbolicLink() && inside(root, await fs.realpath(ancestor))) { snapshot.watchDirectories.push(ancestor); break; }
          if (stat.isSymbolicLink()) break;
        } catch (error) { if (!missing(error)) break; }
        if (ancestor === root) break;
        ancestor = path.dirname(ancestor);
      }
    }
  }
  snapshot.watchDirectories = [...new Set(snapshot.watchDirectories)].sort();
  options.signal?.throwIfAborted();
  // Observation time can change without any semantic workflow change. It must
  // not invalidate a copy or confirmation request pinned to this evidence.
  snapshot.revision = hash(JSON.stringify({ ...snapshot, revision: '' }, (key, value) => key === 'observedAt' ? undefined : value));
  snapshot.observedAt = new Date().toISOString();
  return snapshot;
}

async function readProgress(snapshot: BmadWorkflowSnapshot, options: ReadBmadWorkflowOptions, reader: Reader): Promise<void> {
  const root = snapshot.root!; const config: Record<string, unknown> = {};
  for (const name of CONFIG_PATHS) {
    options.signal?.throwIfAborted();
    const file = path.join(root, name); const diagnosticCount = snapshot.diagnostics.length; const value = await reader.read(file);
    if (!value && snapshot.diagnostics.length > diagnosticCount) snapshot.installation = { state: 'error', reason: 'BMAD TOML 設定無法安全讀取。' };
    if (value) { try { merge(config, object(options.cache?.derive('toml:' + value.fingerprint, Buffer.byteLength(value.content), () => parseToml(value.content)) ?? parseToml(value.content))); } catch (error) { reader.diagnostic('config-invalid', (error as Error).message, file); snapshot.installation = { state: 'error', reason: 'BMAD TOML 設定無法判讀。' }; } }
  }
  if (snapshot.installation.state !== 'ready') return;
  const variables = new Map<string, string>([['project-root', root], ['output_folder', '_bmad-output'], ['planning_artifacts', '{output_folder}/planning-artifacts'], ['implementation_artifacts', '{output_folder}/implementation-artifacts']]);
  flatten(config, variables);
  const resolve = (location: string): string | undefined => {
    let value = variables.get(location) ?? location;
    for (let index = 0; index < 10; index++) { const next = value.replace(/\{([^}]+)\}/g, (original, key: string) => variables.get(key) ?? original); if (next === value) break; value = next; }
    if (/\{[^}]+\}/.test(value)) { reader.diagnostic('output-unresolved', `無法解析輸出路徑：${location}`); return undefined; }
    const target = path.resolve(root, value);
    if (!inside(root, target)) { reader.diagnostic('output-outside-root', '輸出路徑超出目前專案，未掃描。', target); return undefined; }
    if (target === root) snapshot.watchRootArtifacts = true;
    return target;
  };
  const filesCache = new Map<string, Promise<string[]>>(); let scannedFiles = 0, scannedDirectories = 0;
  const scan = (directory: string): Promise<string[]> => {
    const cached = filesCache.get(directory); if (cached) return cached;
    const task = (async (): Promise<string[]> => {
      const results: string[] = [];
      const visit = async (current: string, depth: number): Promise<void> => {
        options.signal?.throwIfAborted();
        try {
          if (++scannedDirectories > 256) { reader.diagnostic('scan-limit', '輸出掃描達 256 個目錄上限。', current); return; }
          const stat = await fs.lstat(current);
          if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(root, await fs.realpath(current))) { reader.diagnostic('unsafe-directory', '略過符號連結或專案外輸出目錄。', current); return; }
          const entries = await fs.readdir(current, { withFileTypes: true });
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            options.signal?.throwIfAborted();
            if (scannedFiles % 64 === 0) await yieldToHost();
            if (scannedFiles >= MAX_FILES) { reader.diagnostic('scan-limit', `輸出掃描達 ${MAX_FILES} 個檔案上限。`, current); return; }
            const target = path.join(current, entry.name);
            if (entry.isSymbolicLink()) { reader.diagnostic('unsafe-symlink', '略過符號連結。', target); continue; }
            if (entry.isDirectory() && current !== root && !['.git', 'node_modules', '_bmad'].includes(entry.name)) {
              if (depth < MAX_DEPTH) await visit(target, depth + 1);
              else reader.diagnostic('scan-depth-limit', `輸出掃描達 ${MAX_DEPTH} 層目錄上限；較深的產物未讀取。`, target);
            }
            else if (entry.isFile()) { scannedFiles++; if (/\.(?:md|ya?ml)$/i.test(entry.name)) results.push(target); }
          }
        } catch (error) { if (options.signal?.aborted) throw error; if (!missing(error)) reader.diagnostic('scan-failed', (error as Error).message, current); }
      };
      await visit(directory, 0); return results;
    })(); filesCache.set(directory, task); return task;
  };
  const implementation = resolve('implementation_artifacts'); const specRoot = resolve('{output_folder}/specs'); const planning = resolve('planning_artifacts');
  const storyFiles = new Set<string>();
  const sprintFiles = new Set<string>();
  const specFolders = new Map<string, { inventory?: string; hasSpec: boolean; records: string[] }>();
  const folderFor = (directory: string) => { let folder = specFolders.get(directory); if (!folder) { folder = { hasSpec: false, records: [] }; specFolders.set(directory, folder); } return folder; };
  for (const directory of [...new Set([implementation, specRoot, planning].filter((value): value is string => !!value))]) {
    snapshot.watchDirectories.push(directory);
    for (const file of await scan(directory)) {
      if (/^sprint-status\.ya?ml$/i.test(path.basename(file))) {
        if (!sprintFiles.has(file)) { sprintFiles.add(file); await readClassicStories(file, reader, snapshot.stories); }
      }
      else if (path.basename(file) === 'stories.yaml') folderFor(path.dirname(file)).inventory = file;
      else if (path.basename(file) === 'SPEC.md') folderFor(path.dirname(file)).hasSpec = true;
      else if (path.basename(path.dirname(file)) === 'stories' && /\.md$/i.test(file)) folderFor(path.dirname(path.dirname(file))).records.push(file);
    }
  }
  for (const folder of specFolders.values()) {
    if (!folder.inventory && !folder.hasSpec) continue;
    for (const file of await readSpecInventory(folder.inventory, [...new Set(folder.records)].sort(), reader, snapshot.stories)) storyFiles.add(file);
  }
  for (const node of snapshot.nodes) {
    const artifacts: BmadArtifact[] = []; const pattern = NAMES[node.skill];
    if (pattern && !node.action) {
      const directories = node.skill === 'bmad-project-context' ? [root] : node.skill === 'bmad-spec' ? [specRoot]
        : [resolve(node.outputLocation || 'planning_artifacts'), ...(['bmad-architecture', 'bmad-retrospective'].includes(node.skill) ? [specRoot, planning, implementation] : [])];
      const outputDirectories = [...new Set(directories.filter((value): value is string => !!value))];
      if (outputDirectories.length) {
        snapshot.watchDirectories.push(...outputDirectories);
        const matches = node.skill === 'bmad-project-context' ? [path.join(root, 'AGENTS.md')] : [...new Set([
          ...(await Promise.all(outputDirectories.map(scan))).flat().filter(file => pattern.test(path.basename(file)) && (node.skill !== 'bmad-build' || path.basename(path.dirname(file)) !== 'stories')),
          ...(node.skill === 'bmad-build' ? [...storyFiles] : [])
        ])].sort();
        for (const file of matches) {
          const diagnosticCount = snapshot.diagnostics.length; const data = await reader.read(file);
          if (!data) {
            if (snapshot.diagnostics.length > diagnosticCount) artifacts.push({ id: hash(`${node.id}\0${path.relative(root, file)}`), path: file,
              relativePath: path.relative(root, file).split(path.sep).join('/'), fingerprint: '', status: 'error', reason: '檔案無法安全讀取；請查看診斷。', canConfirm: false, confirmed: false });
            continue;
          }
          let state: ReturnType<typeof artifactState>;
          try {
            if (node.skill === 'bmad-sprint-planning') {
              const entries = object(object(reader.value(data)).development_status);
              if (!Object.keys(entries).length || Object.values(entries).some(value => typeof value !== 'string' || !STORY_STATUSES.has(value) && value !== 'optional')) throw new Error('Sprint 追蹤檔缺少有效的 development_status 或含無效狀態。');
              state = { status: 'needs-confirmation', reason: '已偵測有效的 Sprint 追蹤檔；檔案存在不代表規劃驗證完成。', canConfirm: true };
            } else state = artifactState(node, data.content, reader.metadata(data));
            if (state.status === 'error') reader.diagnostic('artifact-status-invalid', state.reason, file);
          }
          catch (error) { state = { status: 'error', reason: (error as Error).message, canConfirm: false }; reader.diagnostic('artifact-invalid', state.reason, file); }
          const id = hash(`${node.id}\0${path.relative(root, file)}`);
          const confirmed = state.canConfirm && !!options.confirmations?.some(item => item.root === root && item.stepId === node.id && item.artifactId === id && item.fingerprint === data.fingerprint);
          artifacts.push({ id, path: file, relativePath: path.relative(root, file).split(path.sep).join('/'), fingerprint: data.fingerprint, observedAt: data.observedAt, ...state,
            ...(confirmed ? { status: 'complete' as const, reason: '使用者已確認這份內容完成；內容變更後需重新確認。' } : {}), confirmed });
        }
      }
    }
    const aggregate = stepStatus(artifacts, node);
    if (node.skill === 'bmad-build' && aggregate.status !== 'error') {
      const inventoryStories = snapshot.stories.filter(story => story.mode === 'spec');
      const classicStories = snapshot.stories.filter(story => story.mode === 'classic');
      const missingRecords = inventoryStories.filter(story => story.association === 'not-observed').length;
      if (inventoryStories.some(story => story.association === 'ambiguous' || story.status === 'conflict')) {
        aggregate.status = 'conflict'; aggregate.summary = 'Story 歸屬或同一記錄的狀態有衝突；已完成的個別 Build 證據仍保留。';
      } else if (snapshot.stories.some(story => story.status === 'error') || snapshot.diagnostics.some(item => item.code === 'sprint-invalid' || item.code === 'read-failed' && sprintFiles.has(item.path ?? ''))) {
        aggregate.status = 'error'; aggregate.summary = '部分 Story 的正式進度無法判讀；已完成的個別 Build 證據仍保留。';
      } else if (missingRecords) {
        aggregate.status = artifacts.length ? 'draft' : 'not-observed';
        aggregate.summary = `已完成 ${artifacts.filter(artifact => artifact.status === 'complete').length} 份 Build 記錄；尚有 ${missingRecords} 個 inventory Story 沒有執行記錄，不能宣告整體完成。`;
      } else if (inventoryStories.some(story => story.association === 'unconfirmed') && aggregate.status !== 'draft') {
        aggregate.status = 'needs-confirmation'; aggregate.summary = '有可讀記錄，但部分 Story 的 inventory 歸屬未確認；不宣告整體完成。';
      }
      const pendingClassic = classicStories.filter(story => story.status !== 'done');
      if (!['error', 'conflict'].includes(aggregate.status) && pendingClassic.length) {
        if (aggregate.status !== 'needs-confirmation') aggregate.status = artifacts.length || pendingClassic.some(story => story.status !== 'backlog') ? 'draft' : 'not-observed';
        aggregate.summary += ` Sprint 仍有 ${pendingClassic.length}/${classicStories.length} 個 Story 未完成；個別 Build 完成不代表整體交付完成。`;
      } else if (aggregate.status === 'not-observed' && classicStories.length && !inventoryStories.length) {
        aggregate.status = 'complete'; aggregate.summary = `Sprint 正式記錄的 ${classicStories.length} 個 Story 均為 done；未偵測到個別 Build 產物。`;
      }
    }
    snapshot.steps.push({ id: node.id, artifacts, ...aggregate });
  }
}

async function readClassicStories(file: string, reader: Reader, stories: BmadStoryProgress[]): Promise<void> {
  const data = await reader.read(file); if (!data) return;
  try {
    const entries = object(object(reader.value(data)).development_status);
    if (!Object.keys(entries).length) throw new Error('Sprint 追蹤檔沒有 development_status。');
    for (const [id, status] of Object.entries(entries)) {
      if (/^epic-\d+(?:-retrospective)?$/.test(id)) {
        if (typeof status !== 'string' || !STORY_STATUSES.has(status) && status !== 'optional') reader.diagnostic('sprint-invalid', `無效 Epic 或 Retrospective 狀態：${id}`, file);
        continue;
      }
      if (typeof status !== 'string' || !STORY_STATUSES.has(status)) {
        reader.diagnostic('story-status-invalid', `無效 Story 狀態：${id}`, file);
        stories.push({ id: `${file}#${id}`, label: id, mode: 'classic', path: file, status: 'error', observedAt: data.observedAt,
          nativeStatus: typeof status === 'string' ? status : undefined, reason: 'Sprint Story 的正式狀態無法判讀。' });
        continue;
      }
      stories.push({ id: `${file}#${id}`, label: id, mode: 'classic', path: file, status, nativeStatus: status, stage: WORK_STAGES[status], observedAt: data.observedAt, reason: `Sprint 正式記錄：${status}。` });
    }
  } catch (error) { reader.diagnostic('sprint-invalid', (error as Error).message, file); }
}

interface StoryInventoryEntry { id: string; title: string; description: string }
/** v6.12.4 stories-schema: ordered top-level list, string/prefix-free IDs, no progress field. */
function parseStoryInventory(content: string, value = yamlValue(content)): StoryInventoryEntry[] {
  if (!Array.isArray(value)) throw new Error('stories.yaml 必須是依執行順序排列的最上層 YAML list。');
  const entries: StoryInventoryEntry[] = [];
  for (const item of value) {
    const entry = object(item);
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9-]+$/.test(entry.id)) throw new Error('Story id 必須是引號包住的字串，且僅含英數字與連字號。');
    const id = entry.id;
    if (typeof entry.title !== 'string' || !entry.title.trim() || /[\r\n]/.test(entry.title) || typeof entry.description !== 'string') throw new Error('每個 Story 需要單行 title 與字串 description。');
    if (Object.hasOwn(entry, 'status')) throw new Error('stories.yaml 不允許 status；進度只能來自個別 build record。');
    for (const key of ['spec_checkpoint', 'done_checkpoint']) if (entry[key] !== undefined && typeof entry[key] !== 'boolean') throw new Error(`${key} 必須為 boolean。`);
    if (entry.invoke_dev_with !== undefined && typeof entry.invoke_dev_with !== 'string') throw new Error('invoke_dev_with 必須為字串。');
    if (entries.some(previous => previous.id === id || previous.id.startsWith(`${id}-`) || id.startsWith(`${previous.id}-`))) throw new Error('Story ids 必須唯一，且不可在 <id>- 檔名前綴規則下互相重疊。');
    entries.push({ id, title: entry.title, description: entry.description });
  }
  return entries;
}

async function readSpecInventory(inventory: string | undefined, records: string[], reader: Reader, stories: BmadStoryProgress[]): Promise<string[]> {
  let entries: StoryInventoryEntry[] | undefined;
  let inventoryObservedAt: string | undefined;
  if (inventory) {
    const data = await reader.read(inventory);
    if (data) { inventoryObservedAt = data.observedAt; try { entries = parseStoryInventory(data.content, reader.value(data)); } catch (error) { reader.diagnostic('story-inventory-invalid', (error as Error).message, inventory); } }
  }
  const parsed = new Map<string, BmadStoryProgress | undefined>();
  const record = async (file: string): Promise<BmadStoryProgress | undefined> => {
    if (!parsed.has(file)) { const rows: BmadStoryProgress[] = []; await readSpecStory(file, reader, rows); parsed.set(file, rows[0]); }
    return parsed.get(file);
  };
  const confirmedRecords: string[] = [], consumed = new Set<string>();
  if (entries) for (const entry of entries) {
    const id = `${inventory}#${entry.id}`;
    const matches = records.filter(file => path.basename(file).startsWith(`${entry.id}-`));
    for (const file of matches) consumed.add(file);
    if (!matches.length) {
      stories.push({ id, label: entry.title, mode: 'spec', path: inventory!, inventoryPath: inventory,
        association: 'not-observed', status: 'backlog', stage: '待開始', observedAt: inventoryObservedAt, reason: `Inventory 列出 Story ${entry.id}；尚未偵測到 stories/${entry.id}-*.md build record，inventory 本身沒有進度。` });
    } else if (matches.length > 1) {
      const markers: string[] = [];
      for (const file of matches) { const row = await record(file); markers.push(`${path.basename(file)} (${row?.status ?? '無法判讀'})`); reader.diagnostic('story-record-ambiguous', `Story ${entry.id} 有多個匹配的 build record，未自動選取。`, file); }
      stories.push({ id, label: entry.title, mode: 'spec', path: inventory!, inventoryPath: inventory,
        association: 'ambiguous', status: 'conflict', reason: `同一 Story ${entry.id} 匹配多份記錄，請確認歸屬：${markers.join('、')}。` });
    } else {
      const file = matches[0], row = await record(file);
      stories.push({ ...(row ?? { mode: 'spec' as const, path: file, status: 'error', reason: '已匹配 build record，但其正式狀態無法判讀。' }),
        id, label: entry.title, inventoryPath: inventory, association: 'confirmed' });
      confirmedRecords.push(file);
    }
  }
  for (const file of records.filter(file => !consumed.has(file))) {
    const row = await record(file);
    if (!row) continue;
    const reason = !inventory ? '未偵測到 stories.yaml inventory。' : !entries ? 'stories.yaml 無效或寫入中。' : '此檔案未匹配 inventory 內的任何 Story。';
    reader.diagnostic('story-association-unconfirmed', `${reason}僅保留可讀 build record，Story 歸屬未確認。`, file);
    stories.push({ ...row, status: row.status === 'conflict' ? 'conflict' : 'needs-confirmation', inventoryPath: inventory,
      association: 'unconfirmed', reason: `${reason}歸屬未確認；檔案本身記錄 ${row.status}，不據此宣告 inventory Story 完成。` });
  }
  return confirmedRecords;
}

async function readSpecStory(file: string, reader: Reader, stories: BmadStoryProgress[]): Promise<void> {
  const data = await reader.read(file); if (!data) return;
  try {
    const fm = reader.metadata(data); const status = fm.status;
    const body = data.content.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    const section = /(?:^|\n)##\s+Status\s*\r?\n\s*`?([a-z-]+)`?\s*(?:\r?\n|$)/i.exec(body)
      ?? /(?:^|\n)Status:\s*`?([a-z-]+)`?\s*(?:\r?\n|$)/i.exec(body);
    const bodyStatus = section?.[1].toLowerCase();
    if (bodyStatus && STORY_STATUSES.has(bodyStatus) && typeof status === 'string' && STORY_STATUSES.has(status) && bodyStatus !== status) {
      reader.diagnostic('story-status-conflict', 'Story frontmatter 與 Status 區段不一致；請由 BMAD 核對。', file);
      stories.push({ id: file, label: typeof fm.title === 'string' ? fm.title : path.basename(file, '.md'), mode: 'spec', path: file, status: 'conflict', nativeStatus: status, observedAt: data.observedAt, reason: `同一 Story 的狀態不同：frontmatter=${status}，Status=${bodyStatus}。` });
      return;
    }
    if (typeof status !== 'string' || !STORY_STATUSES.has(status)) { reader.diagnostic('story-status-invalid', 'Story frontmatter 沒有可識別的狀態。', file); return; }
    stories.push({ id: file, label: typeof fm.title === 'string' ? fm.title : path.basename(file, '.md'), mode: 'spec', path: file, status, nativeStatus: status, stage: buildStage(status, fm.route), observedAt: data.observedAt, reason: `Story 正式記錄：${status}。` });
  } catch (error) { reader.diagnostic('story-invalid', (error as Error).message, file); }
}
