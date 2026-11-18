import type { BmadCommandRequest } from '../workspace/bmadProtocol';
import type { ReviewerToolId } from '../workspace/reviewSessionProtocol';

export type CodexCliSource =
  | { kind: 'skill'; featureId: string; inputs: Record<string, string>; revision: string }
  | { kind: 'bmad'; request: BmadCommandRequest }
  | { kind: 'review'; tool: ReviewerToolId; requestId: string; action: 'resume' | 'refresh'; revision: string }
  | { kind: 'merge-request'; projectId: number; iid: number; reviewerTool: ReviewerToolId; expectedScope?: string };
