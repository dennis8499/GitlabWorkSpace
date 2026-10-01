/** @jsxImportSource preact */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { QuickAction, QuickActionsResponse, QuickActionsState } from '../workspace/quickActionsProtocol';
import './quick-actions.css';

interface VsCodeBridge {
  postMessage(message: { type: 'ready' } | { type: 'perform'; action: QuickAction }): void;
}

declare function acquireVsCodeApi(): VsCodeBridge;
const vscode = acquireVsCodeApi();

const actions: Array<{ id: QuickAction; label: string; pending: string; icon: 'workspace' | 'group' | 'refresh' | 'connect' }> = [
  { id: 'openWorkspace', label: '開啟工作台', pending: '開啟中…', icon: 'workspace' },
  { id: 'selectGroup', label: '切換 Group', pending: '讀取中…', icon: 'group' },
  { id: 'refresh', label: '重新整理', pending: '更新中…', icon: 'refresh' },
  { id: 'connect', label: '連線 GitLab', pending: '連線中…', icon: 'connect' }
];

function Icon({ name }: { name: (typeof actions)[number]['icon'] }) {
  if (name === 'workspace') return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="8" height="7" rx="1" /><rect x="13" y="4" width="8" height="16" rx="1" /><rect x="3" y="13" width="8" height="7" rx="1" /></svg>;
  if (name === 'group') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3" /><path d="M3 19v-1a6 6 0 0 1 12 0v1Z" /><path d="M16 5.2a3 3 0 0 1 0 5.6M17 14a5 5 0 0 1 4 5" /></svg>;
  if (name === 'refresh') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.8 9a7 7 0 0 1 12-2L20 12M4 12l2.2 5a7 7 0 0 0 12-2" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2v5M16 2v5M6 7h12v4a6 6 0 0 1-6 6v5M9 7V4M15 7V4" /></svg>;
}

function QuickActions() {
  const [state, setState] = useState<QuickActionsState>({ connected: false });

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const response = event.data as Partial<QuickActionsResponse> | undefined;
      if (!response || response.type !== 'state' || !response.state || typeof response.state.connected !== 'boolean') return;
      setState(response.state);
    };
    window.addEventListener('message', receive);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', receive);
  }, []);

  function activate(action: QuickAction): void {
    if (state.busyAction) return;
    if (!state.connected && action !== 'connect' && action !== 'openWorkspace') return;
    vscode.postMessage({ type: 'perform', action });
  }

  return <main class="quick-actions" aria-label="GitLab Workspace 快速操作">
    <p class="connection-status" title={state.groupLabel}>{state.connected ? `目前 Group：${state.groupLabel ?? '尚未選擇'}` : '尚未連線 GitLab'}</p>
    <div class="action-grid">
      {actions.map((action) => {
        const connecting = action.id === 'connect' && state.connected;
        const label = connecting ? '重新連線' : action.label;
        const active = state.busyAction === action.id;
        const disabled = !!state.busyAction || (!state.connected && (action.id === 'selectGroup' || action.id === 'refresh'));
        return <button
          key={action.id}
          class={`action-button${action.id === (state.connected ? 'openWorkspace' : 'connect') ? ' action-primary' : ''}`}
          type="button"
          disabled={disabled}
          aria-label={active ? action.pending : label}
          onClick={() => activate(action.id)}
        >
          <Icon name={action.icon} />
          <span>{active ? action.pending : label}</span>
        </button>;
      })}
    </div>
    <p class="action-message" role="status" aria-live="polite">{state.busyAction ? `${actions.find((action) => action.id === state.busyAction)?.pending}` : state.errorMessage ?? ''}</p>
  </main>;
}

render(<QuickActions />, document.getElementById('quick-actions')!);
