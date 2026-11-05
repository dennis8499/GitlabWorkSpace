import type { ReviewerToolId } from '../workspace/reviewSessionProtocol';

export const routingModel = 'gpt-6-luna';
export const routingEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type RoutingEffort = typeof routingEfforts[number];
export type RequestedEffort = 'auto' | RoutingEffort;
export interface ModelRoutingBinding {
  tool: ReviewerToolId;
  requestId: string;
  runtimeRoot: string;
  requestedEffort: RequestedEffort;
  skillPath: string;
  payloadHash: string;
  reviewerInstructions?: string;
}
export interface ModelRoutingHistory { effort: RoutingEffort; reason: string; kind: string; }
export interface ModelRoutingSummary {
  model: string;
  requestedEffort: RequestedEffort;
  effort?: RoutingEffort;
  phase: 'assessing' | 'reviewing' | 'complete';
  reason: string;
  history: ModelRoutingHistory[];
  reportPath?: string;
}
