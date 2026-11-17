const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async () => {
  const evidence = process.env.GLW_RECOVERY_FIXTURE;
  const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace');
  assert.ok(extension);
  const api = await extension.activate();
  const host = api.getWorkspaceForTesting();
  // Authentication is the scenario under test; optional metadata probes have
  // their own suites and must not race the exact user-request count here.
  api.session.ensureMetadataChecked = async () => undefined;
  // Keep this lifecycle witness focused on the authentication probe. Metadata
  // discovery has its own suites and must not race its one-request assertion.
  api.session.ensureMetadataChecked = async () => undefined;
  let requests = 0;
  api.setFetchForTesting(async () => {
    requests++;
    return new Response(JSON.stringify({ id: 1, username: 'synthetic', name: 'Synthetic Recovery User' }), { headers: { 'content-type': 'application/json' } });
  });
  host.connectedUserChanged = async () => undefined;
  if (process.env.GLW_RECOVERY_PHASE === 'blocked') {
    // Retain the packaged Host's constructors even when Windows paths differ in case.
    const recovery = host.getApiControlRecovery();
    recovery.options.scriptPath = path.join(evidence, 'interactive-fixture.ps1');
    const execute = recovery.execute.bind(recovery);
    recovery.execute = async source => {
      try {
        const stdout = await execute(source);
        await fs.appendFile(path.join(process.env.GLW_RECOVERY_REPORT_DIR, 'powershell.jsonl'), JSON.stringify({ source, stdout }) + '\n');
        return stdout;
      } catch (error) {
        await fs.appendFile(path.join(process.env.GLW_RECOVERY_REPORT_DIR, 'powershell.jsonl'), JSON.stringify({ source, error: error.message, stderr: error.stderr }) + '\n');
        throw error;
      }
    };
    const capture = recovery.capture.bind(recovery);
    let captured;
    recovery.capture = error => {
      const target = capture(error);
      captured = { name: error.name, diagnostics: error.diagnostics, target };
      return target;
    };
    await fs.writeFile(path.join(evidence, 'extension-pid.txt'), String(process.pid));
    await host.runCommandAction('connect', () => host.loginAccount({ requestId: 'lifecycle-blocked', operationId: 'lifecycle-blocked',
      baseUrl: 'https://recovery-lifecycle.example', token: 'SYNTHETIC-ONLY' }), { operationId: 'lifecycle-blocked' });
    const receipt = host.accountLoginReceipts.get('lifecycle-blocked');
    assert.match(receipt.error, /控制鎖缺少擁有者/);
    assert.equal(requests, 0);
    const correlated = api.getNotificationsForTesting().items.filter(item => item.operationId === 'lifecycle-blocked');
    assert.equal(correlated.length, 1);
    const notice = correlated.find(item => item.target?.kind === 'networkRecovery');
    await fs.writeFile(path.join(process.env.GLW_RECOVERY_REPORT_DIR, 'capture.json'), JSON.stringify({ captured,
      root: recovery.root, runtime: process.env.GITLAB_WORKSPACE_RUNTIME_DIR, receipt, notices: api.getNotificationsForTesting() }, null, 2));
    assert.ok(notice);
    // Run the contributed command. The informational notification may remain open
    // until VS Code exits; helper readiness is observed separately below.
    void vscode.commands.executeCommand('gitlabWorkspace.repairApiControl');
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { await fs.access(path.join(evidence, 'helper-ready.json')); break; }
      catch (error) { if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await fs.writeFile(path.join(evidence, 'blocked.json'), JSON.stringify({ requests, targetKind: notice.target.kind, extensionVersion: extension.packageJSON.version }));
  } else {
    await host.runCommandAction('connect', () => host.loginAccount({ requestId: 'lifecycle-reconnected', operationId: 'lifecycle-reconnected',
      baseUrl: 'https://recovery-lifecycle.example', token: 'SYNTHETIC-ONLY' }), { operationId: 'lifecycle-reconnected' });
    const receipt = host.accountLoginReceipts.get('lifecycle-reconnected');
    assert.equal(receipt.error, undefined);
    const account = api.session.accounts.find(item => item.id === api.session.activeAccountId);
    assert.equal(account.userId, 1);
    assert.equal(requests, 1);
    await fs.writeFile(path.join(evidence, 'reconnected.json'), JSON.stringify({ requests, userId: account.userId, extensionVersion: extension.packageJSON.version }));
  }
};
