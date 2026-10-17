import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BmadCatalogNode } from './bmadProtocol';

export interface BmadTerminalOptions { shellPath: string; shellArgs: string[]; }

/** Pass the prompt as an argument to the executable, never through a shell. */
export function bmadTerminalOptions(
  prompt: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  lookup: (filename: string) => boolean = existsSync
): BmadTerminalOptions | undefined {
  const windows = platform === 'win32';
  const paths = environment[Object.keys(environment).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'] ?? '';
  const directories = paths.split(windows ? ';' : ':').filter(Boolean);
  const join = windows ? path.win32.join : path.posix.join;
  for (const directory of directories) {
    const executable = join(directory, windows ? 'codex.exe' : 'codex');
    if (lookup(executable)) return { shellPath: executable, shellArgs: [prompt] };
  }
  if (windows) {
    // npm's .cmd is a shell script. Run its JavaScript entry point with Node
    // directly so quotes, %, &, $ and newlines in a prompt stay data.
    const node = directories.map(directory => join(directory, 'node.exe')).find(lookup);
    if (!node) return undefined;
    for (const directory of directories) {
      const shim = join(directory, 'codex.cmd');
      const script = join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (lookup(shim) && lookup(script)) return { shellPath: node, shellArgs: [script, prompt] };
    }
  }
  return undefined;
}

export function buildBmadLaunchPrompt(node: BmadCatalogNode): string {
  if (!/^bmad-[a-z0-9-]+$/.test(node.skill)) throw new Error('BMAD Skill 名稱無效。');
  return [
    `請使用 $${node.skill} 執行此專案的 BMAD 步驟。`,
    node.action ? `步驟意圖：${node.action}` : '',
    node.args ? `官方操作參數提示：${node.args}` : '',
    '請先讀取此 Skill 的官方指引，以繁體中文互動，保留 BMAD 原生產物格式、狀態及完成條件。'
  ].filter(Boolean).join('\n');
}
