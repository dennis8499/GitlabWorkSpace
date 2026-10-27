/** Caller intent only. The workbench never selects, probes or invokes a model. */
export interface ReviewerExecutionPolicy {
  schema: 'ReviewExecutionPolicy/v1';
  mode: 'single' | 'parallel';
  subagent_model: string;
  subagent_reasoning_effort: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
}

export type ReviewerExecutionOverrides = Partial<ReviewerExecutionPolicy>;
export const DEFAULT_REVIEWER_EXECUTION: ReviewerExecutionPolicy = {
  schema: 'ReviewExecutionPolicy/v1', mode: 'single', subagent_model: 'inherit',
  subagent_reasoning_effort: 'default'
};
export const REVIEWER_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const REVIEWER_EXECUTION_FIELDS = ['executionMode', 'subagentModel', 'subagentReasoningEffort'] as const;

export function validateReviewerExecution(value?: unknown): ReviewerExecutionPolicy {
  if (value === undefined) return { ...DEFAULT_REVIEWER_EXECUTION };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_REVIEWER_EXECUTION, key))) {
    throw new Error('審查執行設定包含未知欄位或格式錯誤。');
  }
  const policy = { ...DEFAULT_REVIEWER_EXECUTION, ...value } as ReviewerExecutionPolicy;
  if (policy.schema !== 'ReviewExecutionPolicy/v1' || !['single', 'parallel'].includes(policy.mode)) {
    throw new Error('審查執行模式必須為 single 或 parallel。');
  }
  if (typeof policy.subagent_model !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,159}$/.test(policy.subagent_model)
    || policy.subagent_model.includes('://') || /^(?:sk-|ghp_|glpat-)/.test(policy.subagent_model)) {
    throw new Error('子 Agent 模型必須為模型識別碼。');
  }
  if (!REVIEWER_EFFORTS.includes(policy.subagent_reasoning_effort)) {
    throw new Error('子 Agent 推理強度設定無效。');
  }
  return policy;
}

/** Empty per-call controls retain workspace values; user/global settings are never read here. */
export function resolveReviewerExecution(inputs: Record<string, string>, cardId: string,
  workspace?: unknown): ReviewerExecutionPolicy {
  const base = validateReviewerExecution(workspace);
  const input = (field: string): string | undefined => {
    const value = inputs[`${cardId}.${field}`];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('本次 Reviewer 執行欄位格式無效。');
    return value.trim();
  };
  const mode = input('executionMode');
  const model = input('subagentModel');
  const effort = input('subagentReasoningEffort');
  return validateReviewerExecution({ ...base, ...(mode ? { mode } : {}),
    ...(model ? { subagent_model: model } : {}), ...(effort ? { subagent_reasoning_effort: effort } : {}) });
}

export function reviewerExecutionFromConfiguration(inspected?: {
  workspaceFolderValue?: unknown; workspaceValue?: unknown; globalValue?: unknown;
}): ReviewerExecutionPolicy {
  const workspace = validateReviewerExecution(inspected?.workspaceValue);
  if (inspected?.workspaceFolderValue === undefined) return workspace;
  validateReviewerExecution(inspected.workspaceFolderValue);
  return validateReviewerExecution({ ...workspace, ...(inspected.workspaceFolderValue as ReviewerExecutionOverrides) });
}

export interface InstalledReviewerBinding {
  schema: 'InstalledReviewerBinding/v1';
  tool: 'merge-reviewer' | 'release-reviewer';
  version: string;
  script_path: string;
  script_sha256: string;
  skill_sha256: string;
  payload_sha256: string;
  payload_files: number;
}
