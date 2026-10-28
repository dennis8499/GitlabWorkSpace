import { normalizeSopConfig, type SopConfig } from './sop';

export function sopConfigKey(baseUrl: string, groupId: number): string {
  return `gitlabWorkspace.sop.v1:${encodeURIComponent(baseUrl)}:${groupId}`;
}

export function loadSopConfig(state: { get<T>(key: string): T | undefined } | undefined, baseUrl?: string, groupId?: number): SopConfig {
  return normalizeSopConfig(baseUrl && groupId ? state?.get(sopConfigKey(baseUrl, groupId)) : undefined);
}
