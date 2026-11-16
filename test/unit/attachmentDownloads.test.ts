import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveProjectAttachment } from '../../src/api/attachments';
import { GitLabApiError, GitLabAttachmentBrowserRequiredError, GitLabClient } from '../../src/api/gitLabClient';

const base = 'https://gitlab.example.test/gitlab';
const secret = 'a'.repeat(32);
const context = { projectId: 42, projectPath: 'group/sub/project', serverVersion: '17.4.0' };
const browserUrl = `${base}/group/sub/project/uploads/${secret}/hello%20%E4%B8%96%E7%95%8C.png`;
const apiUrl = `${base}/api/v4/projects/42/uploads/${secret}/hello%20%E4%B8%96%E7%95%8C.png`;

test('attachment routes bind project IDs, nested paths and relative uploads to the configured installation', () => {
  for (const url of [browserUrl, `/uploads/${secret}/hello%20%E4%B8%96%E7%95%8C.png`, `${base}/-/project/42/uploads/${secret}/hello%20%E4%B8%96%E7%95%8C.png`]) {
    const resolved = resolveProjectAttachment(base, url, context);
    assert.equal(resolved.apiUrl, apiUrl);
    assert.equal(new URL(resolved.browserUrl).origin, new URL(base).origin);
    assert.equal(resolved.maxBytes, 50 * 1024 * 1024);
  }
  assert.equal(resolveProjectAttachment(base, `/uploads/${secret}/hello%20%E4%B8%96%E7%95%8C.png`, context).browserUrl, browserUrl);
});

test('attachment downloads use the supported API starting at 17.4 and keep unknown versions on the browser path', () => {
  for (const version of ['17.4.0', '17.4.1-ee', '18.0.0', '19.4.1-ce']) assert.equal(resolveProjectAttachment(base, browserUrl, { ...context, serverVersion: version }).apiUrl, apiUrl);
  for (const version of ['16.11.10', '17.2.0', '17.3.99', undefined, '', '17.4.0-pre', 'future']) assert.equal(resolveProjectAttachment(base, browserUrl, { ...context, serverVersion: version }).apiUrl, undefined);
});

test('invalid attachment origins, projects and encoded paths are rejected before any request', async () => {
  let sent = 0;
  const client = new GitLabClient(base, 'host-only-token', async () => { sent++; return new Response('never'); });
  const invalid = [
    browserUrl.replace('gitlab.example.test', 'other.example.test'), browserUrl.replace('https:', 'http:'),
    browserUrl.replace('https://', 'https://user:secret@'), browserUrl.replace('/gitlab/', '/gitlab-evil/'),
    browserUrl.replace('/group/sub/project/', '/group/other/'), `${base}/-/project/43/uploads/${secret}/file.png`,
    `${base}/api/v4/user`, `${base}/group/sub/project/uploads/hash/file.png`,
    browserUrl + '?private_token=no', browserUrl + '#fragment', browserUrl.replace('/uploads/', '/%2e%2e/uploads/'),
    `${base}/group/sub/project/uploads/${secret}/a%2Fb.png`, `${base}/group/sub/project/uploads/${secret}/a%255cb.png`,
    `${base}/group/sub/project/uploads/${secret}/%00.png`, browserUrl.replace('/uploads/', '/x/../uploads/'),
    `${base}/group/sub/project/uploads/${secret}/bad\\name.png`
  ];
  for (const url of invalid) await assert.rejects(client.downloadUpload(url, context), /outside/);
  await assert.rejects(client.downloadUpload(browserUrl, { ...context, projectId: 0 }), /invalid/);
  await assert.rejects(client.downloadUpload(browserUrl, { ...context, maxBytes: 50 * 1024 * 1024 + 1 }), /invalid/);
  assert.equal(sent, 0);
});

test('modern attachment API keeps the token in Host headers and preserves filename encoding and bytes', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new GitLabClient(base, 'host-only-token', async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(new Uint8Array([0, 137, 80, 255]), { headers: { 'content-type': 'image/png; charset=binary' } });
  });
  const result = await client.downloadUpload(browserUrl, context);
  assert.deepEqual([...result.bytes], [0, 137, 80, 255]);
  assert.equal(result.contentType, 'image/png');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, apiUrl);
  assert.equal(new Headers(calls[0].init?.headers).get('PRIVATE-TOKEN'), 'host-only-token');
  assert.equal(calls[0].init?.redirect, 'manual');
  assert.ok(!calls[0].url.includes('host-only-token'));
});

test('legacy private attachments report browserRequired without sending a token or following login redirects', async () => {
  let requests = 0;
  const client = new GitLabClient(base, 'host-only-token', async (url, init) => {
    requests++;
    assert.equal(String(url), browserUrl);
    assert.equal(new Headers(init?.headers).has('PRIVATE-TOKEN'), false);
    assert.equal(init?.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: '/gitlab/users/sign_in' } });
  });
  await assert.rejects(client.downloadUpload(browserUrl, { ...context, serverVersion: '16.11.10' }), error => {
    assert.ok(error instanceof GitLabAttachmentBrowserRequiredError);
    assert.equal(error.browserUrl, browserUrl);
    assert.match(error.message, /瀏覽器登入/);
    return true;
  });
  assert.equal(requests, 1);
});

test('legacy public attachment previews retain their bytes without authentication', async () => {
  const client = new GitLabClient(base, 'host-only-token', async (_url, init) => {
    assert.equal(new Headers(init?.headers).has('PRIVATE-TOKEN'), false);
    return new Response('public', { headers: { 'content-type': 'image/webp' } });
  });
  const result = await client.downloadUpload(browserUrl, { ...context, serverVersion: undefined });
  assert.equal(Buffer.from(result.bytes).toString(), 'public');
  assert.equal(result.contentType, 'image/webp');
});

test('attachment API permission and missing-file failures never downgrade or replay against a web route', async () => {
  for (const status of [401, 403, 404, 302]) {
    let requests = 0;
    const client = new GitLabClient(base, 'host-only-token', async url => { requests++; assert.equal(String(url), apiUrl); return new Response('', { status, headers: { location: '/gitlab/users/sign_in' } }); });
    await assert.rejects(client.downloadUpload(browserUrl, context), error => error instanceof GitLabApiError && error.status === status);
    assert.equal(requests, 1);
  }
  const client = new GitLabClient(base, 'host-only-token', async () => new Response('', { status: 302, headers: { location: 'https://other.example.test/users/sign_in' } }));
  await assert.rejects(client.downloadUpload(browserUrl, { ...context, serverVersion: '16.11.10' }), error => error instanceof GitLabApiError && !(error instanceof GitLabAttachmentBrowserRequiredError));
});

test('attachment downloads enforce exact byte limits and cancellation', async () => {
  for (const size of [4, 5]) {
    const client = new GitLabClient(base, 'host-only-token', async () => new Response(new Uint8Array(size)));
    assert.equal((await client.downloadUpload(browserUrl, { ...context, maxBytes: 5 })).bytes.byteLength, size);
  }
  const tooLarge = new GitLabClient(base, 'host-only-token', async () => new Response(new Uint8Array(6)));
  await assert.rejects(tooLarge.downloadUpload(browserUrl, { ...context, maxBytes: 5 }), /too large/);
  const controller = new AbortController(); controller.abort(); let sent = 0;
  const client = new GitLabClient(base, 'host-only-token', async () => { sent++; return new Response('never'); }).withReadSignal(controller.signal);
  await assert.rejects(client.downloadUpload(browserUrl, context), { name: 'AbortError' });
  assert.equal(sent, 0);
});
