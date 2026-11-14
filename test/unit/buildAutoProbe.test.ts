import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { BuildAutoProbeStore, buildAutoSettingsDigest, buildAutoWritableRoots, type BuildAutoExecutionClient } from '../../src/codex/buildAutoProbe';

const exec = promisify(execFile);
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'build-auto-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = path.join(root, 'storage'), source = path.join(root, 'source'); await Promise.all([mkdir(storage), mkdir(source)]);
  return { storage, source, store: new BuildAutoProbeStore(storage) };
}
test('the probe uses command/exec and actual local commits, without starting a model turn', async t => {
  const f = await fixture(t), calls: string[] = [], failures: string[] = []; let settingsKey = '';
  const withExecutionClient: BuildAutoExecutionClient = async (source, roots, operation) => {
    assert.equal(source, f.source);
    assert.deepEqual(roots, buildAutoWritableRoots(roots[0]));
    const settings = { sandboxPolicy: { type: 'workspaceWrite', writableRoots: roots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
    settingsKey = buildAutoSettingsDigest(settings, roots[0]);
    const client = { async request(method: string, args: Record<string, any> = {}): Promise<any> {
      calls.push(method);
      if (method === 'config/read') return { config: { features: { multi_agent: true } } };
      if (method === 'experimentalFeature/list') return { data: [{ name: 'multi_agent', enabled: true }], nextCursor: null };
      assert.equal(method, 'command/exec'); assert.equal(args.sandboxPolicy.networkAccess, false);
      assert.deepEqual(args.sandboxPolicy.writableRoots, roots);
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const [key, value] of Object.entries(args.env as Record<string, string | null>)) if (value === null) delete env[key]; else env[key] = value;
      const [file, ...commandArgs] = args.command as string[];
      try {
        const result = await exec(file, commandArgs, { cwd: args.cwd, env });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) { failures.push(String(error)); return { exitCode: 1, stdout: '', stderr: String(error) }; }
    } };
    return operation(client, settings, '0.167.2');
  };
  const capability = await f.store.probe({ root: f.source, withExecutionClient });
  assert.equal(capability.state, 'ready', failures.join('\n') || capability.reason); assert.equal(capability.gitSandbox, 'verified');
  assert.ok(calls.filter(method => method === 'command/exec').length >= 5);
  assert.ok(!calls.includes('turn/start'));
  assert.deepEqual(await f.store.read(f.source, '0.167.2', settingsKey), capability);
  assert.equal(await f.store.read(f.source, '0.168.0', settingsKey), undefined);
  assert.equal(await f.store.read(f.source, '0.167.2', 'changed-policy'), undefined);
  assert.deepEqual(await readdir(path.join(f.storage, 'build-auto-probes')), []);
});
test('read-only sandbox does not run any command or silently elevate permissions', async t => {
  const f = await fixture(t); let commands = 0;
  const withExecutionClient: BuildAutoExecutionClient = (_source, _roots, operation) => operation({ request: async () => { commands++; throw new Error('unexpected'); } },
    { sandboxPolicy: { type: 'readOnly', networkAccess: false } }, '0.167.2');
  const capability = await f.store.probe({ root: f.source, withExecutionClient });
  assert.equal(capability.state, 'unavailable'); assert.equal(commands, 0);
});
test('missing subagents or failed sandbox Git never produce a ready proof', async t => {
  const f = await fixture(t);
  for (const subagents of [false, true]) {
    let commands = 0;
    const withExecutionClient: BuildAutoExecutionClient = (_source, roots, operation) => operation({ request: async (method: string): Promise<any> => {
      if (method === 'config/read') return { config: { features: { multi_agent: subagents } } };
      if (method === 'experimentalFeature/list') return { data: [{ name: 'multi_agent', enabled: subagents }], nextCursor: null };
      commands++; return { exitCode: 1, stdout: '', stderr: 'sandbox denied Git metadata' };
    } }, { sandboxPolicy: { type: 'workspaceWrite', writableRoots: roots, networkAccess: false } }, '0.167.2');
    const capability = await f.store.probe({ root: f.source, withExecutionClient });
    assert.equal(capability.state, 'unavailable'); assert.equal(commands, subagents ? 1 : 0);
  }
});
