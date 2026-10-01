import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PythonCommand {
  executable: string;
  args: string[];
}

export interface PythonRuntime extends PythonCommand {
  env: NodeJS.ProcessEnv;
  version: string;
}

export type PythonVersionProbe = (command: PythonCommand, env: NodeJS.ProcessEnv) => Promise<string>;

export function pythonCommandCandidates(configuredPath: string, platform = process.platform): PythonCommand[] {
  const requested = configuredPath.trim() || 'python';
  const windows = platform === 'win32';
  const basename = windows ? path.win32.basename(requested) : path.basename(requested);
  const args = windows && /^py(?:\.exe)?$/i.test(basename) ? ['-3'] : [];
  const candidates: PythonCommand[] = [{ executable: requested, args }];
  if (windows && requested.toLocaleLowerCase('en-US') === 'python') {
    candidates.push({ executable: 'python3', args: [] }, { executable: 'py', args: ['-3'] });
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.executable.toLocaleLowerCase('en-US');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function pythonUtf8Environment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...environment, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}

async function probePythonVersion(command: PythonCommand, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync(command.executable, [...command.args, '--version'], {
    encoding: 'utf8',
    env,
    timeout: 10_000,
    windowsHide: true
  });
  return `${result.stdout} ${result.stderr}`;
}

export async function resolvePythonRuntime(
  configuredPath: string,
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  versionProbe: PythonVersionProbe = probePythonVersion
): Promise<PythonRuntime> {
  const env = pythonUtf8Environment(environment);
  for (const command of pythonCommandCandidates(configuredPath, platform)) {
    try {
      const version = await versionProbe(command, env);
      const parsed = /Python\s+(\d+)\.(\d+)/.exec(version);
      if (!parsed || Number(parsed[1]) < 3 || (Number(parsed[1]) === 3 && Number(parsed[2]) < 11)) continue;
      return { ...command, env, version: `Python ${parsed[1]}.${parsed[2]}` };
    } catch {
      // Try the next supported Windows launcher only when the default command is unavailable.
    }
  }
  throw new Error('需要 Python 3.11+ 才能安裝工具 Release。請確認 gitlabWorkspace.pythonPath，並確認 Windows 已安裝 Python 或 Python launcher。');
}
