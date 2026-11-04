import type { ActionAvailability } from '../api/actionAvailability';
import type { WorkspaceCapabilities } from '../workspace/workspaceCapabilities';

export function localProjectBlocker(capabilities?: WorkspaceCapabilities): FeatureBlocker | undefined {
  return capabilities ? availabilityBlocker(capabilities.localProjectOperations) : undefined;
}

export interface FeatureBlocker { reason: string; tone: 'hint' | 'warning' | 'error'; details?: string; }
export function blockedWhen(condition: unknown, reason: string, tone: FeatureBlocker['tone'] = 'hint', details?: string): FeatureBlocker | undefined {
  return condition ? { reason, tone, ...(details ? { details } : {}) } : undefined;
}
export function firstBlocker(...values: (FeatureBlocker | undefined)[]): FeatureBlocker | undefined { return values.find(Boolean); }
export function availabilityBlocker(value: ActionAvailability | undefined, fallback = '操作條件尚未確認，請重新檢查。'): FeatureBlocker | undefined {
  return value?.status === 'allowed' ? undefined : {
    reason: value?.reason ?? fallback, tone: value?.details ? 'error' : value?.status === 'denied' ? 'warning' : 'hint', details: value?.details
  };
}
export function featureNoticeId(prefix: string, blocker: FeatureBlocker): string {
  const text = JSON.stringify([prefix, blocker.reason, blocker.tone, blocker.details]);
  // Stable across re-renders and shared by controls with the same cause.
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return `${prefix.replace(/[^A-Za-z0-9_-]/g, '-')}-${(hash >>> 0).toString(36)}`;
}
export function availabilityProps(prefix: string, blocker: FeatureBlocker | undefined) {
  return { disabled: !!blocker, 'aria-describedby': blocker ? featureNoticeId(prefix, blocker) : undefined };
}
export function groupFeatureBlockers(items: Record<string, FeatureBlocker | undefined>) {
  const grouped = new Map<string, { blocker: FeatureBlocker; labels: string[] }>();
  for (const [label, blocker] of Object.entries(items)) {
    if (!blocker) continue;
    const key = featureNoticeId('reason', blocker);
    const group = grouped.get(key);
    if (group) group.labels.push(label); else grouped.set(key, { blocker, labels: [label] });
  }
  return [...grouped.values()];
}
