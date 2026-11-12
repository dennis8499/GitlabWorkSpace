/** @jsxImportSource preact */
import { useEffect, useRef } from 'preact/hooks';
import type { WorkspaceRequest, WorkspaceResponse } from '../workspace/workspaceProtocol';

export type BranchReadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type PickSkillBranch = Extract<WorkspaceRequest, { type: 'pickSkillBranch' }>;
let sequence = 0;

/** Free-form refs stay editable; the native picker only supplies a current-field suggestion. */
export function BranchInput({ id, label, value, onInput, repo, revision, field, onPick, disabled, required, placeholder, describedBy }: {
  id: string; label: string; value: string; onInput: (value: string) => void;
  repo?: string; revision?: string; field: PickSkillBranch['field']; onPick?: (request: PickSkillBranch) => void;
  disabled?: boolean; required?: boolean; placeholder?: string; describedBy?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const version = useRef(0);
  const pending = useRef<{ request: PickSkillBranch; inputVersion: number; value: string }>();
  const current = useRef({ repo, revision, field, value, onInput });
  current.current = { repo, revision, field, value, onInput };
  useEffect(() => {
    const receive = (event: MessageEvent<WorkspaceResponse>): void => {
      const message = event.data, expected = pending.current, latest = current.current;
      if (message?.type !== 'skillBranchSelected' || !expected || message.requestId !== expected.request.requestId
        || message.repo !== latest.repo || message.revision !== latest.revision || message.field !== latest.field
        || version.current !== expected.inputVersion || latest.value !== expected.value) return;
      pending.current = undefined;
      if (message.branch) { version.current++; latest.onInput(message.branch); }
      input.current?.focus();
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  const pick = (): void => {
    if (disabled || !repo || !revision || !onPick) return;
    const request: PickSkillBranch = { type: 'pickSkillBranch', repo, revision, field, requestId: `skill-pick-${Date.now()}-${++sequence}` };
    pending.current = { request, inputVersion: version.current, value };
    onPick(request);
  };
  return <div class="skills-branch-input"><div class="skills-branch-control">
    <input id={id} ref={input} type="text" value={value} required={required} disabled={disabled} aria-describedby={describedBy}
      placeholder={placeholder} autoComplete="off" onInput={event => { version.current++; pending.current = undefined; onInput(event.currentTarget.value); }}
      onKeyDown={event => { if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); pick(); } }} />
    <button class="skills-branch-toggle" type="button" aria-label={`選擇${label}`} title="在 VS Code 搜尋分支（Alt+↓）"
      disabled={disabled || !revision || !onPick} onClick={pick}><span aria-hidden="true">▾</span></button>
  </div></div>;
}
