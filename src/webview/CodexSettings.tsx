/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import type { WorkspaceRequest, WorkspaceResponse } from '../workspace/workspaceProtocol';
import { OperationFeedback } from './OperationFeedback';

export function CodexSettings({ post, expanded = false, pending, scopeRevision }: {
  post: (request: WorkspaceRequest) => void;
  expanded?: boolean;
  pending: boolean;
  scopeRevision?: string;
}) {
  const [status, setStatus] = useState<Extract<WorkspaceResponse, { type: 'codexCliStatus' }>>();
  useEffect(() => {
    const receive = (event: MessageEvent<WorkspaceResponse>) => {
      if (event.data?.type === 'codexCliStatus') setStatus(event.data);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  return <details class="workspace-settings" open={expanded}>
    <summary data-settings-section="codex" tabIndex={0}>Codex CLI 執行環境</summary>
    <div class="button-row">
      <button type="button" disabled={pending} onClick={() => { setStatus(undefined); post({ type: 'codexCliSettings', action: 'check' }); }}>檢查 Codex CLI</button>
      <button type="button" disabled={pending} onClick={() => post({ type: 'codexCliSettings', action: 'login' })}>登入 Codex</button>
      <button type="button" onClick={() => post({ type: 'codexCliSettings', action: 'executable' })}>設定執行檔</button>
    </div>
    {status && <p role="status">Codex CLI {status.version} · {status.loggedIn ? '已登入' : '尚未登入'}</p>}
    <OperationFeedback resourceKey="codex-cli:settings" scopeRevision={scopeRevision} />
  </details>;
}
