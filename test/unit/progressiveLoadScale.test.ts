import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitLabClient } from '../../src/api/gitLabClient';
import { GitLabNetworkGate } from '../../src/api/gitLabNetworkGate';
import { GitLabRequestBudget } from '../../src/api/gitLabRequestBudget';

test('500 Repo inventory and 50 accounts share host admission while first pages stay bounded', { timeout: 30_000 }, async t => {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'glw-load-scale-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('glw-load-scale-')); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); });
  await writeFile(path.join(root, 'network-policy.json'), JSON.stringify({ schema: 'GitLabWorkspaceNetworkPolicy/v1', api: { startsPerSecond: 1000, concurrency: 2 } }));
  let active = 0, peak = 0, requests = 0;
  const accounts = new Set<string>();
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    requests++; accounts.add(new Headers(init?.headers).get('PRIVATE-TOKEN')!); peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    const page = Number(new URL(String(input)).searchParams.get('page') ?? 1);
    const items = Array.from({ length: 100 }, (_, i) => ({ id: (page - 1) * 100 + i + 1, path: `repo-${(page - 1) * 100 + i + 1}` }));
    return new Response(JSON.stringify(items), { headers: page < 5 ? { 'x-next-page': String(page + 1) } : {} });
  };
  const clients = Array.from({ length: 50 }, (_, i) => new GitLabClient('https://scale.example.test', `synthetic-user-${i}`, fetcher, undefined, undefined, undefined, undefined, undefined, new GitLabNetworkGate(root)));
  const first = await Promise.all(clients.map(client => client.listGroupProjectsPage(1)));
  assert.equal(requests, 50); assert.equal(accounts.size, 50); assert.ok(peak <= 2);
  assert.ok(first.every(page => page.items.length === 100 && !page.complete));
  let cursor = first[0].nextCursor, total = 100;
  while (cursor) { const page = await clients[0].listGroupProjectsPage(1, cursor); total += page.items.length; cursor = page.nextCursor; }
  assert.equal(total, 500); assert.equal(requests, 54);
  const stateDirs = await import('node:fs/promises').then(fs => fs.readdir(path.join(root, 'api')));
  const state = await readFile(path.join(root, 'api', stateDirs[0], 'state.json'), 'utf8');
  assert.ok(!state.includes('synthetic-user-')); assert.deepEqual(JSON.parse(state).active, []);
});

test('10,000 Issues load by batches of at most 20 actual sends and continue each page exactly once', { timeout: 30_000 }, async () => {
  const pages: number[] = [];
  const client = new GitLabClient('https://scale-issues.example.test', 'synthetic', async input => {
    const page = Number(new URL(String(input)).searchParams.get('page') ?? 1); pages.push(page);
    return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: (page - 1) * 100 + i + 1 }))), { headers: page < 100 ? { 'x-next-page': String(page + 1) } : {} });
  });
  let cursor: string | undefined, total = 0;
  for (let batch = 0; batch < 5; batch++) {
    const budget = new GitLabRequestBudget();
    try {
      const scoped = client.withRequestBudget(budget);
      for (let page = 0; page < 20; page++) {
        const result = await scoped.listAssignedGroupIssuesPage(1, cursor); total += result.items.length; cursor = result.nextCursor;
        if (batch === 0 && page === 0) assert.equal(pages.length, 1, 'initial HTTP work does not depend on all 10,000 Issues');
      }
      assert.equal(budget.usedRequests, 20);
      if (cursor) await assert.rejects(scoped.listAssignedGroupIssuesPage(1, cursor), { name: 'GitLabBudgetExceededError' });
    } finally { budget.dispose(); }
  }
  assert.equal(total, 10_000); assert.equal(cursor, undefined);
  assert.deepEqual(pages, Array.from({ length: 100 }, (_, i) => i + 1));
});
