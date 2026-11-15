import type { CodexTaskOrigin } from './workflowProtocol';
import { createHash } from 'node:crypto';

/** An expected navigation context, never credentials or permission to publish. */
export function workAccountScope(origin: Pick<CodexTaskOrigin, 'baseUrl' | 'accountKey'>): string {
  return createHash('sha256').update(JSON.stringify([origin.baseUrl.replace(/\/+$/, ''), origin.accountKey])).digest('hex');
}

/** Stable remote object identity; separate from its changing content and authorization. */
export function workSourceIdentity(origin: Pick<CodexTaskOrigin, 'baseUrl' | 'accountKey' | 'projectId' | 'kind' | 'iid'>): string {
  return JSON.stringify([origin.baseUrl.replace(/\/+$/, ''), origin.accountKey, origin.projectId, origin.kind, origin.iid ?? null]);
}
