import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedGitRemote, normalizeGitLabBaseUrl } from '../../src/api/urlPolicy';

test('normalizes HTTPS GitLab base URLs and keeps installation paths', () => {
  assert.equal(normalizeGitLabBaseUrl(' https://gitlab.example.com/gitlab/ '), 'https://gitlab.example.com/gitlab');
});

test('allows the configured local GitLab CE HTTP endpoint', () => {
  assert.equal(normalizeGitLabBaseUrl('http://127.0.0.1:8929/'), 'http://127.0.0.1:8929');
});

test('allows custom HTTP hosts, IP addresses, ports, and installation paths', () => {
  assert.equal(normalizeGitLabBaseUrl('http://gitlab.internal:8929/gitlab/'), 'http://gitlab.internal:8929/gitlab');
  assert.equal(normalizeGitLabBaseUrl('http://192.168.1.20:8080/'), 'http://192.168.1.20:8080');
  assert.equal(normalizeGitLabBaseUrl('http://[::1]:8929/gitlab/'), 'http://[::1]:8929/gitlab');
});

test('rejects URL schemes other than HTTP and HTTPS', () => {
  for (const url of ['ftp://gitlab.example.com', 'file:///tmp/gitlab', 'javascript:alert(1)']) {
    assert.throws(() => normalizeGitLabBaseUrl(url), /HTTP or HTTPS/);
  }
});

test('rejects URLs containing credentials, query strings, or fragments', () => {
  for (const url of [
    'https://user:password@gitlab.example.com',
    'https://gitlab.example.com?token=secret',
    'https://gitlab.example.com/#section',
    'https://gitlab.example.com?',
    'https://gitlab.example.com#',
    'https://@gitlab.example.com',
    'https://:@gitlab.example.com',
    String.raw`http:\@gitlab.internal.test`,
    'http:////@gitlab.internal.test'
  ]) {
    assert.throws(() => normalizeGitLabBaseUrl(url));
  }
});

test('clone URLs must use the configured origin and scheme without embedded credentials', () => {
  assert.equal(isAllowedGitRemote('http://127.0.0.1:8929', 'http://127.0.0.1:8929/group/repo.git'), true);
  const customBase = 'http://gitlab.internal:8929/gitlab';
  assert.equal(isAllowedGitRemote(customBase, 'http://gitlab.internal:8929/group/repo.git'), true);
  for (const remote of [
    'https://gitlab.internal:8929/group/repo.git',
    'http://gitlab.internal:8930/group/repo.git',
    'http://other.internal:8929/group/repo.git',
    'http://user:password@gitlab.internal:8929/group/repo.git',
    'http://@gitlab.internal:8929/group/repo.git',
    String.raw`http:\@gitlab.internal:8929/group/repo.git`,
    'http:////@gitlab.internal:8929/group/repo.git',
    'http://gitlab.internal:8929/group/repo.git?',
    'http://gitlab.internal:8929/group/repo.git#'
  ]) {
    assert.equal(isAllowedGitRemote(customBase, remote), false);
  }
  for (const base of [
    'http://@gitlab.internal:8929',
    String.raw`http:\@gitlab.internal:8929`,
    'http:////@gitlab.internal:8929',
    'http://gitlab.internal:8929?',
    'http://gitlab.internal:8929#'
  ]) {
    assert.equal(isAllowedGitRemote(base, 'http://gitlab.internal:8929/group/repo.git'), false);
  }
  assert.equal(isAllowedGitRemote('http://127.0.0.1:8929', 'file:///tmp/repo.git'), false);
});
