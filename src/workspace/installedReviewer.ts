import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ReviewerToolId } from './reviewSessionProtocol';
import type { InstalledReviewerBinding } from './reviewExecution';

/** Bind a copied task to the actual installed entrypoint, without executing it. */
export async function readInstalledReviewerBinding(root: string, tool: ReviewerToolId): Promise<InstalledReviewerBinding> {
  if (tool !== 'merge-reviewer' && tool !== 'release-reviewer') throw new Error('未知的 Reviewer 工具。');
  const directory = path.resolve(root, '.agents', 'skills', tool);
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('已安裝 Reviewer 目錄無效，請重新安裝工作流程包。');
  const script = path.join(directory, 'scripts', 'review_session.py');
  const skill = path.join(directory, 'SKILL.md'), versionFile = path.join(directory, 'VERSION');
  const files = [script, skill, versionFile];
  for (const file of files) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('已安裝 Reviewer 的來源檔案無效，請重新安裝工作流程包。');
    const actual = await fs.realpath(file), relative = path.relative(await fs.realpath(directory), actual);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Reviewer helper 不在已安裝技能目錄內。');
  }
  const [scriptBytes, skillBytes, versionBytes] = await Promise.all(files.map(file => fs.readFile(file)));
  const version = versionBytes.toString('utf8').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('已安裝 Reviewer 版本格式無效。');
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const rows: [string, string][] = [];
  const skip = new Set(['__pycache__', '.pytest_cache', '.git']);
  async function inventory(directoryPath: string): Promise<void> {
    for (const entry of await fs.readdir(directoryPath, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name.endsWith('.pyc')) continue;
      const file = path.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) throw new Error('已安裝 Reviewer 的 payload 不接受連結。');
      if (entry.isDirectory()) await inventory(file);
      else if (entry.isFile()) rows.push([path.relative(directory, file).split(path.sep).join('/'), digest(await fs.readFile(file))]);
      else throw new Error('已安裝 Reviewer 的 payload 包含非一般檔案。');
    }
  }
  await inventory(directory);
  rows.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  return { schema: 'InstalledReviewerBinding/v1', tool, version, script_path: script,
    script_sha256: digest(scriptBytes), skill_sha256: digest(skillBytes),
    payload_sha256: digest(Buffer.from(JSON.stringify(rows))), payload_files: rows.length };
}
