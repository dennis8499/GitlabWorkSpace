export interface BmadEnvironmentTool {
  id: 'codex' | 'uv';
  label: string;
  state: 'ready' | 'found' | 'missing' | 'unsupported' | 'error';
  version?: string;
  reason: string;
}
export interface BmadEnvironmentCheck {
  root?: string;
  checkedAt: string;
  tools: BmadEnvironmentTool[];
}
