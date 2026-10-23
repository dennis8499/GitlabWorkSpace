import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Memento, SecretStorage } from 'vscode';
import { GitLabClient } from '../../src/api/gitLabClient';
import { GitLabNetworkGate } from '../../src/api/gitLabNetworkGate';
import { GitLabSession } from '../../src/connection/session';

const moduleLoader = require('node:module'), originalLoad = moduleLoader._load;
let WorkspacePanel: any;
moduleLoader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? {} : originalLoad(name, ...args);
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { moduleLoader._load = originalLoad; }

class State implements Memento {
  private readonly values = new Map<string, unknown>([
    ['gitlabWorkspace.baseUrl', 'https://cooldown.example.test'],
    ['gitlabWorkspace.selectedGroupId', 42], ['gitlabWorkspace.selectedGroupLabel', 'team']
  ]);
  get<T>(key: string, fallback?: T): T | undefined { return this.values.has(key) ? this.values.get(key) as T : fallback; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  keys(): readonly string[] { return [...this.values.keys()]; }
}

async function fixture(t: { after(fn: () => Promise<void>): void }, status: number, readSummary = false, onFetch?: () => Promise<void>) {
  const parent = await realpath(os.tmpdir()), runtime = await mkdtemp(path.join(parent, 'glw-cooldown-presentation-'));
  t.after(async () => {
    assert.equal(path.dirname(runtime), parent); assert.ok(path.basename(runtime).startsWith('glw-cooldown-presentation-'));
    await rm(runtime, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });
  await writeFile(path.join(runtime, 'network-policy.json'), JSON.stringify({ schema: 'GitLabWorkspaceNetworkPolicy/v1', api: { startsPerSecond: 1000, concurrency: 2 } }));
  const calls: string[] = [];
  const client = new GitLabClient('https://cooldown.example.test', 'test-token', async input => {
    calls.push(new URL(String(input)).pathname);
    await onFetch?.();
    return new Response('{}', { status, headers: { 'Retry-After': '60' } });
  }, undefined, undefined, undefined, undefined, undefined, new GitLabNetworkGate(runtime, 30_000));
  const session = new GitLabSession({} as SecretStorage, new State(), true);
  session.getClient = async () => client;
  const host = Object.create(WorkspacePanel.prototype), snapshots: any[] = [];
  Object.assign(host, {
    session, disposed: false, panel: { visible: true }, activeMode: 'reviewer', currentUser: { id: 7 },
    requestGeneration: 0, mergeRequestGeneration: 0, mergeRequestFilter: 'all',
    mergeRequestSummaryGeneration: 0,
    mergeRequests: [], projects: [], issues: [], groupIssueBoards: [], groupMilestones: [],
    workspaceSections: {}, workspaceSectionPages: new Map(), workspaceSectionGenerations: new Map(),
    workspaceSectionAborts: new Map(), workspaceSectionReads: new Map(),
    mergeRequestSectionAborts: {}, mergeRequestSectionGenerations: { diffs: 0, discussions: 0 },
    selectedMergeRequest: { request: { id: 1, project_id: 4, iid: 1, source_branch: 'feature', target_branch: 'main',
      diff_refs: { base_sha: 'a'.repeat(40), start_sha: 'b'.repeat(40), head_sha: 'c'.repeat(40) } },
      diffs: [], discussions: [], sections: { diffs: { status: 'idle' }, discussions: { status: 'idle' } } },
    operationContextStorage: { getStore: () => 'test-operation' },
    // Version-failure cases model a loaded summary; summary-failure cases use its real Host reader.
    ...(!readSummary ? { loadMergeRequest: async () => undefined } : {}),
    resolveGroupProject: async () => ({ id: 4 }), setBusyOwner: () => undefined,
    noteOutcome: () => undefined, sendSnapshot: () => snapshots.push(structuredClone({
      list: host.workspaceSections.mergeRequests, diff: host.selectedMergeRequest.sections.diffs }))
  });
  return { host, calls, snapshots };
}

for (const status of [429, 503]) {
  test(`cold summary HTTP ${status} failure retains its cooldown in the requested Diff section`, async t => {
    const { host, calls, snapshots } = await fixture(t, status, true);
    await host.loadMergeRequestSection('diffs', 4, 1);
    const state = () => host.selectedMergeRequest.sections.diffs;
    assert.deepEqual(calls, ['/api/v4/projects/4/merge_requests/1'], 'the failing route is the summary, before version discovery');
    assert.equal(state().status, 'error');
    assert.equal(state().transportStage, 'cooldown');
    assert.ok(state().retryAt > Date.now() + 50_000);
    assert.equal(host.selectedMergeRequest.sections.discussions.status, 'idle');
    assert.ok(snapshots.some(snapshot => snapshot.diff.status === 'error' && snapshot.diff.transportStage === 'cooldown'));
    const retryAt = state().retryAt;
    await host.loadMergeRequestSection('diffs', 4, 1);
    assert.equal(calls.length, 1, 'summary retry must honor the real shared cooldown without HTTP');
    assert.equal(state().status, 'error'); assert.equal(state().retryAt, retryAt);
  });
}

for (const change of ['MR', 'account'] as const) {
  test(`a late failed summary cannot replace Diff state after the ${change} changes`, async t => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const { host, calls } = await fixture(t, 429, true, async () => { entered(); await delayed; });
    const read = host.loadMergeRequestSection('diffs', 4, 1);
    await started;
    if (change === 'MR') {
      host.selectedMergeRequest = { ...host.selectedMergeRequest, request: { ...host.selectedMergeRequest.request, iid: 2 },
        sections: { diffs: { status: 'idle' }, discussions: { status: 'idle' } } };
      host.mergeRequestGeneration++;
    } else {
      host.session.connectionEpochValue++;
      host.requestGeneration++;
    }
    release(); await read;
    assert.equal(calls.length, 1);
    assert.deepEqual(host.selectedMergeRequest.sections.diffs, { status: 'idle' });
  });
}

for (const status of [429, 503]) for (const target of ['list', 'diff'] as const) {
  test(`${target} preserves the real Gate HTTP ${status} cooldown after failure and retry sends no HTTP`, async t => {
    const { host, calls, snapshots } = await fixture(t, status);
    const read = () => target === 'list' ? host.loadWorkspaceSection('mergeRequests') : host.loadMergeRequestSection('diffs', 4, 1);
    const state = () => target === 'list' ? host.workspaceSections.mergeRequests : host.selectedMergeRequest.sections.diffs;
    await read();
    assert.equal(calls.length, 1, 'Retry-After exceeds the real 30-second Gate deadline, so it must not auto-retry');
    assert.equal(state().status, 'error');
    assert.equal(state().transportStage, 'cooldown');
    assert.ok(state().retryAt > Date.now() + 50_000);
    assert.ok(snapshots.some(snapshot => snapshot[target]?.status === 'error' && snapshot[target].transportStage === 'cooldown'),
      'the terminal snapshot keeps the visible countdown');
    const retryAt = state().retryAt;
    await read();
    assert.equal(calls.length, 1, 'a second attempt observes the shared Gate cooldown before sending');
    assert.equal(state().status, 'error');
    assert.equal(state().transportStage, 'cooldown');
    assert.equal(state().retryAt, retryAt);
  });
}
