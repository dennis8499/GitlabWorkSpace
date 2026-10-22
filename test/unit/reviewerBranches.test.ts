import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readReviewerBranches } from '../../src/workspace/reviewerBranches';

const clipboard: string[] = [];
const vscode = {
  workspace: { workspaceFolders: [] as Array<{ uri: { scheme: string; fsPath: string } }>,
    workspaceFile: undefined as { scheme: string; fsPath: string } | undefined },
  env: { clipboard: { writeText: async (text: string) => { clipboard.push(text); } } }
};
const moduleLoader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = (name, parent, main) => name === 'vscode' ? vscode : originalLoad(name, parent, main);
let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { moduleLoader._load = originalLoad; }

async function repository(t: test.TestContext, commit = true): Promise<string> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'reviewer-branches-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', temporary]);
  if (commit) execFileSync('git', ['-C', temporary, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'baseline']);
  return realpath(temporary);
}

function branchHost(root: string) {
  const messages: Array<{ type: string; requestId: string; branches: string[]; error?: string }> = [];
  let revision = 'current';
  const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), {
    disposed: false, skillBranchReads: new Map(),
    getSkillsContext: () => ({ revision, reviewerRepositories: [{ name: 'service', path: root }], availableFeatures: [] }),
    post: (message: typeof messages[number]) => messages.push(message)
  });
  return { host, messages, invalidate: () => { revision = 'changed'; } };
}

test('branch discovery returns all local and remote refs beyond 1000, excludes tags and any symbolic ref', async t => {
  const root = await repository(t);
  const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const refs = Array.from({ length: 1005 }, (_, index) => `create refs/heads/feature/${index} ${sha}`);
  refs.push(`create refs/remotes/origin/main ${sha}`, `create refs/remotes/upstream/feature/a ${sha}`, `create refs/tags/release ${sha}`);
  execFileSync('git', ['-C', root, 'update-ref', '--stdin'], { input: refs.join('\n') + '\n' });
  execFileSync('git', ['-C', root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  execFileSync('git', ['-C', root, 'symbolic-ref', 'refs/remotes/origin/default', 'refs/remotes/origin/main']);
  const branches = await readReviewerBranches(root);
  assert.equal(branches.length, 1008);
  assert.ok(branches.includes('main')); assert.ok(branches.includes('feature/1004'));
  assert.ok(branches.includes('origin/main')); assert.ok(branches.includes('upstream/feature/a'));
  assert.ok(!branches.includes('origin/HEAD')); assert.ok(!branches.includes('origin/default')); assert.ok(!branches.includes('release'));
});

test('branch discovery reads new local refs on each request and supports an unborn repository', async t => {
  const root = await repository(t);
  assert.deepEqual(await readReviewerBranches(root), ['main']);
  execFileSync('git', ['-C', root, 'branch', 'new-branch']);
  assert.deepEqual(await readReviewerBranches(root), ['main', 'new-branch']);
  assert.deepEqual(await readReviewerBranches(await repository(t, false)), []);
});

test('host shares only in-flight branch reads, echoes request IDs, and rereads after completion offline without Skills', async t => {
  const root = await repository(t), fixture = branchHost(root);
  const reads = [fixture.host.loadSkillBranches(root, 'current', 'first'), fixture.host.loadSkillBranches(root, 'current', 'second')];
  assert.equal(fixture.host.skillBranchReads.size, 1);
  await Promise.all(reads);
  assert.equal(fixture.host.skillBranchReads.size, 0);
  assert.deepEqual(fixture.messages.map(message => message.requestId), ['first', 'second']);
  execFileSync('git', ['-C', root, 'branch', 'new-branch']);
  await fixture.host.loadSkillBranches(root, 'current', 'third');
  assert.deepEqual(fixture.messages.at(-1)?.branches, ['main', 'new-branch']);
});

test('host reports Git errors, allows retry, rejects foreign Repos, and drops stale responses', async t => {
  const root = await repository(t), fixture = branchHost(root);
  fixture.host.gitRepositories = { gitExecutable: path.join(root, 'missing-git-executable') };
  await fixture.host.loadSkillBranches(root, 'current', 'failed');
  assert.ok(fixture.messages[0].error); assert.deepEqual(fixture.messages[0].branches, []);
  assert.equal(fixture.host.skillBranchReads.size, 0);
  fixture.host.gitRepositories = undefined;
  await fixture.host.loadSkillBranches(root, 'current', 'retry');
  assert.deepEqual(fixture.messages.at(-1)?.branches, ['main']);
  await fixture.host.loadSkillBranches(path.dirname(root), 'current', 'foreign');
  assert.match(fixture.messages.at(-1)?.error ?? '', /VS Code/);
  const count = fixture.messages.length;
  const pending = fixture.host.loadSkillBranches(root, 'current', 'obsolete'); fixture.invalidate();
  await pending;
  assert.equal(fixture.messages.length, count); assert.equal(fixture.host.skillBranchReads.size, 0);
});

test('host reviewer inventory excludes stale scans, changes context revision, and retains Wiki scope', async t => {
  const root = await repository(t), other = await repository(t), stale = await repository(t);
  vscode.workspace.workspaceFolders = [root, other].map(fsPath => ({ uri: { scheme: 'file', fsPath } }));
  const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), {
    disposed: false, inventoryGeneration: 0, reviewerNativeRepositories: [], projects: [],
    workspaceMatch: { status: 'matched', profile: 'repository', root, repositories: [{ name: 'service', path: root, matched: false }] },
    skillsWorkflowKitStateRoot: root, skillsWorkflowKitState: { status: 'missing' },
    projectContextSignature: () => 'project', context: { extension: { packageJSON: { version: 'test' } } },
    session: {}, repositoryScan: { repositories: [{ name: 'stale', path: stale, repositoryId: 'old', remotes: [] }] },
    gitRepositories: { getInventory: async () => [{ name: 'second', path: other, remotes: [], repositoryId: 'live' }] },
    sendSnapshot: () => undefined
  });
  const before = host.getSkillsContext();
  await host.refreshInventory();
  const current = host.getSkillsContext();
  assert.notEqual(current.revision, before.revision);
  assert.deepEqual(current.repositories.map((repo: { path: string }) => repo.path), [root]);
  assert.deepEqual(current.reviewerRepositories.map((repo: { path: string }) => repo.path).sort(), [root, other].sort());
  assert.ok(host.localWorkspaceRepositories.some((repo: { path: string }) => repo.path === stale));
  vscode.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: root } }];
  const removed = host.getSkillsContext();
  assert.notEqual(removed.revision, current.revision);
  assert.deepEqual(removed.reviewerRepositories.map((repo: { path: string }) => repo.path), [root]);
});

test('host canonicalizes workspace folder aliases asynchronously without native Git registration', async t => {
  const root = await repository(t), alias = root + '-alias';
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rm(alias, { recursive: true, force: true }));
  vscode.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: alias } }];
  const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), {
    disposed: false, projects: [], workspaceMatch: { status: 'matched', profile: 'repository', root,
      repositories: [{ name: 'service', path: root, matched: false }] },
    skillsWorkflowKitStateRoot: root, skillsWorkflowKitState: { status: 'missing' },
    projectContextSignature: () => 'project', context: { extension: { packageJSON: { version: 'test' } } },
    session: {}, sendSnapshot: () => undefined
  });
  await host.refreshInventory();
  assert.deepEqual(host.reviewerWorkspaceFolders.folders, [root]);
  assert.deepEqual(host.getSkillsContext().reviewerRepositories, [{ name: 'service', path: root }]);
});

test('copying Reviewer prompts validates the selected workspace Repo and includes all workspace candidates', async t => {
  const root = await repository(t), other = await repository(t);
  vscode.workspace.workspaceFolders = [root, other].map(fsPath => ({ uri: { scheme: 'file', fsPath } }));
  vscode.workspace.workspaceFile = { scheme: 'file', fsPath: path.join(path.dirname(root), 'review.code-workspace') };
  clipboard.length = 0;
  const context = { revision: 'current', mode: 'repository', root, repositories: [{ name: 'service', path: root }],
    reviewerRepositories: [{ name: 'service', path: root }, { name: 'second', path: other, defaultBranch: 'main' }],
    availableFeatures: ['release-review', 'merge-repo'], installed: { version: 'test' } };
  const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), {
    operationPhase: () => undefined, getSkillsContext: () => context, refreshWorkflowKit: async () => undefined,
    refreshInventory: async () => undefined, post: () => undefined
  });
  const request = { featureId: 'release-review', revision: 'current', inputs: {
    'release-review.repo': 'second', 'release-review.base': 'main', 'release-review.head': 'feature/new'
  } };
  await host.copySkillGuidePrompt(request);
  assert.equal(clipboard.length, 1);
  assert.ok(clipboard[0].includes(`專案名稱：${JSON.stringify(other)}`));
  assert.ok(clipboard[0].includes(`Skills 專案根目錄：${root}`));
  for (const repo of context.reviewerRepositories) assert.ok(clipboard[0].includes(`- ${repo.name} → ${repo.path}`));
  assert.ok(clipboard[0].includes(`--workspace-file ${JSON.stringify(vscode.workspace.workspaceFile.fsPath)}`));
  assert.match(clipboard[0], /start → 必要 step → check → finish/);
  request.inputs['release-review.repo'] = path.dirname(root);
  await assert.rejects(host.copySkillGuidePrompt(request), /VS Code 工作區/);
  assert.equal(clipboard.length, 1);
  vscode.workspace.workspaceFile = undefined;
});
