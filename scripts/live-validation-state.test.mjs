import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanupLoad, createIssue, ensureIssueLink, GitLab } from './live-validation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateRoot = path.join(root, '.gitlab-workspace-validation');

function fixturePaths(runId) {
  return {
    runId,
    manifestPath: path.join(stateRoot, 'runs', runId, 'ce16-load.json'),
    workspacePath: path.join(stateRoot, 'workspaces', 'ce16', runId, 'performance')
  };
}

function cleanupManifest(runId, workspacePath) {
  return {
    schema: 'GitLabWorkspaceLiveFixture/v2', environment: 'ce16', runId,
    ownerMarker: `load-${runId}-ce16`,
    group: { id: 700, fullPath: `grp-sn-maint/performance-${runId}` },
    checkoutRoot: workspacePath,
    resources: { projects: [{ id: 800, path: `grp-sn-maint/performance-${runId}/repo-01` }] }
  };
}

test('an interrupted load rerun reuses the existing Issue and records it only once', async () => {
  const title = 'Validation rerun issue';
  const issue = { id: 900, iid: 3, title, web_url: 'http://gitlab.invalid/issues/3', assignees: [] };
  const manifest = { resources: { issues: [] } };
  const calls = [];
  const client = {
    async pages(route) { calls.push(['pages', route]); return []; },
    async request(route, options) {
      calls.push([options?.method ?? 'GET', route]);
      if (options?.method === 'POST') return issue;
      return issue;
    }
  };

  const first = await createIssue(client, 41, title, 'owned validation issue', manifest, 'issues');
  const second = await createIssue(client, 41, title, 'owned validation issue', manifest, 'issues');

  assert.equal(first.iid, issue.iid);
  assert.equal(second.iid, issue.iid);
  assert.equal(calls.filter(([method]) => method === 'POST').length, 1);
  assert.equal(calls.filter(([, route]) => route === 'projects/41/issues/3').length, 1);
  assert.equal(manifest.resources.issues.length, 1);
});

test('a two-way REST issue link found in GitLab response fields is recorded without a duplicate POST', async () => {
  const manifest = { resources: { graphLinks: [] } };
  const calls = [];
  const client = {
    async pages(route) {
      calls.push(['pages', route]);
      return [{ iid: 2, project_id: 42, issue_link_id: 99, link_type: 'relates_to' }];
    },
    async request(route, options) {
      calls.push([options?.method ?? 'GET', route]);
      throw new Error('A matching two-way link should already exist.');
    }
  };

  const first = await ensureIssueLink(client, 41, 1, 42, 2, manifest);
  const second = await ensureIssueLink(client, 41, 1, 42, 2, manifest);

  assert.equal(first.id, 99);
  assert.deepEqual(second, first);
  assert.equal(calls.filter(([method]) => method === 'pages').length, 1);
  assert.equal(calls.filter(([method]) => method === 'POST').length, 0);
  assert.equal(manifest.resources.graphLinks.length, 1);
});

test('the live API client backs off across repeated 429 responses with a zero Retry-After header', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const responses = Array.from({ length: 6 }, () =>
    new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } }));
  responses.push(new Response(JSON.stringify({ id: 35 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  let calls = 0;
  const retryDelays = [];
  globalThis.fetch = async () => responses[calls++];
  globalThis.setTimeout = (callback, milliseconds) => {
    retryDelays.push(milliseconds);
    queueMicrotask(callback);
    return 0;
  };
  try {
    const client = new GitLab('ce19', 'test-only-token');
    const user = await client.request('user');
    assert.deepEqual(user, { id: 35 });
    assert.equal(calls, 7);
    assert.deepEqual(retryDelays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    assert.equal(client.metrics.requests, 7);
    assert.equal(client.metrics.failures, 6);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('load cleanup refuses an unrecorded project and preserves its manifest and workspace', async (t) => {
  const paths = fixturePaths(`regression-${Date.now()}`);
  t.after(() => {
    rmSync(path.dirname(paths.manifestPath), { recursive: true, force: true });
    rmSync(path.dirname(paths.workspacePath), { recursive: true, force: true });
  });
  mkdirSync(path.dirname(paths.manifestPath), { recursive: true });
  mkdirSync(paths.workspacePath, { recursive: true });
  writeFileSync(paths.manifestPath, `${JSON.stringify(cleanupManifest(paths.runId, paths.workspacePath), null, 2)}\n`);
  let deleted = false;
  const client = {
    key: 'ce16',
    async request(route, options) {
      if (options?.method === 'DELETE') deleted = true;
      return { id: 700, full_path: `grp-sn-maint/performance-${paths.runId}`, description: `GitLab Workspace isolated live-validation fixture; owner=load-${paths.runId}-ce16` };
    },
    async pages(route) {
      if (route.endsWith('/subgroups')) return [];
      return [
        { id: 800, description: `GitLab Workspace isolated live-validation fixture; owner=load-${paths.runId}-ce16` },
        { id: 801, description: `GitLab Workspace isolated live-validation fixture; owner=load-${paths.runId}-ce16` }
      ];
    }
  };

  await assert.rejects(cleanupLoad(client, paths.runId), /unrecorded or unowned projects/);
  assert.equal(deleted, false);
  assert.equal(existsSync(paths.workspacePath), true);
  assert.equal(JSON.parse(readFileSync(paths.manifestPath, 'utf8')).cleanedAt, undefined);
});

test('load cleanup accepts Windows path case changes and deletes only an exactly owned fixture', async (t) => {
  const paths = fixturePaths(`regression-${Date.now()}-owned`);
  t.after(() => {
    rmSync(path.dirname(paths.manifestPath), { recursive: true, force: true });
    rmSync(path.dirname(paths.workspacePath), { recursive: true, force: true });
  });
  mkdirSync(path.dirname(paths.manifestPath), { recursive: true });
  mkdirSync(paths.workspacePath, { recursive: true });
  const manifestWorkspace = process.platform === 'win32'
    ? paths.workspacePath.replace(/\.gitlab-workspace-validation/i, '\\.GITLAB-WORKSPACE-VALIDATION')
    : paths.workspacePath;
  writeFileSync(paths.manifestPath, `${JSON.stringify(cleanupManifest(paths.runId, manifestWorkspace), null, 2)}\n`);
  let deleted = false;
  const client = {
    key: 'ce16',
    async request(route, options) {
      if (options?.method === 'DELETE') { deleted = true; return {}; }
      return { id: 700, full_path: `grp-sn-maint/performance-${paths.runId}`, description: `GitLab Workspace isolated live-validation fixture; owner=load-${paths.runId}-ce16` };
    },
    async pages(route) {
      if (route.endsWith('/subgroups')) return [];
      return [{ id: 800, description: `GitLab Workspace isolated live-validation fixture; owner=load-${paths.runId}-ce16` }];
    }
  };

  const result = await cleanupLoad(client, paths.runId);
  assert.equal(result.deleted, true);
  assert.equal(deleted, true);
  assert.equal(existsSync(paths.workspacePath), false);
  assert.ok(JSON.parse(readFileSync(paths.manifestPath, 'utf8')).cleanedAt);
});
