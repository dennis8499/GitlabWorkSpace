import type { CodexTaskState } from '../codex/protocol';

const ordered = (tasks: readonly CodexTaskState[]) => [...tasks].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.createdAt.localeCompare(a.createdAt));

/** Keep the reader beside the removed row in the same order as the task rail. */
export function adjacentCodexTask(previous: readonly CodexTaskState[], current: readonly CodexTaskState[], selected?: string): string | undefined {
  const available = new Set(current.map(task => task.id));
  if (selected && available.has(selected)) return selected;
  const before = ordered(previous), index = before.findIndex(task => task.id === selected);
  if (index >= 0) {
    for (let next = index + 1; next < before.length; next++) if (available.has(before[next].id)) return before[next].id;
    for (let next = index - 1; next >= 0; next--) if (available.has(before[next].id)) return before[next].id;
  }
  const after = ordered(current);
  return (after.find(task => !task.archived) ?? after[0])?.id;
}
