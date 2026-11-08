import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PythonRuntime } from './pythonRuntime';
import type { InstalledReviewerBinding, NativeMergeReviewerCapabilities, ReviewerCapabilities, ReviewerSessionCapabilities } from './reviewSessionProtocol';
import { workflowKitPythonCommand } from './workflowKitRunner';
export type { ReviewerCapabilities } from './reviewSessionProtocol';
const exec = promisify(execFile);
const cache = new Map<string, Promise<ReviewerCapabilities | undefined>>();

function versionAtLeast(version: string, minimum: string): boolean {
  const actual = version.split('.').map(part => Number.parseInt(part, 10));
  const required = minimum.split('.').map(part => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(actual.length, required.length); index++) {
    const difference = (actual[index] ?? 0) - (required[index] ?? 0);
    if (difference) return difference > 0;
  }
  return true;
}

/** Probe only the bound local helper. Its capabilities command never starts capture. */
export function readReviewerCapabilities(binding: InstalledReviewerBinding, python: PythonRuntime,
  workspace: string): Promise<ReviewerCapabilities | undefined> {
  const key = JSON.stringify([binding.script_path, binding.payload_sha256, python.executable, python.args,
    workspace, python.env.GITLAB_WORKSPACE_RUNTIME_DIR, python.env.REVIEW_SHARED_CACHE_DIR,
    binding.workflow_kit_runner?.script_sha256, binding.workflow_kit_runner?.syntax_analysis?.engine_sha256]);
  const existing = cache.get(key);
  if (existing) return existing;
  const task = (async () => {
    const options = { env: python.env, encoding: 'utf8' as const,
      windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 };
    const run = async (helperArgs: readonly string[]) => {
      const command = await workflowKitPythonCommand(python, binding.workflow_kit_runner, helperArgs);
      return exec(command.executable, command.args, options);
    };
    let result;
    try {
      const capabilityArgs = ['-X', 'utf8', '-B', binding.script_path, 'capabilities', '--workspace', workspace];
      if (binding.tool === 'release-reviewer' && versionAtLeast(binding.version, '0.11.0')) {
        capabilityArgs.push('--expected-payload-sha256', binding.payload_sha256);
      }
      result = await run(capabilityArgs);
    } catch (error) {
      const failure = error as { code?: unknown; stderr?: unknown };
      if (failure.code !== 2 || typeof failure.stderr !== 'string'
        || !/invalid choice:\s*['"]capabilities['"]/i.test(failure.stderr)) throw error;
      // Earlier MergeReviewer and ReleaseReviewer sessions have no capabilities command. Verify
      // their actual start interface before emitting any of its options.
      const label = binding.tool === 'merge-reviewer' ? 'MergeReviewer' : 'ReleaseReviewer';
      const help = await run(['-X', 'utf8', '-B', binding.script_path, 'start', '--help'])
        .catch(() => { throw new Error(`已安裝 ${label} 不支援可恢復的審查流程，請更新工作流程包。`); });
      const commands = /\{start,step,check,finish,status,cancel\}/.test(help.stdout);
      const required = ['--workspace', '--workspace-file', '--project', '--base', '--head', '--runtime-root',
        '--request-id', '--requests-file', '--auth-scope', '--refresh'];
      if (!commands || required.some(flag => !help.stdout.includes(flag))) {
        throw new Error(`已安裝 ${label} 的 session 介面不相容，請更新工作流程包。`, { cause: error });
      }
      return undefined;
    }
    const value: unknown = JSON.parse(result.stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('已安裝 Reviewer 功能或來源身分不相容，請重新安裝相同來源的工作流程包。');
    }
    const capabilities = value as Record<string, unknown>;
    if (capabilities.schema === 'MergeReviewCapabilities/v1') {
      const native = capabilities as unknown as NativeMergeReviewerCapabilities;
      const features = native.features;
      if (binding.tool !== 'merge-reviewer' || !versionAtLeast(binding.version, '0.20.4') || native.protocol_version !== 1 ||
        !Array.isArray(native.draft_formats) || !native.draft_formats.includes('compact') || !native.draft_formats.includes('v3') ||
        !features || typeof features !== 'object' ||
        !Array.isArray(features.artifact_scopes) || !features.artifact_scopes.includes('context') ||
        !features.artifact_scopes.includes('runtime') ||
        ['read_only_artifact_view', 'request_preflight', 'incremental_resume', 'phase_metrics']
          .some(name => typeof features[name as keyof typeof features] !== 'boolean')) {
        throw new Error('已安裝 Reviewer 功能或來源身分不相容，請重新安裝相同來源的工作流程包。');
      }
      return native;
    }

    const legacy = capabilities as unknown as ReviewerSessionCapabilities;
    const updatesSchemaValid = binding.tool === 'release-reviewer'
      ? legacy.updates_schema === 'ReviewUpdates/v1' || legacy.updates_schema === 'ReleaseReviewUpdates/v1'
      : legacy.updates_schema === 'ReviewUpdates/v1';
    const featureNames = ['request_id', 'read_only_view', 'status_summary', 'read_window', 'updates_file',
      'durable_review_progress', 'phase_metrics', 'literal_search_batch', 'patch_encoding', 'operation_diagnostics'];
    const rawFeatures = legacy.features as unknown;
    const featuresValid = rawFeatures === undefined || (typeof rawFeatures === 'object' && rawFeatures !== null && !Array.isArray(rawFeatures)
      && featureNames.every(name => { const flag = (rawFeatures as Record<string, unknown>)[name]; return flag === undefined || typeof flag === 'boolean'; }));
    if (legacy.schema !== 'ReviewCapabilities/v1' || legacy.tool !== binding.tool ||
      legacy.skill_version !== binding.version || legacy.payload_sha256 !== binding.payload_sha256 ||
      legacy.prepare_evidence !== true || !updatesSchemaValid || !featuresValid ||
      legacy.shared_cache_schema !== 'ReviewerSharedCache/v2' || legacy.git_commands !== 0 ||
      legacy.network_commands !== 0 || typeof legacy.runtime_root !== 'string' ||
      legacy.payload_files !== undefined && (!Number.isInteger(legacy.payload_files) || legacy.payload_files < 0)) {
      throw new Error('已安裝 Reviewer 功能或來源身分不相容，請重新安裝相同來源的工作流程包。');
    }
    if (legacy.budget_profiles !== undefined && (legacy.budget_schema !== 'ReviewBudget/v1' ||
      !Array.isArray(legacy.budget_profiles) || !legacy.budget_profiles.includes('balanced') ||
      !legacy.budget_profiles.includes('unlimited') || legacy.budget_profiles.some(profile => !['balanced', 'unlimited'].includes(profile)))) {
      throw new Error('已安裝 Reviewer 的時間預算功能不相容。');
    }
    delete (legacy as unknown as Record<string, unknown>).supports_parallel_agents;
    return legacy;
  })();
  cache.set(key, task);
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  task.catch(() => cache.delete(key));
  return task;
}
