import path from 'node:path';
import { createHash } from 'node:crypto';
import { validValidationAttempts, validWorkContext } from './workContext';
import { isLocalWikiBaseline, isLocalWikiQualityReceipt } from '../workspace/localWikiQuality';
/** Stored records are untrusted even when their JSON and envelope are valid. */
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const optional = (value: unknown, valid: (value: unknown) => boolean) => value === undefined || valid(value);
const array = (value: unknown, valid: (value: unknown) => boolean) => Array.isArray(value) && value.every(valid);
const fields = (value: ObjectValue, keys: string[], valid: (value: unknown) => boolean = string) => keys.every(key => optional(value[key], valid));
const text = (value: unknown, max = 4096): value is string => string(value) && value.length > 0 && value.length <= max && !value.includes('\0');
const absolute = (value: unknown): value is string => text(value, 32767) && path.isAbsolute(value);
const sha = (value: unknown): value is string => string(value) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const digest = (value: unknown): value is string => string(value) && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => string(value) && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value);
const opaque = (value: unknown): value is string => string(value) && /^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(value);
const date = (value: unknown): value is string => text(value, 100) && Number.isFinite(Date.parse(value));
const same = (a: string, b: string): boolean => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const inside = (root: string, value: string): boolean => { const relative = path.relative(root, value); return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
const list = (value: unknown, max: number, check: (value: unknown) => boolean): value is unknown[] => Array.isArray(value) && value.length <= max && value.every(check);
const ids = (value: unknown, max: number): value is string[] => list(value, max, opaque) && new Set(value).size === value.length;
const tests = (value: unknown): boolean => list(value, 20, entry => text(entry) && entry.trim().length > 0 && !/[\r\n]/.test(entry));
const keys = (value: ObjectValue, names: string[]): boolean => Object.keys(value).every(key => names.includes(key));

export function validCodexTemporaryRef(value: unknown, repository = false): boolean {
  return object(value) && keys(value, repository ? ['repository', 'ref', 'sha'] : ['ref', 'sha']) && (!repository || absolute(value.repository)) &&
    text(value.ref, 2048) && /^(?:refs\/(?:heads|remotes)\/workbench\/|refs\/gitlab-workspace\/tasks\/)/.test(value.ref) &&
    !/[\s\\~^:?*[\]]/.test(value.ref) && !value.ref.includes('..') && !value.ref.includes('@{') && !value.ref.includes('//') &&
    value.ref.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')) && sha(value.sha);
}

export function validCodexGroupAnalysis(value: unknown, root: string): boolean {
  if (!object(value) || !keys(value, ['id', 'groupRoot', 'runtimeRoot', 'outputRoot', 'repositories', 'issueDrafts']) || !optional(value.issueDrafts, item => typeof item === 'boolean') || !uuid(value.id) || !absolute(value.groupRoot) ||
    !same(value.groupRoot, root) || !absolute(value.runtimeRoot) || path.basename(value.runtimeRoot) !== value.id ||
    path.basename(path.dirname(value.runtimeRoot)) !== 'codex-group-analysis' || !absolute(value.outputRoot) ||
    !(inside(value.groupRoot, value.outputRoot) && !inside(value.runtimeRoot, value.outputRoot) || same(value.outputRoot, path.join(value.runtimeRoot, 'artifacts'))) ||
    !Array.isArray(value.repositories) || !value.repositories.length || value.repositories.length > 100) return false;
  const seen = new Set<string>();
  return value.repositories.every(repo => {
    if (!object(repo) || !keys(repo, ['id', 'name', 'path', 'sha', 'snapshotPath', 'projectPath']) || !opaque(repo.id) || seen.has(repo.id) ||
      !text(repo.name, 1024) || !absolute(repo.path) || !sha(repo.sha) || !absolute(repo.snapshotPath) || !optional(repo.projectPath, item => text(item, 500)) ||
      !same(repo.path, value.groupRoot as string) && !inside(value.groupRoot as string, repo.path)) return false;
    seen.add(repo.id);
    const expected = path.join(value.runtimeRoot as string, 'sources', createHash('sha256').update(repo.path).digest('hex').slice(0, 16));
    return same(repo.snapshotPath, expected);
  });
}

function validDelivery(value: unknown): boolean {
  if (!object(value) || !keys(value, ['mode', 'state', 'steps', 'artifactDigest', 'deliveredCommitSha', 'url', 'error', 'confirmation']) ||
    !['automatic', 'manual'].includes(String(value.mode)) || !['pending', 'running', 'published', 'needs-attention', 'cancelled'].includes(String(value.state)) ||
    !optional(value.artifactDigest, digest) || !optional(value.deliveredCommitSha, sha) || !fields(value, ['url', 'error'], item => text(item, 8192)) ||
    !optional(value.confirmation, item => object(item) && keys(item, ['digest', 'confirmedAt', 'headSha', 'targetSha', 'issueDigest']) && digest(item.digest) && date(item.confirmedAt) && optional(item.headSha, sha) && optional(item.targetSha, sha) && optional(item.issueDigest, digest)) ||
    !Array.isArray(value.steps) || value.steps.length > 200) return false;
  const seen = new Set<string>();
  const valid = value.steps.every(step => {
    if (!object(step) || !keys(step, ['id', 'kind', 'state', 'key', 'bodyHash', 'resourceId', 'url', 'sha', 'parentSha', 'treeSha', 'error']) ||
      !opaque(step.id) || seen.has(step.id) || !['commit', 'push', 'merge-request', 'issue-note', 'review-note', 'reply', 'upload', 'wiki'].includes(String(step.kind)) ||
      !['prepared', 'sending', 'confirmed', 'uncertain'].includes(String(step.state)) || !digest(step.key) ||
      !optional(step.bodyHash, ['push', 'merge-request'].includes(String(step.kind)) ? sha : digest) ||
      !optional(step.resourceId, id => Number.isSafeInteger(id) && Number(id) > 0) || !fields(step, ['url', 'error'], item => text(item, 8192)) ||
      !fields(step, ['sha', 'parentSha', 'treeSha'], sha)) return false;
    seen.add(step.id);
    if (step.state === 'confirmed') {
      // Adopting a reviewed HEAD does not create a Host commit or parent receipt.
      // An optional parent is already validated above; SHA and tree stay required.
      if (step.kind === 'commit' && (!sha(step.sha) || !sha(step.treeSha))) return false;
      if (step.kind === 'push' && !sha(step.sha)) return false;
      if (['merge-request', 'issue-note', 'review-note', 'reply'].includes(String(step.kind)) && !step.resourceId) return false;
      if (step.kind === 'upload' && !text(step.url, 8192)) return false;
    }
    return true;
  });
  return valid && (value.state !== 'published' || value.steps.length > 0 && value.steps.every(step => object(step) && step.state === 'confirmed'));
}

function validAdditions(value: ObjectValue): boolean {
  const spec = value.spec as ObjectValue, source = spec.source as ObjectValue;
  if (!absolute(spec.root)) return false;
  if (!optional(spec.review, review => object(review) && optional(review.launchBinding, binding => object(binding) &&
    keys(binding, ['path', 'sha256']) && absolute(binding.path) && digest(binding.sha256)))) return false;
  if (!optional(spec.workContext, validWorkContext) || !optional(spec.localWikiBaseline, isLocalWikiBaseline) || !optional(value.validationAttempts, validValidationAttempts) ||
      !optional(value.implementationCycles, item => integer(item) && Number(item) <= 3)) return false;
  if (!fields(source, ['requirement'], item => text(item, 32000)) || !fields(source, ['automaticDelivery', 'oneClick'], item => typeof item === 'boolean') ||
    !optional(source.expectedScope, digest) ||
    !optional(source.additionalSkillIds, item => ids(item, 100)) || !optional(source.testCommands, tests) ||
    !optional(source.repositoryIds, item => source.kind === 'group-analysis' && ids(item, 1000)) ||
    !optional(spec.preparationKey, item => text(item, 4096)) ||
    !optional(spec.bmadArtifacts, item => object(item) && keys(item, ['outputRoot', 'projectChangesRoot', 'seedRoot']) && absolute(item.outputRoot) &&
      uuid(path.basename(item.outputRoot)) && path.basename(path.dirname(item.outputRoot)) === 'codex-bmad-artifacts' &&
      optional(item.projectChangesRoot, root => absolute(root) && same(root, path.join(item.outputRoot as string, 'project'))) &&
      optional(item.seedRoot, root => absolute(root) && path.basename(root) === '_bmad-output' && /^[a-zA-Z0-9_-]{1,160}$/.test(path.basename(path.dirname(root))) &&
        path.basename(path.dirname(path.dirname(root))) === createHash('sha256').update(path.resolve(spec.root as string)).digest('hex') &&
        path.basename(path.dirname(path.dirname(path.dirname(root)))) === 'bmad-artifacts')) ||
    !optional(spec.requirementSummary, item => string(item) && item.length <= 8000 && !item.includes('\0')) ||
    !optional(spec.projectRules, item => list(item, 1, rule => object(rule) && keys(rule, ['path', 'fingerprint']) && absolute(rule.path) && digest(rule.fingerprint) &&
      ['AGENTS.md', 'AGENTS.override.md'].some(name => same(rule.path as string, path.join(spec.root as string, name))))) ||
    !optional(spec.skill, item => object(item) && text(item.name, 200) && absolute(item.path) && optional(item.fingerprint, digest)) ||
    !optional(spec.additionalSkills, item => list(item, 100, skill => object(skill) && keys(skill, ['id', 'name', 'path', 'fingerprint']) &&
      opaque(skill.id) && text(skill.name, 200) && absolute(skill.path) && digest(skill.fingerprint)) &&
      new Set((item as ObjectValue[]).map(skill => skill.id)).size === (item as ObjectValue[]).length) ||
    !optional(spec.delivery, item => object(item) && keys(item, ['mode', 'testCommands']) && ['automatic', 'manual'].includes(String(item.mode)) && optional(item.testCommands, tests)) ||
    !optional(value.delivery, validDelivery) || !optional(value.cleanupState, item => ['pending', 'running', 'complete', 'needs-attention'].includes(String(item))) ||
    !optional(value.closing, item => object(item) && keys(item, ['reason', 'startedAt']) && ['completed', 'manual', 'deleted'].includes(String(item.reason)) && date(item.startedAt)) ||
    !optional(value.ownedThreadIds, item => ids(item, 1000)) || !optional(value.temporaryRefs, item => list(item, 1000, ref => validCodexTemporaryRef(ref, true)))) return false;
  if (source.kind === 'group-analysis') {
    if (!text(source.requirement, 32000) || !validCodexGroupAnalysis(spec.groupAnalysis, spec.root as string) || spec.origin || spec.workflow) return false;
    const binding = spec.groupAnalysis as ObjectValue;
    if (!absolute(spec.executionRoot) || !same(spec.executionRoot, binding.outputRoot as string) || !Array.isArray(spec.writableRoots) ||
      !spec.writableRoots.some(root => absolute(root) && same(root, binding.outputRoot as string)) || spec.writableRoots.some(root => !absolute(root) ||
        !same(root, binding.outputRoot as string) && !same(root, path.join(binding.groupRoot as string, '.gitlab-workspace', 'runtime')))) return false;
  } else if (spec.groupAnalysis !== undefined) return false;
  if (Array.isArray(source.additionalSkillIds) && source.additionalSkillIds.some(id => !Array.isArray(spec.additionalSkills) || !spec.additionalSkills.some(skill => object(skill) && skill.id === id))) return false;
  if (!optional(spec.workflow, item => object(item) && optional(item.temporaryRefs, refs => list(refs, 1000, ref => validCodexTemporaryRef(ref))))) return false;
  const workflow = spec.workflow;
  if (object(workflow) && !optional(workflow.managedClone, clone => object(clone) && keys(clone, ['path', 'cacheRepository', 'branch', 'sourceSha', 'remoteUrl']) &&
    absolute(clone.path) && absolute(clone.cacheRepository) && text(clone.branch, 2048) && sha(clone.sourceSha) && text(clone.remoteUrl, 8192) &&
    absolute(workflow.runtimeRoot) && same(clone.path, path.join(workflow.runtimeRoot, 'repository')) && absolute(spec.executionRoot) && same(spec.executionRoot, clone.path) &&
    object(spec.origin) && absolute(spec.origin.repositoryRoot) && same(clone.cacheRepository, spec.origin.repositoryRoot) && clone.sourceSha === spec.origin.sourceSha && clone.branch === spec.origin.branch)) return false;
  if (object(workflow) && Array.isArray(workflow.temporaryRefs) && workflow.temporaryRefs.some(ref => !object(ref) || !string(workflow.id) ||
    !(String(ref.ref).endsWith('-' + workflow.id) || String(ref.ref).includes('-' + workflow.id + '-')))) return false;
  if (Array.isArray(value.temporaryRefs) && value.temporaryRefs.some(ref => !object(ref) ||
    !same(String(ref.repository), object(spec.origin) ? String(spec.origin.repositoryRoot) : String(spec.root)) ||
    !(String(ref.ref).startsWith(`refs/gitlab-workspace/tasks/${value.id}/`) || object(spec.workflow) &&
      (String(ref.ref).endsWith('-' + spec.workflow.id) || String(ref.ref).includes('-' + spec.workflow.id + '-'))))) return false;
  if (!optional(spec.origin, item => object(item) && optional(item.sourceProjectId, id => Number.isSafeInteger(id) && Number(id) > 0) &&
    optional(item.sourceRemote, remote => text(remote, 200) && /^[a-z0-9][a-z0-9._/-]*$/i.test(remote)) && optional(item.pushUrl, url => text(url, 4096) && !/[\0\r\n]/.test(url)))) return false;
  return optional(value.validation, item => object(item) && keys(item, ['cwd', 'artifactDigest', 'testedAt', 'commands', 'turnId', 'noChanges', 'requirementDigest', 'profileDigest', 'manual']) &&
    optional(item.requirementDigest, digest) && optional(item.profileDigest, digest) &&
    optional(item.manual, manual => object(manual) && keys(manual, ['confirmedAt', 'checks']) && date(manual.confirmedAt) &&
      list(manual.checks, 100, check => text(check, 4096)) && manual.checks.length > 0 && Array.isArray(item.commands) && item.commands.length === 0) &&
    absolute(item.cwd) && digest(item.artifactDigest) && date(item.testedAt) && optional(item.turnId, opaque) && optional(item.noChanges, flag => typeof flag === 'boolean') &&
    list(item.commands, 100, command => object(command) && keys(command, ['command', 'exitCode', 'cwd', 'itemId', 'startedAtMs', 'completedAtMs']) &&
      text(command.command, 20_000) && Number.isSafeInteger(command.exitCode) && optional(command.cwd, absolute) && optional(command.itemId, opaque) &&
      fields(command, ['startedAtMs', 'completedAtMs'], integer) && !(typeof command.startedAtMs === 'number' && typeof command.completedAtMs === 'number' && command.completedAtMs < command.startedAtMs)));
}
/** Older hosts must fail closed rather than manage records carrying new contracts. */
export function hasCodexV3Metadata(value: unknown): boolean {
  if (!object(value) || !object(value.spec) || !object(value.spec.source)) return false;
  const spec = value.spec, source = spec.source as ObjectValue;
  return source.kind === 'group-analysis' || ['additionalSkillIds', 'testCommands', 'automaticDelivery', 'oneClick', 'repositoryIds'].some(key => source[key] !== undefined) ||
    ['additionalSkills', 'delivery', 'groupAnalysis', 'preparationKey', 'projectRules', 'requirementSummary', 'workContext'].some(key => spec[key] !== undefined) ||
    object(spec.skill) && spec.skill.fingerprint !== undefined || object(spec.workflow) && spec.workflow.temporaryRefs !== undefined ||
    object(spec.origin) && ['sourceProjectId', 'sourceRemote', 'pushUrl'].some(key => (spec.origin as ObjectValue)[key] !== undefined) ||
    ['delivery', 'validation', 'validationAttempts', 'implementationCycles', 'closing', 'cleanupState', 'ownedThreadIds', 'temporaryRefs'].some(key => value[key] !== undefined);
}
export function validStoredCodexProjection(value: unknown): boolean {
  if (!object(value) || !['title', 'createdAt', 'updatedAt'].every(key => string(value[key])) ||
    !fields(value, ['threadId', 'turnId', 'error', 'ownerInstance', 'pendingMessage']) ||
    !fields(value, ['pinned', 'archived', 'dispatchPending', 'pendingMessageIsUser'], item => typeof item === 'boolean') ||
    !optional(value.revision, integer) || !optional(value.ownerGeneration, item => integer(item) && Number(item) > 0) || !object(value.spec) || !object(value.spec.source) ||
    !['free', 'skill', 'bmad', 'group-analysis', 'issue', 'project-wiki', 'merge-request', 'review'].includes(String(value.spec.source.kind))) return false;
  if (!['GitLabWorkspaceCodexTask/v1', 'GitLabWorkspaceCodexTask/v2', 'GitLabWorkspaceCodexTask/v3', 'GitLabWorkspaceCodexTask/v4'].includes(String(value.schema)) ||
    hasCodexV3Metadata(value) && !['GitLabWorkspaceCodexTask/v3', 'GitLabWorkspaceCodexTask/v4'].includes(String(value.schema)) || !validAdditions(value)) return false;
  const taskWorkspace = value.spec.taskWorkspace;
  const specification = value.spec;
  if (!optional(taskWorkspace, item => object(item) && keys(item, ['schema', 'taskId', 'directory', 'workspaceFile', 'originRoot', 'accountId']) &&
    value.schema === 'GitLabWorkspaceCodexTask/v4' && item.schema === 'GitLabWorkspaceTaskWorkspace/v1' && item.taskId === value.id &&
    absolute(item.directory) && path.basename(item.directory) === item.taskId && path.basename(path.dirname(item.directory)) === 'codex-workspaces' &&
    absolute(item.workspaceFile) && same(item.workspaceFile, path.join(item.directory, 'task.code-workspace')) && absolute(item.originRoot) &&
    absolute(specification.root) && same(item.originRoot, specification.root) && optional(item.accountId, account => text(account, 256)) &&
    text(value.ownerInstance, 256) && integer(value.ownerGeneration) && Number(value.ownerGeneration) > 0 && integer(value.revision) && Number(value.revision) > 0)) return false;
  const origin = value.spec.origin;
  if (!optional(value.spec.launch, item => object(item) && integer(item.openedAt) && fields(item, ['draftReadyAt', 'checkedMs', 'submittedAt'], integer))) return false;
  if (!optional(origin, item => object(item) && ['projectPath', 'webUrl', 'sourceBranch'].every(key => string(item[key])) &&
    fields(item, ['targetBranch', 'branch']))) return false;
  if (!optional(value.progress, item => object(item) && fields(item, ['diff', 'model', 'effort', 'tool', 'waitReason', 'updatedAt']) &&
    optional(item.phase, phase => ['preflight', 'process', 'readiness', 'workspace', 'conversation', 'executing', 'verifying', 'cleanup'].includes(String(phase))) &&
    optional(item.plan, steps => array(steps, step => object(step) && string(step.step) && ['pending', 'inProgress', 'completed'].includes(String(step.status)))) &&
    optional(item.tokens, tokens => object(tokens) && ['total', 'input', 'output'].every(key => integer(tokens[key])) && optional(tokens.contextWindow, integer)) &&
    optional(item.quota, quota => object(quota) && typeof quota.usedPercent === 'number' && quota.usedPercent >= 0 && quota.usedPercent <= 100 && optional(quota.resetsAt, integer)))) return false;
  if (!optional(value.result, item => object(item) && ['needs-work', 'ready', 'draft', 'published', 'partial', 'uncertain'].includes(String(item.state)) &&
    string(item.summary) && fields(item, ['reportPath', 'draftId', 'revision', 'url', 'handoffPath']) &&
    optional(item.wikiQuality, isLocalWikiQualityReceipt) &&
    optional(item.files, files => array(files, string)) &&
    optional(item.tests, tests => array(tests, entry => object(entry) && string(entry.command) && Number.isSafeInteger(entry.exitCode))) &&
    optional(item.followUps, links => list(links, 100, link => object(link) && keys(link, ['kind', 'projectId', 'iid', 'url', 'title', 'scope']) && optional(link.scope, digest) &&
      ['issue', 'merge-request', 'wiki'].includes(String(link.kind)) && Number.isSafeInteger(link.projectId) && Number(link.projectId) > 0 &&
      optional(link.iid, iid => Number.isSafeInteger(iid) && Number(iid) > 0) && text(link.url, 8192) && /^https?:\/\//i.test(link.url) && text(link.title, 4096))) &&
    optional(item.replyDrafts, drafts => array(drafts, entry => object(entry) && string(entry.discussionId) && string(entry.body))) &&
    optional(item.evidence, evidence => object(evidence) && ['sourceSha', 'branch', 'digest', 'verifiedAt'].every(key => string(evidence[key]))))) return false;
  if (!optional(value.modelRouting, item => object(item) && ['assessing', 'reviewing', 'complete', 'stopped'].includes(String(item.phase)) &&
    array(item.history, entry => object(entry) && string(entry.reason) && fields(entry, ['effort'])) &&
    fields(item, ['model', 'reason', 'effort', 'recommendedEffort', 'reportPath']) && optional(item.capped, flag => typeof flag === 'boolean'))) return false;
  if (!optional(value.goal, item => object(item) && string(item.objective) && fields(item, ['status', 'startedAt']) &&
    fields(item, ['tokenBudget', 'timeBudgetSeconds', 'tokensUsed', 'timeUsedSeconds'], integer))) return false;
  if (!optional(value.recovery, item => object(item) && ['checkedAt', 'message', 'execution', 'cleanup', 'publication'].every(key => string(item[key])))) return false;
  if (!optional(value.publication, item => object(item) && ['kind', 'state', 'key'].every(key => string(item[key])))) return false;
  if (!optional(value.publications, entries => object(entries) && Object.keys(entries).length <= 1000 && Object.values(entries).every(item =>
    object(item) && ['review', 'reply'].includes(String(item.kind)) && ['pending', 'confirmed', 'not-published'].includes(String(item.state)) &&
    string(item.key) && fields(item, ['discussionId', 'bodyHash', 'error'])))) return false;
  if (!optional(value.queuedMessages, entries => Array.isArray(entries) && entries.length <= 200 && entries.every(item =>
    object(item) && string(item.id) && /^[a-z0-9-]{1,100}$/i.test(item.id) && string(item.text) && item.text.length <= 32_000 &&
    ['queued', 'sending', 'accepted', 'uncertain'].includes(String(item.state))))) return false;
  if (!optional(value.routingThreadIds, items => array(items, string)) || !optional(value.routingUserMessages, items => array(items, string))) return false;
  return true;
}
