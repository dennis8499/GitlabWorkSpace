export interface VirtualWindow { start: number; end: number; }

/** Preserve the first visible stable item, including its pixel offset, as rows change. */
export function restoreScrollAnchor(
  previousKeys: readonly (string | number)[], previousOffsets: readonly number[],
  nextKeys: readonly (string | number)[], nextOffsets: readonly number[], scrollTop: number
): number {
  if (!nextKeys.length) return 0;
  if (!previousKeys.length || scrollTop <= 0) return Math.max(0, scrollTop);
  const index = Math.min(previousKeys.length - 1, lowerBound(previousOffsets, scrollTop));
  const nextIndices = new Map(nextKeys.map((key, offset) => [key, offset]));
  for (let distance = 0; distance < previousKeys.length; distance++) {
    for (const candidate of distance ? [index + distance, index - distance] : [index]) {
      if (candidate < 0 || candidate >= previousKeys.length) continue;
      const next = nextIndices.get(previousKeys[candidate]);
      if (next !== undefined) return Math.max(0, nextOffsets[next] + scrollTop - previousOffsets[candidate]);
    }
  }
  return 0;
}

/** Keep small lists fully mounted and window large, variable-height lists with row overscan. */
export function virtualWindow(
  itemCount: number,
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  threshold = 200,
  overscan = 10
): VirtualWindow {
  if (itemCount <= threshold) return { start: 0, end: itemCount };
  const firstVisible = lowerBound(offsets, Math.max(0, scrollTop));
  const lastVisible = lowerBound(offsets, Math.max(0, scrollTop + viewportHeight));
  return {
    start: Math.max(0, firstVisible - overscan),
    end: Math.min(itemCount, lastVisible + overscan + 1)
  };
}

function lowerBound(offsets: readonly number[], value: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((offsets[middle] ?? 0) < value) low = middle + 1;
    else high = middle;
  }
  return Math.min(Math.max(0, low - 1), Math.max(0, offsets.length - 1));
}
