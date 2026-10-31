import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectBmadEnvironment } from '../../src/workspace/bmadEnvironment';

test('environment probes report missing uv and CLI failure independently', async () => {
  const calls: string[] = [];
  const value = await inspectBmadEnvironment('/project', { platform: 'linux', environment: { PATH: '/tools' }, realpath: async file => file,
    exists: async file => !file.endsWith('/uv'), probe: async file => {
      calls.push(file); if (file.endsWith('/codex')) throw new Error('cannot start');
      return file.endsWith('/node') ? 'v20.11.1' : '10.0.0';
    } });
  assert.equal(value.root, '/project');
  assert.deepEqual(value.tools.map(tool => [tool.id, tool.state]), [['codex', 'error'], ['uv', 'missing']]);
  assert.deepEqual(calls.sort(), ['/tools/codex']);
});

test('Windows command wrappers are discovered without invoking a command shell', async () => {
  const calls: string[] = [];
  const value = await inspectBmadEnvironment(undefined, { platform: 'win32', environment: { Path: 'relative;C:\\tools' }, realpath: async file => file,
    exists: async file => /(?:node\.exe|npm\.cmd|codex\.cmd|uv\.exe)$/.test(file), probe: async file => {
      calls.push(file); return file.endsWith('node.exe') ? 'v20.12.0' : 'uv 0.9.2';
    } });
  assert.deepEqual(value.tools.map(tool => tool.state), ['found', 'ready']);
  assert.ok(calls.every(file => file.endsWith('.exe')));
  assert.ok(calls.every(file => file.startsWith('C:\\tools\\')));
});

test('project-local executables, resolved project links and untrusted workspaces are only discovered', async () => {
  for (const setting of [{ root: '/project', directory: '/project/tools', resolved: '/project/tools' },
    { root: '/project', directory: '/global', resolved: '/project/tools' },
    { root: '/project', directory: '/global', resolved: '/global', probeVersions: false }]) {
    let probes = 0;
    const value = await inspectBmadEnvironment(setting.root, { platform: 'linux', environment: { PATH: setting.directory },
      probeVersions: setting.probeVersions, exists: async () => true,
      realpath: async file => file === setting.root ? setting.root : file.replace(setting.directory, setting.resolved),
      probe: async () => { probes++; return '99.0.0'; } });
    assert.equal(probes, 0); assert.ok(value.tools.every(tool => tool.state === 'found'));
  }
});
