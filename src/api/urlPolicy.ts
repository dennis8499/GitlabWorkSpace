/** Normalizes a GitLab installation URL and limits clear-text HTTP to IPv4 loopback. */
export function normalizeGitLabBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Enter a GitLab URL.');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Enter a valid GitLab URL using HTTPS or http://127.0.0.1.');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The GitLab URL cannot contain credentials, a query, or a fragment.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('GitLab must use HTTPS, except for http://127.0.0.1 loopback.');
  }
  if (url.protocol === 'http:' && url.hostname !== '127.0.0.1') {
    throw new Error('HTTP is allowed only for the exact 127.0.0.1 loopback address.');
  }

  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

export function gitLabApiRoot(baseUrl: string): URL {
  return new URL(`${baseUrl.replace(/\/+$/, '')}/api/v4/`);
}

/** True only when a GitLab-provided clone URL stays on the configured server. */
export function isAllowedGitRemote(baseUrl: string, remoteUrl: string): boolean {
  try {
    const base = new URL(baseUrl);
    const remote = new URL(remoteUrl);
    return (
      remote.protocol === base.protocol &&
      remote.origin === base.origin &&
      !remote.username &&
      !remote.password &&
      !remote.search &&
      !remote.hash
    );
  } catch {
    return false;
  }
}
