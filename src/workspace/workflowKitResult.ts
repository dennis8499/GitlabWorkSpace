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
