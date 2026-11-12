import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readReviewerBranches } from '../../src/workspace/reviewerBranches';
import { CodexWorkspaceLease } from '../../src/codex/workspaceLease';
import { codexRootKey } from '../../src/codex/taskStore';
import { networkRuntimeRoot } from '../../src/api/localNetworkLease';

const clipboard: string[] = [];
let selectBranch: (branches: readonly string[]) => Promise<string | undefined> = async branches => branches[0];
const vscode = {
  window: { showQuickPick: (branches: readonly string[]) => selectBranch(branches) },
  workspace: { isTrusted: true, workspaceFolders: [] as Array<{ uri: { scheme: string; fsPath: string } }>,
    workspaceFile: undefined as { scheme: string; fsPath: string } | undefined,
    getConfiguration: () => ({ get: <T>(_key: string, fallback: T) => fallback }) },
  env: { clipboard: { writeText: async (text: string) => { clipboard.push(text); } } }
};
const moduleLoader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = (name, parent, main) => {
  if (name === 'vscode') return vscode;
  if (name === './installedReviewer') return { readInstalledReviewerBinding: async (root: string, tool: string) => ({
    schema: 'InstalledReviewerBinding/v1',tool,version:'0.22.0',script_path:path.join(root,'.agents/skills',tool,'scripts/review_session.py'),
    script_sha256:'a'.repeat(64),skill_sha256:'b'.repeat(64),payload_sha256:'c'.repeat(64),payload_files:30 }) };
  if (name === './pythonRuntime') return { ...originalLoad(name, parent, main) as typeof import('../../src/workspace/pythonRuntime'),
    resolvePythonRuntime: async () => ({executable:'python',args:[],env:{}}) };
  if (name === './reviewerCapabilities') return { readReviewerCapabilities: async (binding: {tool:string;version:string;payload_sha256:string}, _python: unknown, workspace: string) => ({
    schema:'ReviewCapabilities/v1',tool:binding.tool,skill_version:binding.version,prepare_evidence:true,
    updates_schema:binding.tool==='release-reviewer'?'ReleaseReviewUpdates/v1':'ReviewUpdates/v1',shared_cache_schema:'ReviewerSharedCache/v2',payload_sha256:binding.payload_sha256,
    features:{request_id:true,read_only_view:true,status_summary:true,read_window:true,updates_file:true,durable_review_progress:true,phase_metrics:true,literal_search_batch:true,patch_encoding:true,operation_diagnostics:true},
    runtime_root:path.join(path.dirname(workspace),'review-runtime'),git_commands:0,network_commands:0 }) };
  return originalLoad(name,parent,main);
};
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
    getLocalOperationScope: () => 'local-root',
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

test('native Skills branch picker verifies the current local Repo and drops responses after root changes', async t => {
  const root = await repository(t), fixture = branchHost(root);
  const request = { type: 'pickSkillBranch', repo: root, revision: 'current', requestId: 'native-branch', field: 'merge-repo.base' };
  let calls = 0;
  selectBranch = async branches => { calls++; assert.deepEqual(branches, ['main']); return 'main'; };
  t.after(() => { selectBranch = async branches => branches[0]; });
  await fixture.host.pickSkillBranch(request);
  assert.deepEqual(fixture.messages[0], { type: 'skillBranchSelected', repo: root, revision: 'current', requestId: request.requestId, field: request.field, branch: 'main' });
  await assert.rejects(fixture.host.pickSkillBranch({ ...request, repo: path.dirname(root) }), /VS Code/);
  await fixture.host.pickSkillBranch({ ...request, revision: 'obsolete' }); assert.equal(calls, 1);
  selectBranch = async () => { fixture.invalidate(); return 'main'; };
  await fixture.host.pickSkillBranch({ ...request, requestId: 'obsolete-on-close' }); assert.equal(fixture.messages.length, 1);
  const changed = branchHost(root);
  selectBranch = async () => { changed.host.getLocalOperationScope = () => 'different-root'; return 'main'; };
  await changed.host.pickSkillBranch(request); assert.equal(changed.messages.length, 0);
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
    workspaceFile: vscode.workspace.workspaceFile.fsPath, workspaceRoot: path.dirname(vscode.workspace.workspaceFile.fsPath),
    workspaceRootAmbiguous: false,
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
  assert.match(clipboard[0], /start --prepare-evidence/);
  assert.match(clipboard[0], /--request-id "[0-9a-f]{32}"/);
  assert.match(clipboard[0], /status --summary/);
  assert.match(clipboard[0], /read-window/);
  assert.match(clipboard[0], /--updates-file/);
  assert.doesNotMatch(clipboard[0], /--protocol round-v1/);
  const release = await host.prepareSkillGuideTask(request, '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(release.skill.name, 'release-reviewer'); assert.equal(release.review.requestId, '0123456789abcdef0123456789abcdef');
  assert.ok(release.prompt.includes('--request-id "0123456789abcdef0123456789abcdef"')); assert.equal(release.root, root);
  const merge = await host.prepareSkillGuideTask({ featureId: 'merge-repo', revision: 'current', inputs: {
    'merge-repo.repo': other, 'merge-repo.base': 'main', 'merge-repo.head': 'feature/new'
  } }, 'fedcba98-7654-3210-fedc-ba9876543210');
  assert.equal(merge.skill.name, 'merge-reviewer'); assert.equal(merge.review.requestId, 'fedcba9876543210fedcba9876543210');
  assert.ok(merge.prompt.includes('--request-id "fedcba9876543210fedcba9876543210"')); assert.ok(merge.writableRoots.includes(root));
  request.inputs['release-review.repo'] = path.dirname(root);
  await assert.rejects(host.copySkillGuidePrompt(request), /VS Code 工作區/);
  assert.equal(clipboard.length, 1);
  vscode.workspace.workspaceFile = undefined;
});

test('Reviewer runtime stays stable when inventory canonicalizes the workspace drive letter', async t => {
  if (process.platform !== 'win32') { t.skip(); return; }
  const root = await repository(t), opened = root[0].toLowerCase() + root.slice(1);
  vscode.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: opened } }];
  vscode.workspace.workspaceFile = undefined;
  const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), {
    projects: [], workspaceMatch: { status: 'matched', profile: 'repository', root, repositories: [] },
    workflowKit: { snapshot: { state: { status: 'missing' } } }, session: {}, projectContextSignature: () => 'same'
  });
  const before = host.getSkillsContext();
  host.reviewerWorkspaceFolders = { signature: JSON.stringify([opened]), folders: [root] };
  const after = host.getSkillsContext();
  assert.equal(after.reviewRuntimeRoot, before.reviewRuntimeRoot);
  assert.equal(after.releaseReviewRuntimeRoot, before.releaseReviewRuntimeRoot);
});

test('Codex review refresh keeps its queued request ID on revalidation and resume keeps fixed evidence', async t => {
  const root = await repository(t), temp = await mkdtemp(path.join(os.tmpdir(), 'reviewer-controls-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const runtimes = { 'merge-reviewer': path.join(temp, 'merge'), 'release-reviewer': path.join(temp, 'release') };
  const original = 'a'.repeat(32);
  for (const tool of ['merge-reviewer', 'release-reviewer'] as const) {
    const runtime = runtimes[tool], prefix = tool === 'merge-reviewer' ? 'Merge' : 'Release';
    await mkdir(path.join(runtime, 'jobs'), { recursive: true });
    await writeFile(path.join(runtime, `.${tool}-runtime.json`), JSON.stringify({ schema: `${prefix}ReviewRuntime/v1`, directory: await realpath(runtime) }));
    await writeFile(path.join(runtime, 'jobs', original + '.json'), JSON.stringify({ schema: `${prefix}ReviewSession/v1`, request_id: original,
      runtime_root: runtime, state: 'reviewing', phase: 'review', updated_at: '2026-11-03T00:00:00Z',
      inputs: { workspace: root, project: root, base: 'main', head: 'topic' } }));
    const skill = path.join(root, '.agents/skills', tool, 'SKILL.md');
    await mkdir(path.dirname(skill), { recursive: true }); await writeFile(skill, 'fixture Skill');
    const context = { revision: 'current', mode: 'repository', root, workspaceRoot: root,
      repositories: [{ name: 'service', path: root }], reviewerRepositories: [{ name: 'service', path: root }],
      reviewRuntimeRoot: runtimes['merge-reviewer'], releaseReviewRuntimeRoot: runtimes['release-reviewer'],
      installed: { status: 'installed', version: 'test' } };
    const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), {
      getSkillsContext: () => context, resolveProjectContext: () => ({ root }),
      refreshWorkflowKit: async () => undefined, post: () => undefined
    });
    const source = { kind: 'review', action: 'refresh', tool, requestId: original, revision: 'current' };
    const initial = await host.prepareCodexTask(source), checked = await host.prepareCodexTask(source, initial);
    assert.notEqual(initial.review.requestId, original);
    assert.equal(checked.review.requestId, initial.review.requestId);
    assert.equal(checked.prompt, initial.prompt);
    assert.ok(checked.prompt.includes(`--request-id "${checked.review.requestId}"`));
    const resume = await host.prepareCodexTask({ ...source, action: 'resume' });
    assert.equal(resume.review.requestId, original);
    assert.ok(resume.prompt.includes(`--request-id ${original}`));
    assert.ok(resume.prompt.includes(JSON.stringify(runtime)));
  }
});

test('Codex workspace admission excludes managed writes while local reads remain available', async t => {
  const root = await repository(t);
  const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), { projectContext: { root } });
  const lease = await CodexWorkspaceLease.acquire(path.join(networkRuntimeRoot(), 'codex-workspaces', codexRootKey(root) + '.lock'));
  let writes = 0;
  try {
    for (const request of [{ type: 'installWorkflowKit' }, { type: 'syncRepos' }, { type: 'selectProjectRoot' },
      { type: 'gitAction', action: { type: 'commit', message: 'fixture' } }]) {
      await assert.rejects(host.withCodexWriteGuard(request, async () => { writes++; }), (error: Error) => error.name === 'TimeoutError');
    }
    assert.equal(writes, 0);
    assert.equal(await host.withCodexWriteGuard({ type: 'copySkillGuidePrompt' }, async () => 'local read'), 'local read');
  } finally { await lease.release(); }
  await host.withCodexWriteGuard({ type: 'installWorkflowKit' }, async () => { writes++; });
  assert.equal(writes, 1);
});
