import type { IssueTask } from '../issues/protocol';

export interface ChildTaskDraft { title: string; description: string; }
export interface IssueChildTaskDrafts {
  selectedId?: string;
  drafts: Record<string, ChildTaskDraft>;
}
export type ChildTaskDraftState = Record<string, IssueChildTaskDrafts>;

export function updateChildTaskState(state: ChildTaskDraftState, issueId: number,
  update: (current: IssueChildTaskDrafts) => IssueChildTaskDrafts): ChildTaskDraftState {
  const current = state[issueId] ?? { drafts: {} };
  const next = update(current);
  return next === current ? state : { ...state, [issueId]: next };
}

/** Only an exact, confirmed submission may consume its own saved draft. */
export function settleChildTaskDraft(state: ChildTaskDraftState, issueId: number, taskId: string | undefined,
  submitted: ChildTaskDraft): ChildTaskDraftState {
  if (!taskId) return state;
  return updateChildTaskState(state, issueId, current => {
    const draft = current.drafts[taskId];
    if (!draft || draft.title !== submitted.title || draft.description !== submitted.description) return current;
    const drafts = { ...current.drafts }; delete drafts[taskId];
    return { ...current, drafts };
  });
}

/** A placeholder or failed read cannot establish that a child task disappeared. */
export function retainChildTaskRows(previous: IssueTask[], incoming: IssueTask[], complete: boolean): IssueTask[] {
  return complete || !previous.length ? incoming : previous;
}
