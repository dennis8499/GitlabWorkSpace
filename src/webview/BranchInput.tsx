/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';

export type BranchReadStatus = 'idle' | 'loading' | 'ready' | 'error';

export function BranchInput({ id, label, value, onInput, branches, status, error, disabled, required, placeholder }: {
  id: string;
  label: string;
  value: string;
  onInput: (value: string) => void;
  branches: readonly string[];
  status: BranchReadStatus;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const matches = branches.filter(branch => branch.toLowerCase().includes(query.toLowerCase()));
  const listId = `${id}-branches`;
  const activeId = open && active >= 0 && active < matches.length ? `${listId}-${active}` : undefined;
  const close = () => { setOpen(false); setActive(-1); };
  const reveal = () => { setQuery(''); setActive(-1); setOpen(true); };
  const choose = (branch: string) => { onInput(branch); close(); };

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  useEffect(() => { setActive(-1); }, [branches]);
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const empty = status === 'loading' ? '正在讀取分支…'
    : status === 'error' ? `${error ?? '分支讀取失敗'}；仍可直接輸入名稱。`
    : query ? '找不到符合的分支；可直接使用輸入的名稱。'
    : status === 'ready' ? '此 Repo 尚無本機或遠端追蹤分支；可直接輸入名稱。'
    : '尚未讀取分支；可直接輸入名稱。';

  return <div class="skills-branch-input" ref={root} onBlur={event => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) close();
  }}>
    <div class="skills-branch-control">
      <input id={id} ref={input} type="text" role="combobox" value={value} required={required} disabled={disabled}
        placeholder={placeholder} autoComplete="off" aria-autocomplete="list" aria-expanded={open}
        aria-controls={listId} aria-activedescendant={activeId} onFocus={reveal} onClick={() => { if (!open) reveal(); }}
        onInput={event => { onInput(event.currentTarget.value); setQuery(event.currentTarget.value); setOpen(true); setActive(-1); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const candidates = open ? matches : branches;
            if (!open) { setQuery(''); setOpen(true); }
            if (candidates.length) setActive(current => event.key === 'ArrowDown'
              ? Math.min(current + 1, candidates.length - 1) : current < 0 ? candidates.length - 1 : Math.max(current - 1, 0));
          } else if (event.key === 'Enter' && open) {
            event.preventDefault();
            if (active >= 0 && matches[active]) choose(matches[active]);
            else close();
          } else if (event.key === 'Escape') { event.preventDefault(); close(); }
          else if (event.key === 'Tab') close();
        }} />
      <button class="skills-branch-toggle" type="button" aria-label={`顯示${label}列表`} aria-expanded={open}
        aria-controls={listId} tabIndex={-1} disabled={disabled} onMouseDown={event => event.preventDefault()}
        onClick={() => {
          if (open) close();
          else { input.current?.focus(); reveal(); }
        }}><span aria-hidden="true">▾</span></button>
    </div>
    {open && <div class="skills-branch-popup">
      <div id={listId} role="listbox" aria-label={`${label}候選`} aria-busy={status === 'loading'} class="skills-branch-options">
        {matches.map((branch, index) => <div key={branch} id={`${listId}-${index}`} role="option"
          aria-selected={branch === value} class={index === active ? 'active' : ''}
          onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(branch)}>{branch}</div>)}
      </div>
      {!matches.length && <p class="skills-branch-empty" role="status">{empty}</p>}
    </div>}
  </div>;
}
