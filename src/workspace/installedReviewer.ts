import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ownedStoragePath } from '../storage/ownedStorage';
import type { InstalledReviewerBinding, ReviewerToolId } from './reviewSessionProtocol';
import { readWorkflowKitRunnerBinding, type VerifiedWorkflowKitInstallation } from './workflowKitRunner';

/** Bind a copied task to the actual installed entrypoint, without executing it. */
export async function readInstalledReviewerBinding(root: string, tool: ReviewerToolId,
  installation?: VerifiedWorkflowKitInstallation): Promise<InstalledReviewerBinding> {
  if (tool !== 'merge-reviewer' && tool !== 'release-reviewer') throw new Error('未知的 Reviewer 工具。');
  const directory = path.resolve(root, '.agents', 'skills', tool);
  if (installation && !await ownedStoragePath(root, directory)) throw new Error('找不到已驗證的 Reviewer 目錄。');
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('已安裝 Reviewer 目錄無效，請重新安裝工作流程包。');
  const script = path.join(directory, 'scripts', 'review_session.py');
  const skill = path.join(directory, 'SKILL.md'), versionFile = path.join(directory, 'VERSION');
  const files = [script, skill, versionFile];
  const canonicalDirectory = await fs.realpath(directory);
  const verifiedFiles = await Promise.all(files.map(async file => {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('已安裝 Reviewer 的來源檔案無效，請重新安裝工作流程包。');
    const actual = await fs.realpath(file), relative = path.relative(canonicalDirectory, actual);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Reviewer helper 不在已安裝技能目錄內。');
    return fs.readFile(file);
  }));
  const [scriptBytes, skillBytes, versionBytes] = verifiedFiles;
  const knownBytes = new Map(files.map((file, index) => [file, verifiedFiles[index]]));
  const version = versionBytes.toString('utf8').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('已安裝 Reviewer 版本格式無效。');
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const rows: [string, string][] = [];
  const skip = new Set(['__pycache__', '.pytest_cache', '.git']);
  async function inventory(directoryPath: string): Promise<void> {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    await Promise.all(entries.map(async entry => {
      if (skip.has(entry.name) || entry.name.endsWith('.pyc')) return;
      const file = path.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) throw new Error('已安裝 Reviewer 的 payload 不接受連結。');
      if (entry.isDirectory()) await inventory(file);
      else if (entry.isFile()) rows.push([path.relative(directory, file).split(path.sep).join('/'), digest(knownBytes.get(file) ?? await fs.readFile(file))]);
      else throw new Error('已安裝 Reviewer 的 payload 包含非一般檔案。');
    }));
  }
  const [, workflow_kit_runner] = await Promise.all([inventory(directory), installation ? installation.runner : readWorkflowKitRunnerBinding(root)]);
  rows.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  if (installation) {
    const prefix = `.agents/skills/${tool}/`;
    const expected = installation.marker.files;
    if (Object.keys(expected).filter(file => file.startsWith(prefix)).length !== rows.length ||
        rows.some(([name, sha]) => expected[prefix + name] !== sha)) {
      throw new Error('Reviewer 檔案與已驗證的 WorkflowKit 安裝紀錄不符。');
    }
  }
  return { schema: 'InstalledReviewerBinding/v1', tool, version, script_path: script,
    script_sha256: digest(scriptBytes), skill_sha256: digest(skillBytes),
    payload_sha256: digest(Buffer.from(JSON.stringify(rows))), payload_files: rows.length,
    ...(workflow_kit_runner ? { workflow_kit_runner } : {}) };
}
