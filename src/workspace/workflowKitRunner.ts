import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PythonRuntime } from './pythonRuntime';
import type { WorkflowKitRunnerBinding } from './reviewSessionProtocol';

const RUNNER_RELATIVE_PATH = '.agents/gitlab-workspace-kit/run.py';
const RUNNER_FILE = RUNNER_RELATIVE_PATH.split('/').join(path.sep);

/** The installer status API authenticates the marker before a caller requests this binding. */
export async function readWorkflowKitRunnerBinding(root: string): Promise<WorkflowKitRunnerBinding | undefined> {
  const markerPath = path.join(root, '.gitlab-workspace', 'tool-manifests', 'workflow-kit.json');
  let markerBytes: Buffer;
  try {
    const markerInfo = await fs.lstat(markerPath);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 16 * 1024 * 1024) {
      throw new Error('WorkflowKit 安裝紀錄不是安全的檔案。');
    }
    markerBytes = await fs.readFile(markerPath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  const marker: unknown = JSON.parse(markerBytes!.toString('utf8'));
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) throw new Error('WorkflowKit 安裝紀錄格式無效。');
  const version = (marker as { version?: unknown }).version;
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('WorkflowKit 安裝版本無效。');
  }
  const files = (marker as { files?: unknown }).files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('WorkflowKit 安裝紀錄缺少受管理檔案清單。');
  const expected = (files as Record<string, unknown>)[RUNNER_RELATIVE_PATH];
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
        throw new Error('WorkflowKit 已宣告 runner，但檔案不存在或不是一般檔案；請重新安裝工作流程包。');
      }
      throw error;
    });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('WorkflowKit runner 路徑無效，請重新安裝工作流程包。');
  }
  const runnerInfo = await fs.lstat(runnerPath).catch(error => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error('WorkflowKit 已宣告 runner，但檔案不存在或不是一般檔案；請重新安裝工作流程包。');
    }
    throw error;
  });
  if (!runnerInfo.isFile() || runnerInfo.isSymbolicLink()) throw new Error('WorkflowKit 已宣告 runner，但檔案不存在或不是一般檔案；請重新安裝工作流程包。');
  const actual = createHash('sha256').update(await fs.readFile(runnerPath)).digest('hex');
  if (actual !== expected.toLowerCase()) throw new Error('WorkflowKit runner 與已驗證的安裝紀錄不符；請重新安裝工作流程包。');
  return { script_path: runnerPath, script_sha256: actual };
}

/** Recheck the runner before launch and preserve Python launcher arguments for both processes. */
export async function workflowKitPythonCommand(python: PythonRuntime,
  runner: WorkflowKitRunnerBinding | undefined, helperArgs: readonly string[]): Promise<{ executable: string; args: string[] }> {
  if (!runner) return { executable: python.executable, args: [...python.args, ...helperArgs] };
  if (!/^[a-f0-9]{64}$/i.test(runner.script_sha256)) throw new Error('WorkflowKit runner 摘要格式無效。');
  const runnerDirectory = path.dirname(runner.script_path);
  const agentsDirectory = path.dirname(runnerDirectory);
  if (path.basename(runner.script_path) !== 'run.py' || path.basename(runnerDirectory) !== 'gitlab-workspace-kit'
    || path.basename(agentsDirectory) !== '.agents') throw new Error('WorkflowKit runner 路徑無效。');
  for (const directory of [agentsDirectory, runnerDirectory]) {
    const directoryInfo = await fs.lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('WorkflowKit runner 路徑無效；請重新檢查安裝。');
  }
  const info = await fs.lstat(runner.script_path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('WorkflowKit runner 路徑無效；請重新檢查安裝。');
  const actual = createHash('sha256').update(await fs.readFile(runner.script_path)).digest('hex');
  if (actual !== runner.script_sha256.toLowerCase()) throw new Error('WorkflowKit runner 在複製提示詞後已變更；請重新檢查安裝。');
  return { executable: python.executable,
    args: [...python.args, '-X', 'utf8', '-B', runner.script_path, '--', python.executable, ...python.args, ...helperArgs] };
}
