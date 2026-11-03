/** Shared by logs, notifications and inline diagnostics. Never use on user draft content. */
export function sanitizeDiagnostic(value: string, secrets: Iterable<string> = []): string {
  let result = value;
  for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]');
  return result.replace(/\b(?:glpat|gldt|glrt|glcbt)-[\w-]+/gi, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/\bBearer\s+[^\s,;"}]+/gi, 'Bearer [redacted]')
    .replace(/((?:private-token|authorization|access_token|token|password)\s*[=:]\s*)[^\s,;"}]+/gi, '$1[redacted]').slice(0, 2048);
}

/** Traverse diagnostic envelopes only; leave Issue bodies, Git messages and drafts intact. */
export function sanitizeFeedbackDiagnostics<T>(value: T, sanitize: (text: string) => string = sanitizeDiagnostic): T {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => sanitizeFeedbackDiagnostics(item, sanitize)) as T;
  const source = value as Record<string, unknown>;
  let result: Record<string, unknown> | undefined;
  const set = (key: string, next: unknown) => { if (next !== source[key]) { result ??= { ...source }; result[key] = next; } };
  for (const key of ['error', 'refreshError', 'reason', 'details', 'permissionNotice', 'workspaceRootError', 'cloneRootError', 'groupRepositoryScanError']) {
    if (typeof source[key] === 'string') set(key, sanitize(source[key] as string));
  }
  if (['error', 'gitError', 'message', 'gitRepositories'].includes(String(source.type)) && typeof source.message === 'string') set('message', sanitize(source.message));
  for (const key of ['warnings', 'notices', 'errors']) if (Array.isArray(source[key])) set(key, (source[key] as unknown[]).map(item =>
    typeof item === 'string' ? sanitize(item) : sanitizeFeedbackDiagnostics(item, sanitize)));
  for (const key of ['availability', 'sections', 'noteReactionStates', 'loadErrors']) {
    const map = source[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) set(key, Object.fromEntries(Object.entries(map).map(([name, item]) =>
      [name, typeof item === 'string' && key === 'loadErrors' ? sanitize(item) : sanitizeFeedbackDiagnostics(item, sanitize)])));
  }
  for (const key of ['response', 'data', 'patch', 'snapshot', 'operation', 'operations', 'operationSnapshot', 'createAvailability', 'deleteAvailability',
    'instance', 'capabilities', 'selectedMergeRequest', 'freshness', 'workflowKit', 'workflowKitInstallTarget', 'state', 'skillsContext', 'groupMatch',
    'bmadWorkflow', 'bmadEnvironment', 'observation', 'installation', 'codex', 'tools', 'repositoryScan', 'issueBoardContent', 'projectContext']) {
    if (source[key] && typeof source[key] === 'object') set(key, sanitizeFeedbackDiagnostics(source[key], sanitize));
  }
  return (result ?? value) as T;
}
