import assert from 'node:assert/strict';
import test from 'node:test';
import type { SecretStorage } from 'vscode';
import { releaseAssetSelection, ToolReleaseManager } from '../../src/workspace/releaseManager';

function secrets(token?: string): SecretStorage {
  return { get: async () => token, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) };
}

function giteaRelease(version: string, downloadUrl: string) {
  return [{ tag_name: `v${version}`, html_url: `https://tech-sharing.cathaysec.com.tw/01002903/Megin/releases/tag/v${version}`, assets: [{ name: 'megin-skills.zip', browser_download_url: downloadUrl }] }];
}

test('parses the exact managed Release assets and ignores the wrong archive name', () => {
  assert.equal(releaseAssetSelection('megin', { assets: [{ name: 'megin-skills.zip', browser_download_url: 'https://example.test/a.zip' }] })?.name, 'megin-skills.zip');
  assert.equal(releaseAssetSelection('megin', { assets: [{ name: 'source.zip', browser_download_url: 'https://example.test/a.zip' }] }), undefined);
  assert.equal(releaseAssetSelection('merge-reviewer', { assets: [{ name: 'merge-reviewer-v0.1.2.zip', browser_download_url: 'https://example.test/a.zip' }] }), undefined);
  assert.equal(releaseAssetSelection('merge-reviewer', { assets: [{ name: 'merge-reviewer-0.1.2.zip', browser_download_url: 'https://example.test/a.zip' }] })?.name, 'merge-reviewer-0.1.2.zip');
});

test('falls back from GitHub to Gitea and strips the Gitea Token after an asset redirect', async () => {
  const calls: Array<{ url: string; authorization?: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url: url.toString(), authorization: headers.get('authorization') ?? undefined });
    if (url.hostname === 'api.github.com') return new Response('unavailable', { status: 503 });
    if (url.pathname.includes('/api/v1/repos/')) return new Response(JSON.stringify(giteaRelease('0.2.1', 'https://tech-sharing.cathaysec.com.tw/releases/megin.zip')), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/releases/megin.zip')) return new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/megin.zip' } });
    if (url.hostname === 'cdn.example.net') return new Response(new Uint8Array([80, 75, 3, 4]), { status: 200 });
    return new Response('not found', { status: 404 });
  };
  const manager = new ToolReleaseManager(secrets('internal-secret'), fetcher);
  const release = await manager.latestCompatible('megin', 'auto');
  assert.equal(release.version, '0.2.1');
  assert.equal(release.source, 'gitea');
  assert.equal(release.fallbackFrom, 'github');
  assert.deepEqual([...await manager.download(release)], [80, 75, 3, 4]);
  assert.ok(calls.some((call) => call.url.includes('api.github.com')));
  const giteaAssetCall = calls.find((call) => call.url.endsWith('/releases/megin.zip'));
  assert.equal(giteaAssetCall?.authorization, 'token internal-secret');
  assert.equal(calls.find((call) => call.url.includes('cdn.example.net'))?.authorization, undefined);
});

test('keeps an explicitly selected version when auto source moves from GitHub to Gitea', async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.github.com') {
      return new Response(JSON.stringify(giteaRelease('0.3.0', 'https://github.com/dennis8499/Megin/releases/download/v0.3.0/megin-skills.zip')), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname.includes('/api/v1/repos/')) return new Response(JSON.stringify(giteaRelease('0.2.1', 'https://tech-sharing.cathaysec.com.tw/releases/megin.zip')), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('not found', { status: 404 });
  };
  const selected = await new ToolReleaseManager(secrets(), fetcher).getVersion('megin', '0.2.1', 'auto');
  assert.equal(selected.version, '0.2.1');
  assert.equal(selected.source, 'gitea');
  assert.equal(selected.fallbackFrom, 'github');
});

test('falls back to Gitea when GitHub responds successfully but has no compatible asset', async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.github.com') return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname.includes('/api/v1/repos/')) return new Response(JSON.stringify(giteaRelease('0.2.1', 'https://tech-sharing.cathaysec.com.tw/releases/megin.zip')), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('not found', { status: 404 });
  };
  const release = await new ToolReleaseManager(secrets(), fetcher).latestCompatible('megin', 'auto');
  assert.equal(release.source, 'gitea');
  assert.equal(release.fallbackFrom, 'github');
});
