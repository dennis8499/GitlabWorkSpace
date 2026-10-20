import { isAllowedGitRemote } from '../api/urlPolicy';

export interface GitRemoteAddress { name: string; fetchUrl?: string; pushUrl?: string; }

export function gitFetchArguments(remote: string, branch?: string, pruneOnFetch = false): string[] {
  const args = ['fetch', '--atomic', '--no-auto-maintenance', '--jobs=1'];
  if (branch !== undefined) args.push('--no-tags', '--no-prune', '--no-recurse-submodules', '--no-write-fetch-head');
  else if (pruneOnFetch) args.push('--prune');
  return [...args, remote, ...(branch !== undefined ? ['+refs/heads/' + branch + ':refs/remotes/' + remote + '/' + branch] : [])];
}

/** Parse the network command we are actually executing, never the first known Repo. */
export function gitNetworkRemoteUrl(args: readonly string[], remotes: readonly GitRemoteAddress[]): string | undefined {
  if (!['fetch', 'push', 'ls-remote', 'pull', 'clone'].includes(args[0])) return undefined;
  const withValue = new Set(['-j', '--jobs', '--depth', '--shallow-since', '--shallow-exclude', '--upload-pack', '--receive-pack', '--exec', '-o', '--push-option', '--server-option', '--filter', '--negotiation-tip', '--refmap', '--sort', '--template', '--origin', '--branch', '-b']);
  let options = true, selected: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const value = args[index];
    if (options && value === '--') { options = false; continue; }
    if (options && withValue.has(value)) { index++; continue; }
    if (options && value.startsWith('-')) continue;
    selected = value; break;
  }
  if (!selected) return undefined;
  const remote = remotes.find(item => item.name === selected);
  return remote ? args[0] === 'push' ? remote.pushUrl ?? remote.fetchUrl : remote.fetchUrl : selected;
}

/** A token for a subpath installation must not authorize a sibling application. */
export function isTrustedGitLabRemote(baseUrl: string | undefined, remoteUrl: string): boolean {
  if (!baseUrl || !isAllowedGitRemote(baseUrl, remoteUrl)) return false;
  try {
    const base = new URL(baseUrl), remote = new URL(remoteUrl);
    const basePath = base.pathname.replace(/\/+$/, '');
    return remote.pathname.length > basePath.length + 1 &&
      remote.pathname.startsWith(basePath + '/') && !/%(?:2e|2f|5c|00|25)/i.test(remote.pathname);
  } catch { return false; }
}
