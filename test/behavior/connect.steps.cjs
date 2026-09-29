const assert = require('node:assert/strict');
const { Given, When, Then, setWorldConstructor } = require('@cucumber/cucumber');
const { GitLabSession } = require('../../out/src/connection/session.js');

const TOKEN = 'behavior-test-token-do-not-use';

class MemoryState {
  constructor() { this.values = new Map(); }
  get(key, defaultValue) { return this.values.get(key) ?? defaultValue; }
  async update(key, value) {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }
  keys() { return [...this.values.keys()]; }
  setKeysForSync() {}
}

class MemorySecrets {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async store(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
  onDidChange() { return { dispose() {} }; }
}

class ConnectWorld {
  constructor() {
    this.calls = [];
    this.baseUrl = undefined;
    this.userStatus = 200;
    this.state = new MemoryState();
    this.secrets = new MemorySecrets();
    this.session = new GitLabSession(this.secrets, this.state);
  }
}

setWorldConstructor(ConnectWorld);

Given('a GitLab server at {string}', function (url) {
  this.baseUrl = url;
});

Given('an invalid GitLab URL {string}', function (url) {
  this.baseUrl = url;
});

Given('the GitLab server rejects the token', function () {
  this.userStatus = 401;
});

When('I connect with a token', async function () {
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    this.calls.push({ url: url.href, origin: url.origin, token: headers.get('PRIVATE-TOKEN'), redirect: init?.redirect });
    if (url.pathname.endsWith('/api/v4/user')) {
      return new Response(JSON.stringify({ id: 9, username: 'tester', name: 'Test User' }), {
        status: this.userStatus,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (url.pathname.endsWith('/api/v4/metadata')) {
      return new Response(JSON.stringify({ version: '18.4.0' }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname.endsWith('/api/graphql')) {
      return new Response(JSON.stringify({ data: { __schema: { types: [] } } }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    await this.session.connect(this.baseUrl, TOKEN);
  } catch (error) {
    this.error = error;
  } finally {
    global.fetch = originalFetch;
  }
});

Then('the connection stores the normalized URL {string}', function (url) {
  assert.equal(this.error, undefined);
  assert.equal(this.session.baseUrl, url);
  assert.equal(this.state.get('gitlabWorkspace.baseUrl'), url);
});

Then('GitLab receives the token at {string}', function (expectedUrl) {
  assert.equal(this.calls[0]?.url, expectedUrl);
  assert.equal(this.calls[0]?.token, TOKEN);
});

Then('every API request stays on the configured origin', function () {
  const origin = new URL(this.session.baseUrl).origin;
  assert.ok(this.calls.length >= 3);
  assert.ok(this.calls.every((call) => call.origin === origin));
  assert.ok(this.calls.every((call) => call.token === TOKEN && call.redirect === 'manual'));
});

Then('the connection rejects the URL without making a request', function () {
  assert.match(this.error?.message ?? '', /HTTP or HTTPS|cannot contain credentials, a query, or a fragment/);
  assert.equal(this.calls.length, 0);
  assert.equal(this.secrets.values.size, 0);
  assert.equal(this.state.keys().length, 0);
});

Then('the token is rejected and not stored', function () {
  assert.match(this.error?.message ?? '', /rejected/);
  assert.equal(this.secrets.values.size, 0);
  assert.equal(this.state.keys().length, 0);
});
