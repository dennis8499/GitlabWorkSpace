import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../../resources/sidebar-webview/sidebar.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../../resources/sidebar-webview/sidebar.js', import.meta.url), 'utf8');
const hostValues = (value) => JSON.parse(JSON.stringify(value));

async function mount() {
  const dom = new JSDOM(html, { url: 'https://sidebar.example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const requests = [];
  dom.window.acquireVsCodeApi = () => ({ postMessage: (message) => requests.push(message) });
  dom.window.eval(script);
  await new Promise((resolve) => setTimeout(resolve, 25));
  return {
    dom,
    requests,
    buttons: () => [...dom.window.document.querySelectorAll('.action-button')],
    sendState(state) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'state', state } }));
    }
  };
}

test('renders accessible quick actions and enables connection as the primary disconnected action', async (t) => {
  const view = await mount();
  t.after(() => view.dom.window.close());

  assert.deepEqual(hostValues(view.requests), [{ type: 'ready' }]);
  assert.deepEqual(view.buttons().map((button) => button.textContent.trim()), ['開啟工作台', '切換 Group', '重新整理', '連線 GitLab']);
  assert.equal(view.buttons()[0].disabled, false);
  assert.equal(view.buttons()[1].disabled, true);
  assert.equal(view.buttons()[2].disabled, true);
  assert.equal(view.buttons()[3].classList.contains('action-primary'), true);
  assert.equal(view.buttons().every((button) => button.type === 'button'), true);

  view.buttons()[3].click();
  assert.deepEqual(hostValues(view.requests.at(-1)), { type: 'perform', action: 'connect' });
});

test('updates group and busy state, dispatches existing actions, and exposes errors accessibly', async (t) => {
  const view = await mount();
  t.after(() => view.dom.window.close());
  view.sendState({ connected: true, groupLabel: 'team/dotnet' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(view.dom.window.document.querySelector('.connection-status').textContent, '目前 Group：team/dotnet');
  assert.equal(view.buttons()[0].classList.contains('action-primary'), true);
  assert.equal(view.buttons()[1].textContent.trim(), '切換 Group');
  assert.equal(view.buttons()[3].textContent.trim(), '重新連線');

  for (const [index, action] of ['openWorkspace', 'selectGroup', 'refresh', 'connect'].entries()) {
    view.buttons()[index].click();
  }
  assert.deepEqual(hostValues(view.requests.slice(1)), ['openWorkspace', 'selectGroup', 'refresh', 'connect'].map((action) => ({ type: 'perform', action })));

  view.sendState({ connected: true, groupLabel: 'team/dotnet', busyAction: 'refresh' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.buttons().every((button) => button.disabled), true);
  assert.equal(view.dom.window.document.querySelector('[aria-live="polite"]').textContent, '更新中…');

  view.sendState({ connected: true, groupLabel: 'team/dotnet', errorMessage: '無法連線' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.dom.window.document.querySelector('[role="status"]').textContent, '無法連線');
  assert.equal(view.buttons().every((button) => !button.disabled), true);
});
