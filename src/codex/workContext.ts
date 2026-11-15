import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AcceptanceCriterion, CriterionEvidence, RepoVerificationProfile, RequirementSnapshot, RequirementSource, ValidationAttempt, WorkContext } from './workContextProtocol';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (value: Record<string, unknown>, allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && (empty || !!value.trim()) && value.length <= max && !value.includes('\0');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = (value: unknown): value is string => text(value, 40) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const optional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);
export const validWorkId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/i.test(value);
const criterionId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value);
const strings = (value: unknown, max: number, size: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => text(item, size));
const fail = (): never => { throw new Error('需求快照、驗證設定或驗證紀錄格式無法核對。'); };
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function sourceIdentity(source: RequirementSource): unknown {
  // revision may be GitLab updated_at. A comment must not change the requirement digest.
  return [source.kind, source.identity];
}
function requirementDigest(value: Pick<RequirementSnapshot, 'source' | 'title' | 'description' | 'supplement' | 'criteria'>): string {
  return hash([sourceIdentity(value.source), value.title, value.description, value.supplement ?? '', value.criteria.map(item => [item.id, item.text, item.contentDigest])]);
}
function profileDigest(value: Pick<RepoVerificationProfile, 'kind' | 'commands' | 'manualChecks' | 'reason' | 'origin'>): string {
  return hash([value.kind, value.origin, value.commands, value.manualChecks, value.reason ?? '']);
}
function safeSource(value: RequirementSource): RequirementSource {
  if (!object(value) || !fields(value, ['kind', 'identity', 'url', 'revision']) || !text(value.kind, 100) || !text(value.identity, 4096) ||
    !optional(value.revision, item => text(item, 4096)) || !optional(value.url, item => text(item, 4096))) return fail();
  let url: string | undefined;
  if (value.url) {
    const parsed = new URL(value.url); if (!['http:', 'https:'].includes(parsed.protocol)) return fail();
    parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''; url = parsed.toString();
  }
  return { kind: value.kind, identity: value.identity, ...(url ? { url } : {}), ...(value.revision ? { revision: value.revision } : {}) };
}

/** Read only the acceptance section; unrelated task lists do not become new requirements. */
export function extractAcceptanceCriteria(description: string): string[] {
  const criteria: string[] = []; let level = 0, active = false, fence: string | undefined;
  for (const line of description.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker[0]; else if (fence === marker[0]) fence = undefined; continue; }
    if (fence) continue;
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (/驗收|完成條件|acceptance criteria|definition of done/i.test(heading[2])) { active = true; level = heading[1].length; }
      else if (active && heading[1].length <= level) active = false;
      continue;
    }
    const item = active && /^\s*(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?(.+?)\s*$/.exec(line);
    if (item && criteria.length < 100) criteria.push(item[1]);
  }
  return criteria;
}

export function createRequirementSnapshot(options: {
  source: RequirementSource; title: string; description: string; supplement?: string;
  criteria?: readonly (string | { id: string; text: string })[]; previous?: RequirementSnapshot; capturedAt?: string;
}): RequirementSnapshot {
  const source = safeSource(options.source), capturedAt = options.capturedAt ?? new Date().toISOString();
  if (!text(options.title, 4096, true) || !text(options.description, 128_000, true) || !optional(options.supplement, item => text(item, 32_000, true)) || !instant(capturedAt)) return fail();
  const previous = options.previous;
  if (previous && (!validRequirementSnapshot(previous) || hash(sourceIdentity(previous.source)) !== hash(sourceIdentity(source)))) return fail();
  const input = options.criteria ?? extractAcceptanceCriteria(options.description);
  if (!Array.isArray(input) || input.length > 100) return fail();
  const raw = input.map(item => typeof item === 'string' ? { text: item.trim() } : { id: item.id, text: item.text?.trim() });
  if (raw.some(item => !text(item.text, 4096) || item.id !== undefined && !criterionId(item.id))) return fail();
  const prior = previous?.criteria ?? [], used = new Set<string>();
  const exact = raw.map(item => item.id ?? prior.find(candidate => candidate.text === item.text && !used.has(candidate.id) && (used.add(candidate.id), true))?.id);
  used.clear();
  const criteria: AcceptanceCriterion[] = raw.map((item, index) => {
    let id = exact[index];
    if (!id && prior.length === raw.length && !exact.includes(prior[index]?.id)) id = prior[index]?.id;
    if (!id) {
      const prefix = `ac-${hash(sourceIdentity(source)).slice(0, 12)}-`; let ordinal = index + 1;
      do { id = prefix + ordinal++; } while (used.has(id) || exact.includes(id));
    }
    if (used.has(id)) return fail(); used.add(id);
    return { id, text: item.text, contentDigest: hash(item.text) };
  });
  const value = { schema: 'GitLabWorkspaceRequirementSnapshot/v1' as const, source, title: options.title, description: options.description,
    ...(options.supplement === undefined ? {} : { supplement: options.supplement }), capturedAt, criteria };
  return freeze({ ...value, contentDigest: requirementDigest(value) });
}

export function freezeVerificationProfile(options: {
  kind: RepoVerificationProfile['kind']; commands: readonly string[]; manualChecks?: readonly string[];
  reason?: string; origin?: RepoVerificationProfile['origin'];
}): RepoVerificationProfile {
  const value = { schema: 'GitLabWorkspaceRepoVerificationProfile/v1' as const, kind: options.kind, origin: options.origin ?? 'explicit',
    commands: [...options.commands], manualChecks: [...options.manualChecks ?? []], ...(options.reason === undefined ? {} : { reason: options.reason }) };
  const result = { ...value, digest: profileDigest(value) }; if (!validVerificationProfile(result)) return fail();
  return freeze(result);
}
export function validRequirementSnapshot(value: unknown): value is RequirementSnapshot {
  if (!object(value) || !fields(value, ['schema', 'source', 'title', 'description', 'supplement', 'capturedAt', 'criteria', 'contentDigest']) || value.schema !== 'GitLabWorkspaceRequirementSnapshot/v1' ||
      !text(value.title, 4096, true) || !text(value.description, 128_000, true) || !optional(value.supplement, item => text(item, 32_000, true)) || !instant(value.capturedAt) || !digest(value.contentDigest) ||
      !Array.isArray(value.criteria) || value.criteria.length > 100) return false;
  try {
    const source = safeSource(value.source as RequirementSource);
    if (source.url !== (value.source as RequirementSource).url) return false;
    const ids = new Set<string>();
    for (const item of value.criteria) {
      if (!object(item) || !fields(item, ['id', 'text', 'contentDigest']) || !criterionId(item.id) || ids.has(item.id) || !text(item.text, 4096) || !digest(item.contentDigest) || item.contentDigest !== hash(item.text)) return false;
      ids.add(item.id);
    }
    return value.contentDigest === requirementDigest(value as unknown as RequirementSnapshot);
  } catch { return false; }
}
export function validVerificationProfile(value: unknown): value is RepoVerificationProfile {
  return object(value) && fields(value, ['schema', 'kind', 'origin', 'commands', 'manualChecks', 'reason', 'digest']) && value.schema === 'GitLabWorkspaceRepoVerificationProfile/v1' &&
    ['code', 'docs', 'manual'].includes(String(value.kind)) && ['explicit', 'project', 'detected'].includes(String(value.origin)) && strings(value.commands, 20, 4096) && value.commands.every(item => !/[\r\n]/.test(item)) &&
    strings(value.manualChecks, 50, 4096) && optional(value.reason, item => text(item, 4096)) && digest(value.digest) && value.digest === profileDigest(value as unknown as RepoVerificationProfile);
}
export function validWorkContext(value: unknown): value is WorkContext {
  return object(value) && fields(value, ['schema', 'workId', 'requirement', 'verification']) && value.schema === 'GitLabWorkspaceWorkContext/v1' &&
    optional(value.workId, validWorkId) && validRequirementSnapshot(value.requirement) && optional(value.verification, validVerificationProfile);
}
export function validValidationAttempts(value: unknown): value is ValidationAttempt[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  const ids = new Set<string>();
  for (const item of value) {
    if (!object(item) || !fields(item, ['id', 'cycle', 'startedAt', 'completedAt', 'cwd', 'artifactDigest', 'requirementDigest', 'profileDigest', 'turnId', 'state', 'reason', 'commands']) ||
      !validWorkId(item.id) || ids.has(item.id) || !Number.isSafeInteger(item.cycle) || Number(item.cycle) < 1 || Number(item.cycle) > 3 || !instant(item.startedAt) ||
      !optional(item.completedAt, instant) || typeof item.completedAt === 'string' && item.completedAt < item.startedAt || !text(item.cwd, 4096) || !path.isAbsolute(item.cwd) ||
      !optional(item.artifactDigest, digest) || !optional(item.requirementDigest, digest) || !optional(item.profileDigest, digest) || !optional(item.turnId, entry => text(entry, 200)) ||
      !['passed', 'failed', 'blocked', 'interrupted', 'incomplete'].includes(String(item.state)) || !optional(item.reason, entry => text(entry, 8000)) || !Array.isArray(item.commands) || item.commands.length > 100) return false;
    ids.add(item.id);
    for (const command of item.commands) {
      if (!object(command) || !fields(command, ['command', 'cwd', 'itemId', 'exitCode', 'signal', 'startedAtMs', 'completedAtMs']) || !text(command.command, 8192) ||
        !optional(command.cwd, entry => text(entry, 4096) && path.isAbsolute(entry)) || !optional(command.itemId, entry => text(entry, 200)) || !optional(command.exitCode, Number.isSafeInteger) ||
        !optional(command.signal, entry => text(entry, 100)) || !optional(command.startedAtMs, entry => Number.isSafeInteger(entry) && Number(entry) >= 0) ||
        !optional(command.completedAtMs, entry => Number.isSafeInteger(entry) && Number(entry) >= 0) || typeof command.startedAtMs === 'number' && typeof command.completedAtMs === 'number' && command.completedAtMs < command.startedAtMs) return false;
    }
    if (item.state === 'passed' && (!item.completedAt || !item.artifactDigest || !item.commands.length || item.commands.some(command => command.exitCode !== 0 || command.signal))) return false;
  }
  return true;
}
/** Old evidence never passes a changed criterion; successful commands alone are insufficient. */
export function evaluateCriteria(snapshot: RequirementSnapshot, evidence: readonly CriterionEvidence[] = []): CriterionEvidence[] {
  if (!validRequirementSnapshot(snapshot) || evidence.length > 100) return fail();
  return snapshot.criteria.map(criterion => {
    const records = evidence.filter(item => item.criterionId === criterion.id && item.criterionDigest === criterion.contentDigest);
    if (records.length !== 1) return { criterionId: criterion.id, criterionDigest: criterion.contentDigest, state: 'unknown', evidence: [], reason: '尚無此版本驗收條件的唯一證據。' };
    const item = records[0];
    if (!['passed', 'failed', 'unknown', 'not-applicable'].includes(item.state) || !strings(item.evidence, 100, 4096) || !optional(item.reason, entry => text(entry, 4096)) ||
      item.state === 'passed' && !item.evidence.length || item.state === 'not-applicable' && !item.reason?.trim()) return fail();
    return structuredClone(item);
  });
}
