/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import type { GitLabProject } from '../api/types';
import type { RepositoryScanState, ScannedRepository } from '../git/repositoryScanProtocol';
import type { WorkspaceRequest } from '../workspace/workspaceProtocol';
import { VirtualRows } from './VirtualRows';

export function LocalRepositoriesPanel({ repositories, scan, projects, post }: {
  repositories: ScannedRepository[]; scan?: RepositoryScanState; projects: GitLabProject[]; post: (request: WorkspaceRequest) => void;
}) {
  const [search, setSearch] = useState('');
  const visible = repositories.filter(repository => (repository.name + ' ' + repository.path).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const scanning = scan?.status === 'scanning';
  return <section class="local-repositories-panel" aria-label="本機 Repo 清單">
    <div class="toolbar"><label class="search"><input aria-label="搜尋本機 Repo" type="search" placeholder="Repo 名稱或路徑…" value={search} onInput={event => setSearch(event.currentTarget.value)} /></label><span>{visible.length} 個 Repo</span>{scanning && <button type="button" onClick={() => post({ type: 'cancelRepositoryScan' })}>取消掃描</button>}</div>
    <p role="status">{scanning ? `掃描中：已檢查 ${scan.checkedDirectories} 個資料夾，找到 ${scan.repositories.length} 個 Repo。` : scan?.status === 'cancelled' ? '掃描已取消，已取得的結果保留。' : scan?.status === 'completed' ? `掃描完成：找到 ${scan.repositories.length} 個 Repo。` : scan?.status === 'error' ? '掃描未完成，請查看下方錯誤後重試。' : '顯示 VS Code Git 已辨識的 Repo；一鍵掃描可補齊工作區中的其他 Repo。'}</p>
    <p class="subtle">掃描略過：{(scan?.excludes ?? ['.git', 'node_modules', '.venv']).join('、')}。可在 VS Code 的 GitLab Workspace 設定調整。</p>
    <VirtualRows className="repo-list local-repo-list" items={visible} itemKey={repository => repository.path} estimateHeight={96} renderItem={repository => <div class="repo-row local-repo-row"><span class="repo-details"><strong>{repository.name}</strong><small>{repository.path}</small><small>{repository.projectIds?.length ? repository.projectIds.map(id => projects.find(project => project.id === id)?.path_with_namespace).filter(Boolean).join('、') : '未匹配目前 GitLab Group 的專案'}</small>{repository.registrationError && <small role="alert">{repository.registrationError}</small>}</span><span class={`pill ${repository.repositoryId ? 'success' : 'danger'}`}>{repository.repositoryId ? 'VS Code 已登錄' : 'Git 未登錄'}</span><button type="button" disabled={!repository.repositoryId} onClick={() => post({ type: 'gitOpenRepository', path: repository.path })}>開啟版控</button></div>} />
    {!visible.length && <p class="empty-inline">{search ? '沒有符合條件的本機 Repo。' : '尚未找到本機 Repo。請開啟工作區後按「一鍵掃描 Repo」。'}</p>}
    {!!scan?.errors.length && <details class="scan-errors"><summary>{scan.errors.length} 項掃描錯誤</summary>{scan.errors.map(error => <p><strong>{error.path}</strong><br />{error.message}</p>)}</details>}
  </section>;
}
