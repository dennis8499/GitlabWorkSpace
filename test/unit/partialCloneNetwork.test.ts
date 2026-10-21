import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { GitLabClient } from '../../src/api/gitLabClient';
import { OperationLog } from '../../src/logging/operationLog';

const vscode = { ProgressLocation: { Notification: 1 }, window: {
  showInformationMessage: async () => '開始',
  withProgress: async (_options: unknown, action: Function) => action({ report: () => {} }, { onCancellationRequested: () => ({ dispose: () => {} }) })
} };
const loader = require('node:module'), original = loader._load;
loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? vscode : original(name, ...args);
let WorkspacePanel: any;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); } finally { loader._load = original; }

test('a selected download from the first 100 of 1000 projects performs one clone and never requests the other nine pages', async () => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'glw-partial-clone-')));
  const root = path.join(temp, 'workspace'), remote = path.join(temp, 'remote.git'); await mkdir(root);
  execFileSync('git', ['init', '--quiet', '--bare', remote]);
  const project = (id: number) => ({ id, name: `Project ${id}`, path: `project-${id}`, path_with_namespace: `team/project-${id}`,
    web_url: `https://gitlab.test/team/project-${id}`, http_url_to_repo: `https://gitlab.test/team/project-${id}.git`, default_branch: 'main' });
  const projects = Array.from({ length: 100 }, (_, id) => project(id + 1));
  const calls: URL[] = [], lines: string[] = [];
  const log = new OperationLog({ info: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line) });
  const client = new GitLabClient('https://gitlab.test', 'test-token', async input => {
    const url = new URL(String(input)); calls.push(url);
    assert.equal(url.pathname, '/api/v4/groups/42/projects'); assert.equal(url.searchParams.get('page') ?? '1', '1');
    return new Response(JSON.stringify(projects), { headers: { 'content-type': 'application/json', 'x-next-page': '2', 'x-total-pages': '10' } });
  });
  const count = process.env.GIT_CONFIG_COUNT, index = Number(count ?? 0);
  const key = `GIT_CONFIG_KEY_${index}`, value = `GIT_CONFIG_VALUE_${index}`;
  const savedKey = process.env[key], savedValue = process.env[value];
  process.env.GIT_CONFIG_COUNT = String(index + 1); process.env[key] = `url.${pathToFileURL(remote).href}.insteadOf`; process.env[value] = projects[0].http_url_to_repo;
  const host: any = Object.create(WorkspacePanel.prototype);
  Object.assign(host, { disposed: false, busy: false, projects: (await client.listGroupProjectsPage(42)).items,
    workspaceSections: { projects: { status: 'ready', complete: false } }, workspaceFoldersGeneration: 1, currentUser: { id: 9 },
    session: { baseUrl: 'https://gitlab.test', connectionEpoch: 1, selectedGroup: { id: 42, full_path: 'team' },
      getClient: async () => client, getCloneCredentials: async () => ({ baseUrl: 'https://gitlab.test', token: 'test-token' }),
      cachedRead: () => { throw new Error('partial download must not load a complete Group'); } },
    captureWorkflowKitAccess: () => () => {}, resolveProjectRoot: async () => ({ root, revision: 'root' }),
    sendSnapshot: () => {}, post: () => {}, operationPhase: () => {}, noteOutcome: () => {}, repositoryOutcome: () => ({ status: 'succeeded', effect: 'applied' }),
    cloneProgressPublisher: () => ({ publish: () => {}, dispose: () => {} }), reconcileAfterWrite: async (action: Function) => action(),
    refreshProjectRoot: async () => {}, refreshInventory: async () => {}, schedulePendingWorkspaceRefresh: () => {} });
  try {
    await log.run('workspace', 'clone', {}, () => host.clone([1], false));
    assert.equal(calls.length, 1, 'only the initial page was downloaded, with no per-project supplement for complete metadata');
    const config = await readFile(path.join(root, 'project-1--1', '.git', 'config'), 'utf8');
    assert.ok(config.includes(projects[0].http_url_to_repo));
    const networkStarts = lines.filter(line => line.startsWith('[git]') && line.includes(' started') && line.includes('"network":true'));
    assert.equal(networkStarts.length, 1); assert.ok(networkStarts[0].startsWith('[git] clone started'));
    assert.equal(lines.some(line => line.startsWith('[git] fetch started')), false);
    assert.equal(lines.some(line => line.includes('test-token')), false);
    await assert.rejects(host.clone([1000], false), /清單/);
    assert.equal(calls.length, 1);
  } finally {
    if (count === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = count;
    if (savedKey === undefined) delete process.env[key]; else process.env[key] = savedKey;
    if (savedValue === undefined) delete process.env[value]; else process.env[value] = savedValue;
    log.dispose(); await rm(temp, { recursive: true, force: true });
  }
});
