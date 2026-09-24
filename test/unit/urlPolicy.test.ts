import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedGitRemote, normalizeGitLabBaseUrl } from '../../src/api/urlPolicy';

test('normalizes HTTPS GitLab base URLs and keeps installation paths', () => {
  assert.equal(normalizeGitLabBaseUrl(' https://gitlab.example.com/gitlab/ '), 'https://gitlab.example.com/gitlab');
});

test('allows the configured local GitLab CE HTTP endpoint', () => {
  assert.equal(normalizeGitLabBaseUrl('http://127.0.0.1:8929/'), 'http://127.0.0.1:8929');
});

test('rejects non-loopback HTTP and other loopback aliases', () => {
  for (const url of ['http://gitlab.example.com', 'http://192.168.1.20', 'http://localhost:8929', 'http://[::1]:8929']) {
    assert.throws(() => normalizeGitLabBaseUrl(url), /HTTPS|127\.0\.0\.1/);
  }
});

test('rejects URLs containing credentials, query strings, or fragments', () => {
  for (const url of [
    'https://user:password@gitlab.example.com',
    'https://gitlab.example.com?token=secret',
    'https://gitlab.example.com/#section'
  ]) {
    assert.throws(() => normalizeGitLabBaseUrl(url));
  }
});

test('clone URLs must use the configured origin and scheme without embedded credentials', () => {
  assert.equal(isAllowedGitRemote('http://127.0.0.1:8929', 'http://127.0.0.1:8929/group/repo.git'), true);
  for (const remote of [
    'https://127.0.0.1:8929/group/repo.git',
    'http://127.0.0.1:8930/group/repo.git',
    'http://127.0.0.2:8929/group/repo.git',
    'http://user:password@127.0.0.1:8929/group/repo.git',
    'file:///tmp/repo.git'
  ]) {
    assert.equal(isAllowedGitRemote('http://127.0.0.1:8929', remote), false);
  }
});
