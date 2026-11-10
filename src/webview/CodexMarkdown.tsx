/** @jsxImportSource preact */
import { createElement, type ComponentChildren } from 'preact';
import { useMemo } from 'preact/hooks';
import DOMPurify from 'dompurify';
import { Lexer, type Token, type Tokens } from 'marked';
import './codex-markdown.css';

/** The renderer never inserts model-provided HTML or automatically loads images. */
export function safeCodexLink(value: string): string | undefined {
  if ([...value].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) || !/^https?:\/\//i.test(value)) return;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !DOMPurify.isValidAttribute('a', 'href', url.href)) return;
    return url.href;
  } catch { return; }
}

/** This only recognizes file references. The Host still verifies repository containment before opening. */
export function safeCodexFileLink(value: string): { path: string; line?: number } | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(value).replace(/\\/g, '/'); } catch { return; }
  if (!decoded || decoded.length > 4096 || decoded !== decoded.trim() || decoded.includes('?') || decoded.startsWith('//') ||
    [...decoded].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return;
  let file = decoded, line: number | undefined;
  const anchor = /#L([1-9]\d*)(?:C[1-9]\d*)?$/.exec(file);
  const suffix = !file.includes('#') && /:([1-9]\d*)(?::[1-9]\d*)?$/.exec(file);
  const location = anchor || suffix;
  if (location) { line = Number(location[1]); file = file.slice(0, location.index); }
  if (line !== undefined && (!Number.isSafeInteger(line) || line > 10_000_000)) return;
  const withoutDrive = file.replace(/^[a-z]:\//i, '/');
  if (!file || file.endsWith('/') || /[:#]/.test(withoutDrive) || withoutDrive.split('/').some(part => part === '..') || file === '.') return;
  return { path: file, ...(line === undefined ? {} : { line }) };
}

export function CodexMarkdown({ text, onOpenLink, onOpenFile, onCopy }: {
  text: string; onOpenLink?: (url: string) => void; onOpenFile?: (path: string, line?: number) => void; onCopy?: (text: string) => void;
}) {
  const tokens = useMemo(() => {
    try { return Lexer.lex(text, { gfm: true }); }
    catch { return [{ type: 'text', raw: text, text }]; }
  }, [text]);
  const render = (items: Token[], depth = 0): ComponentChildren => {
    if (depth > 32) return items.map(item => item.raw).join('');
    return items.map((token, index): ComponentChildren => {
      const children = () => render(('tokens' in token ? token.tokens : []) ?? [], depth + 1);
      switch (token.type) {
        case 'space': case 'def': return null;
        case 'heading': return createElement(`h${Math.min(6, Math.max(1, (token as Tokens.Heading).depth))}`, { key: index }, children());
        case 'paragraph': return <p key={index}>{children()}</p>;
        case 'text': return token.tokens ? children() : token.text;
        case 'strong': return <strong key={index}>{children()}</strong>;
        case 'em': return <em key={index}>{children()}</em>;
        case 'del': return <del key={index}>{children()}</del>;
        case 'br': return <br key={index} />;
        case 'hr': return <hr key={index} />;
        case 'escape': return token.text;
        case 'codespan': return <code key={index}>{token.text}</code>;
        case 'code': return <div class="codex-markdown-code" key={index}>
          {(token.lang || onCopy) && <div class="codex-markdown-code-heading"><span class="subtle">{token.lang && String(token.lang).split(/\s/)[0]}</span>
            {onCopy && <button type="button" class="quiet small" onClick={() => onCopy(token.text)}>複製程式碼</button>}</div>}
          <pre tabIndex={0}><code>{token.text}</code></pre></div>;
        case 'blockquote': return <blockquote key={index}>{children()}</blockquote>;
        case 'html': return <span key={index} class="codex-markdown-literal">{token.raw}</span>;
        case 'link': case 'image': {
          const href = safeCodexLink(token.href), label = token.type === 'image' ? `圖片：${token.text || token.href}` : children();
          const file = !href && token.type === 'link' && onOpenFile ? safeCodexFileLink(token.href) : undefined;
          return href ? <a key={index} href={href} target="_blank" rel="noreferrer noopener" onClick={event => {
            if (onOpenLink) { event.preventDefault(); onOpenLink(href); }
          }}>{label}</a> : file ? <button key={index} type="button" class="codex-markdown-file" onClick={() => onOpenFile!(file.path, file.line)}>{label}</button> : <span key={index}>{label}</span>;
        }
        case 'list': {
          const list = token as Tokens.List, rows = list.items.map((item, row) => <li key={row}>
            {item.task && <span aria-label={item.checked ? '已完成' : '未完成'}>{item.checked ? '☑ ' : '☐ '}</span>}{render(item.tokens, depth + 1)}</li>);
          return list.ordered ? <ol key={index} start={Number(list.start) || 1}>{rows}</ol> : <ul key={index}>{rows}</ul>;
        }
        case 'table': {
          const table = token as Tokens.Table;
          return <div class="codex-markdown-table" key={index} tabIndex={0} role="region" aria-label="Markdown 表格"><table><thead><tr>{table.header.map((cell, column) =>
            <th key={column} scope="col" style={{ textAlign: table.align[column] ?? undefined }}>{render(cell.tokens, depth + 1)}</th>)}</tr></thead>
            <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column} style={{ textAlign: table.align[column] ?? undefined }}>{render(cell.tokens, depth + 1)}</td>)}</tr>)}</tbody></table></div>;
        }
        default: return token.raw;
      }
    });
  };
  return <div class="codex-markdown">{render(tokens)}</div>;
}
