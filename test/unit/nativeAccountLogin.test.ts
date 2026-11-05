import assert from 'node:assert/strict';
import test from 'node:test';
import type { InputBoxOptions } from 'vscode';
import { promptNativeAccountLogin } from '../../src/connection/nativeAccountLogin';

test('native login normalizes the site, masks credentials and validates before accepting input', async () => {
  const options: InputBoxOptions[] = [], answers = ['https://gitlab.test/team/', '  host-only-secret  '];
  const result = await promptNativeAccountLogin([], undefined, async input => { options.push(input); return answers.shift(); });
  assert.deepEqual(result, { baseUrl: 'https://gitlab.test/team', token: 'host-only-secret', accountId: undefined });
  assert.equal(options[1].password, true); assert.equal(options[1].ignoreFocusOut, true);
  assert.ok(await options[0].validateInput!('https://user:password@gitlab.test'));
  assert.ok(await options[0].validateInput!('ftp://gitlab.test'));
  assert.ok(await options[0].validateInput!('x'.repeat(2049)));
  assert.ok(await options[1].validateInput!(''));
  assert.ok(await options[1].validateInput!('token\nsecond'));
  assert.ok(await options[1].validateInput!('x'.repeat(8193)));
  assert.doesNotMatch(JSON.stringify(options), /host-only-secret/);
});

test('cancelling either native input returns no credentials; invalid answers do not advance', async () => {
  for (const answers of [[undefined], ['https://gitlab.test', undefined]]) {
    let calls = 0;
    assert.equal(await promptNativeAccountLogin([], undefined, async () => { calls++; return answers.shift(); }), undefined);
    assert.ok(calls <= 2);
  }
  let calls = 0;
  await assert.rejects(promptNativeAccountLogin([], undefined, async () => { calls++; return 'https://user:password@gitlab.test'; }));
  assert.equal(calls, 1);
  await assert.rejects(promptNativeAccountLogin([], 'removed', async () => { assert.fail('removed identity cannot prompt'); }));
});

test('relogin binds the saved identity to its original site', async () => {
  const account = { id: 'saved', baseUrl: 'https://gitlab.test', userId: 1, username: 'saved', name: 'Saved', needsLogin: true };
  await assert.rejects(promptNativeAccountLogin([account], 'saved', async input => {
    assert.equal(input.value, account.baseUrl);
    assert.ok(await input.validateInput!('https://other.test'));
    return 'https://other.test';
  }), /原有/);
});
