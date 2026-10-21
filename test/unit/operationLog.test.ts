import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationLog, currentOperationLog, type OperationLogSink } from '../../src/logging/operationLog';
import type { LogLevel, OperationLogEntry } from '../../src/logging/logProtocol';
import { logGitCommand } from '../../src/git/gitCommandLog';

function fixture(): { log: OperationLog; output: Array<{ level: LogLevel; line: string }>; entries(): OperationLogEntry[] } {
  const output: Array<{ level: LogLevel; line: string }> = [];
  const sink: OperationLogSink = {
    info: line => output.push({ level: 'info', line }),
    warn: line => output.push({ level: 'warn', line }),
    error: line => output.push({ level: 'error', line })
  };
  return { log: new OperationLog(sink), output, entries: () => output.map(({ level, line }) => {
    const match = /^\[(.*)\] (.*) (started|success|error|cancelled) (\{.*\})$/.exec(line);
    assert.ok(match, 'each native log call contains one readable operation and its JSON metadata');
    return { ...JSON.parse(match[4]), level, feature: match[1], action: match[2], result: match[3] } as OperationLogEntry;
  }) };
}

test('sends successful and failed operations to the native sink, captures their original account and correlates API requests', async () => {
  const { log, entries, output } = fixture();
  let accountId = 'first';
  log.setContextSource(() => ({ accountId }));
  await log.run('issue', 'update', {}, async () => {
    accountId = 'second';
    await log.wrapFetch(async () => new Response('{}', { status: 201 }))('https://gitlab.test/api/v4/projects/1/issues?token=hidden', { method: 'POST', body: 'private-description' });
  });
  const failure = new Error('Synthetic failure\nprivate-second-line');
  await assert.rejects(log.run('projects', 'clone', {}, async () => { throw failure; }), error => error === failure);
  const issue = entries().filter(entry => entry.feature === 'issue');
  assert.equal(issue.length, 2);
  assert.ok(issue.every(entry => entry.accountId === 'first'));
  const api = entries().find(entry => entry.feature === 'api')!;
  assert.equal(api.operationId, issue[0].operationId);
  assert.equal(api.statusCode, 201);
  assert.equal(api.method, 'POST');
  assert.equal(api.endpoint, 'https://gitlab.test/api/v4/projects/1/issues');
  assert.ok(entries().filter(entry => entry.feature === 'projects').every(entry => entry.accountId === 'second'));
  assert.equal(entries().filter(entry => entry.result === 'error' && entry.message === 'Synthetic failure').length, 1);
  assert.equal(entries().length, 5);
  for (const secret of ['private-description', 'private-second-line', 'hidden']) assert.ok(!JSON.stringify(output).includes(secret));
  assert.equal(new Set(entries().map(entry => entry.id)).size, 5);
  log.dispose();
});

test('redacts secrets and credentials across allowed fields and excludes unapproved details', () => {
  const { log, output, entries } = fixture();
  log.addSecret('custom-secret-value');
  log.setContextSource(() => ({ accountId: 'custom-secret-value', repositoryPath: 'https://user:pass@host/repo', groupId: 4 }));
  log.record({
    feature: 'custom-secret-value', action: 'glpat-private-token', result: 'success',
    message: 'custom-secret-value https://user:pass@host gldt-private glrt-private glcbt-private authorization=hidden Bearer hidden token=hidden password=hidden access_token=hidden private-token=hidden',
    projectId: 0, durationMs: Number.NaN, statusCode: Number.POSITIVE_INFINITY,
    body: 'private-body', environment: { TOKEN: 'private-environment' }
  } as Parameters<OperationLog['record']>[0]);
  const serialized = JSON.stringify(output);
  for (const secret of ['custom-secret-value', 'user:pass', 'glpat-private-token', 'gldt-private', 'glrt-private', 'glcbt-private', 'hidden', 'private-body', 'private-environment']) {
    assert.ok(!serialized.includes(secret), secret);
  }
  const entry = entries()[0];
  assert.equal(entry.accountId, '[redacted]');
  assert.equal(entry.repositoryPath, 'https://[redacted]@host/repo');
  assert.equal(entry.groupId, 4);
  assert.equal(entry.projectId, 0);
  assert.equal(entry.durationMs, undefined);
  assert.equal(entry.statusCode, undefined);
  assert.equal(log.sanitize('x'.repeat(3000)).length, 2048);
});

test('formats each record as one readable line and lets the native sink supply time and severity', () => {
  const { log, output, entries } = fixture();
  log.record({ feature: 'workspace', action: 'updateIssue', result: 'success', level: 'warn', durationMs: 120, message: 'first\r\nsecond' });
  assert.match(output[0].line, /^\[workspace\] updateIssue success \{/);
  assert.equal(output[0].level, 'warn');
  const metadata = JSON.parse(output[0].line.slice(output[0].line.indexOf('{')));
  assert.equal(metadata.message, 'first\r\nsecond');
  assert.equal(metadata.durationMs, 120);
  assert.match(metadata.id, /^[\da-f-]{36}$/);
  assert.match(metadata.operationId, /^[\da-f-]{36}$/);
  for (const key of ['timestamp', 'level', 'feature', 'action', 'result']) assert.ok(!(key in metadata), key);
  log.record({ feature: 'work\r\nspace', action: 'read\nIssue', result: 'success', message: 'multi\nline' });
  assert.ok(output.every(({ line }) => !/[\r\n]/.test(line)));
  assert.equal(entries()[1].feature, 'work\\r\\nspace');
  assert.equal(entries()[1].action, 'read\\nIssue');
  log.record({ feature: 'workspace', action: 'readIssue', result: 'error' });
  assert.deepEqual(output.map(entry => entry.level), ['warn', 'info', 'error']);
});

test('nested operations share correlation while concurrent operations retain independent context', async () => {
  const { log, entries } = fixture();
  let activeAccount = 'initial';
  log.setContextSource(() => ({ accountId: activeAccount }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const left = log.run('parallel', 'left', { accountId: 'left' }, async () => {
    assert.equal(currentOperationLog(), log);
    await log.run('nested', 'child', { projectId: 7 }, async () => {
      await new Promise(resolve => setImmediate(resolve));
      log.record({ feature: 'nested', action: 'inside', result: 'success' });
    });
    await gate;
    log.record({ feature: 'parallel', action: 'left-after', result: 'success' });
  });
  activeAccount = 'changed';
  await log.run('parallel', 'right', { accountId: 'right' }, async () => {
    assert.equal(currentOperationLog(), log);
    await new Promise(resolve => setImmediate(resolve));
    log.record({ feature: 'parallel', action: 'right-after', result: 'success' });
  });
  release();
  await left;
  assert.equal(currentOperationLog(), undefined);
  const leftId = entries().find(entry => entry.action === 'left')!.operationId;
  const rightId = entries().find(entry => entry.action === 'right')!.operationId;
  assert.notEqual(leftId, rightId);
  assert.ok(entries().filter(entry => entry.operationId === leftId).every(entry => entry.accountId === 'left'));
  assert.ok(entries().filter(entry => entry.operationId === rightId).every(entry => entry.accountId === 'right'));
  assert.ok(entries().filter(entry => entry.feature === 'nested').every(entry => entry.operationId === leftId && entry.projectId === 7));
  assert.equal(entries().find(entry => entry.action === 'left-after')!.projectId, undefined);
});

test('correlates Git exit codes while preserving command results and excluding arguments and output', async () => {
  const { log, entries, output } = fixture();
  let identity = 'first';
  log.setContextSource(() => ({ accountId: identity }));
  const failure = Object.assign(new Error('private-stderr-output'), { code: 128 });
  await log.run('workflow', 'prepareDelivery', {}, async () => {
    identity = 'second';
    assert.deepEqual(await logGitCommand(['-c', 'http.extraHeader=private-header', '-C', 'repo', 'show', 'private-argument'], 'repo',
      async () => ({ stdout: 'private-stdout-output' })), { stdout: 'private-stdout-output' });
    await assert.rejects(logGitCommand(['cat-file'], 'repo', async () => { throw failure; }), error => error === failure);
  });
  assert.ok(entries().every(entry => entry.accountId === 'first'));
  assert.equal(new Set(entries().map(entry => entry.operationId)).size, 1);
  assert.ok(entries().some(entry => entry.action === 'show' && entry.exitCode === 0 && entry.repositoryPath === 'repo'));
  assert.ok(entries().some(entry => entry.action === 'cat-file' && entry.exitCode === 128));
  const git = entries().filter(entry => entry.feature === 'git');
  assert.equal(git.length, 4, 'each execution has one start and one terminal record');
  assert.equal(new Set(git.map(entry => entry.commandId)).size, 2);
  for (const commandId of new Set(git.map(entry => entry.commandId))) {
    assert.match(commandId!, /^[\da-f-]{36}$/);
    const command = git.filter(entry => entry.commandId === commandId);
    assert.deepEqual(command.map(entry => entry.result), ['started', command[0].action === 'show' ? 'success' : 'error']);
    assert.ok(command.every(entry => entry.network === false));
  }
  const serialized = JSON.stringify(output);
  for (const value of ['private-header', 'private-argument', 'private-stdout-output', 'private-stderr-output']) assert.ok(!serialized.includes(value));
  log.dispose();
});

test('Git network classification, accepted exit codes and cancellation keep exactly one terminal per execution', async () => {
  const { log, entries } = fixture();
  const cancelled = Object.assign(new Error('private-error'), { name: 'AbortError' });
  await log.run('workflow', 'sync', {}, async () => {
    await logGitCommand(['fetch', 'private-remote'], 'repo', async () => ({ code: 0 }));
    await logGitCommand(['rev-parse'], 'repo', async () => ({ code: 1 }), undefined,
      { outcome: value => ({ result: 'success', exitCode: value.code }) });
    await logGitCommand(['fetch'], 'repo', async () => ({ code: 128 }));
    await assert.rejects(logGitCommand(['status'], 'repo', async () => { throw cancelled; }), error => error === cancelled);
    await assert.rejects(logGitCommand(['diff'], 'repo', async () => { throw Object.assign(new Error('private-error'), { exitCode: 2 }); }));
  });
  const commands = entries().filter(entry => entry.feature === 'git');
  assert.equal(commands.length, 10);
  assert.equal(new Set(commands.map(entry => entry.commandId)).size, 5);
  assert.ok(commands.filter(entry => entry.action === 'fetch').every(entry => entry.network === true));
  assert.equal(commands.find(entry => entry.action === 'rev-parse' && entry.result !== 'started')?.exitCode, 1);
  assert.equal(commands.find(entry => entry.action === 'rev-parse' && entry.result !== 'started')?.result, 'success');
  assert.equal(commands.find(entry => entry.action === 'status' && entry.result !== 'started')?.result, 'cancelled');
  assert.equal(commands.find(entry => entry.action === 'diff' && entry.result !== 'started')?.exitCode, 2);
  for (const commandId of new Set(commands.map(entry => entry.commandId))) {
    const pair = commands.filter(entry => entry.commandId === commandId);
    assert.equal(pair.length, 2); assert.equal(pair[0].result, 'started'); assert.notEqual(pair[1].result, 'started');
  }
});

test('context-only diagnostics capture identity, retain correlation and isolate concurrent cache decisions', async () => {
  const { log, entries } = fixture();
  let identity = 'first';
  log.setContextSource(() => ({ accountId: identity }));
  await log.run('workspace', 'read', {}, async () => {
    const result = log.withContext({ requestReason: 'page-entry', cacheResult: 'hit' }, () => 42);
    assert.equal(result, 42);
    await Promise.all(['miss', 'joined'].map(cacheResult => log.withContext({ requestReason: 'page-entry', cacheResult: cacheResult as 'miss' | 'joined' }, async () => {
      identity = 'second'; await new Promise(resolve => setImmediate(resolve));
      log.record({ feature: 'cache', action: 'projects', result: 'success' });
    })));
    log.record({ feature: 'workspace', action: 'after-cache', result: 'success' });
  });
  assert.equal(entries().length, 5, 'withContext adds no implicit start or terminal record');
  assert.equal(new Set(entries().map(entry => entry.operationId)).size, 1);
  assert.ok(entries().every(entry => entry.accountId === 'first'));
  assert.deepEqual(entries().filter(entry => entry.feature === 'cache').map(entry => entry.cacheResult).sort(), ['joined', 'miss']);
  assert.equal(entries().find(entry => entry.action === 'after-cache')?.cacheResult, undefined);
  assert.equal(entries().find(entry => entry.action === 'after-cache')?.requestReason, undefined);
  assert.equal(currentOperationLog(), undefined);
});

test('API diagnostics expose only approved operation names and safe page identities', async () => {
  const { log, entries, output } = fixture();
  const fetcher = log.wrapFetch(async () => new Response('private-response'));
  const query = 'query IssueTasks($after: String) { privateField }';
  const variables = { after: 'private-cursor', description: 'private-description' };
  await log.withContext({ requestReason: 'manual-refresh', cacheResult: 'refresh' }, () =>
    fetcher('https://gitlab.test/api/graphql?token=private-query', { method: 'POST', body: JSON.stringify({ query, variables }) }));
  await fetcher('https://gitlab.test/api/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  await fetcher('https://gitlab.test/api/graphql', { method: 'POST', body: JSON.stringify({ query, variables: { after: 'another-private-cursor' } }) });
  await fetcher('https://gitlab.test/api/graphql', { method: 'POST', body: JSON.stringify({ query: 'query PrivateCustomerName { secrets }', variables: { after: null } }) });
  await fetcher('https://gitlab.test/api/graphql', { method: 'POST', body: 'private-invalid-json' });
  await fetcher('https://gitlab.test/api/v4/groups/1/projects?page=2&search=private-search');
  await fetcher('https://gitlab.test/api/v4/groups/1/projects?page_token=private-page-token');
  await fetcher('https://gitlab.test/api/v4/groups/1/projects?page=private-invalid-page');
  const failure = new Error('Failed https://user:password@gitlab.test/api/v4/issues?search=private-search&page_token=private-page-token#private-fragment');
  await assert.rejects(log.wrapFetch(async () => { throw failure; })('https://gitlab.test/api/v4/issues'), error => error === failure);
  const api = entries();
  assert.equal(api[0].graphqlOperationName, 'IssueTasks');
  assert.equal(api[0].cacheResult, 'refresh'); assert.equal(api[0].requestReason, 'manual-refresh');
  assert.match(api[0].pageIdentity!, /^cursor:[\da-f]{16}$/);
  assert.equal(api[0].pageIdentity, api[1].pageIdentity); assert.notEqual(api[1].pageIdentity, api[2].pageIdentity);
  assert.equal(api[3].graphqlOperationName, undefined); assert.equal(api[3].pageIdentity, 'page:1');
  assert.equal(api[4].graphqlOperationName, undefined); assert.equal(api[4].pageIdentity, undefined);
  assert.equal(api[5].pageIdentity, 'page:2');
  assert.match(api[6].pageIdentity!, /^cursor:[\da-f]{16}$/); assert.match(api[7].pageIdentity!, /^cursor:[\da-f]{16}$/);
  assert.equal(api[8].message, 'Failed https://gitlab.test/api/v4/issues');
  for (const value of ['privateField', 'private-cursor', 'private-description', 'another-private-cursor', 'PrivateCustomerName', 'private-invalid-json', 'private-query', 'private-search', 'private-page-token', 'private-invalid-page', 'private-fragment', 'user:password', 'private-response']) {
    assert.ok(!JSON.stringify(output).includes(value), value);
  }
});

test('diagnostic fields apply redaction and reject unapproved enum or operation values', () => {
  const { log, entries, output } = fixture(); log.addSecret('custom-secret');
  log.withContext({ requestReason: 'custom-secret', targetPath: 'custom-secret', commandId: 'custom-secret', network: false }, () => {
    log.record({ feature: 'cache', action: 'read', result: 'success', cacheResult: 'private-value',
      graphqlOperationName: 'private-query-name', pageIdentity: 'private-cursor', query: 'private-query', variables: 'private-variables' } as any);
  });
  assert.equal(entries()[0].requestReason, '[redacted]'); assert.equal(entries()[0].network, false);
  assert.equal(entries()[0].cacheResult, undefined); assert.equal(entries()[0].graphqlOperationName, undefined); assert.equal(entries()[0].pageIdentity, undefined);
  for (const value of ['custom-secret', 'private-value', 'private-query-name', 'private-cursor', 'private-query', 'private-variables']) assert.ok(!JSON.stringify(output).includes(value));
});

test('standalone fetches retain captured context and preserve HTTP responses and thrown errors', async () => {
  const { log, entries, output } = fixture();
  let identity = 'first';
  log.setContextSource(() => ({ accountId: identity }));
  const response = new Response('private-response-body', { status: 500 });
  const fetcher = log.wrapFetch(async () => {
    identity = 'second';
    await new Promise(resolve => setImmediate(resolve));
    return response;
  });
  assert.equal(await fetcher('https://user:pass@gitlab.test/api/v4/projects?token=private-query'), response);
  assert.equal(entries()[0].accountId, 'first');
  assert.equal(entries()[0].endpoint, 'https://gitlab.test/api/v4/projects');
  assert.equal(entries()[0].statusCode, 500);
  assert.equal(entries()[0].level, 'error');
  const failure = new Error('authorization=private-error');
  await assert.rejects(log.wrapFetch(async () => { throw failure; })('https://gitlab.test/api/v4/projects'), error => error === failure);
  assert.equal(entries()[1].message, 'authorization=[redacted]');
  const cancelled = Object.assign(new Error('request cancelled'), { name: 'AbortError' });
  await assert.rejects(log.wrapFetch(async () => { throw cancelled; })('https://gitlab.test/api/v4/projects'), error => error === cancelled);
  assert.equal(entries()[2].result, 'cancelled');
  assert.equal(entries()[2].level, 'info');
  assert.equal(new Set(entries().map(entry => entry.operationId)).size, 3);
  for (const value of ['user:pass', 'private-query', 'private-response-body', 'private-error']) assert.ok(!JSON.stringify(output).includes(value));
});

test('cancelled operations preserve the original error and are not logged as failures', async () => {
  const { log, entries } = fixture();
  const cancelled = Object.assign(new Error('cancelled'), { name: 'AbortError' });
  await assert.rejects(log.run('workspace', 'read', {}, async () => { throw cancelled; }), error => error === cancelled);
  const completed = entries().find(entry => entry.result !== 'started')!;
  assert.equal(completed.result, 'cancelled');
  assert.equal(completed.level, 'info');
  assert.equal(entries().filter(entry => entry.result === 'error').length, 0);
});

test('handled domain failures are logged as errors even when the adapter resolves normally', async () => {
  const { log, entries } = fixture();
  let handled = false, callbacks = 0;
  const result = await log.run('workspace', 'loadMergeRequestSection', {}, async () => {
    handled = true; return { status: 'error' };
  }, () => {
    callbacks++; assert.equal(handled, true, 'the domain outcome is read after the adapter completes');
    return { result: 'error', level: 'error', message: 'GitLab API request failed (HTTP 500).' };
  });
  assert.deepEqual(result, { status: 'error' }); assert.equal(callbacks, 1);
  assert.equal(entries().length, 2);
  assert.ok(entries().every(entry => entry.action === 'loadMergeRequestSection'));
  const completed = entries().find(entry => entry.result !== 'started')!;
  assert.equal(completed.result, 'error'); assert.equal(completed.level, 'error');
  assert.equal(completed.message, 'GitLab API request failed (HTTP 500).');
  assert.equal(new Set(entries().map(entry => entry.operationId)).size, 1);
  log.dispose();
});

test('applied writes with refresh warnings remain successful and retain the actual warning message', async () => {
  const { log, entries } = fixture();
  const warning = 'Issue 已更新，但重新載入失敗：GitLab read timed out after 30 seconds.';
  const result = await log.run('workspace', 'updateIssue', {}, async () => 42,
    () => ({ result: 'success', level: 'warn', message: warning }));
  assert.equal(result, 42);
  const completed = entries().filter(entry => entry.result === 'success');
  assert.equal(completed.length, 1); assert.equal(completed[0].level, 'warn'); assert.equal(completed[0].message, warning);
  assert.equal(entries().filter(entry => entry.result === 'error').length, 0);
  log.dispose();
});
