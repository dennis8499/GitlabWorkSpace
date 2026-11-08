import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SyntaxAnalysisBinding } from './reviewSessionProtocol';

const PREFIX = '.agents/gitlab-workspace-kit/scripts/syntax-context/';
const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

async function plain(root: string, relative: string): Promise<string> {
  if (relative.includes('\\') || relative.includes(':') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('WorkflowKit 語法分析資產路徑無效。');
  }
  let current = path.resolve(root);
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink()) throw new Error('WorkflowKit 語法分析資產不能使用連結。');
  }
  const info = await fs.lstat(current);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('WorkflowKit 語法分析資產無效。');
  return current;
}

/** Called only after installer status has authenticated this managed installation. */
export async function readSyntaxAnalysisBinding(root: string): Promise<SyntaxAnalysisBinding | undefined> {
  let marker: { files?: Record<string, unknown>; capabilities?: unknown };
  try {
    const markerPath = await plain(root, '.gitlab-workspace/tool-manifests/workflow-kit.json');
    marker = JSON.parse((await fs.readFile(markerPath)).toString('utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const expected = marker.files?.[PREFIX + 'bundle.json'];
  if (expected === undefined) {
    if (Array.isArray(marker.capabilities) && marker.capabilities.includes('syntax-context')) {
      throw new Error('WorkflowKit 已宣告語法分析，但缺少受管理資產。');
    }
    return undefined;
  }
  if (!hash(expected)) throw new Error('WorkflowKit 語法分析摘要無效。');
  const bundlePath = await plain(root, PREFIX + 'bundle.json');
  const bytes = await fs.readFile(bundlePath);
  if (digest(bytes) !== expected) throw new Error('WorkflowKit 語法分析套件與安裝紀錄不符。');
  const bundle = JSON.parse(bytes.toString('utf8')) as { schema?: unknown; files?: Record<string, unknown>; languages?: unknown };
  if (bundle.schema !== 'SyntaxBundle/v1' || !bundle.files || typeof bundle.files !== 'object' || Array.isArray(bundle.files)
    || !Array.isArray(bundle.languages) || !bundle.languages.every(language => typeof language === 'string')) {
    throw new Error('WorkflowKit 語法分析套件格式無效。');
  }
  for (const [name, expectedHash] of Object.entries(bundle.files)) {
    if (!hash(expectedHash) || marker.files?.[PREFIX + name] !== expectedHash) throw new Error('WorkflowKit 語法分析資產未受管理。');
    const file = await plain(root, PREFIX + name);
    if (digest(await fs.readFile(file)) !== expectedHash) throw new Error('WorkflowKit 語法分析資產已變更，請重新檢查安裝。');
  }
  if (!hash(bundle.files['cli.py']) || !hash(bundle.files['acceptance.json'])) throw new Error('WorkflowKit 語法分析缺少必要入口。');
  const acceptance = JSON.parse((await fs.readFile(path.join(path.dirname(bundlePath), 'acceptance.json'))).toString('utf8'));
  if (acceptance.schema !== 'SyntaxAcceptance/v1' || !['auto', 'off'].includes(acceptance.default_mode)) {
    throw new Error('WorkflowKit 語法分析驗收狀態無效。');
  }
  return { schema: 'SyntaxAnalysisBinding/v1', script_path: path.join(path.dirname(bundlePath), 'cli.py'),
    engine_sha256: expected, languages: bundle.languages, default_mode: acceptance.default_mode };
}

export async function verifySyntaxAnalysisBinding(binding: SyntaxAnalysisBinding): Promise<void> {
  const root = path.resolve(path.dirname(binding.script_path), '../../../..');
  const current = await readSyntaxAnalysisBinding(root);
  if (!current || current.script_path !== binding.script_path || current.engine_sha256 !== binding.engine_sha256) {
    throw new Error('WorkflowKit 語法分析在建立任務後已變更；請重新檢查安裝。');
  }
}
