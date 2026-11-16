/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { WorkspaceRequest, WorkspaceResponse } from '../workspace/workspaceProtocol';
import type { CodexEnvironment, CodexEvent } from '../codex/protocol';
type Post = (request: WorkspaceRequest) => void;
function useCodexEvents(receive: (event: CodexEvent) => void, post: Post): void {
  const receiver = useRef(receive); receiver.current = receive;
  useEffect(() => {
    const listener = (event: MessageEvent<WorkspaceResponse>) => { if (event.data?.type === 'codexEvent') receiver.current(event.data.event); };
    window.addEventListener('message', listener); post({ type: 'listCodexTasks' });
    return () => window.removeEventListener('message', listener);
  }, []);
}
export function CodexSettings({ post, expanded = false }: { post: Post; expanded?: boolean }) {
  const [environment, setEnvironment] = useState<CodexEnvironment>({ state: 'unchecked' });
  useCodexEvents(event => { if (event.kind === 'environment') setEnvironment(event.environment); }, post);
  return <details class="workspace-settings codex-settings" open={expanded || environment.state !== 'ready'}><summary data-settings-section="codex" tabIndex={0}>Codex 執行環境 · {environment.state === 'ready' ? '可使用' : '需要檢查'}</summary>
    <p class="subtle">使用本機 Codex CLI 的 App Server 執行任務，沿用 CLI 登入與設定。</p>
    <p role="status">{environment.message ?? '按下檢查確認 Codex CLI、登入與執行權限。'}{environment.version && ` · CLI ${environment.version}`}</p>
    {environment.state === 'ready' && environment.compatibility && <p class="subtle">{environment.compatibility === 'verified' ? '此 CLI 版本已通過協定驗證。' : '基礎協定相容；進階功能依目前 CLI 支援的能力啟用。'}</p>}
    {environment.executable && <p class="subtle codex-root">{environment.executable}</p>}
    {environment.checkedAt && <p class="subtle">最後檢查：{new Date(environment.checkedAt).toLocaleString()}</p>}
    {environment.mcp?.length ? <details><summary>MCP 狀態</summary>{environment.mcp.map(server => <p key={server.name}>{server.name}：{server.status}</p>)}</details> : null}
    <div class="button-row"><button type="button" onClick={() => post({ type: 'checkCodex' })}>檢查 Codex</button>
      <button type="button" onClick={() => post({ type: 'openConfiguration', setting: 'gitlabWorkspace.codex.executablePath' })}>設定執行檔</button>
      <button type="button" onClick={() => post({ type: 'openConfiguration', setting: 'gitlabWorkspace.codex.autoApproveLocalOperations' })}>設定新任務的自動核准預設</button>
      {environment.authenticated === false && <button type="button" onClick={() => post({ type: 'configureCodex', action: 'login' })}>登入 Codex</button>}
      {environment.sandbox && environment.sandbox !== 'ready' && <button type="button" onClick={() => post({ type: 'configureCodex', action: 'sandbox' })}>設定 Windows sandbox</button>}
    </div><p class="subtle">任務可各自調整命令與檔案修改的自動核准；額外權限、問題、工具表單與 GitLab 成果交付仍需確認。新任務預設不會改變既有任務。</p>
  </details>;
}
