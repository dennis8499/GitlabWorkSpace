import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PythonRuntime } from './pythonRuntime';
import { isReviewerTool, type WorkflowKitRunnerBinding } from './reviewSessionProtocol';
import { assertWorkflowKitManifestCurrent, readWorkflowKitManifest, type VerifiedWorkflowKitManifest, type WorkflowKitManifest } from './workflowKitIntegration';

const RUNNER_RELATIVE_PATH = '.agents/gitlab-workspace-kit/run.py';
const RUNNER_FILE = RUNNER_RELATIVE_PATH.split('/').join(path.sep);
const CAPABILITIES_FILE = '.agents/gitlab-workspace-kit/runner-capabilities.json';
const LAUNCH_FILE = '.agents/gitlab-workspace-kit/review_launch.py';
const RUNNER_LIMIT = 64 * 1024 * 1024;
const RUNNER_FILE_ERROR = 'WorkflowKit 已宣告 runner，但檔案不存在或不是一般檔案；請重新安裝工作流程包。';
const RUNNER_SIZE_ERROR = 'WorkflowKit runner 超過 64 MiB 容量限制；請重新檢查安裝。';

export interface VerifiedWorkflowKitInstallation {
  marker: VerifiedWorkflowKitManifest;
  runner?: WorkflowKitRunnerBinding;
}

async function runnerDigest(file: string): Promise<string> {
  const entry = await fs.lstat(file, { bigint: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(RUNNER_FILE_ERROR);
    throw error;
  });
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(RUNNER_FILE_ERROR);
  if (entry.size > BigInt(RUNNER_LIMIT)) throw new Error(RUNNER_SIZE_ERROR);

  const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await fs.open(file, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) throw new Error(RUNNER_FILE_ERROR);
    if (opened.size > BigInt(RUNNER_LIMIT)) throw new Error(RUNNER_SIZE_ERROR);

    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, RUNNER_LIMIT - length + 1), null);
      if (!bytesRead) return digest.digest('hex');
      length += bytesRead;
      if (length > RUNNER_LIMIT) throw new Error(RUNNER_SIZE_ERROR);
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

async function verifiedAsset(root: string, relative: string, expected: unknown): Promise<Buffer> {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('WorkflowKit runner 能力缺少受管理摘要。');
  const file = path.join(root, relative), info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('WorkflowKit runner 能力檔案無效。');
  const bytes = await fs.readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('WorkflowKit runner 能力與安裝紀錄不符。');
  return bytes;
}

/** The installer status API authenticates the marker before a caller requests this binding. */
export async function readWorkflowKitRunnerBinding(root: string, verifiedMarker?: WorkflowKitManifest): Promise<WorkflowKitRunnerBinding | undefined> {
  const marker = verifiedMarker ?? await unboundRunnerManifest(root);
  if (!marker) return undefined;
  const { version, files } = marker;
  const expected = files[RUNNER_RELATIVE_PATH];
  if (expected === undefined) {
    const [major, minor, patch] = version.split('.').map(Number);
    if (major > 1 || major === 1 && (minor > 3 || minor === 3 && patch >= 5)) {
      throw new Error('WorkflowKit 1.3.5 以上必須宣告受管理 runner；請重新檢查安裝紀錄。');
    }
    return undefined;
  }
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) {
    throw new Error('WorkflowKit runner 摘要格式無效。');
  }

  const runnerPath = path.join(root, RUNNER_FILE);
  let parent = path.resolve(root);
  for (const part of ['.agents', 'gitlab-workspace-kit']) {
    parent = path.join(parent, part);
    const info = await fs.lstat(parent).catch(error => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new Error(RUNNER_FILE_ERROR);
      }
      throw error;
    });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('WorkflowKit runner 路徑無效，請重新安裝工作流程包。');
  }
  const actual = await runnerDigest(runnerPath);
  if (actual !== expected.toLowerCase()) throw new Error('WorkflowKit runner 與已驗證的安裝紀錄不符；請重新安裝工作流程包。');
  let launch: Pick<WorkflowKitRunnerBinding, 'review_launch_request' | 'review_launch_sha256' | 'read_only_inspection' | 'read_only_manifest_sha256' | 'review_launch_tools'> = {};
  if (files[CAPABILITIES_FILE] !== undefined) {
    const capabilities = JSON.parse((await verifiedAsset(root, CAPABILITIES_FILE, files[CAPABILITIES_FILE])).toString('utf8'));
    if (capabilities.schema !== 'WorkflowKitRunnerCapabilities/v1' || capabilities.review_launch_request !== 1 || capabilities.read_only_inspection !== true) {
      throw new Error('WorkflowKit runner 能力格式不相容。');
    }
    const tools: unknown = capabilities.review_launch_tools;
    if (tools !== undefined && (!Array.isArray(tools) || !tools.every(isReviewerTool) || new Set(tools).size !== tools.length)) {
      throw new Error('WorkflowKit runner 審查工具清單格式不相容。');
    }
    await verifiedAsset(root, LAUNCH_FILE, files[LAUNCH_FILE]);
    launch = { review_launch_request: 1, read_only_inspection: true, review_launch_sha256: files[LAUNCH_FILE] as string,
      ...(capabilities.read_only_manifest_sha256 === true ? { read_only_manifest_sha256: true } : {}),
      ...(Array.isArray(tools) ? { review_launch_tools: tools } : {}) };
  }
  return { script_path: runnerPath, script_sha256: actual, ...launch };
}

async function unboundRunnerManifest(root: string): Promise<WorkflowKitManifest | undefined> {
  const markerPath = path.join(root, '.gitlab-workspace', 'tool-manifests', 'workflow-kit.json');
  try { await fs.lstat(markerPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  return readWorkflowKitManifest(root);
}

/** Recheck the runner before launch and preserve Python launcher arguments for both processes. */
export async function workflowKitPythonCommand(python: PythonRuntime,
  runner: WorkflowKitRunnerBinding | undefined, helperArgs: readonly string[], options: {
    readOnly?: boolean; installation?: VerifiedWorkflowKitManifest;
  } = {}): Promise<{ executable: string; args: string[] }> {
  const installation = options.installation;
  if (installation) await assertWorkflowKitManifestCurrent(installation);
  if (!runner) return { executable: python.executable, args: [...python.args, ...helperArgs] };
  if (!/^[a-f0-9]{64}$/i.test(runner.script_sha256)) throw new Error('WorkflowKit runner 摘要格式無效。');
  const runnerDirectory = path.dirname(runner.script_path);
  const agentsDirectory = path.dirname(runnerDirectory);
  if (path.basename(runner.script_path) !== 'run.py' || path.basename(runnerDirectory) !== 'gitlab-workspace-kit'
    || path.basename(agentsDirectory) !== '.agents') throw new Error('WorkflowKit runner 路徑無效。');
  const root = path.dirname(agentsDirectory);
  if (installation && path.relative(root, installation.root)) throw new Error('WorkflowKit runner 不屬於已驗證的安裝。');
  for (const directory of [agentsDirectory, runnerDirectory]) {
    const directoryInfo = await fs.lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('WorkflowKit runner 路徑無效；請重新檢查安裝。');
  }
  const actual = await runnerDigest(runner.script_path);
  if (actual !== runner.script_sha256.toLowerCase()) throw new Error('WorkflowKit runner 在複製提示詞後已變更；請重新檢查安裝。');
  if (runner.review_launch_request === 1) {
    const current = await readWorkflowKitRunnerBinding(root, installation);
    if (current?.review_launch_request !== 1 || current.review_launch_sha256 !== runner.review_launch_sha256 ||
      current.script_sha256 !== runner.script_sha256 || JSON.stringify(current.review_launch_tools) !== JSON.stringify(runner.review_launch_tools)) {
      throw new Error('WorkflowKit launcher 在建立任務後已變更；請重新檢查安裝。');
    }
  }
  if (installation) await assertWorkflowKitManifestCurrent(installation);
  const readOnly = options.readOnly && runner.read_only_inspection
    ? ['--read-only', ...(installation && runner.read_only_manifest_sha256
      ? ['--expected-install-manifest-sha256', installation.sha256] : [])] : [];
  return { executable: python.executable,
    args: [...python.args, '-X', 'utf8', '-B', runner.script_path, ...readOnly, '--', python.executable, ...python.args, ...helperArgs] };
}
