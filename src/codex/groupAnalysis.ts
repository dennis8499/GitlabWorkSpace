import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { parse as parseToml } from '@iarna/toml';
import type { CodexTaskSpec, CodexTaskResult } from './protocol';
import type { PythonRuntime } from '../workspace/pythonRuntime';
import { exportCommitSnapshot, sameWorkflowPath, workflowGit, workflowHash } from './projectWorkflows';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { insideStorage, ownedStoragePath } from '../storage/ownedStorage';
import type { CodexGroupRepository } from './workflowProtocol';
export type { CodexGroupRepository, CodexGroupAnalysisBinding } from './workflowProtocol';

/** Match BMAD's layered output_folder setting without modifying its configuration. */
export async function groupSpecsDirectory(root: string): Promise<string> {
  const variables = new Map<string, string>([['project-root', root], ['output_folder', '_bmad-output']]);
  for (const filename of ['_bmad/config.toml', '_bmad/config.user.toml', '_bmad/custom/config.toml', '_bmad/custom/config.user.toml']) {
    const file = path.join(root, filename);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 || !insideStorage(await realpath(root), await realpath(file))) throw new Error('BMAD 設定路徑無法驗證。');
      const config = parseToml(await readFile(file, 'utf8')) as Record<string, unknown>;
      const visit = (value: Record<string, unknown>): void => {
        for (const [key, entry] of Object.entries(value)) {
          if (typeof entry === 'string') variables.set(key, entry);
          else if (entry && typeof entry === 'object' && !Array.isArray(entry)) visit(entry as Record<string, unknown>);
        }
      };
      visit(config);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  let output = variables.get('output_folder')!;
  for (let iteration = 0; iteration < 10; iteration++) {
    const next = output.replace(/\{([^}]+)\}/g, (original, name: string) => variables.get(name) ?? original);
    if (next === output) break; output = next;
  }
  if (/\{[^}]+\}/.test(output)) throw new Error('BMAD 輸出路徑包含無法解析的變數。');
  const result = path.resolve(root, output, 'specs');
  if (!insideStorage(root, result)) throw new Error('開發文件輸出必須位於目前 Group。');
  return result;
}

export async function prepareGroupAnalysis(options: {
  root: string; storage: string; source: Extract<CodexTaskSpec['source'], { kind: 'group-analysis' }>;
  repositories: Array<{ id: string; name: string; path: string; projectPath?: string }>;
  previous?: CodexTaskSpec; signal?: AbortSignal;
}): Promise<CodexTaskSpec> {
  const { source, signal } = options;
  if (!source.requirement?.trim()) throw new Error('請描述要分析的功能、異動目的與驗收期待。');
  const root = await realpath(options.root), prior = options.previous?.groupAnalysis;
  if (prior) {
    if (prior.groupRoot !== root || options.previous!.source.requirement !== source.requirement) throw new Error('原 Group 或需求已變更，請重新準備。');
    return { ...options.previous!, source };
  }
  const requested = source.repositoryIds?.length ? new Set(source.repositoryIds) : undefined;
  const candidates = options.repositories.filter(repo => !requested || requested.has(repo.id));
  if (!candidates.length || candidates.length > 100 || requested && candidates.length !== requested.size) throw new Error('請選擇目前 Group 中 1 到 100 個有效 Repo。');
  const id = randomUUID(), runtimeRoot = path.join(options.storage, 'codex-group-analysis', id);
  const outputRoot = path.join(await groupSpecsDirectory(root), id), repositories: CodexGroupRepository[] = [];
  for (const repo of candidates) {
    signal?.throwIfAborted();
    const canonical = await realpath(repo.path);
    if (!sameWorkflowPath(canonical, root) && !sameWorkflowPath(path.dirname(canonical), root)) throw new Error('分析 Repo 必須位於目前 Group，請重新選擇。');
    const top = (await workflowGit(canonical, ['rev-parse', '--show-toplevel'])).trim();
    if (await realpath(top) !== canonical) continue;
    const sha = (await workflowGit(canonical, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('無法取得 Repo 的已提交版本。');
    const key = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
    repositories.push({ ...repo, path: canonical, sha, snapshotPath: path.join(runtimeRoot, 'sources', key) });
  }
  if (!repositories.length) throw new Error('目前 Group 沒有可分析的已提交 Repo。');
  const skillPath = path.join(root, '.agents', 'skills', 'bmad-spec', 'SKILL.md'); await access(skillPath);
  const skill = await readFile(skillPath, 'utf8');
  const binding = { id, groupRoot: root, runtimeRoot, outputRoot, repositories };
  const prompt = [
    '$bmad-spec 依下列需求執行 Group 跨專案需求影響分析，保留問答釐清能力。',
    `使用者需求：\n${source.requirement}`,
    '來源僅使用下方固定提交快照。原 Group 是技能安裝位置；不要從原工作目錄讀取未提交內容。',
    ...repositories.map(repo => `${repo.name} (${repo.projectPath ?? repo.path}) @ ${repo.sha}\n唯讀來源：${repo.snapshotPath}`),
    `文件僅保存到 ${outputRoot}，至少產生 SPEC.md、cards.md、sources.json。`,
    'SPEC.md 必須包含需求、現況與預期、受影響專案/模組、檔案證據、介面、依賴/實作順序、驗收條件、測試計畫、風險與待確認事項。',
    'cards.md 依專案與功能提供可複製的牌卡標題、描述及驗收內容，拆分與實際開卡由使用者決定。不要建立 Issue、修改程式、提交、推送或發布。',
    'sources.json 格式為 {"repositories":[{"id":"來源清單的ID","sha":"固定SHA","evidence":[{"path":"Repo內相對路徑","claim":"影響說明或不受影響的依據"}]}]}；每個選定專案都須列出分析結論、來源與證據。',
    `來源ID清單：${JSON.stringify(repositories.map(repo => ({ id: repo.id, name: repo.name, sha: repo.sha })))}`,
    '資料缺少、快照無法完整分析或仍有影響實作的需求問題時先提問/明列缺口，不能宣稱已完成。'
  ].join('\n\n');
  return { source, title: 'Group 需求影響分析', root, executionRoot: outputRoot, workspaceKey: workflowHash(root),
    writableRoots: [outputRoot], skill: { name: 'bmad-spec', path: skillPath }, groupAnalysis: binding,
    prompt, environmentKey: workflowHash(JSON.stringify([root, binding, skill, source.requirement])),
    delivery: { mode: 'manual', testCommands: [] } };
}

export async function startGroupAnalysis(spec: CodexTaskSpec, storage: string, python: PythonRuntime, signal?: AbortSignal): Promise<void> {
  const binding = spec.groupAnalysis!;
  if (binding.runtimeRoot !== path.join(storage, 'codex-group-analysis', binding.id) || !insideStorage(binding.groupRoot, binding.outputRoot)) throw new Error('Group 分析目錄不屬於此任務。');
  await mkdir(binding.runtimeRoot, { recursive: true });
  await ownedStoragePath(storage, binding.runtimeRoot);
  for (const repo of binding.repositories) {
    signal?.throwIfAborted();
    const receipt = path.join(binding.runtimeRoot, `${path.basename(repo.snapshotPath)}.json`);
    let previous: { sha?: string; path?: string } | undefined;
    try { previous = JSON.parse(await readFile(receipt, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous) { if (previous.sha !== repo.sha || previous.path !== repo.path) throw new Error('Group 來源快照收據不符。'); }
    else {
      await mkdir(path.dirname(repo.snapshotPath), { recursive: true });
      await exportCommitSnapshot(repo.path, repo.sha, repo.snapshotPath, python);
      await atomicNetworkJson(receipt, { sha: repo.sha, path: repo.path });
    }
  }
  await mkdir(binding.outputRoot, { recursive: true });
  await ownedStoragePath(binding.groupRoot, binding.outputRoot);
}

export async function collectGroupAnalysis(spec: CodexTaskSpec): Promise<CodexTaskResult> {
  const binding = spec.groupAnalysis!;
  const files = await readdir(binding.outputRoot);
  for (const name of ['SPEC.md', 'cards.md', 'sources.json']) {
    const file = path.join(binding.outputRoot, name), info = await lstat(file);
    if (!files.includes(name) || !info.isFile() || info.isSymbolicLink() || !info.size || info.size > 2 * 1024 * 1024) throw new Error(`分析文件 ${name} 缺少或超出範圍。`);
    await ownedStoragePath(binding.outputRoot, file);
  }
  const sources = JSON.parse(await readFile(path.join(binding.outputRoot, 'sources.json'), 'utf8')) as { repositories?: Array<{ id: string; sha: string; evidence?: Array<{ path: string; claim: string }> }> };
  if (!Array.isArray(sources.repositories) || sources.repositories.length !== binding.repositories.length || new Set(sources.repositories.map(repo => repo.id)).size !== sources.repositories.length) throw new Error('缺少選定專案的來源與證據，請完成所有 Repo 的分析。');
  const specification = await readFile(path.join(binding.outputRoot, 'SPEC.md'), 'utf8');
  for (const section of [/需求|requirements?/i, /專案|模組|projects?|modules?/i, /證據|evidence/i, /介面|interfaces?|api/i,
    /依賴|相依|dependencies|dependency/i, /順序|order|sequence/i, /驗收|acceptance/i, /測試|tests?|validation/i]) {
    if (!section.test(specification)) throw new Error('開發文件缺少必要的需求、介面、依賴、驗收或測試章節。');
  }
  for (const item of sources.repositories) {
    const repo = binding.repositories.find(repo => repo.id === item.id && repo.sha === item.sha);
    if (!repo || !Array.isArray(item.evidence) || !item.evidence.length) throw new Error('分析證據與固定 Repo/SHA 不符。');
    for (const evidence of item.evidence) {
      if (typeof evidence.path !== 'string' || !evidence.claim?.trim() || !insideStorage(repo.snapshotPath, path.resolve(repo.snapshotPath, evidence.path))) throw new Error('程式證據路徑無效。');
      const target = path.resolve(repo.snapshotPath, evidence.path); await ownedStoragePath(repo.snapshotPath, target); await access(target);
    }
  }
  return { state: 'ready', summary: `已整合 ${sources.repositories.length} 個專案的異動需求與開發文件；請依牌卡建議自行開立 Issue。`,
    reportPath: path.join(binding.outputRoot, 'SPEC.md'), handoffPath: path.join(binding.outputRoot, 'cards.md'), files: ['SPEC.md', 'cards.md', 'sources.json'] };
}
