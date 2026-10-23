import assert from 'node:assert/strict';
import test from 'node:test';
import { liveEnvironments } from './live-environments.mjs';

test('live profiles retain existing CE16.11.10 and CE19 defaults', () => {
  assert.deepEqual(liveEnvironments({}), {
    ce16: { url: 'http://127.0.0.1:8930', tokenName: 'GLW_CE16_TOKEN', version: '16.11.10' },
    ce19: { url: 'http://127.0.0.1:8929', tokenName: 'GLW_CE19_TOKEN', version: '19.4.1' }
  });
});

test('CE16.11.10 target and subpath overrides are independent and preserve CE19', () => {
  const profiles = liveEnvironments({ GLW_CE16_URL: 'https://gitlab.example.test/gitlab/', GLW_CE16_EXPECTED_VERSION: '16.11.10' });
  assert.equal(profiles.ce16.url, 'https://gitlab.example.test/gitlab');
  assert.equal(profiles.ce16.version, '16.11.10');
  assert.deepEqual(profiles.ce19, liveEnvironments({}).ce19);
  const exactOverride = liveEnvironments({ GLW_CE16_EXPECTED_VERSION: '16.11.9' });
  assert.equal(exactOverride.ce16.url, 'http://127.0.0.1:8930');
  assert.equal(exactOverride.ce16.version, '16.11.9');
});

test('live target configuration rejects credentials, transports and nonexact versions before any network use', () => {
  for (const url of ['file:///tmp/gitlab', 'ftp://gitlab.example.test', 'https://user:secret@gitlab.example.test', 'https://gitlab.example.test?token=secret', 'https://gitlab.example.test/#fragment', 'not a URL']) {
    assert.throws(() => liveEnvironments({ GLW_CE16_URL: url }), /GLW_CE16_URL/);
  }
  for (const version of ['', '16.11', 'v16.11.0', '16.11.0-ee', '16.11.0\n', '16.11.0\0']) {
    assert.throws(() => liveEnvironments({ GLW_CE16_EXPECTED_VERSION: version }), /GLW_CE16_EXPECTED_VERSION/);
  }
});
