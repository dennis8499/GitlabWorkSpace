/** @jsxImportSource preact */
import type { CodexTaskState } from '../codex/protocol';

export function CodexTaskLocations({ task }: { task: CodexTaskState }) {
  const locations = task.locations;
  const workspace = locations?.workspaceRoot ?? task.root;
  const source = locations?.sourceRoot ?? task.origin?.repositoryRoot;
  const execution = locations?.executionRoot ?? task.workingDirectory;
  const historical = task.retention === 'results-only';
  return <section class="codex-task-context" aria-label="任務來源與位置">
    {locations?.wikiTarget && <p class="codex-context-kind"><strong>{locations.wikiTarget === 'local' ? '本地 Codebase Wiki' : 'GitLab Wiki 草稿'}</strong>
      {locations.wikiTarget === 'local' ? ' · 保存在工作區的 Wiki' : ' · 檢閱後另行發布至 GitLab'}</p>}
    {locations?.sourceBasis && <p class="codex-source-basis">來源依據：{locations.sourceBasis}</p>}
    <dl class="codex-location-list">
      <dt>工作區根目錄</dt><dd title={workspace}>{workspace}</dd>
      {source && <><dt>來源 Repo／範圍</dt><dd title={source}>{source}</dd></>}
      {!historical && execution && <><dt>實際執行目錄</dt><dd title={execution}>{execution}</dd></>}
      {!historical && locations?.outputRoot && <><dt>{locations.wikiTarget === 'local' ? '本地 Wiki 保存位置' : locations.wikiTarget === 'gitlab' ? 'GitLab Wiki 草稿位置' : '成果位置'}</dt><dd title={locations.outputRoot}>{locations.outputRoot}</dd></>}
    </dl>
  </section>;
}
