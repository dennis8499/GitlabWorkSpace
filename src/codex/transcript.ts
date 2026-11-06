import { codexOutputKey, type CodexOutputItem } from './protocol';

const text = (value: unknown, limit = 64_000): string => typeof value === 'string' ? value.slice(0, limit) : '';

/** Both persisted history and live items use the server's thread/turn/item identity. */
export function projectCodexItem(threadId: string | undefined, turnId: string | undefined,
  item: Record<string, any>, final = false): CodexOutputItem | undefined {
  if (typeof item.id !== 'string' || !item.id) return undefined;
  const base = { id: item.id, threadId, turnId, final, status: text(item.status, 100) || undefined };
  if (item.type === 'agentMessage' || item.type === 'plan') return { ...base, kind: item.type === 'plan' ? 'tool' : 'agent', text: text(item.text) };
  if (item.type === 'userMessage') return { ...base, kind: 'user', text: (item.content ?? [])
    .filter((part: any) => part.type === 'text').map((part: any) => text(part.text)).join('\n').slice(0, 64_000) };
  if (item.type === 'commandExecution') return { ...base, kind: 'command', command: text(item.command, 20_000),
    text: text(item.aggregatedOutput), exitCode: Number.isSafeInteger(item.exitCode) ? item.exitCode : undefined };
  if (item.type === 'fileChange') return { ...base, kind: 'file', text: (item.changes ?? []).map((change: any) => text(change.path, 4096)).join('\n').slice(0, 64_000) };
  if (item.type === 'mcpToolCall') return { ...base, kind: 'tool', text: `${text(item.server, 200)} / ${text(item.tool, 200)}` };
  return undefined;
}

/** Merge ordered pages around shared anchors; history never overwrites a newer in-flight delta. */
export function mergeCodexTranscript(current: readonly CodexOutputItem[], incoming: readonly CodexOutputItem[], history = false): CodexOutputItem[] {
  const result = current.map(item => ({ ...item }));
  let insertion = history ? 0 : result.length;
  for (let index = 0; index < incoming.length; index++) {
    const item = incoming[index], key = codexOutputKey(item);
    const existing = result.findIndex(value => codexOutputKey(value) === key);
    if (existing >= 0) {
      if (!history || item.final) result[existing] = { ...result[existing], ...item };
      insertion = existing + 1;
    } else {
      // Find the next common item to place new historical entries immediately before it.
      let anchor = -1;
      if (history) for (let next = index + 1; next < incoming.length; next++) {
        anchor = result.findIndex(value => codexOutputKey(value) === codexOutputKey(incoming[next]));
        if (anchor >= 0) break;
      }
      const position = anchor >= 0 ? anchor : insertion;
      result.splice(position, 0, { ...item }); insertion = position + 1;
    }
  }
  return result;
}
