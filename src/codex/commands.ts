import type { CodexCommand } from './protocol';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
export function isCodexCommand(value: unknown): value is CodexCommand {
  if (!record(value) || typeof value.action !== 'string') return false;
  let allowed = ['action', 'taskId'];
  if (value.action === 'storage') return Object.keys(value).length === 1;
  if (value.action === 'create') return Object.keys(value).every(key => ['action', 'context'].includes(key)) &&
    (value.context === undefined || ['none', 'selection', 'file', 'diff'].includes(String(value.context)));
  if (!string(value.taskId, 100) || !/^[a-z0-9-]+$/i.test(String(value.taskId))) return false;
  if (value.action === 'metadata') {
    allowed = [...allowed, 'title', 'pinned', 'archived'];
    if (value.title !== undefined && !string(value.title, 200) || value.pinned !== undefined && typeof value.pinned !== 'boolean' ||
      value.archived !== undefined && typeof value.archived !== 'boolean') return false;
  } else if (value.action === 'approvals') {
    allowed.push('settings'); const settings = value.settings;
    if (!record(settings) || Object.keys(settings).length !== 3 || !['command', 'file', 'permissions'].every(key => typeof settings[key] === 'boolean')) return false;
  } else if (value.action === 'reorder') { allowed.push('direction'); if (!['up', 'down'].includes(String(value.direction))) return false; }
  else if (value.action === 'publish-reply') { allowed.push('discussionId', 'body'); if (!string(value.discussionId, 160) || !string(value.body, 50_000)) return false; }
  else if (value.action === 'open-file') {
    allowed.push('path', 'line');
    if (!string(value.path, 4096) || value.line !== undefined && (!Number.isSafeInteger(value.line) || Number(value.line) < 1 || Number(value.line) > 10_000_000)) return false;
  }
  else if (!['manage', 'reconcile', 'diagnostics', 'fork', 'goal', 'handoff', 'handoff-review', 'open-worktree', 'remove-worktree', 'regenerate-wiki', 'mr-fix', 'reprepare', 'open-diff'].includes(value.action)) return false;
  return Object.keys(value).every(key => allowed.includes(key));
}
