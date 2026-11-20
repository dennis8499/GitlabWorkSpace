import type { InstalledReviewerBinding, ReviewerCapabilities, ReviewerToolId } from './reviewSessionProtocol';

export interface ReviewLaunchRequest {
  schema: 'ReviewLaunchRequest/v1';
  tool: ReviewerToolId;
  request_id: string;
  workspace: string;
  project: string;
  base: string;
  head: string;
  runtime_root: string;
  workspace_file?: string;
  auth_scope?: string;
  binding: InstalledReviewerBinding;
  draft_format: 'compact' | 'v3';
  refresh?: boolean;
  no_fetch?: boolean;
}
export interface ReviewLaunchBinding {
  path: string;
  sha256: string;
  request: ReviewLaunchRequest;
  action: 'start' | 'status' | 'finish';
  shell?: 'powershell' | 'posix';
}
export function supportsReviewLaunch(binding: InstalledReviewerBinding | undefined, capabilities: ReviewerCapabilities | undefined): boolean {
  const runner = binding?.workflow_kit_runner;
  if (runner?.review_launch_request !== 1 || runner.read_only_inspection !== true || !runner.review_launch_sha256) return false;
  if (binding?.tool === 'release-reviewer') {
    return runner.review_launch_tools?.includes(binding.tool) === true && capabilities?.schema === 'ReviewCapabilities/v1' &&
      capabilities.tool === binding.tool && capabilities.prepare_evidence === true &&
      capabilities.features?.launch_preflight === true && capabilities.features.read_only_inspection === true;
  }
  return binding?.tool === 'merge-reviewer' && capabilities?.schema === 'MergeReviewCapabilities/v1' &&
    capabilities.features.launch_preflight === true && capabilities.features.read_only_inspection === true &&
    capabilities.draft_formats.includes('compact');
}

/** Preserve literal paths in the Host's shell instead of treating JSON escaping as shell quoting. */
export function reviewLaunchCommand(launch: ReviewLaunchBinding): string {
  const literal = (value: string): string => "'" + value.replaceAll("'", launch.shell === 'posix' ? "'\"'\"'" : "''") + "'";
  return `python -X utf8 -B ${literal(launch.request.binding.workflow_kit_runner!.script_path)} --review-request ${literal(launch.path)} --expected-request-sha256 ${launch.sha256} --action ${launch.action}`;
}
