/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';

export function tabPanelProps(prefix: string, id: string, shared = false) {
  return { id: shared ? `${prefix}-panel` : `${prefix}-panel-${id}`, role: 'tabpanel', 'aria-labelledby': `${prefix}-tab-${id}`, tabIndex: 0 } as const;
}
/** Manual activation: moving focus never starts a remote read. */
export function Tabs<T extends string>({ prefix, label, items, selected, onChange, className = 'issue-tabs', sharedPanel = false }: {
  prefix: string; label: string; items: ReadonlyArray<readonly [T, string]>; selected: T; onChange: (id: T) => void; className?: string; sharedPanel?: boolean;
}) {
  const [focused, setFocused] = useState(selected);
  useEffect(() => setFocused(selected), [selected]);
  return <nav class={className} role="tablist" aria-label={label}>{items.map(([id, name], index) => <button key={id} type="button"
    id={`${prefix}-tab-${id}`} role="tab" aria-selected={selected === id} aria-controls={sharedPanel ? `${prefix}-panel` : `${prefix}-panel-${id}`}
    tabIndex={focused === id ? 0 : -1} class={selected === id ? 'active' : ''} onClick={() => { setFocused(id); onChange(id); }}
    onKeyDown={event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % items.length : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault(); const target = items[next][0]; setFocused(target);
      document.getElementById(`${prefix}-tab-${target}`)?.focus();
    }}>{name}</button>)}</nav>;
}
