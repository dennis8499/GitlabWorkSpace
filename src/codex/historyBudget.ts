import { codexOutputKey, type CodexOutputItem } from './protocol';

export const codexHistoryBudget = 32 * 1024 * 1024;
/** Conservative UTF-16 payload estimate, independent of Buffer so the same budget works in the webview. */
export function codexItemBytes(item: CodexOutputItem): number {
  return 256 + 2 * (item.text.length + (item.command?.length ?? 0) + (item.id?.length ?? 0) +
    (item.files ?? []).reduce((sum, file) => sum + file.path.length + (file.diff?.length ?? 0), 0));
}
export function transcriptWindow(items: readonly CodexOutputItem[], budget = codexHistoryBudget, anchor?: string): CodexOutputItem[] {
  if (items.reduce((sum, item) => sum + codexItemBytes(item), 0) <= budget) return items as CodexOutputItem[];
  const index = anchor ? items.findIndex(item => codexOutputKey(item) === anchor) : items.length - 1;
  let start = Math.max(0, index), end = start + 1, bytes = items[start] ? codexItemBytes(items[start]) : 0;
  while (start > 0 || end < items.length) {
    let added = false;
    if (start > 0 && bytes + codexItemBytes(items[start - 1]) <= budget) { bytes += codexItemBytes(items[--start]); added = true; }
    if (end < items.length && bytes + codexItemBytes(items[end]) <= budget) { bytes += codexItemBytes(items[end++]); added = true; }
    if (!added) break;
  }
  return items.slice(start, end);
}
export function boundTranscriptCache(cache: Record<string, CodexOutputItem[]>, selected?: string, budget = codexHistoryBudget, anchor?: string): {
  cache: Record<string, CodexOutputItem[]>; evicted: string[]; trimmed: boolean;
} {
  const result = { ...cache }, evicted: string[] = [];
  const size = (items: CodexOutputItem[]) => items.reduce((sum, item) => sum + codexItemBytes(item), 0);
  let bytes = Object.values(result).reduce((sum, items) => sum + size(items), 0);
  for (const id of Object.keys(result)) if (bytes > budget && id !== selected) { bytes -= size(result[id]); delete result[id]; evicted.push(id); }
  let trimmed = false;
  if (selected && result[selected] && bytes > budget) {
    result[selected] = transcriptWindow(result[selected], budget, anchor); trimmed = true;
  }
  return { cache: result, evicted, trimmed };
}
