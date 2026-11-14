import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { collectIssueResult, issueBranchName, startIssueWorkflow, startWikiWorkflow, withWorkflowExecution,
  workflowGit, workflowRemote } from '../../src/codex/projectWorkflows';
import type { CodexTaskSpec, CodexOutputItem } from '../../src/codex/protocol';
import { resolvePythonRuntime } from '../../src/workspace/pythonRuntime';

const quoteNativeArgument = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-project-workflow-'));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), remote = path.join(root, 'remote.git'); await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'user.name=Workflow Test', '-c', 'user.email=workflow@test.local', ...args],
    { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); await writeFile(path.join(repo, 'main.ts'), 'export const answer = 1;\n');
  git('add', '.'); git('commit', '-m', 'Initial fixture'); const sha = git('rev-parse', 'HEAD');
  git('clone', '--bare', repo, remote); git('remote', 'add', 'origin', remote);
  const id = randomUUID();
  const spec: CodexTaskSpec = { source: { kind: 'issue', projectId: 4, issueIid: 8 }, title: 'Issue #8', root,
    workspaceKey: 'fixture', environmentKey: 'fixture', prompt: 'Implement and test', skill: { name: 'bmad-help', path: path.join(root, 'SKILL.md') },
    executionRoot: repo, writableRoots: [repo],
    origin: { kind: 'issue', accountKey: 'test', baseUrl: 'https://gitlab.test', projectId: 4, projectPath: 'team/project',
      webUrl: 'https://gitlab.test/team/project/-/issues/8', repositoryRoot: repo, iid: 8, sourceBranch: 'main', sourceSha: sha, branch: 'issue/8-answer' },
    workflow: { id, runtimeRoot: path.join(root, 'runtime', id), remote: 'origin' } };
  return { root, repo, remote, spec, git };
}

test('Issue creates a dedicated branch at the fixed default SHA and resumes without discarding working changes', async t => {
  const f = await fixture(t); await startIssueWorkflow(f.spec);
  assert.equal(f.git('branch', '--show-current'), 'issue/8-answer'); assert.equal(f.git('rev-parse', 'HEAD'), f.spec.origin!.sourceSha);
  await writeFile(path.join(f.repo, 'main.ts'), 'export const answer = 2;\n');
  await startIssueWorkflow(f.spec);
  assert.match(await readFile(path.join(f.repo, 'main.ts'), 'utf8'), /2/);
  f.git('checkout', 'main'); await assert.rejects(startIssueWorkflow(f.spec), /切回/);
});

test('Issue rejects dirty trees and retains its pinned local source when the default branch advances', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, 'untracked.txt'), 'keep me');
  await assert.rejects(startIssueWorkflow(f.spec), /未提交/); assert.equal(f.git('branch', '--show-current'), 'main');
  await rm(path.join(f.repo, 'untracked.txt'));
  await writeFile(path.join(f.repo, 'main.ts'), 'export const answer = 2;\n'); f.git('add', '.'); f.git('commit', '-m', 'New default'); f.git('push', 'origin', 'main');
  const advanced = f.git('rev-parse', 'HEAD');
  await startIssueWorkflow(f.spec);
  assert.equal(f.git('branch', '--show-current'), f.spec.origin!.branch);
  assert.equal(f.git('rev-parse', 'HEAD'), f.spec.origin!.sourceSha);
  assert.equal(f.git('rev-parse', 'main'), advanced, 'local-first setup must not reset the existing default branch');
});

test('Issue branch names avoid collisions and non-ASCII titles have a valid deterministic fallback', async t => {
  const f = await fixture(t);
  assert.equal(await issueBranchName(f.repo, 8, 'Fix Answer'), 'issue/8-fix-answer');
  f.git('branch', 'issue/8-fix-answer'); assert.equal(await issueBranchName(f.repo, 8, 'Fix Answer'), 'issue/8-fix-answer-2');
  assert.equal(await issueBranchName(f.repo, 8, '修正計算'), 'issue/8-development');
});

test('Issue completion requires implementation and actual successful test commands, including corrected reruns', async t => {
  const f = await fixture(t); await startIssueWorkflow(f.spec);
  await mkdir(path.join(f.repo, '_bmad-output')); await writeFile(path.join(f.repo, '_bmad-output/spec.md'), '# Specification');
  const output: CodexOutputItem[] = [{ id: 'claim', kind: 'agent', text: 'All tests passed.' }];
  assert.equal((await collectIssueResult(f.spec, output)).state, 'needs-work');
  await writeFile(path.join(f.repo, 'main.ts'), 'export const answer = 2;\n');
  assert.equal((await collectIssueResult(f.spec, output)).state, 'needs-work');
  output.push({ id: 'echo', kind: 'command', command: 'echo npm test', text: '', exitCode: 0 });
  assert.equal((await collectIssueResult(f.spec, output)).state, 'needs-work');
  output.push({ id: 'test-failed', kind: 'command', command: 'node --test test/main.test.js', text: '', exitCode: 1 });
  assert.equal((await collectIssueResult(f.spec, output)).state, 'needs-work');
  output.push({ id: 'test-fixed', kind: 'command', command: 'node --test test/main.test.js', text: '', exitCode: 0 });
  const result = await collectIssueResult(f.spec, output); assert.equal(result.state, 'ready'); assert.equal(result.tests!.length, 1);
  output.push({ id: 'npm-windows', kind: 'command', command: 'npm.cmd test', text: '', exitCode: 0 },
    { id: 'python-windows', kind: 'command', command: '& "C:\\Program Files\\Python\\python.exe" -m unittest -v', text: '', exitCode: 0 });
  assert.equal((await collectIssueResult(f.spec, output)).tests!.length, 3);
  assert.equal(f.git('rev-parse', 'HEAD'), f.spec.origin!.sourceSha, 'workflow did not commit');
});

test('Issue completion retains direct and native-wrapped Python failures and accepts actual corrected reruns', async t => {
  const f = await fixture(t); await startIssueWorkflow(f.spec);
  await writeFile(path.join(f.repo, 'test_calculator.py'), 'from calculator import add\nassert add(2, 3) == 5\n');
  const python = await resolvePythonRuntime('python'), pythonArgs = [...python.args, '-E', '-B', 'test_calculator.py'];
  const shell = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : '/bin/sh';
  const body = (process.platform === 'win32' ? '& ' : '') + [python.executable, ...pythonArgs].map(quoteNativeArgument).join(' ');
  const shellArgs = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', body] : ['-c', body];
  for (const wrapped of [false, true]) {
    const command = wrapped ? [shell, ...shellArgs].map(quoteNativeArgument).join(' ') : 'python -E -B test_calculator.py';
    const output: CodexOutputItem[] = [];
    const run = () => {
      let exitCode = 0;
      try { execFileSync(wrapped ? shell : python.executable, wrapped ? shellArgs : pythonArgs, { cwd: f.repo, env: python.env, windowsHide: true, stdio: 'pipe' }); }
      catch (error) { exitCode = (error as { status: number }).status; }
      assert.ok(exitCode === 0 || exitCode === 1);
      output.push({ id: 'python-' + output.length, kind: 'command', command, text: '', exitCode });
      return exitCode;
    };
    await writeFile(path.join(f.repo, 'calculator.py'), 'def add(a, b):\n    return a - b\n');
    assert.equal(run(), 1);
    const failed = await collectIssueResult(f.spec, output); assert.equal(failed.state, 'needs-work');
    assert.deepEqual(failed.tests, [{ command, exitCode: 1 }]);
    await writeFile(path.join(f.repo, 'calculator.py'), 'def add(a, b):\n    return a + b\n');
    assert.equal(run(), 0);
    const passed = await collectIssueResult(f.spec, output); assert.equal(passed.state, 'ready');
    assert.deepEqual(passed.tests, [{ command, exitCode: 0 }]); assert.match(passed.evidence!.digest, /^[a-f0-9]{64}$/);
  }
});

test('Issue Python evidence recognizes conventional paths and safe flags but rejects scripts and fabricated output', async t => {
  const f = await fixture(t); await startIssueWorkflow(f.spec);
  await writeFile(path.join(f.repo, 'main.ts'), 'export const answer = 2;\n');
  const native = (body: string) => `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command ${quoteNativeArgument(body)}`;
  const accepted = [
    'python -E -B test_calculator.py', 'python3 -I -u tests/calculator_test.py',
    '& "C:\\Program Files\\Python\\python.exe" -X utf8 -B ".\\tests with spaces\\test_calculator.py"',
    '"/opt/python tools/python3" -EB \'./tests with spaces/calculator_test.py\'',
    'python3.12 -Xutf8 -- test_calculator.py', 'python -B -m unittest -v', 'python3 -m pytest -q',
    'cd "C:\\repo with spaces"\npython -E -B test_calculator.py',
    'Set-Location -LiteralPath \'C:\\repo with spaces\'; & "C:\\Python\\python.exe" -E -B test_calculator.py',
    'cd /repo && python -E -B test_calculator.py',
    '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "python -E -B test_calculator.py"',
    native('try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\npython -E -B test_calculator.py'),
    native('cd "C:\\repo with spaces"\npython -E -B test_calculator.py')
  ];
  for (const command of accepted) {
    const result = await collectIssueResult(f.spec, [{ id: 'run', kind: 'command', command, text: '', exitCode: 0 }]);
    assert.equal(result.state, 'ready', command); assert.deepEqual(result.tests, [{ command, exitCode: 0 }]);
  }
  const rejected = [
    'python calculator.py', 'python scripts/validate.py', 'python -c "print(\'all tests passed\')"',
    'python -c "print(\'pytest passed\')"', 'python -c "print(\'unittest passed\')"',
    'python -O test_calculator.py', 'python -OO tests/calculator_test.py', 'python -m compileall test_calculator.py',
    'python -E -B test_calculator.py --help', 'python test_calculator.py && python -c "print(\'passed\')"',
    'python test_calculator.py; echo passed', 'echo python -E -B test_calculator.py',
    'cd /repo\npython -c "print(\'pytest passed\')"', 'cd /repo; python -O test_calculator.py',
    native('python -c "print(\'pytest passed\')"'), native('python -O test_calculator.py'),
    native('python -E -B test_calculator.py; exit 0'), native('python -E -B test_calculator.py\nexit 0'),
    native('Write-Output "pytest passed"'), native('python -E -B test_calculator.py && python -c "print(\'passed\')"'),
    native('pwsh -Command "python -E -B test_calculator.py"')
  ];
  for (const command of rejected) {
    const result = await collectIssueResult(f.spec, [{ id: 'fake', kind: 'command', command, text: 'All tests passed.', exitCode: 0 }]);
    assert.equal(result.state, 'needs-work', command); assert.deepEqual(result.tests, [], command);
  }
});

test('Wiki uses an archive of the fixed remote SHA and preserves the source working branch and dirty files', async t => {
  const f = await fixture(t);
  const spec: CodexTaskSpec = { ...f.spec, source: { kind: 'project-wiki', projectId: 4 },
    origin: { ...f.spec.origin!, kind: 'project-wiki', webUrl: 'https://gitlab.test/team/project' },
    executionRoot: path.join(f.spec.workflow!.runtimeRoot, 'source') };
  await writeFile(path.join(f.repo, 'main.ts'), 'uncommitted work');
  const python = await resolvePythonRuntime('python'); await startWikiWorkflow(spec, python);
  assert.match(await readFile(path.join(spec.executionRoot!, 'main.ts'), 'utf8'), /answer = 1/);
  assert.equal(await readFile(path.join(f.repo, 'main.ts'), 'utf8'), 'uncommitted work');
  assert.equal(f.git('branch', '--show-current'), 'main');
  await mkdir(path.join(spec.executionRoot!, 'wiki')); await writeFile(path.join(spec.executionRoot!, 'wiki/index.md'), '# Draft');
  await startWikiWorkflow(spec, python); assert.equal(await readFile(path.join(spec.executionRoot!, 'wiki/index.md'), 'utf8'), '# Draft');
});

test('Workflow Git is cancellable before any mutation and resolves nonstandard verified remotes', async t => {
  const f = await fixture(t), abort = new AbortController(); abort.abort();
  await assert.rejects(withWorkflowExecution({ signal: abort.signal }, () => workflowGit(f.repo, ['checkout', '-b', 'must-not-exist'])), /cancel/i);
  assert.equal(f.git('branch', '--show-current'), 'main');
  f.git('remote', 'add', 'company', 'https://gitlab.test/team/project.git');
  const project = { id: 4, name: 'project', path: 'project', path_with_namespace: 'team/project', web_url: 'https://gitlab.test/team/project', http_url_to_repo: 'https://gitlab.test/team/project.git' };
  assert.equal(await workflowRemote(f.repo, project), 'company');
  await assert.rejects(workflowRemote(f.repo, { ...project, http_url_to_repo: 'https://gitlab.test/team/another.git' }), /remote/);
});
