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
  empty?: ComponentChildren;
}

/** Variable-height list windowing with ten-row overscan and full-data keyboard navigation. */
export function VirtualRows<T>({ items, itemKey, estimateHeight, className, renderItem, resetKey, active = true, empty }: VirtualRowsProps<T>) {
  const windowed = items.length > 200;
  const container = useRef<HTMLDivElement>(null);
  const observer = useRef<ResizeObserver>();
  const measurementFrame = useRef<number>();
  const elements = useRef(new Map<string | number, HTMLElement>());
  const measured = useRef(new Map<string | number, number>());
  const rowRefs = useRef(new Map<string | number, (element: HTMLDivElement | null) => void>());
  const activeRef = useRef(active && windowed); activeRef.current = active && windowed;
  const lastWidth = useRef<number>();
  const focusRequest = useRef<number>();
  const focusedKeyRef = useRef<string | number>();
  const focusInside = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const [measureRevision, setMeasureRevision] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [focusRevision, setFocusRevision] = useState(0);
  const [focusedKey, setFocusedKey] = useState<string | number>();

  const keys = useMemo(() => items.map(itemKey), [items, itemKey]);
  const previousLayout = useRef<{ keys: (string | number)[]; geometry: number[]; resetKey?: string | number; windowed: boolean }>({ keys: [], geometry: [], resetKey, windowed });
  function naturalGeometry(rowKeys: readonly (string | number)[]): number[] {
    const offsets = [0];
    let zoom = 1;
    for (let ancestor: HTMLElement | null = container.current; ancestor; ancestor = ancestor.parentElement) {
      const value = Number.parseFloat(window.getComputedStyle(ancestor).getPropertyValue('zoom'));
      if (Number.isFinite(value) && value > 0) zoom *= value;
    }
    for (const key of rowKeys) {
      // The window positions are in layout pixels. A bounding rect includes
      // CSS zoom; remove it without rounding away fractional row heights.
      const height = (elements.current.get(key)?.getBoundingClientRect().height ?? 0) / zoom || estimateHeight;
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
    let nextTop = reset ? 0 : canAnchor ? restoreScrollAnchor(previous.keys, previous.geometry, keys, nextGeometry, element?.scrollTop ?? scrollTop) : element?.scrollTop ?? scrollTop;
    const removedFocus = active && focusInside.current && focusedKeyRef.current !== undefined && !keys.includes(focusedKeyRef.current);
    if (removedFocus) {
      const formerIndex = previous.keys.indexOf(focusedKeyRef.current!);
      const replacement = keys.length ? Math.min(Math.max(0, formerIndex), keys.length - 1) : -1;
      if (replacement >= 0) {
        focusedKeyRef.current = keys[replacement];
        setFocusedKey(keys[replacement]);
        focusRequest.current = replacement;
        setFocusedIndex(replacement);
        setFocusRevision(revision => revision + 1);
        if (windowed) {
          const top = nextGeometry[replacement] ?? 0;
          const bottom = nextGeometry[replacement + 1] ?? top;
          const height = element?.clientHeight ?? viewportHeight;
          if (top < nextTop || bottom > nextTop + height) nextTop = Math.max(0, top - Math.max(0, (height - (bottom - top)) / 2));
        }
      } else {
        focusedKeyRef.current = undefined;
        focusInside.current = false;
        setFocusedKey(undefined);
        const search = element?.closest('.list-column, .local-repositories-panel')?.querySelector<HTMLInputElement>('.search input')
          ?? element?.closest('.page')?.querySelector<HTMLInputElement>('.search input');
        search?.focus();
      }
    }
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
    const updateViewport = (): void => {
      setViewportHeight(element.clientHeight || 400);
      const width = element.clientWidth;
      if (width > 0 && lastWidth.current !== undefined && width !== lastWidth.current) {
        measured.current.clear();
        // ResizeObserver may report the rows before it reports the container.
        // Re-observe mounted rows after invalidating their old widths so that
        // their current heights are reported even when they no longer resize.
        for (const [key, row] of elements.current) setRowRef(key, row);
        setMeasureRevision((revision) => revision + 1);
      }
      if (width > 0) lastWidth.current = width;
    };
    updateViewport();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateViewport);
      return () => window.removeEventListener('resize', updateViewport);
    }
    let frame: number | undefined;
    const resize = new ResizeObserver(() => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => { frame = undefined; updateViewport(); });
    });
    resize.observe(element);
    return () => { resize.disconnect(); if (frame !== undefined) window.cancelAnimationFrame(frame); };
  }, [active, windowed]);

  useEffect(() => () => {
    observer.current?.disconnect();
    if (measurementFrame.current !== undefined) window.cancelAnimationFrame(measurementFrame.current);
  }, []);
  useEffect(() => {
    if (!active || !windowed) {
      observer.current?.disconnect();
      if (measurementFrame.current !== undefined) window.cancelAnimationFrame(measurementFrame.current);
      measurementFrame.current = undefined; return;
    }
    setMeasureRevision(revision => revision + 1);
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
  const pinnedIndex = windowed && focusedKey !== undefined ? keys.indexOf(focusedKey) : -1;
  if (pinnedIndex >= 0 && (pinnedIndex < startAt || pinnedIndex >= endAt)) {
    visible.push({ item: items[pinnedIndex], index: pinnedIndex });
    visible.sort((left, right) => left.index - right.index);
  }

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
      // Publish measured geometry in the next frame, outside ResizeObserver's
      // delivery cycle, so row placement cannot trigger a same-frame resize loop.
      if (changed && measurementFrame.current === undefined) measurementFrame.current = window.requestAnimationFrame(() => {
        measurementFrame.current = undefined;
        if (activeRef.current) setMeasureRevision(revision => revision + 1);
      });
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

  return <div ref={container} class={className} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} onKeyDownCapture={moveFocus}
    onFocusCapture={(event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-virtual-index]');
      const index = Number(row?.dataset.virtualIndex);
      if (!row || !Number.isInteger(index) || keys[index] === undefined) return;
      focusInside.current = true;
      focusedKeyRef.current = keys[index];
      setFocusedKey(keys[index]);
    }} onBlurCapture={(event) => {
      const element = event.currentTarget;
      if (event.relatedTarget && element.contains(event.relatedTarget as Node)) return;
      const clear = (): void => {
        if (element.contains(element.ownerDocument.activeElement)) return;
        focusInside.current = false;
        focusedKeyRef.current = undefined;
        setFocusedKey(undefined);
      };
      if (event.relatedTarget) clear();
      else queueMicrotask(clear);
    }}>
    <div style={windowed ? { height: `${geometry[items.length] ?? 0}px`, position: 'relative' } : undefined}>
      {!items.length && empty}
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

