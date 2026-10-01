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

const actions: Array<{ id: QuickAction; label: string; pending: string; icon: 'workspace' | 'issue' | 'projects' }> = [
  { id: 'openWorkspace', label: '開啟工作台', pending: '開啟中…', icon: 'workspace' },
  { id: 'openMyWork', label: '我的工作', pending: '開啟中…', icon: 'issue' },
  { id: 'openProjects', label: '專案', pending: '開啟中…', icon: 'projects' }
];

function Icon({ name }: { name: (typeof actions)[number]['icon'] }) {
  if (name === 'workspace') return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="8" height="7" rx="1" /><rect x="13" y="4" width="8" height="16" rx="1" /><rect x="3" y="13" width="8" height="7" rx="1" /></svg>;
  if (name === 'issue') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9M12 7v5l3 2" /><path d="M16 3h5v5" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 4v5" /></svg>;
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
    vscode.postMessage({ type: 'perform', action });
  }

  return <main class="quick-actions" aria-label="GitLab Workspace 工作台導覽">
    <p class="connection-status" title={state.groupLabel}>{state.connected ? `GitLab 已連線 · ${state.groupLabel ?? '尚未選擇 Group'}` : '尚未連線 GitLab'}</p>
    <button
      class="action-button workspace-primary"
      type="button"
      disabled={!!state.busyAction}
      aria-label={state.busyAction === 'openWorkspace' ? '開啟中…' : '開啟工作台'}
      onClick={() => activate('openWorkspace')}
    >
      <Icon name="workspace" />
      <span>{state.busyAction === 'openWorkspace' ? '開啟中…' : '開啟工作台'}</span>
    </button>
    <nav class="workspace-shortcuts" aria-label="工作台頁面">
      {actions.filter((action) => action.id !== 'openWorkspace').map((action) => {
        const active = state.busyAction === action.id;
        return <button
          key={action.id}
          class={`action-button workspace-shortcut${active ? ' shortcut-active' : ''}`}
          type="button"
          disabled={!!state.busyAction}
          aria-label={active ? action.pending : action.label}
          onClick={() => activate(action.id)}
        >
          <Icon name={action.icon} />
          <span>{active ? action.pending : action.label}</span>
        </button>;
      })}
    </nav>
    <p class="action-message" role="status" aria-live="polite">{state.busyAction ? `${actions.find((action) => action.id === state.busyAction)?.pending}` : state.errorMessage ?? ''}</p>
  </main>;
}

render(<QuickActions />, document.getElementById('quick-actions')!);
