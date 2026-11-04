import { randomBytes } from 'node:crypto';
import type { Uri, Webview } from 'vscode';

export type WebviewSurface = 'dashboard' | 'sidebar';

export function createWebviewCsp(source: string, nonce: string, surface: WebviewSurface): string {
  return ["default-src 'none'", `style-src ${source}`, "style-src-attr 'none'",
    `script-src 'nonce-${nonce}' ${source}`, `font-src ${source}`,
    ...(surface === 'dashboard' ? [`img-src ${source} data: https:`, `worker-src ${source} blob:`] : [])].join('; ') + ';';
}

const attribute = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

/** The production loader and native browser probes share the exact same policy. */
export function prepareWebviewHtml(html: string, webview: Pick<Webview, 'asWebviewUri' | 'cspSource'>,
  assetRoot: Uri, surface: WebviewSurface, nonce = randomBytes(16).toString('base64')): string {
  const base = webview.asWebviewUri(assetRoot).toString().replace(/\/$/, '') + '/';
  const csp = createWebviewCsp(webview.cspSource, nonce, surface);
  return html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${attribute(csp)}"><base href="${attribute(base)}">`)
    .replace(/<script\b([^>]*)>/g, (_match, attributes: string) => `<script nonce="${attribute(nonce)}"${attributes}>`);
}
