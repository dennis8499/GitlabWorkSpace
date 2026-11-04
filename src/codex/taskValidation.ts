import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
/** Resolve missing leaf directories through an existing ancestor without creating anything. */
export async function canonicalRuntime(candidate: string, project: string): Promise<string> {
  let ancestor = path.resolve(candidate);
  const suffix: string[] = [];
  for (;;) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('無法核對審查 runtime 路徑。');
      const parent = path.dirname(ancestor); if (parent === ancestor) throw new Error('審查 runtime 路徑無效。');
      suffix.unshift(path.basename(ancestor)); ancestor = parent;
    }
  }
  if (!(await stat(ancestor)).isDirectory()) throw new Error('審查 runtime 必須是資料夾。');
  const canonical = path.join(ancestor, ...suffix), relative = path.relative(canonical, await realpath(project));
  if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) throw new Error('審查 runtime 不可包含整個專案根目錄，請指定獨立的 Repo 外資料夾。');
  try {
    await run('git', ['-C', ancestor, 'rev-parse', '--absolute-git-dir'], {
      windowsHide: true, timeout: 5000, maxBuffer: 32_768,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' }
    });
  } catch (error) {
    const details = error as { code?: number; stderr?: string };
    if (details.code === 128 && /not a git repository/i.test(details.stderr ?? '')) return canonical;
    throw new Error('無法確認審查 runtime 是否位於 Git Repo 外，請檢查路徑及 Git 執行環境。');
  }
  throw new Error('審查 runtime 位於 Git Repo 內，請將 gitlabWorkspace.reviewRuntimePath 設為 Repo 外的獨立資料夾。');
}
