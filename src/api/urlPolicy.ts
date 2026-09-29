/** Normalizes a GitLab installation URL that uses HTTP or HTTPS. */
export function normalizeGitLabBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Enter a GitLab URL.');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Enter a valid GitLab URL using HTTP or HTTPS.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('GitLab must use HTTP or HTTPS.');
  }
  if (!getHttpAuthority(trimmed)) {
    throw new Error('Enter a valid GitLab URL using HTTP or HTTPS.');
  }
  if (hasCredentialsQueryOrFragment(trimmed, url)) {
    throw new Error('The GitLab URL cannot contain credentials, a query, or a fragment.');
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
      Boolean(getHttpAuthority(baseUrl)) &&
      Boolean(getHttpAuthority(remoteUrl)) &&
      remote.protocol === base.protocol &&
      remote.origin === base.origin &&
      !hasCredentialsQueryOrFragment(baseUrl, base) &&
      !hasCredentialsQueryOrFragment(remoteUrl, remote)
    );
  } catch {
    return false;
  }
}

function hasCredentialsQueryOrFragment(input: string, url: URL): boolean {
  const trimmed = input.trim();
  const authority = getHttpAuthority(trimmed);
  return Boolean(
    url.username || url.password || authority?.includes('@') ||
    trimmed.includes('?') || trimmed.includes('#')
  );
}

function getHttpAuthority(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed.includes('\\')) {
    return undefined;
  }
  return trimmed.match(/^https?:\/\/([^/?#]+)/i)?.[1];
}
