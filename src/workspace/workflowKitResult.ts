/** Extract a structured installer error without hiding its original message. */
export function workflowKitFailure(output: string): Error | undefined {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const result = value as Record<string, unknown>;
    return result.ok === false && typeof result.error === 'string' ? new Error(result.error) : undefined;
  }
  return undefined;
}

/** Installer warnings are informational and do not turn a successful install into a failure. */
export function workflowKitWarnings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string =>
    typeof item === 'string' && !!item.trim() && item.length <= 2000).slice(0, 20) : [];
}
