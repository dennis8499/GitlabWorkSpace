/** @jsxImportSource preact */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { restoreScrollAnchor, virtualWindow } from './virtualWindow';

interface VirtualRowsProps<T> {
  items: readonly T[];
  itemKey: (item: T) => string | number;
  estimateHeight: number;
  className: string;
  renderItem: (item: T, index: number) => ComponentChildren;
  /** Change only for an explicit scope, search or navigation change. */
  resetKey?: string | number;
  active?: boolean;
}

/** Variable-height list windowing with ten-row overscan and full-data keyboard navigation. */
export function VirtualRows<T>({ items, itemKey, estimateHeight, className, renderItem, resetKey, active = true }: VirtualRowsProps<T>) {
  const windowed = items.length > 200;
  const container = useRef<HTMLDivElement>(null);
  const observer = useRef<ResizeObserver>();
  const elements = useRef(new Map<string | number, HTMLElement>());
  const measured = useRef(new Map<string | number, number>());
  const rowRefs = useRef(new Map<string | number, (element: HTMLDivElement | null) => void>());
  const activeRef = useRef(active && windowed); activeRef.current = active && windowed;
  const focusRequest = useRef<number>();
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const [measureRevision, setMeasureRevision] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [focusRevision, setFocusRevision] = useState(0);

  const keys = useMemo(() => items.map(itemKey), [items, itemKey]);
  const previousLayout = useRef<{ keys: (string | number)[]; geometry: number[]; resetKey?: string | number; windowed: boolean }>({ keys: [], geometry: [], resetKey, windowed });
  function naturalGeometry(rowKeys: readonly (string | number)[]): number[] {
    const offsets = [0];
    for (const key of rowKeys) {
      const height = elements.current.get(key)?.getBoundingClientRect().height || estimateHeight;
      measured.current.set(key, height);
      offsets.push(offsets[offsets.length - 1] + height);
    }
    return offsets;
  }
  // Measure natural rows only when crossing the windowing threshold. Normal
  // small-list input needs neither offsets nor ResizeObserver notifications.
  if (windowed && !previousLayout.current.windowed) previousLayout.current.geometry = naturalGeometry(previousLayout.current.keys);
  const geometry = useMemo(() => {
    if (!windowed) return [];
    const offsets = new Array<number>(items.length + 1);
    offsets[0] = 0;
    for (let index = 0; index < items.length; index++) offsets[index + 1] = offsets[index] + (measured.current.get(keys[index]) ?? estimateHeight);
    return offsets;
  }, [keys, estimateHeight, measureRevision, windowed]);
  useLayoutEffect(() => {
    const previous = previousLayout.current;
    const element = container.current;
    const reset = previous.resetKey !== resetKey;
    const nextGeometry = !windowed && previous.windowed ? naturalGeometry(keys) : geometry;
    const canAnchor = previous.geometry.length === previous.keys.length + 1 && nextGeometry.length === keys.length + 1;
    const nextTop = reset ? 0 : canAnchor ? restoreScrollAnchor(previous.keys, previous.geometry, keys, nextGeometry, element?.scrollTop ?? scrollTop) : element?.scrollTop ?? scrollTop;
    previousLayout.current = { keys, geometry, resetKey, windowed };
    if (!windowed) measured.current.clear();
    else if (reset) { measured.current.clear(); setMeasureRevision(revision => revision + 1); }
    if (element && Math.abs(element.scrollTop - nextTop) > 0.5) element.scrollTop = nextTop;
    setScrollTop(nextTop);
    const retained = new Set(keys);
    for (const key of measured.current.keys()) if (!retained.has(key)) measured.current.delete(key);
    for (const key of rowRefs.current.keys()) if (!retained.has(key)) rowRefs.current.delete(key);
  }, [keys, geometry, resetKey, windowed]);

  useEffect(() => {
    const element = container.current;
    if (!element || !active || !windowed) return;
    let width = element.clientWidth;
    const updateViewport = (): void => setViewportHeight(element.clientHeight || 400);
    updateViewport();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateViewport);
      return () => window.removeEventListener('resize', updateViewport);
    }
    const resize = new ResizeObserver(() => {
      updateViewport();
      if (element.clientWidth !== width) {
        width = element.clientWidth;
        measured.current.clear();
        setMeasureRevision((revision) => revision + 1);
      }
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, [active, windowed]);

  useEffect(() => () => observer.current?.disconnect(), []);
  useEffect(() => {
    if (!active || !windowed) { observer.current?.disconnect(); return; }
    for (const [key, element] of elements.current) setRowRef(key, element);
  }, [active, windowed]);

  useEffect(() => {
    if (focusRequest.current === undefined) return;
    const requested = focusRequest.current;
    focusRequest.current = undefined;
    const row = container.current?.querySelector<HTMLElement>(`[data-virtual-index="${requested}"]`);
    const focusable = row?.matches('button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')
      ? row : row?.querySelector<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])');
    if (focusable) focusable.focus();
    else if (row) { row.tabIndex = -1; row.focus(); }
  }, [focusedIndex, scrollTop, focusRevision]);

  const { start: startAt, end: endAt } = windowed ? virtualWindow(items.length, geometry, scrollTop, viewportHeight) : { start: 0, end: items.length };
  const visible = windowed ? items.slice(startAt, endAt).map((item, offset) => ({ item, index: startAt + offset })) : items.map((item, index) => ({ item, index }));

  function setRowRef(key: string | number, element: HTMLElement | null): void {
    const prior = elements.current.get(key);
    if (prior) observer.current?.unobserve(prior);
    if (!element) { elements.current.delete(key); return; }
    elements.current.set(key, element);
    if (!activeRef.current || typeof ResizeObserver === 'undefined') return;
    if (!observer.current) observer.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const rowKey = target.dataset.virtualKey;
        const keyValue = rowKey && target.dataset.virtualKeyNumber === 'true' ? Number(rowKey) : rowKey;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (keyValue !== undefined && height > 0 && Math.abs((measured.current.get(keyValue) ?? 0) - height) > 0.5) {
          measured.current.set(keyValue, height);
          changed = true;
        }
      }
      if (changed) setMeasureRevision((revision) => revision + 1);
    });
    observer.current.observe(element);
  }

  function moveFocus(event: KeyboardEvent): void {
    if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const target = event.target as HTMLElement;
    if (target.matches('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]')) return;
    const current = Number(target.closest<HTMLElement>('[data-virtual-index]')?.dataset.virtualIndex);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? Math.min(items.length - 1, Number.isInteger(current) ? current + 1 : focusedIndex)
        : Math.max(0, Number.isInteger(current) ? current - 1 : focusedIndex);
    event.preventDefault();
    focusRequest.current = next;
    setFocusedIndex(next);
    setFocusRevision(revision => revision + 1);
    if (!windowed) return; // Native focus scrolls fully mounted rows into view.
    const top = geometry[next] ?? 0;
    const bottom = geometry[next + 1] ?? top;
    const element = container.current;
    if (element && (top < element.scrollTop || bottom > element.scrollTop + element.clientHeight)) {
      element.scrollTop = Math.max(0, top - Math.max(0, (element.clientHeight - (bottom - top)) / 2));
    }
    setScrollTop(element?.scrollTop ?? 0);
  }

  return <div ref={container} class={className} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} onKeyDownCapture={moveFocus}>
    <div style={windowed ? { height: `${geometry[items.length] ?? 0}px`, position: 'relative' } : undefined}>
      {visible.map(({ item, index }) => {
        const key = keys[index];
        if (!rowRefs.current.has(key)) rowRefs.current.set(key, element => setRowRef(key, element));
        return <div class="virtual-list-row" key={String(key)} ref={rowRefs.current.get(key)} data-virtual-index={index} data-virtual-key={String(key)} data-virtual-key-number={typeof key === 'number' ? 'true' : 'false'} style={windowed ? { position: 'absolute', insetInline: 0, top: `${geometry[index]}px` } : undefined}>
          {renderItem(item, index)}
        </div>;
      })}
    </div>
  </div>;
}

