/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { virtualWindow } from './virtualWindow';

interface VirtualRowsProps<T> {
  items: readonly T[];
  itemKey: (item: T) => string | number;
  estimateHeight: number;
  className: string;
  renderItem: (item: T, index: number) => ComponentChildren;
}

/** Variable-height list windowing with ten-row overscan and full-data keyboard navigation. */
export function VirtualRows<T>({ items, itemKey, estimateHeight, className, renderItem }: VirtualRowsProps<T>) {
  const container = useRef<HTMLDivElement>(null);
  const observer = useRef<ResizeObserver>();
  const elements = useRef(new Map<string | number, HTMLElement>());
  const measured = useRef(new Map<string | number, number>());
  const focusRequest = useRef<number>();
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const [measureRevision, setMeasureRevision] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState(0);

  const geometry = useMemo(() => {
    const offsets = new Array<number>(items.length + 1);
    offsets[0] = 0;
    for (let index = 0; index < items.length; index++) offsets[index + 1] = offsets[index] + (measured.current.get(itemKey(items[index])) ?? estimateHeight);
    return offsets;
  }, [items, itemKey, estimateHeight, measureRevision]);
  const itemsSignature = useMemo(() => items.map((item) => String(itemKey(item))).join('\0'), [items, itemKey]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
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
  }, []);

  useEffect(() => {
    const element = container.current;
    if (element) element.scrollTop = 0;
    setScrollTop(0);
    measured.current.clear();
    setMeasureRevision((revision) => revision + 1);
  }, [itemsSignature]);

  useEffect(() => () => observer.current?.disconnect(), []);

  useEffect(() => {
    if (focusRequest.current === undefined) return;
    const requested = focusRequest.current;
    focusRequest.current = undefined;
    const row = container.current?.querySelector<HTMLElement>(`[data-virtual-index="${requested}"]`);
    const focusable = row?.matches('button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')
      ? row : row?.querySelector<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])');
    focusable?.focus();
  }, [focusedIndex, scrollTop]);

  const { start: startAt, end: endAt } = virtualWindow(items.length, geometry, scrollTop, viewportHeight);
  const visible = items.length > 200 ? items.slice(startAt, endAt).map((item, offset) => ({ item, index: startAt + offset })) : items.map((item, index) => ({ item, index }));

  function setRowRef(key: string | number, element: HTMLElement | null): void {
    const prior = elements.current.get(key);
    if (prior) observer.current?.unobserve(prior);
    if (!element) { elements.current.delete(key); return; }
    elements.current.set(key, element);
    if (typeof ResizeObserver === 'undefined') return;
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
    const current = Number(target.closest<HTMLElement>('[data-virtual-index]')?.dataset.virtualIndex);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? Math.min(items.length - 1, Number.isInteger(current) ? current + 1 : focusedIndex)
        : Math.max(0, Number.isInteger(current) ? current - 1 : focusedIndex);
    event.preventDefault();
    focusRequest.current = next;
    setFocusedIndex(next);
    const top = geometry[next] ?? 0;
    const bottom = geometry[next + 1] ?? top;
    const element = container.current;
    if (element && (top < element.scrollTop || bottom > element.scrollTop + element.clientHeight)) {
      element.scrollTop = Math.max(0, top - Math.max(0, (element.clientHeight - (bottom - top)) / 2));
    }
    setScrollTop(element?.scrollTop ?? 0);
  }

  return <div ref={container} class={className} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} onKeyDownCapture={moveFocus}>
    <div style={{ height: `${geometry[items.length] ?? 0}px`, position: 'relative' }}>
      {visible.map(({ item, index }) => {
        const key = itemKey(item);
        return <div class="virtual-list-row" key={String(key)} ref={(element) => setRowRef(key, element)} data-virtual-index={index} data-virtual-key={String(key)} data-virtual-key-number={typeof key === 'number' ? 'true' : 'false'} style={items.length > 200 ? { position: 'absolute', insetInline: 0, top: `${geometry[index]}px` } : undefined}>
          {renderItem(item, index)}
        </div>;
      })}
    </div>
  </div>;
}

