import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ProjectFolder, ProjectRootContext } from './projectRootProtocol';
export type { ProjectFolder, ProjectRootContext } from './projectRootProtocol';

export const PROJECT_ROOT_SETTING = 'projectRoot';
export const PROJECT_FOLDER_KEY = 'gitlabWorkspace.projectFolder';

export function selectedProjectFolder(folders: readonly ProjectFolder[], selectedUri?: string): ProjectFolder | undefined {
  return folders.length === 1 ? folders[0] : folders.find(folder => folder.uri === selectedUri);
}

/** The opened folder is authoritative; never infer a parent from Git or GitLab. */
export async function resolveProjectRootContext(
  folders: ProjectFolder[], selectedUri: string | undefined, configuredRoot: string
): Promise<ProjectRootContext> {
  const folder = selectedProjectFolder(folders, selectedUri);
  const configured = configuredRoot.trim();
  const context: ProjectRootContext = { folders, selectedFolderUri: folder?.uri, manual: !!configured,
    revision: createHash('sha256').update(JSON.stringify([folders, folder?.uri, configured])).digest('hex') };
  if (!folder) return { ...context, error: folders.length ? '請選擇本次操作的專案資料夾。' : '請先在 VS Code 開啟本機專案資料夾。' };
  const candidate = path.resolve(folder.path, configured || '.');
  try {
    const root = await realpath(candidate);
    if (!(await stat(root)).isDirectory()) throw new Error('Not a directory');
    return { ...context, root,
      revision: createHash('sha256').update(JSON.stringify([context.revision, root])).digest('hex') };
  } catch {
    return { ...context, error: `專案根目錄不存在或無法讀取：${candidate}` };
  }
}
