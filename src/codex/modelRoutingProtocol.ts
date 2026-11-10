import type { ReviewerToolId } from '../workspace/reviewSessionProtocol';

export const routingModel = 'gpt-6-luna';
export const routingEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type RoutingEffort = string;
export type RequestedEffort = 'auto' | RoutingEffort;
export function validModelEfforts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 32 && new Set(value).size === value.length &&
    value.every(item => typeof item === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(item) && item !== 'auto');
}
export function autoEfforts(efforts: readonly string[]): string[] {
  return effortOrder.filter(effort => efforts.includes(effort));
}
export function selectRoutingEffort(recommended: string, supported: readonly string[]): { effort: string; capped: boolean } {
  const choices = autoEfforts(supported), rank = effortOrder.indexOf(recommended as typeof effortOrder[number]);
  if (!choices.length || rank < 0 || choices.length !== supported.length) throw new Error('此模型的思考強度無法排序，請手動選擇。');
  const effort = choices.find(item => effortOrder.indexOf(item as typeof effortOrder[number]) >= rank) ?? choices[choices.length - 1];
  return { effort, capped: effortOrder.indexOf(effort as typeof effortOrder[number]) < rank };
}
export interface ModelRoutingBinding {
  tool: ReviewerToolId;
  requestId: string;
  runtimeRoot: string;
  requestedEffort: RequestedEffort;
  skillPath: string;
  payloadHash: string;
  reviewerInstructions?: string;
  supportsModelSelection?: boolean;
  model?: string;
  supportedEfforts?: string[];
}
export interface ModelRoutingHistory { effort: RoutingEffort; reason: string; kind: string; recommended_effort?: string; capped?: boolean; }
export interface ModelRoutingSummary {
  model: string;
  requestedEffort: RequestedEffort;
  effort?: RoutingEffort;
  phase: 'assessing' | 'reviewing' | 'complete' | 'stopped';
  reason: string;
  history: ModelRoutingHistory[];
  reportPath?: string;
  recommendedEffort?: string;
  capped?: boolean;
}
