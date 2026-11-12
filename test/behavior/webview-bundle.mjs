import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

async function classicBundle(entry, sources) {
  const { rolldown } = await import('rolldown');
  const bundle = await rolldown({ input: entry, logLevel: 'silent', plugins: [{ name: 'jsdom-generated-modules',
    resolveId(id, importer) {
      if (!sources) return;
      const resolved = importer ? path.resolve(path.dirname(importer), id) : path.resolve(id);
      return sources.has(resolved) ? resolved : undefined;
    },
    async load(id) {
      if (sources && !sources.has(id)) return;
      const code = sources?.get(id) ?? await readFile(id, 'utf8');
      return code.replaceAll('import.meta.url', 'document.baseURI');
    }
  }] });
  try {
    const result = await bundle.generate({ format: 'iife', codeSplitting: false });
    return result.output.find(item => item.type === 'chunk' && item.isEntry).code;
  } finally { await bundle.close(); }
}

/** Source mode isolates UI regression runs from generated extension assets. */
export async function webviewBundle(kind) {
  const directory = kind === 'sidebar' ? 'sidebar-webview' : 'issue-webview';
  const html = await readFile(new URL(`../../resources/${directory}/${kind}.html`, import.meta.url), 'utf8');
  if (process.env.GITLAB_WORKSPACE_UI_SOURCE !== '1') {
    const entry = fileURLToPath(new URL(`../../resources/${directory}/${kind}.js`, import.meta.url));
    return { html, script: await classicBundle(entry) };
  }
  const { build } = await import('vite');
  const result = await build({ configFile: process.env.GITLAB_WORKSPACE_UI_CONFIG ?? fileURLToPath(new URL(`../../vite.${kind}.config.mjs`, import.meta.url)),
    logLevel: 'silent', build: { write: false, emptyOutDir: false } });
  // Rebundle emitted bytes in memory for JSDOM. Real chunk loading and CSP are
  // verified separately in the Chromium renderer probes and Extension Host.
  const base = fileURLToPath(new URL(`../../resources/${directory}/`, import.meta.url));
  const sources = new Map(result.output.filter(item => item.type === 'chunk').map(item => [path.resolve(base, item.fileName), item.code]));
  const entry = result.output.find(item => item.type === 'chunk' && item.isEntry);
  return { html, script: await classicBundle(path.resolve(base, entry.fileName), sources) };
}
