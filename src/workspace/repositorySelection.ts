export function reconcileProjectSelection(selectedIds: readonly number[], availableIds: readonly number[]): number[] {
  const available = new Set(availableIds);
  return [...new Set(selectedIds.filter((id) => Number.isSafeInteger(id) && available.has(id)))];
}

export function toggleProjectSelection(
  selectedIds: readonly number[],
  projectIds: readonly number[],
  checked: boolean
): number[] {
  const selected = new Set(selectedIds.filter((id) => Number.isSafeInteger(id)));
  for (const projectId of projectIds) {
    if (!Number.isSafeInteger(projectId)) continue;
    if (checked) selected.add(projectId);
    else selected.delete(projectId);
  }
  return [...selected];
}

export function countHiddenProjectSelection(selectedIds: readonly number[], visibleIds: readonly number[]): number {
  const visible = new Set(visibleIds);
  return selectedIds.filter((id) => !visible.has(id)).length;
}
