import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { build } from 'vite';

let bundle;
async function mount(text, withHandlers = true) {
  bundle ??= build({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), logLevel: 'silent',
    plugins: [{ name: 'codex-markdown-test-entry', resolveId: id => id.endsWith('virtual:codex-markdown-test') ? '\0codex-markdown-test' : undefined,
      load: id => id === '\0codex-markdown-test' ? `import { h, render } from 'preact';
        import { CodexMarkdown } from ${JSON.stringify(fileURLToPath(new URL('../../src/webview/CodexMarkdown.tsx', import.meta.url)))};
        export const mount = (target, text, withHandlers) => render(h(CodexMarkdown, { text, ...(withHandlers ? {
          onOpenLink: url => window.openedLinks.push(url), onCopy: text => window.copiedBlocks.push(text),
          onOpenFile: (path, line) => window.openedFiles.push({ path, line }) } : {}) }), target);` : undefined }],
    build: { write: false, minify: false, lib: { entry: 'virtual:codex-markdown-test', name: 'CodexMarkdownTest', formats: ['iife'] } } });
  const result = await bundle, script = (Array.isArray(result) ? result[0] : result).output.find(item => item.type === 'chunk' && item.isEntry).code;
  const dom = new JSDOM('<main></main>', { runScripts: 'dangerously', url: 'https://fixture.invalid' });
  dom.window.openedLinks = []; dom.window.copiedBlocks = []; dom.window.openedFiles = [];
  dom.window.eval(script); dom.window.CodexMarkdownTest.mount(dom.window.document.querySelector('main'), text, withHandlers);
  return dom;
}

test('Codex Markdown renders readable headings, tables, lists and literal fenced code', async t => {
  const dom = await mount('# Result\n\n**Verified** _change_.\n\n| File | Result |\n| --- | --- |\n| main.ts | pass |\n\n- one\n- two\n\n```html\n<script>alert(1)</script>\n```');
  t.after(() => dom.window.close()); const document = dom.window.document;
  assert.equal(document.querySelector('h1').textContent, 'Result');
  assert.equal(document.querySelector('strong').textContent, 'Verified');
  assert.equal(document.querySelectorAll('tbody td').length, 2); assert.equal(document.querySelectorAll('li').length, 2);
  assert.equal(document.querySelector('pre code').textContent, '<script>alert(1)</script>'); assert.equal(document.querySelector('script'), null);
});

test('Codex Markdown never executes HTML, navigates unsafe URLs or requests embedded images', async t => {
  const dom = await mount('<img src="https://evil.invalid/pixel" onerror="window.injected=1">\n<script>window.injected=1</script>\n\n' +
    '[bad](javascript:alert%281%29) [command](command:workbench.action.closeWindow) [file](file:///secret) [data](data:text/html,hello)\n\n' +
    '![remote image](https://evil.invalid/image.png) [good](https://example.com/docs)');
  t.after(() => dom.window.close()); const document = dom.window.document;
  assert.equal(dom.window.injected, undefined); assert.equal(document.querySelector('img, script, iframe'), null);
  assert.equal(document.querySelectorAll('a').length, 2);
  assert.ok([...document.querySelectorAll('a')].every(link => link.href.startsWith('https://')));
  const good = [...document.querySelectorAll('a')].find(link => link.textContent === 'good'); good.click();
  assert.deepEqual(dom.window.openedLinks, ['https://example.com/docs']);
  assert.match(document.body.textContent, /<script>/);
});

test('Codex Markdown copies the exact displayed code and routes local file lines through callbacks', async t => {
  const code = 'const text = "<script>literal</script>";\n  keepIndentation();';
  const dom = await mount('```ts\n' + code + '\n```\n\n[relative](src/main.ts:12) [absolute](/workspace/src/main.ts#L34C2) ' +
    '[Windows](C:/workspace/src/main.ts:56:4) [space](src/a%20b.ts#L9) [plain](README.md)');
  t.after(() => dom.window.close()); const document = dom.window.document;
  document.querySelector('.codex-markdown-code button').click(); assert.deepEqual(dom.window.copiedBlocks, [code]);
  assert.equal(document.querySelector('pre code').textContent, code);
  for (const button of document.querySelectorAll('.codex-markdown-file')) { assert.equal(button.type, 'button'); button.click(); }
  assert.deepEqual(JSON.parse(JSON.stringify(dom.window.openedFiles)), [
    { path: 'src/main.ts', line: 12 }, { path: '/workspace/src/main.ts', line: 34 },
    { path: 'C:/workspace/src/main.ts', line: 56 }, { path: 'src/a b.ts', line: 9 }, { path: 'README.md' }
  ]);
  assert.equal(document.querySelectorAll('a').length, 0, 'local paths never become browser navigation links');
});

test('Codex Markdown rejects encoded schemes, traversal, network paths and invalid file line references', async t => {
  const targets = ['command:workbench.action.closeWindow', 'vscode://file/C:/secret', 'file:///secret', 'data:text/plain,hello',
    'javascript%3Aalert%281%29', '//server/share/file.ts', '%5C%5Cserver%5Cshare%5Cfile.ts', '../secret.ts', 'src/%2e%2e/secret.ts',
    'src/main.ts?run=true', 'src/main.ts#other', 'src/main.ts:0', 'src/main.ts:-1', 'src/main.ts#L10000001', 'src/main.ts%00', 'src/main.ts%0a'];
  const dom = await mount(targets.map((target, index) => `[unsafe ${index}](${target})`).join('\n\n') + '\n\n![local image](src/private.png)');
  t.after(() => dom.window.close());
  assert.equal(dom.window.document.querySelector('a, button, img'), null);
  assert.deepEqual(dom.window.openedFiles, []); assert.deepEqual(dom.window.openedLinks, []);
});

test('Codex Markdown keeps code and local references readable without action callbacks', async t => {
  const dom = await mount('```text\nKeep the text\n```\n\n[file](src/main.ts:5)', false); t.after(() => dom.window.close());
  assert.equal(dom.window.document.querySelector('pre code').textContent, 'Keep the text');
  assert.match(dom.window.document.body.textContent, /file/); assert.equal(dom.window.document.querySelector('button, a'), null);
});
