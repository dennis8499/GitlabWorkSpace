import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PythonRuntime } from './pythonRuntime';
import type { InstalledReviewerBinding } from './reviewExecution';
import type { ReviewerToolId } from './reviewSessionProtocol';
import type { ReviewerCapabilities } from './reviewSessionProtocol';
export type { ReviewerCapabilities } from './reviewSessionProtocol';
const exec = promisify(execFile);
const cache = new Map<string, Promise<ReviewerCapabilities>>();

/** Probe only the bound local helper. Its capabilities command never starts capture. */
export function readReviewerCapabilities(binding: InstalledReviewerBinding, python: PythonRuntime,
  workspace: string): Promise<ReviewerCapabilities> {
  const key = JSON.stringify([binding.script_path, binding.payload_sha256, python.executable, python.args,
    workspace, python.env.GITLAB_WORKSPACE_RUNTIME_DIR, python.env.REVIEW_SHARED_CACHE_DIR]);
  const existing = cache.get(key);
  if (existing) return existing;
  const task = (async () => {
    const result = await exec(python.executable, [...python.args, '-X', 'utf8', '-B', binding.script_path,
      'capabilities', '--workspace', workspace], { env: python.env, encoding: 'utf8',
      windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
    const value = JSON.parse(result.stdout) as ReviewerCapabilities;
    if (value.schema !== 'ReviewCapabilities/v1' || value.tool !== binding.tool ||
      value.skill_version !== binding.version || value.payload_sha256 !== binding.payload_sha256 ||
      value.prepare_evidence !== true || value.updates_schema !== 'ReviewUpdates/v1' ||
      value.shared_cache_schema !== 'ReviewerSharedCache/v2' || value.git_commands !== 0 ||
      value.network_commands !== 0 || typeof value.runtime_root !== 'string') {
      throw new Error('已安裝 Reviewer 功能或來源身分不相容，請重新安裝相同來源的工作流程包。');
    }
    if (value.budget_profiles !== undefined && (value.budget_schema !== 'ReviewBudget/v1' ||
      !Array.isArray(value.budget_profiles) || !value.budget_profiles.includes('balanced') ||
      !value.budget_profiles.includes('unlimited') || value.budget_profiles.some(profile => !['balanced', 'unlimited'].includes(profile)))) {
      throw new Error('已安裝 Reviewer 的時間預算功能不相容。');
    }
    return value;
  })();
  cache.set(key, task);
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  task.catch(() => cache.delete(key));
  return task;
}
