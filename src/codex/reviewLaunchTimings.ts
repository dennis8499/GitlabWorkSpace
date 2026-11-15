/** WorkflowKit review_launch.py's structured stderr record; diagnostic evidence only. */
export type ReviewLaunchAction = 'start' | 'status' | 'view' | 'check' | 'finish' | 'cancel' | 'preflight' | 'schema';
export type ReviewLaunchPhase = 'request_seconds' | 'binding_seconds' | 'capabilities_seconds' | 'preflight_seconds' | 'child_seconds' | 'total_seconds';
export interface ReviewLaunchMetrics {
  schema: 'ReviewLaunchMetrics/v1';
  action: ReviewLaunchAction;
  returncode: number;
  timings: Partial<Record<ReviewLaunchPhase, number>> & { request_seconds: number; binding_seconds: number; capabilities_seconds: number; total_seconds: number };
}
const actions = new Set<ReviewLaunchAction>(['start', 'status', 'view', 'check', 'finish', 'cancel', 'preflight', 'schema']);
const phases = new Set<ReviewLaunchPhase>(['request_seconds', 'binding_seconds', 'capabilities_seconds', 'preflight_seconds', 'child_seconds', 'total_seconds']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const seconds = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 604_800;
const code = (value: unknown): value is number => Number.isSafeInteger(value) && Math.abs(Number(value)) <= 2_147_483_648;

/** Call only for a completed native launcher command, never agent prose or partial deltas. */
export function parseReviewLaunchTimings(output: string, expected: { action?: ReviewLaunchAction; exitCode?: number } = {}): ReviewLaunchMetrics | undefined {
  if (typeof output !== 'string') return;
  const matches: ReviewLaunchMetrics[] = [];
  // The launcher emits its record last. Bound work even when native stdout is very large.
  for (const line of output.slice(-64_000).split('\n').slice(-64)) {
    const text = line.trim(); if (text.length > 4096 || !text.startsWith('{') || !text.endsWith('}')) continue;
    let value: unknown; try { value = JSON.parse(text); } catch { continue; }
    if (!object(value) || value.schema !== 'ReviewLaunchMetrics/v1') continue;
    if (Object.keys(value).some(key => !['schema', 'action', 'returncode', 'timings'].includes(key)) || !actions.has(value.action as ReviewLaunchAction) ||
      !code(value.returncode) || !object(value.timings) || Object.keys(value.timings).some(key => !phases.has(key as ReviewLaunchPhase)) ||
      Object.values(value.timings).some(value => !seconds(value)) ||
      !['request_seconds', 'binding_seconds', 'capabilities_seconds', 'total_seconds'].every(key => seconds((value as { timings: Record<string, unknown> }).timings[key])) ||
      expected.action !== undefined && value.action !== expected.action || expected.exitCode !== undefined && value.returncode !== expected.exitCode) return;
    const timings = value.timings as ReviewLaunchMetrics['timings'];
    // A failed new-request preflight returns before the child reviewer is started.
    if (timings.child_seconds === undefined && !(value.action === 'start' && value.returncode !== 0 && timings.preflight_seconds !== undefined)) return;
    if (Object.values(timings).some(value => value > timings.total_seconds + 0.000001)) return;
    matches.push({ schema: 'ReviewLaunchMetrics/v1', action: value.action as ReviewLaunchAction, returncode: value.returncode, timings: { ...timings } });
  }
  // Multiple invocations in a shell cannot be attributed to a single native item.
  return matches.length === 1 ? matches[0] : undefined;
}

export function launcherHelperSeconds(metrics: ReviewLaunchMetrics): Record<string, number> {
  return Object.fromEntries(Object.entries(metrics.timings).map(([phase, value]) => [`launcher.${metrics.action}.${phase}`, value]));
}

export function isLauncherTimingKey(value: string): boolean {
  const [prefix, action, phase, extra] = value.split('.');
  return prefix === 'launcher' && actions.has(action as ReviewLaunchAction) && phases.has(phase as ReviewLaunchPhase) && extra === undefined;
}
