import type { InstalledReviewerBinding, ReviewerCapabilities } from './reviewSessionProtocol';

export interface ReviewLaunchRequest {
  schema: 'ReviewLaunchRequest/v1';
  tool: 'merge-reviewer';
  request_id: string;
  workspace: string;
  project: string;
  base: string;
  head: string;
  runtime_root: string;
  workspace_file?: string;
  auth_scope?: string;
  binding: InstalledReviewerBinding;
  draft_format: 'compact';
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
  return binding?.tool === 'merge-reviewer' && binding.workflow_kit_runner?.review_launch_request === 1 &&
    binding.workflow_kit_runner.read_only_inspection === true && !!binding.workflow_kit_runner.review_launch_sha256 &&
    capabilities?.schema === 'MergeReviewCapabilities/v1' && capabilities.features.launch_preflight === true &&
    capabilities.features.read_only_inspection === true && capabilities.draft_formats.includes('compact');
}

/** Preserve literal paths in the Host's shell instead of treating JSON escaping as shell quoting. */
export function reviewLaunchCommand(launch: ReviewLaunchBinding): string {
  const literal = (value: string): string => "'" + value.replaceAll("'", launch.shell === 'posix' ? "'\"'\"'" : "''") + "'";
  return `python -X utf8 -B ${literal(launch.request.binding.workflow_kit_runner!.script_path)} --review-request ${literal(launch.path)} --expected-request-sha256 ${launch.sha256} --action ${launch.action}`;
}
