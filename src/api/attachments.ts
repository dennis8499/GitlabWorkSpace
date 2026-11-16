/** Trusted project and server context supplied by the Extension Host. */
export interface GitLabAttachmentOptions {
  projectId: number;
  projectPath: string;
  serverVersion?: string;
  maxBytes?: number;
}

export class GitLabAttachmentBrowserRequiredError extends Error {
  constructor(readonly browserUrl: string) {
    super('此 GitLab 版本的私有附件需要瀏覽器登入，請點選「在 GitLab 查看」。');
    this.name = 'GitLabAttachmentBrowserRequiredError';
  }
}

export interface ProjectAttachment {
  browserUrl: string;
  apiUrl?: string;
  maxBytes: number;
}

function segments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean).map(part => {
    const decoded = decodeURIComponent(part);
    // eslint-disable-next-line no-control-regex -- Reject decoded URL controls and path separators.
    if (!decoded || decoded === '.' || decoded === '..' || /[\u0000-\u001f\u007f/\\]/.test(decoded) || /%(?:2e|2f|5c)/i.test(decoded)) throw new Error('Invalid attachment path.');
    return decoded;
  });
}

/** Resolve only uploads belonging to the Host's current project, never arbitrary same-host URLs. */
export function resolveProjectAttachment(baseUrl: string, rawUrl: string, options: GitLabAttachmentOptions): ProjectAttachment {
  try {
    const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
    if (!Number.isSafeInteger(options.projectId) || options.projectId < 1 || !options.projectPath || options.projectPath.startsWith('/') || options.projectPath.endsWith('/') || options.projectPath.includes('//')
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 50 * 1024 * 1024) throw new Error('Invalid attachment context.');
    const base = new URL(baseUrl);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid GitLab server.');
    // eslint-disable-next-line no-control-regex -- WHATWG URL parsing would otherwise strip controls before validation.
    if (!rawUrl || rawUrl.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(rawUrl) || /%(?:2f|5c)/i.test(rawUrl)
      || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(rawUrl)) throw new Error('Invalid attachment URL.');
    const url = new URL(rawUrl, base.href.replace(/\/$/, '') + '/');
    if (url.origin !== base.origin || url.username || url.password || url.search || url.hash || url.pathname.includes('//')) throw new Error('Invalid attachment origin.');
    const installation = segments(base.pathname);
    const project = segments(options.projectPath);
    const parts = segments(url.pathname);
    const prefixes = [[...installation, ...project, 'uploads'], [...installation, '-', 'project', String(options.projectId), 'uploads'], ['uploads']];
    const prefix = prefixes.find(candidate => parts.length === candidate.length + 2 && candidate.every((part, index) => parts[index] === part));
    if (!prefix) throw new Error('Attachment is outside the current project.');
    const [secret, filename] = parts.slice(-2);
    if (!/^[a-f0-9]{32}$/i.test(secret)) throw new Error('Invalid attachment secret.');
    const suffix = [secret, filename];
    const browserParts = prefix.length === 1 ? [...installation, ...project, 'uploads', ...suffix] : [...prefix, ...suffix];
    const browserUrl = new URL('/' + browserParts.map(encodeURIComponent).join('/'), base.origin).href;
    const version = /^(\d+)\.(\d+)\.(\d+)(?:-(?:ee|ce))?$/.exec(options.serverVersion ?? '');
    const nativeDownload = version && (Number(version[1]) > 17 || Number(version[1]) === 17 && Number(version[2]) >= 4);
    const apiUrl = nativeDownload ? new URL('/' + [...installation, 'api', 'v4', 'projects', String(options.projectId), 'uploads', ...suffix].map(encodeURIComponent).join('/'), base.origin).href : undefined;
    return { browserUrl, apiUrl, maxBytes };
  } catch {
    throw new Error('The attachment URL is outside this GitLab server or the current project, or its download context is invalid.');
  }
}

export function isAttachmentSignInRedirect(baseUrl: string, browserUrl: string, location: string | null): boolean {
  if (!location) return false;
  try {
    const base = new URL(baseUrl), target = new URL(location, browserUrl);
    return target.origin === base.origin && !target.username && !target.password
      && target.pathname === base.pathname.replace(/\/$/, '') + '/users/sign_in';
  } catch { return false; }
}
