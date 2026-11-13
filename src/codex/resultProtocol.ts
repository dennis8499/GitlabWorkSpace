import type { CodexTaskResult, CodexTaskStatus } from './protocol';

export const CODEX_RESULT_SCHEMA = 'GitLabWorkspaceCodexResult/v1';
export const CODEX_RESULT_MAX_BYTES = 128 * 1024 * 1024;
export const CODEX_RESULT_MAX_FILES = 50_000;
export type CodexResultReason = 'completed' | 'manual' | 'deleted';
export interface CodexArtifact {
  id: string;
  /** Portable path relative to this result's directory, never an executable path. */
  path: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
}
export interface CodexResultOrigin {
  kind: string;
  projectId: number;
  projectPath: string;
  webUrl: string;
  repositoryRoot: string;
  sourceBranch: string;
  sourceSha: string;
  iid?: number;
  targetBranch?: string;
  targetSha?: string;
  branch?: string;
  intent?: string;
}
export interface CodexResultDelivery {
  state: string;
  deliveredCommitSha?: string;
  url?: string;
  receipts?: Array<{ action: string; state: string; key?: string; resourceId?: number; commitSha?: string; bodyHash?: string; url?: string }>;
}
export interface CodexResultRestore {
  schema: 'GitLabWorkspaceCodexChanges/v1';
  /** The retained user repository and this exact base commit are prerequisites. */
  originalRepository: string;
  baseSha: string;
  headSha: string;
  objectFormat: 'sha1' | 'sha256';
  patchArtifactId: string;
  inventoryArtifactId: string;
  validatedAt: string;
}
export interface CodexChangeEntry {
  path: string;
  tracked: boolean;
  action: 'write' | 'delete';
  mode: '100644' | '100755' | '000000';
  artifactId?: string;
  sha256?: string;
}
export interface CodexChangeInventory {
  schema: 'GitLabWorkspaceCodexChangeInventory/v1';
  baseSha: string;
  entries: CodexChangeEntry[];
}
/** A result card has no thread, prompt, transcript, runtime or native request identity. */
export interface CodexResultManifest {
  schema: typeof CODEX_RESULT_SCHEMA;
  id: string;
  title: string;
  root: string;
  status: CodexTaskStatus;
  createdAt: string;
  updatedAt: string;
  reason: CodexResultReason;
  /** Salvage export only: never authorizes deletion or implies publication was reconciled. */
  provisional?: true;
  summary: string;
  origin?: CodexResultOrigin;
  result?: CodexTaskResult;
  delivery?: CodexResultDelivery;
  restore?: CodexResultRestore;
  artifacts: CodexArtifact[];
}

export function validResultId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9-]{1,100}$/i.test(id);
}
/** Reject paths that change meaning across Windows and POSIX, including ADS/device names. */
export function safeResultPath(value: string): string {
  if (!value || value.length > 4096 || /[\\:]/.test(value) || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || value.startsWith('/') || value.endsWith('/')) throw new Error('成果路徑無法安全保存。');
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error('成果路徑無法安全保存。');
  }
  return value;
}
export function resultPathKey(value: string): string { return safeResultPath(value).normalize('NFC').toLowerCase(); }
