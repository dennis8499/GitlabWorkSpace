import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

export const missingFile = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
export function insideStorage(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
/** Validate every existing component, including junctions, before touching owned data. */
export async function ownedStoragePath(root: string, target: string): Promise<boolean> {
  if (!insideStorage(root, target)) throw new Error('清理路徑超出所屬儲存區。');
  const rootInfo = await lstat(root).catch(error => { if (missingFile(error)) return undefined; throw error; });
  if (!rootInfo) return false;
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('儲存區不可重新導向。');
  const physicalRoot = await realpath(root);
  let current = root;
  for (const component of path.relative(root, target).split(path.sep)) {
    current = path.join(current, component);
    let info;
    try { info = await lstat(current); } catch (error) { if (missingFile(error)) return false; throw error; }
    if (info.isSymbolicLink() || !insideStorage(physicalRoot, await realpath(current))) throw new Error('清理路徑不可重新導向。');
  }
  return true;
}
export async function removeOwnedStorage(root: string, target: string): Promise<void> {
  if (!await ownedStoragePath(root, target)) return;
  const inspect = async (candidate: string): Promise<void> => {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error('清理目錄包含重新導向，已保留原件。');
    if (info.isDirectory()) for (const entry of await readdir(candidate)) await inspect(path.join(candidate, entry));
  };
  await inspect(target);
  // Check the absolute target again after walking; never follow links during removal.
  await ownedStoragePath(root, target);
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
/** Call only while holding the destination's control gate or after its deletion fence. */
export async function removeOwnedAtomicTemps(root: string, file: string): Promise<void> {
  if (!insideStorage(root, file) || path.dirname(file) !== path.resolve(root)) throw new Error('暫存檔不屬於此儲存區。');
  const prefix = path.basename(file) + '.';
  let names: string[];
  try { names = await readdir(root); } catch (error) { if (missingFile(error)) return; throw error; }
  for (const name of names) {
    if (!name.startsWith(prefix) || !/^[a-f0-9-]{36}\.tmp$/i.test(name.slice(prefix.length))) continue;
    const target = path.join(root, name); await ownedStoragePath(root, target);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('暫存檔無法安全清理。');
    await removeOwnedStorage(root, target);
  }
}
