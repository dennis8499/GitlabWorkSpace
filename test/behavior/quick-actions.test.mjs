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
  for (let attempt = 0; attempt < 50 && requests.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    dom,
    requests,
    buttons: () => [...dom.window.document.querySelectorAll('.action-button')],
    sendState(state) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'state', state } }));
    }
  };
}

test('renders workspace navigation and keeps destinations available before connecting', async (t) => {
  const view = await mount();
  t.after(() => view.dom.window.close());

  assert.deepEqual(hostValues(view.requests), [{ type: 'ready' }]);
  assert.deepEqual(view.buttons().map((button) => button.textContent.trim()), ['開啟工作台', '我的工作', '專案']);
  assert.equal(view.buttons().every((button) => !button.disabled), true);
  assert.equal(view.buttons()[0].classList.contains('workspace-primary'), true);
  assert.equal(view.buttons().every((button) => button.type === 'button'), true);

  view.buttons()[1].click();
  assert.deepEqual(hostValues(view.requests.at(-1)), { type: 'perform', action: 'openMyWork' });
});

test('shows connection scope and dispatches each destination with accessible busy and error feedback', async (t) => {
  const view = await mount();
  t.after(() => view.dom.window.close());
  view.sendState({ connected: true, groupLabel: 'team/dotnet' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(view.dom.window.document.querySelector('.connection-status').textContent, 'GitLab 已連線 · team/dotnet');
  assert.equal(view.buttons()[0].classList.contains('workspace-primary'), true);
  assert.equal(view.buttons()[1].textContent.trim(), '我的工作');
  assert.equal(view.buttons()[2].textContent.trim(), '專案');

  for (const [index, action] of ['openWorkspace', 'openMyWork', 'openProjects'].entries()) {
    view.buttons()[index].click();
  }
  assert.deepEqual(hostValues(view.requests.slice(1)), ['openWorkspace', 'openMyWork', 'openProjects'].map((action) => ({ type: 'perform', action })));

  view.sendState({ connected: true, groupLabel: 'team/dotnet', busyAction: 'openProjects' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.buttons().every((button) => button.disabled), true);
  assert.equal(view.dom.window.document.querySelector('[aria-live="polite"]').textContent, '開啟中…');

  view.sendState({ connected: true, groupLabel: 'team/dotnet', errorMessage: '無法連線' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.dom.window.document.querySelector('[role="status"]').textContent, '無法連線');
  assert.equal(view.buttons().every((button) => !button.disabled), true);
});
