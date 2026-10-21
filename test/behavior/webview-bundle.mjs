import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Source mode isolates UI regression runs from generated extension assets. */
export async function webviewBundle(kind) {
  const directory = kind === 'sidebar' ? 'sidebar-webview' : 'issue-webview';
  const html = await readFile(new URL(`../../resources/${directory}/${kind}.html`, import.meta.url), 'utf8');
  if (process.env.GITLAB_WORKSPACE_UI_SOURCE !== '1') {
    const script = await readFile(new URL(`../../resources/${directory}/${kind}.js`, import.meta.url), 'utf8');
    return { html, script: script.replaceAll('import.meta.url', 'document.baseURI') };
  }
  const { build } = await import('vite');
  const result = await build({ configFile: process.env.GITLAB_WORKSPACE_UI_CONFIG ?? fileURLToPath(new URL(`../../vite.${kind}.config.mjs`, import.meta.url)),
    logLevel: 'silent', build: { write: false, emptyOutDir: false } });
  // JSDOM evaluates classic scripts and has no Worker; real module/Worker behavior
  // is exercised by graph-renderer-benchmark.mjs in an isolated Chrome session.
  return { html, script: result.output.find(item => item.type === 'chunk' && item.isEntry).code.replaceAll('import.meta.url', 'document.baseURI') };
}
