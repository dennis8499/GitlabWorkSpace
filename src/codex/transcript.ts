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
    text: text(item.aggregatedOutput), exitCode: Number.isSafeInteger(item.exitCode) ? item.exitCode : undefined,
    durationMs: Number.isFinite(item.durationMs) && item.durationMs >= 0 ? item.durationMs : undefined };
  if (item.type === 'fileChange') return { ...base, kind: 'file', text: (item.changes ?? []).map((change: any) => text(change.path, 4096)).join('\n').slice(0, 64_000),
    files: (item.changes ?? []).slice(0, 100).map((change: any) => ({ path: text(change.path, 4096), kind: text(change.kind?.type ?? change.kind, 40), diff: text(change.diff, 32_000) })) };
  if (item.type === 'mcpToolCall') return { ...base, kind: 'tool', text: `${text(item.server, 200)} / ${text(item.tool, 200)}` };
  return undefined;
}

/** Merge ordered pages around shared anchors; history never overwrites a newer in-flight delta. */
export function mergeCodexTranscript(current: readonly CodexOutputItem[], incoming: readonly CodexOutputItem[], history = false): CodexOutputItem[] {
  // Index each identity once. Linked insertions preserve page ordering without
  // shifting the whole array or rescanning it for every streamed item.
  interface Entry { item?: CodexOutputItem; previous?: Entry; next?: Entry; }
  const head: Entry = {}, byKey = new Map<string, Entry>();
  let tail = head;
  for (const item of current) {
    const entry: Entry = { item, previous: tail }; tail.next = entry; tail = entry;
    if (!byKey.has(codexOutputKey(item))) byKey.set(codexOutputKey(item), entry);
  }
  const keys = incoming.map(codexOutputKey), anchors: Array<Entry | undefined> = new Array(incoming.length);
  let anchor: Entry | undefined;
  if (history) for (let index = incoming.length - 1; index >= 0; index--) {
    anchors[index] = anchor;
    anchor = byKey.get(keys[index]) ?? anchor;
  }
  let insertion = history ? head : tail;
  for (let index = 0; index < incoming.length; index++) {
    const item = incoming[index], existing = byKey.get(keys[index]);
    if (existing) {
      if ((!history || item.final) && Object.entries(item).some(([key, value]) => existing.item![key as keyof CodexOutputItem] !== value)) {
        existing.item = { ...existing.item!, ...item };
      }
      insertion = existing;
      continue;
    }
    const before = anchors[index], previous = before?.previous ?? insertion;
    const entry: Entry = { item: { ...item }, previous, next: before ?? previous.next };
    if (entry.next) entry.next.previous = entry;
    previous.next = entry; byKey.set(keys[index], entry); insertion = entry;
  }
  const result: CodexOutputItem[] = [];
  for (let entry = head.next; entry; entry = entry.next) result.push(entry.item!);
  return result;
}
