// Real Extension Host, synthetic GitLab transport and a local bare Git remote.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vscode = require('vscode');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.run = async function () {
  const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace');
  const api = await extension.activate();
  let apiReads = 0;
  api.setFetchForTesting(async (input, init) => {
    assert.ok(!init?.method || init.method === 'GET', 'Idle setup must never write to GitLab');
    apiReads++;
    const url = new URL(String(input));
    const value = url.pathname.endsWith('/user') ? { id: 7, username: 'fixture', name: 'Fixture' }
      : /\/(?:metadata|version)$/.test(url.pathname) ? { version: '16.11.0', revision: 'fixture', enterprise: false }
        : [];
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  });
  await api.session.connect('https://gitlab.example.invalid', 'synthetic-token');
  await api.session.setSelectedGroup({ id: 1, name: 'Fixture', full_path: 'fixture', web_url: 'https://gitlab.example.invalid/groups/fixture' });
  const workspace = api.getWorkspaceForTesting();
  await workspace.show('git');
  await api.getGitRepositoryState();
  await pause(10_000); // Finish one-time Webview, Git and metadata setup.
  const before = { apiReads, ...api.getGitActivityForTesting() }, started = Date.now(), samples = [];
  const report = { schema: 'GitLabWorkspaceIdleHost/v1', version: vscode.version,
    scope: 'Visible Git page, selected local repository with a local bare remote, mock GitLab account; extension counters only. No real service or model.',
    before, samples, status: 'RUNNING' };
  for (let minute = 1; minute <= 10; minute++) {
    await pause(60_000);
    const after = { apiReads, ...api.getGitActivityForTesting() };
    const delta = Object.fromEntries(['apiReads', 'commands', 'auxiliaryCommands', 'nativeApiCalls'].map(key => [key, after[key] - before[key]]));
    samples.push({ minute, elapsedMs: Date.now() - started, after, delta });
    report.status = minute === 10 ? 'PASS' : 'RUNNING';
    await fs.writeFile(process.env.GLW_IDLE_REPORT, JSON.stringify(report, null, 2) + '\n');
    console.log('[idle]', JSON.stringify(samples.at(-1)));
    assert.deepEqual(delta, { apiReads: 0, commands: 0, auxiliaryCommands: 0, nativeApiCalls: 0 });
  }
};
