/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CodexLaunchDraft, CodexLaunchPatch } from '../codex/protocol';
import type { WorkspaceRequest } from '../workspace/workspaceProtocol';
import type { DispatchResult } from '../workspace/actionController';
import { canCopyCodexLaunch, codexLaunchManualText } from '../codex/launchProtocol';
import './codex-launch.css';

type Fields = Required<Pick<CodexLaunchPatch, 'requirement' | 'repositoryId' | 'repositoryIds' | 'additionalSkillIds' | 'testCommands' | 'automaticDelivery' | 'model' | 'effort' | 'isolated' | 'discussionIds'>>;
const fields = (draft: CodexLaunchDraft): Fields => ({ requirement: draft.requirement, repositoryId: draft.repositoryId ?? '',
  model: draft.model ?? '', effort: draft.effort ?? '', isolated: draft.isolated,
  repositoryIds: draft.repositoryIds ?? [], additionalSkillIds: draft.additionalSkillIds ?? [], testCommands: draft.testCommands ?? [],
  automaticDelivery: draft.automaticDelivery ?? false,
  discussionIds: draft.source.kind === 'merge-request' ? draft.source.discussionIds ?? [] : [] });
const same = (a: Fields, b: Fields) => JSON.stringify(a) === JSON.stringify(b);
export function CodexLaunchPanel({ draft, post, localDraft, localDraftRevision, onDraftChange }: {
  draft: CodexLaunchDraft; post(request: WorkspaceRequest): DispatchResult;
  localDraft?: CodexLaunchPatch; localDraftRevision?: number; onDraftChange?(patch?: CodexLaunchPatch, baseRevision?: number): void;
}) {
  const [value, setValue] = useState<Fields>(() => ({ ...fields(draft), ...localDraft })), [saving, setSaving] = useState(false);
  const [testInput, setTestInput] = useState(() => (localDraft?.testCommands ?? draft.testCommands ?? []).join('\n'));
  const testEditing = useRef(false);
  const [conflict, setConflict] = useState(() => !!localDraft && !same(fields(draft), { ...fields(draft), ...localDraft }) && localDraftRevision !== draft.revision);
  const local = useRef(value), latest = useRef(draft), dirty = useRef(false), sent = useRef<{ revision: number; value: Fields }>();
  const persist = useRef(onDraftChange); persist.current = onDraftChange;
  const mountedDraft = useRef(draft.id);
  const savedFields = useRef(fields(draft));
  const editBase = useRef(localDraftRevision ?? draft.revision);
  if (localDraft && !same(fields(draft), { ...fields(draft), ...localDraft }) && !sent.current) dirty.current = true;
  latest.current = draft;
  const busy = ['checking', 'submitting'].includes(draft.state), locked = ['submitted', 'submitting', 'uncertain'].includes(draft.state);
  const model = draft.models.find(model => model.id === value.model);
  const checksReady = draft.checks.every(check => check.state === 'ready');
  const modelBlocked = draft.checks.some(check => check.id === 'selection' && check.state === 'blocked');
  useEffect(() => {
    if (mountedDraft.current !== draft.id) {
      mountedDraft.current = draft.id; const next = { ...fields(draft), ...localDraft };
      local.current = next; setValue(next); sent.current = undefined; setSaving(false); dirty.current = !!localDraft;
      savedFields.current = fields(draft); editBase.current = localDraftRevision ?? draft.revision;
      setTestInput(next.testCommands.join('\n'));
      setConflict(!!localDraft && !same(fields(draft), next) && localDraftRevision !== draft.revision);
      return;
    }
    const received = fields(draft), matchesSent = sent.current && same(received, sent.current.value);
    const changedElsewhere = dirty.current && !same(received, savedFields.current) && !matchesSent;
    savedFields.current = received;
    if (sent.current && draft.revision > sent.current.revision) {
      if (matchesSent) {
        dirty.current = !same(local.current, sent.current.value);
        if (!dirty.current) persist.current?.(undefined);
        else { editBase.current = draft.revision; persist.current?.(local.current, editBase.current); }
      } else { dirty.current = true; setConflict(true); }
      sent.current = undefined; setSaving(false);
    }
    if (changedElsewhere) { setConflict(true); sent.current = undefined; setSaving(false); }
    if (!dirty.current) {
      const next = fields(draft); local.current = next; setValue(next);
      if (!testEditing.current) setTestInput(next.testCommands.join('\n'));
      if (localDraft && same(next, { ...next, ...localDraft })) persist.current?.(undefined);
    }
  }, [draft]);
  useEffect(() => {
    if (!dirty.current || saving || locked || busy || conflict) return;
    const timer = setTimeout(() => {
      const current = latest.current, snapshot = structuredClone(local.current);
      sent.current = { revision: current.revision, value: snapshot }; setSaving(true);
      const result = post({ type: 'updateCodexLaunch', draftId: current.id, revision: current.revision, patch: snapshot });
      if (result.status === 'blocked') { sent.current = undefined; setSaving(false); }
    }, 400);
    return () => clearTimeout(timer);
  }, [value, saving, busy, locked, conflict, draft.revision]);
  const edit = (patch: Partial<Fields>) => {
    const next = { ...local.current, ...patch };
    if (!dirty.current) editBase.current = latest.current.revision;
    dirty.current = true; local.current = next; persist.current?.(next, editBase.current); setValue(next);
  };
  const run = (type: 'checkCodexLaunch' | 'submitCodexLaunch') => {
    if (saving || locked || busy || conflict) return;
    const snapshot = structuredClone(local.current), current = latest.current;
    if (type === 'submitCodexLaunch' && current.sourceChange && !current.sourceChange.acknowledged) return;
    sent.current = { revision: current.revision, value: snapshot };
    const result = post({ type, draftId: current.id, revision: current.revision, patch: snapshot });
    if (result.status === 'blocked') sent.current = undefined;
  };
  const acknowledgeSource = () => {
    const current = latest.current, change = current.sourceChange;
    if (!change || change.acknowledged || saving || locked || busy || conflict) return;
    const snapshot = structuredClone(local.current);
    sent.current = { revision: current.revision, value: snapshot }; setSaving(true);
    const result = post({ type: 'updateCodexLaunch', draftId: current.id, revision: current.revision, patch: { ...snapshot, acknowledgedSource: change.key } });
    if (result.status === 'blocked') { sent.current = undefined; setSaving(false); }
  };
  const source = draft.source;
  const kind = { free: '程式工作', issue: 'Issue 開發', 'merge-request': source.kind === 'merge-request' && source.intent === 'fix-comments' ? 'MR 討論修正' : 'MR 審查',
    'project-wiki': '產生 GitLab Wiki 草稿', skill: 'Skills 工作', bmad: 'BMAD 工作', review: '接續審查', 'group-analysis': 'Group 需求影響分析' }[source.kind];
  const linked = ['issue', 'merge-request', 'project-wiki'].includes(source.kind);
  const localWiki = source.kind === 'skill' && !!source.inputs['wiki.profile'];
  const sourceRepository = source.kind === 'skill' ? source.inputs['wiki.sourceRepo'] : draft.repositories.find(repository => repository.id === value.repositoryId)?.path;
  const localWikiRoot = localWiki && draft.root ? draft.root.replace(/[\\/]$/, '') + '/wiki' : undefined;
  return <section class="codex-launch" aria-label="任務準備">
    <header><p class="eyebrow">{kind} · 任務準備</p><h2>{draft.title}</h2>
      <p>確認來源與執行設定後開始。離開畫面後可繼續準備這份任務。</p></header>
    {localWiki && <p class="codex-source-basis">本地 Codebase Wiki：使用目前本機內容；只處理所選來源，不發布至 GitLab。</p>}
    {source.kind === 'project-wiki' && <p class="codex-source-basis">GitLab Wiki 草稿：以遠端預設分支的固定版本建立文件，完成後先預覽頁面差異，再確認發布。</p>}
    {(draft.root || sourceRepository || draft.workingDirectory || localWikiRoot) && <dl class="codex-launch-summary codex-launch-locations" aria-label="任務來源與位置">
      {draft.root && <><dt>工作區根目錄</dt><dd>{draft.root}</dd></>}
      {sourceRepository && <><dt>來源 Repo／範圍</dt><dd>{sourceRepository}</dd></>}
      {draft.workingDirectory && <><dt>實際執行目錄</dt><dd>{draft.workingDirectory}</dd></>}
      {localWikiRoot && <><dt>本地 Wiki 保存位置</dt><dd>{localWikiRoot}</dd></>}
    </dl>}
    <form onSubmit={event => { event.preventDefault(); run('submitCodexLaunch'); }}>
      <fieldset disabled={locked || busy}><legend>需求與工作區</legend>
        <label for="codex-launch-requirement">{source.kind === 'free' || source.kind === 'group-analysis' ? '需求與完成條件' : '補充需求與完成條件（選填）'}</label>
        <textarea id="codex-launch-requirement" rows={5} maxLength={32000} required={source.kind === 'free' || source.kind === 'group-analysis'} value={value.requirement}
          onInput={event => edit({ requirement: event.currentTarget.value })} />
        {source.kind === 'group-analysis' ? <fieldset><legend>分析的本機 Repo</legend>
          {!draft.repositories.length && <p class="subtle">檢查後顯示目前 Group 的本機 Repo。</p>}
          {draft.repositories.map(repo => <label key={repo.id} class="codex-launch-checkbox"><input type="checkbox" checked={value.repositoryIds.includes(repo.id)}
            onChange={event => edit({ repositoryIds: event.currentTarget.checked ? [...value.repositoryIds, repo.id] : value.repositoryIds.filter(id => id !== repo.id) })} />{repo.name} · {repo.path}</label>)}
          <p class="subtle">分析各 Repo 的本機已提交版本，產生文件與牌卡草稿；檢閱後再選擇建立 Issue。</p>
        </fieldset> : <><label for="codex-launch-repository">本機 Repo</label>
        <select id="codex-launch-repository" disabled={!['free', 'issue', 'merge-request', 'project-wiki'].includes(source.kind)} value={value.repositoryId} onChange={event => edit({ repositoryId: event.currentTarget.value })}>
          <option value="">{!['free', 'issue', 'merge-request', 'project-wiki'].includes(source.kind) ? '由來源工作流程固定，執行位置見下方檢查結果' : draft.repositories.length ? '選擇本次工作使用的 Repo' : '檢查後顯示可用 Repo'}</option>
          {draft.repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.name} · {repo.path}</option>)}
        </select></>}
        {source.kind === 'issue' && <p class="subtle">在獨立本機 Repo 副本執行，由目前工作區管理進度與成果。</p>}
        {(source.kind === 'issue' && value.isolated || source.kind === 'merge-request' && source.intent === 'fix-comments') &&
          <p class="subtle">修改與測試在隔離工作區進行；完成後先檢閱成果，再確認遠端交付。</p>}
        {source.kind === 'free' && !!source.contexts?.length && <details><summary>已附加上下文（{source.contexts.length}）</summary>
          {source.contexts.map(item => <details key={item.hash}><summary>{item.kind} · {item.path}</summary><pre>{item.text}</pre></details>)}</details>}
        {draft.discussions && <fieldset><legend>選擇要修正的 MR 討論</legend>
          {draft.discussions.length === 0 && <p>目前沒有未解決的討論。</p>}
          {draft.discussions.map(item => <label key={item.id} class="codex-launch-discussion"><input type="checkbox" checked={value.discussionIds.includes(item.id)}
            onChange={event => edit({ discussionIds: event.currentTarget.checked ? [...value.discussionIds, item.id] : value.discussionIds.filter(id => id !== item.id) })} />
            <span>{item.summary}</span></label>)}
        </fieldset>}
      </fieldset>
      <details class="codex-launch-advanced"><summary>Skills · {(draft.availableSkills?.filter(skill => skill.required).length ?? 0) + value.additionalSkillIds.length} 項</summary>
        <fieldset disabled={locked || busy}><legend>載入的 Skills</legend>
          {!draft.availableSkills?.length && <p class="subtle">檢查 Codex 環境後顯示可用 Skills。</p>}
          {draft.availableSkills?.map(skill => <label key={skill.id} class="codex-launch-checkbox"><input type="checkbox" disabled={!!skill.required}
            checked={!!skill.required || value.additionalSkillIds.includes(skill.id)} onChange={event => edit({ additionalSkillIds: event.currentTarget.checked
              ? [...value.additionalSkillIds, skill.id] : value.additionalSkillIds.filter(id => id !== skill.id) })} />
            <span>{skill.name}{skill.required ? '（必要）' : ''}{skill.description && <span class="subtle"> · {skill.description}</span>}</span></label>)}
        </fieldset>
      </details>
      <details class="codex-launch-advanced"><summary>驗證與交付 · {value.testCommands.length} 項驗證{linked ? ' · 人工確認後交付' : ''}</summary>
        <fieldset disabled={locked || busy}><legend>成果驗證</legend>
          <label for="codex-launch-tests">必要驗證命令（每行一項）</label>
          <textarea id="codex-launch-tests" rows={3} maxLength={81920} value={testInput} onFocus={() => { testEditing.current = true; }}
            onBlur={() => { testEditing.current = false; setTestInput(local.current.testCommands.join('\n')); }}
            onInput={event => { const text = event.currentTarget.value; setTestInput(text); edit({ testCommands: text.split(/\r?\n/).map(line => line.trim()).filter(Boolean) }); }} />
          <p class="subtle">可填入建置、lint 或測試命令；依實際變更選擇必要檢查。</p>
          {!testInput.trim() && !!draft.suggestedTestCommands?.length && <button type="button" class="secondary" disabled={saving || conflict}
            onClick={() => { const commands = [...draft.suggestedTestCommands!]; setTestInput(commands.join('\n')); edit({ testCommands: commands }); }}>採用建議驗證命令</button>}
          {linked && <p class="subtle">先產生成果與驗證結果，由你檢閱確認後才推送或發布至 GitLab。既有自動交付設定不代替這次確認。</p>}
        </fieldset>
      </details>
      <details class="codex-launch-advanced" open={modelBlocked}><summary>模型與思考強度 · {model?.label ?? (value.model || '沿用本機 Codex 設定')}{value.effort ? ` · ${value.effort}` : ''}</summary>
      <fieldset disabled={locked || busy}><legend>執行設定</legend>
        <div class="codex-launch-options"><label>模型<select value={value.model} onChange={event => edit({ model: event.currentTarget.value, effort: '' })}>
          {!draft.requiresModel && <option value="">沿用本機 Codex 設定</option>}
          {draft.models.map(model =>
            <option key={model.id} value={model.id}>{model.label} · {model.id}</option>)}
        </select></label><label>思考強度<select disabled={!value.model} value={value.effort} onChange={event => edit({ effort: event.currentTarget.value })}>
          <option value="">沿用模型預設</option>
          {model?.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
        </select></label></div>
      </fieldset></details>
      {(draft.sourceSha || draft.branch) && <dl class="codex-launch-summary">
        {draft.branch && <><dt>工作分支</dt><dd>{draft.branch}</dd></>}
        {draft.sourceSha && <><dt>來源版本</dt><dd><code>{draft.sourceSha.slice(0, 12)}</code>{draft.targetSha && <> → <code>{draft.targetSha.slice(0, 12)}</code></>}</dd></>}
      </dl>}
      {!!draft.sourceSnapshot?.repositories?.length && <ul class="codex-launch-repository-heads" aria-label="Group 固定 Repo 版本">{draft.sourceSnapshot.repositories.map(repository => <li key={repository.id}>
        {draft.repositories.find(item => item.id === repository.id)?.name ?? repository.id} · <code>{repository.sha}</code>
      </li>)}</ul>}
      {draft.sourceChange && <section class="codex-launch-source-change" aria-labelledby="codex-source-change-title">
        <h3 id="codex-source-change-title">來源已更新，請重新核對</h3>
        <p role="status">{draft.sourceChange.acknowledged ? '已核對這次來源更新。' : '來源與上次檢查不同，核對下列變更後才能開始。'}</p>
        <dl><dt>來源版本</dt><dd><code>{draft.sourceChange.previous.sourceSha || '未提供'}</code><span aria-label="更新為"> → </span><code>{draft.sourceChange.current.sourceSha || '未提供'}</code></dd>
          {(draft.sourceChange.previous.targetSha || draft.sourceChange.current.targetSha) && <><dt>目標版本</dt><dd><code>{draft.sourceChange.previous.targetSha || '未提供'}</code><span aria-label="更新為"> → </span><code>{draft.sourceChange.current.targetSha || '未提供'}</code></dd></>}
          {(draft.sourceChange.previous.title || draft.sourceChange.current.title) && <><dt>來源標題</dt><dd>{draft.sourceChange.previous.title || '未提供'} → {draft.sourceChange.current.title || '未提供'}</dd></>}
          {(draft.sourceChange.previous.updatedAt || draft.sourceChange.current.updatedAt) && <><dt>更新時間</dt><dd>{draft.sourceChange.previous.updatedAt || '未提供'} → {draft.sourceChange.current.updatedAt || '未提供'}</dd></>}
        </dl>
        {draft.sourceChange.discussionsChanged && <p>MR 討論內容或狀態已更新，請重新確認要處理的討論。</p>}
        {(draft.sourceChange.previous.repositories || draft.sourceChange.current.repositories) && <ul aria-label="Group Repo 版本變更">{
          [...new Set([...(draft.sourceChange.previous.repositories ?? []), ...(draft.sourceChange.current.repositories ?? [])].map(repository => repository.id))].map(id => {
            const before = draft.sourceChange!.previous.repositories?.find(repository => repository.id === id)?.sha;
            const after = draft.sourceChange!.current.repositories?.find(repository => repository.id === id)?.sha;
            return before !== after ? <li key={id}>{draft.repositories.find(repository => repository.id === id)?.name ?? id}：<code>{before ?? '未選取'}</code> → <code>{after ?? '未選取'}</code></li> : null;
          })}</ul>}
        <button type="button" disabled={draft.sourceChange.acknowledged || saving || locked || busy || conflict} onClick={acknowledgeSource}>
          {draft.sourceChange.acknowledged ? '已核對更新的來源' : '我已核對更新的來源'}</button>
      </section>}
      <details class="codex-launch-checks" aria-label="環境檢查" open={!checksReady}><summary>開始前檢查 · {draft.checks.filter(check => check.state === 'ready').length}/{draft.checks.length} 通過</summary>
        <ol>{draft.checks.map(check => <li key={check.id} data-state={check.state}>
          <span aria-hidden="true">{{ pending: '○', checking: '◌', ready: '✓', blocked: '!' }[check.state]}</span>
          <div><strong>{check.label}</strong><span> · {{ pending: '尚未檢查', checking: '檢查中…', ready: '已確認', blocked: '需要處理' }[check.state]}</span>
            {check.message && <p>{check.message}</p>}</div>
          {check.repair && <button type="button" onClick={() => post({ type: 'repairCodexLaunch', draftId: draft.id, action: check.repair! })}>
            {{ login: '登入 GitLab', clone: '前往 Clone', scan: '掃描 Repo', tools: '工具與環境', 'codex-login': '登入 Codex', sandbox: '設定 sandbox', executable: '設定 Codex' }[check.repair]}</button>}
          {check.repair === 'scan' && <button type="button" onClick={() => post({ type: 'repairCodexLaunch', draftId: draft.id, action: 'clone' })}>前往 Clone</button>}
        </li>)}</ol>
      </details>
      {draft.error && <p class="warning" role="status">{draft.error}</p>}
      {conflict && <section class="warning" role="alert"><p>保存的設定與這份尚未同步的輸入不同。你的輸入保留在此畫面，請選擇要使用的設定。</p>
        <button type="button" disabled={locked || busy} onClick={() => { editBase.current = latest.current.revision; persist.current?.(local.current, editBase.current); setConflict(false); dirty.current = true; }}>套用我的設定</button>
        <button type="button" onClick={() => { const next = fields(latest.current); local.current = next; setValue(next); dirty.current = false; persist.current?.(undefined); setConflict(false); }}>使用目前保存設定</button>
      </section>}
      <footer class="codex-launch-actions"><button type="button" disabled={busy || locked || saving || conflict} onClick={() => run('checkCodexLaunch')}>重新檢查</button>
        {draft.state === 'submitted' && draft.taskId && <button type="button" onClick={() => post({ type: 'showCodexTask', taskId: draft.taskId! })}>查看任務</button>}
        {draft.state === 'uncertain' && <button type="button" onClick={() => post({ type: 'showCodexLaunch', draftId: draft.id })}>核對開始結果</button>}
        <button type="submit" class="primary" disabled={busy || locked || saving || conflict || !!draft.sourceChange && !draft.sourceChange.acknowledged || ['free', 'group-analysis'].includes(source.kind) && !value.requirement.trim()}>
          {draft.state === 'submitting' ? '正在開始…' : draft.state === 'checking' ? '正在檢查…' : '開始任務'}</button>
        {canCopyCodexLaunch(source) && <button type="button" onClick={() => post({ type: 'copy', text: codexLaunchManualText(draft, local.current) })}>複製手動執行資料</button>}
        <button type="button" disabled={draft.state === 'submitting' || draft.state === 'uncertain'} onClick={() => post({ type: 'cancelCodexLaunch', draftId: draft.id })}>
          {busy ? '停止檢查並保留草稿' : '稍後繼續'}</button>
        <span class="subtle" role="status">{saving ? '正在保存設定…' : dirty.current ? '尚有設定待保存' : '設定已保存'}</span>
      </footer>
    </form>
  </section>;
}
