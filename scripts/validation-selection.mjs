import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const full = reason => ({ mode: 'all', reason });

function category(filename) {
  if (typeof filename !== 'string' || !filename || filename.includes('\\') ||
      filename.startsWith('/') || filename.split('/').some(part => !part || part === '.' || part === '..')) return 'all';
  if (filename.startsWith('docs/work/')) return 'none';
  if (filename.startsWith('src/webview/') || filename.startsWith('test/behavior/')) return 'ui';
  if (filename.startsWith('test/unit/')) return 'quick';
  if (/^(?:README|CONTRIBUTING)(?:\.[^/]+)?$/i.test(filename) || filename.startsWith('docs/')) return 'package';
  return 'all';
}

/** Read --name-status -z, including both sides of every rename/copy. */
export function parseChanges(output) {
  if (typeof output !== 'string' || !output.endsWith('\0')) throw new Error('Missing NUL-delimited Git diff');
  const fields = output.slice(0, -1).split('\0');
  const changes = [];
  while (fields.length) {
    const status = fields.shift();
    if (!/^(?:[AMD]|[RC](?:100|0?\d{1,2}))$/.test(status)) throw new Error('Unsupported Git change status');
    const count = /^[RC]/.test(status) ? 2 : 1;
    if (fields.length < count) throw new Error('Incomplete Git change');
    const paths = fields.splice(0, count);
    if (paths.some(filename => !filename)) throw new Error('Empty Git path');
    changes.push({ status, paths });
  }
  return changes;
}

export function selectValidation({ eventName, changes }) {
  if (eventName !== 'pull_request') return full('Only pull requests may use scoped validation');
  if (!Array.isArray(changes) || changes.length === 0) return full('No reliable changed-file list');
  const categories = new Set();
  for (const change of changes) {
    if (!change || !/^(?:[AMD]|[RC](?:100|0?\d{1,2}))$/.test(change.status) ||
        !Array.isArray(change.paths) || change.paths.length !== (/^[RC]/.test(change.status) ? 2 : 1)) {
      return full('Unknown or incomplete change');
    }
    for (const filename of change.paths) categories.add(category(filename));
  }
  if (categories.has('all')) return full('Runtime, build, validation or unknown paths changed');
  categories.delete('none');
  if (categories.size === 0) return { mode: 'none', reason: 'Only historical work evidence changed' };
  if (categories.size === 1) return { mode: [...categories][0], reason: 'Changes fit one validation profile' };
  if ([...categories].every(value => ['ui', 'quick'].includes(value))) {
    return { mode: 'ui', reason: 'UI validation also includes unit tests' };
  }
  return full('Mixed changes need complete validation');
}

export function inspectChanges({ repository = '.', eventName, base, head, git = spawnSync }) {
  if (eventName !== 'pull_request') return selectValidation({ eventName });
  if (![base, head].every(value => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value))) {
    return full('Missing or invalid pull-request commits');
  }
  try {
    const result = git('git', ['-C', repository, 'diff', '--name-status', '-z', '--find-renames', `${base}...${head}`, '--'],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    if (result.error || result.status !== 0) return full('Cannot read the complete merge-base diff');
    return selectValidation({ eventName, changes: parseChanges(result.stdout) });
  } catch {
    return full('Cannot parse the complete merge-base diff');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = inspectChanges({ repository: process.env.VALIDATION_REPOSITORY || '.',
    eventName: process.env.GITHUB_EVENT_NAME, base: process.env.PR_BASE_SHA, head: process.env.PR_HEAD_SHA });
  console.log(JSON.stringify(result));
}
