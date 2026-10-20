import assert from 'node:assert/strict';
import test from 'node:test';
import { gitNetworkRemoteUrl, isTrustedGitLabRemote } from '../../src/git/gitRemotePolicy';

const remotes = [
  { name: 'origin', fetchUrl: 'https://gitlab.test/gitlab/team/repo.git', pushUrl: 'https://push.test/team/repo.git' },
  { name: 'upstream', fetchUrl: 'https://other.test/team/upstream.git' }
];

test('authentication follows the selected command remote and distinguishes fetch and push URLs', () => {
  assert.equal(gitNetworkRemoteUrl(['fetch', '--atomic', '--jobs=1', 'upstream'], remotes), remotes[1].fetchUrl);
  assert.equal(gitNetworkRemoteUrl(['push', '--force-with-lease=refs/heads/main:abc', '--set-upstream', 'origin', 'HEAD:refs/heads/main'], remotes), remotes[0].pushUrl);
  assert.equal(gitNetworkRemoteUrl(['ls-remote', '--heads', 'origin', 'refs/heads/main'], remotes), remotes[0].fetchUrl);
  assert.equal(gitNetworkRemoteUrl(['fetch', '--depth', '1', '--', 'origin'], remotes), remotes[0].fetchUrl);
  assert.equal(gitNetworkRemoteUrl(['log', 'origin'], remotes), undefined);
  assert.equal(gitNetworkRemoteUrl(['fetch', '--all'], remotes), undefined);
});

test('GitLab credentials are scoped to the installation path and reject other hosts, credentials, queries, and encoded separators', () => {
  const base = 'https://gitlab.test/gitlab';
  assert.equal(isTrustedGitLabRemote(base, remotes[0].fetchUrl), true);
  assert.equal(isTrustedGitLabRemote('https://gitlab.test', 'https://gitlab.test/team/repo.git'), true);
  assert.equal(isTrustedGitLabRemote('http://gitlab.test/gitlab', 'http://gitlab.test/gitlab/team/repo.git'), true, 'an explicitly configured HTTP installation remains compatible');
  for (const url of ['https://gitlab.test/sibling/repo.git', 'https://gitlab.test/gitlab-evil/repo.git', 'https://other.test/gitlab/team/repo.git',
    'https://gitlab.test/gitlab/../sibling/repo.git', 'https://gitlab.test/gitlab/%2e%2e/sibling/repo.git', 'https://gitlab.test/gitlab/team%2frepo.git',
    'https://gitlab.test/gitlab/%252e%252e%252fsibling/repo.git',
    'https://token@gitlab.test/gitlab/team/repo.git', 'https://gitlab.test/gitlab/team/repo.git?token=bad', 'https://gitlab.test/gitlab/team/repo.git#fragment',
    'http://gitlab.test/gitlab/team/repo.git']) assert.equal(isTrustedGitLabRemote(base, url), false, url);
});
