import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { GitLabAttachmentBrowserRequiredError } from '../../src/api/gitLabClient';
import { isWorkspaceRequest } from '../../src/workspace/workspaceRequestValidation';

const calls = { external: [] as string[], saves: 0, downloads: [] as unknown[], writes: 0, opens: 0 };
let savedBytes: Uint8Array | undefined;
let chooseDestination: () => Promise<unknown> = async () => ({ path: '/saved.png' });
let externalResult = true;
const vscode = {
  Uri: { parse: (href: string) => ({ href }), joinPath: () => ({}) },
  env: { openExternal: async ({ href }: { href: string }) => { calls.external.push(href); return externalResult; } },
  window: { showSaveDialog: async () => { calls.saves++; return chooseDestination(); } },
  workspace: { fs: { writeFile: async (_destination: unknown, bytes: Uint8Array) => { calls.writes++; savedBytes = bytes; } } },
  commands: { executeCommand: async () => { calls.opens++; } }
};
const loader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown }, original = loader._load;
loader._load = (name, parent, main) => name === 'vscode' ? vscode : original(name, parent, main);
let IssuePanels: typeof import('../../src/issues/issuePanel').IssuePanels;
try { ({ IssuePanels } = require('../../src/issues/issuePanel')); }
finally { loader._load = original; }

const url = 'https://gitlab.example.test/group/project/uploads/' + 'a'.repeat(32) + '/file.png';
function fixture(version = '16.11.10') {
  calls.external = []; calls.saves = 0; calls.downloads = []; calls.writes = 0; calls.opens = 0;
  savedBytes = undefined;
  chooseDestination = async () => ({ path: '/saved.png' }); externalResult = true;
  const messages: any[] = [];
  const client = { baseUrl: 'https://gitlab.example.test', withReadSignal: () => client,
    downloadUpload: async (href: string, options: unknown) => { calls.downloads.push([href, options]); return { bytes: new Uint8Array([1, 2]), contentType: 'image/png' }; } };
  const session = { baseUrl: client.baseUrl, connectionEpoch: 1, selectedGroup: { id: 1, full_path: 'group' }, metadata: { version }, getClient: async () => client };
  const issue = { id: 8, project_id: 42 };
  const host: any = Object.create(IssuePanels.prototype);
  Object.assign(host, { session, mode: 'detail', issue, navigationVersion: 1, suspended: false,
    lastSnapshot: { type: 'detailData', data: { issue, project: { id: 42, path_with_namespace: 'group/project' } } },
    navigationReadController: new AbortController(), actionContext: new AsyncLocalStorage(), post: (message: unknown) => messages.push(message) });
  return { host, client, session, messages };
}

test('legacy attachment clicks open the validated project in the browser without a save dialog or API call', async () => {
  const { host } = fixture();
  await host.handleRequestBody({ type: 'openLink', url, projectId: 42 });
  assert.deepEqual(calls.external, [url]);
  assert.deepEqual([calls.saves, calls.downloads.length, calls.writes], [0, 0, 0]);
  externalResult = false;
  await assert.rejects(host.handleRequestBody({ type: 'openLink', url, projectId: 42 }), /無法在瀏覽器/);
});

test('private image replies expose browserRequired without automatically opening a browser', async () => {
  const { host, client, messages } = fixture();
  client.downloadUpload = async () => { throw new GitLabAttachmentBrowserRequiredError(url); };
  await host.handleRequestBody({ type: 'image', requestId: 'image-one', url, projectId: 42 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].result.status, 'browserRequired');
  assert.equal(messages[0].result.url, url);
  assert.equal(messages[0].error, undefined);
  assert.deepEqual(calls.external, []);
  await host.handleRequestBody({ type: 'openAttachmentInBrowser', url, projectId: 42 });
  assert.deepEqual(calls.external, [url]);
});

test('browser attachment commands revalidate URL, project, Group and message shape in the Host', async () => {
  const { host } = fixture();
  for (const request of [
    { type: 'openAttachmentInBrowser', url, projectId: 43 },
    { type: 'openAttachmentInBrowser', url: url.replace('/group/project/', '/group/other/'), projectId: 42 },
    { type: 'openAttachmentInBrowser', url: url.replace('gitlab.example.test', 'other.example.test'), projectId: 42 }
  ]) await assert.rejects(host.handleRequestBody(request));
  host.session.selectedGroup = { id: 2, full_path: 'other-group' };
  await assert.rejects(host.handleRequestBody({ type: 'openAttachmentInBrowser', url, projectId: 42 }), /outside/);
  assert.deepEqual(calls.external, []);
  assert.equal(isWorkspaceRequest({ type: 'issueRequest', request: { type: 'openAttachmentInBrowser', url, projectId: 42 } }), true);
  assert.equal(isWorkspaceRequest({ type: 'issueRequest', request: { type: 'openAttachmentInBrowser', url } }), false);
  assert.equal(isWorkspaceRequest({ type: 'issueRequest', request: { type: 'openAttachmentInBrowser', url, projectId: 42, token: 'never-accepted' } }), false);
});

test('native attachments save exact bytes only while the project scope is current and the dialog is accepted', async () => {
  const { host } = fixture('17.4.0');
  chooseDestination = async () => undefined;
  await host.handleRequestBody({ type: 'openLink', url, projectId: 42 });
  assert.equal(calls.downloads.length, 0);
  chooseDestination = async () => { host.session.connectionEpoch++; return { path: '/saved.png' }; };
  await host.handleRequestBody({ type: 'openLink', url, projectId: 42 });
  assert.equal(calls.downloads.length, 0);
  chooseDestination = async () => ({ path: '/saved.png' });
  await host.handleRequestBody({ type: 'openLink', url, projectId: 42 });
  assert.deepEqual(calls.downloads, [[url, { projectId: 42, projectPath: 'group/project', serverVersion: '17.4.0' }]]);
  assert.deepEqual([calls.writes, calls.opens, calls.external.length], [1, 1, 0]);
  assert.deepEqual(savedBytes, new Uint8Array([1, 2]));
});

test('stale image and download results cannot update another account or write a selected file', async () => {
  const { host, client, messages } = fixture('18.0.0');
  client.downloadUpload = async () => { host.session.connectionEpoch++; return { bytes: new Uint8Array([1]), contentType: 'image/png' }; };
  await host.handleRequestBody({ type: 'image', requestId: 'image-stale', url, projectId: 42 });
  assert.deepEqual(messages, []);
  await host.handleRequestBody({ type: 'openLink', url, projectId: 42 });
  assert.deepEqual([calls.writes, calls.opens], [0, 0]);
});

test('image previews use the image budget, allow only supported MIME types and reject stale project input', async () => {
  const { host, client, messages } = fixture('18.0.0');
  await host.handleRequestBody({ type: 'image', requestId: 'image-valid', url, projectId: 42 });
  assert.deepEqual(messages[0].result, { dataUrl: 'data:image/png;base64,AQI=' });
  assert.deepEqual(calls.downloads[0], [url, { projectId: 42, projectPath: 'group/project', serverVersion: '18.0.0', maxBytes: 8 * 1024 * 1024 }]);
  client.downloadUpload = async () => ({ bytes: new Uint8Array([1]), contentType: 'image/svg+xml' });
  await host.handleRequestBody({ type: 'image', requestId: 'image-unsafe', url });
  assert.match(messages.at(-1).error, /not a supported image/);
  await host.handleRequestBody({ type: 'image', requestId: 'image-project', url, projectId: 43 });
  assert.match(messages.at(-1).error, /project changed/);
});
