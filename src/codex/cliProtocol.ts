import type { BmadCommandRequest } from '../workspace/bmadProtocol';
import type { ReviewerToolId } from '../workspace/reviewSessionProtocol';

export type CodexCliSource =
  | { kind: 'skill'; featureId: string; inputs: Record<string, string>; revision: string }
  | { kind: 'bmad'; request: BmadCommandRequest }
  | { kind: 'review'; tool: ReviewerToolId; requestId: string; action: 'resume' | 'refresh'; revision: string }
  | { kind: 'merge-request'; projectId: number; iid: number; reviewerTool: ReviewerToolId; expectedScope?: string };

export type CodexCliRunState = 'preparing' | 'waiting-for-enter' | 'running' | 'failed' | 'unconfirmed' | 'resetting';
export interface CodexCliRunSummary {
  runId: string;
  title: string;
  state: CodexCliRunState;
  source: CodexCliSource['kind'];
  tool?: ReviewerToolId;
  projectId?: number;
  iid?: number;
  error?: string;
  terminalAvailable?: boolean;
}
