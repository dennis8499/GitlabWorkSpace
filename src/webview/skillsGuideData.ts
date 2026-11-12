import type { ReviewerCapabilities, ReviewerSessionCapabilities } from '../workspace/reviewSessionProtocol';
import { buildCommitGuidePrompt, commitGuideCards, validCommitInputs, type CommitGuideContext } from './commitGuideData';
import { withOutputStyle } from '../workspace/outputStyle';
import { normalizeProjectRoot } from './projectUiState';
import { installedReviewerIdentity, workflowKitRunnerIdentity, type InstalledReviewerBinding } from '../workspace/reviewSessionProtocol';
import { reviewLaunchCommand, type ReviewLaunchBinding } from '../workspace/reviewLaunchProtocol';
import {
  buildWikiGuideContext, buildWikiGuidePrompt, canCopyWikiPrompt, createDefaultWikiGuideInputs, DEFAULT_WIKI_GUIDE_CARD_ID, getWikiGuideFields, migrateWikiGuideInputs, wikiGuideCards,
  type WikiGuideCard, type WikiGuideField, type WikiGuideInputValues
} from './codebaseWikiGuideData';

export type SkillGuideToolId = 'codebase-wiki' | 'merge-reviewer' | 'release-reviewer' | 'commit-reviewer';
export type SkillGuideInputValues = WikiGuideInputValues;
export type SkillGuideContext = CommitGuideContext & { reviewRuntimeRoot?: string; releaseReviewRuntimeRoot?: string; reviewAuthScope?: string;
  reviewerBinding?: InstalledReviewerBinding; reviewerCapabilities?: ReviewerCapabilities; reviewerRequestId?: string; modelRouting?: boolean;
  reviewLaunch?: ReviewLaunchBinding };
export type SkillGuideField = WikiGuideField;
export interface SkillGuideCard extends WikiGuideCard {
  tool: SkillGuideToolId;
}
export interface SkillGuideState {
  tool: SkillGuideToolId;
  selections: Partial<Record<SkillGuideToolId, string>>;
  inputs: SkillGuideInputValues;
  migrationNotice?: string;
  commitRepositoryRequired?: Record<string, boolean>;
}

export const skillGuideTools: ReadonlyArray<{ id: SkillGuideToolId; title: string; defaultCard: string }> = [
  { id: 'codebase-wiki', title: 'Codebase LLM Wiki', defaultCard: DEFAULT_WIKI_GUIDE_CARD_ID },
  { id: 'merge-reviewer', title: 'MergeReviewer', defaultCard: 'merge-repo' },
  { id: 'release-reviewer', title: 'ReleaseReviewer', defaultCard: 'release-review' },
  { id: 'commit-reviewer', title: 'CommitReviewer', defaultCard: 'commit-draft' }
];

const field = (id: string, label: string, options: Partial<SkillGuideField> = {}): SkillGuideField => ({ id, label, ...options });
const repoField = () => field('repo', 'Repo', { required: true });
const releaseFields = (): SkillGuideField[] => [repoField(),
  field('base', '基礎分支', { required: true, placeholder: '例如 main 或 origin/main' }),
  field('head', '比較分支', { required: true, placeholder: '例如 feature/payment 或 origin/feature/payment' }),
  field('effort', '審查思考強度（建立任務時可調整）', { kind: 'select', defaultValue: 'high', options: [ 'low', 'medium', 'high', 'xhigh', 'max'] })
];

export const skillGuideCards: readonly SkillGuideCard[] = [
  ...commitGuideCards,
  ...wikiGuideCards.filter(card => card.id !== 'install').map(card => ({ ...card, tool: 'codebase-wiki' as const })),
  {
    tool: 'merge-reviewer', id: 'merge-repo', title: '分支合併審查',
    description: '指定一個 Repo 與兩個明確分支，由 Skill agent 依 Code Review 判準審查差異及其影響。',
    output: '所選 Repo 的 review-reports/merge-review-*.md，一份標題為「合併審查」的繁體中文報告。',
    behavior: '完整輸入交給 Skill 後立即凍結兩個分支與工作區其他 Repo 的本機 HEAD，再開始審查。從 Code Diff 追查必要契約與消費端；缺證與業務疑問保留待人工確認。',
    fields: releaseFields()
  },
  {
    tool: 'release-reviewer', id: 'release-review', title: '上版檢查',
    description: '指定 Repo、基礎分支與比較分支，審查上版風險及相關功能鏈。',
    output: '所選 Repo 的 review-reports/release-review-*.md，一份標題為「上版檢查」且含人工 Checklist 的繁體中文報告。',
    behavior: '完整輸入交給 Skill 後立即凍結兩個分支與工作區其他 Repo 的本機 HEAD，再固定合併前審查。由 Code Diff 追查直接上版阻擋與新增部署依賴。',
    fields: releaseFields()
  }
];

export function getSkillGuideCards(profile: 'group' | 'repository' = 'group'): readonly SkillGuideCard[] {
  if (profile === 'group') return skillGuideCards;
  return skillGuideCards.map(card => {
    return card.tool === 'codebase-wiki' ? { ...card, fields: card.fields.filter(item => item.id !== 'repo') } : card;
  });
}

export function getSkillGuideCard(tool: SkillGuideToolId, id?: string, profile: 'group' | 'repository' = 'group'): SkillGuideCard {
  const cards = getSkillGuideCards(profile);
  const defaultId = skillGuideTools.find(item => item.id === tool)!.defaultCard;
  return cards.find(card => card.tool === tool && card.id === id)
    ?? cards.find(card => card.tool === tool && card.id === defaultId)!;
}

export function restoreSkillGuideState(saved?: SkillGuideState, legacyInputs?: WikiGuideInputValues, legacySelection?: string): SkillGuideState {
  const defaults = Object.fromEntries(skillGuideCards.flatMap(card => card.fields.filter(item => item.defaultValue !== undefined)
    .map(item => [`${card.id}.${item.id}`, item.defaultValue!])));
  const supportedTool = skillGuideTools.some(item => item.id === saved?.tool);
  const tool = supportedTool ? saved!.tool : 'codebase-wiki';
  const selections = Object.fromEntries(skillGuideTools.map(item => [item.id,
    getSkillGuideCard(item.id, saved && !supportedTool && item.id === 'codebase-wiki'
      ? DEFAULT_WIKI_GUIDE_CARD_ID
      : saved?.selections?.[item.id] ?? (item.id === 'codebase-wiki' ? legacySelection : undefined)).id]));
  const inputs = migrateWikiGuideInputs({ ...createDefaultWikiGuideInputs(), ...defaults, ...legacyInputs, ...saved?.inputs });
  for (const prefix of ['merge-repo', 'release-review']) if (inputs[`${prefix}.effort`] === 'auto') inputs[`${prefix}.effort`] = 'high';
  const removedMode = ['merge-quick', 'merge-group', 'merge-mr'].includes(saved?.selections?.['merge-reviewer'] ?? '')
    || !!inputs['merge-repo.target'] && inputs['merge-repo.target'] !== '分支比較'
    || inputs['merge-repo.mode'] === '直接比較' || inputs['merge-repo.output'] === 'Markdown＋JSON';
  for (const key of Object.keys(inputs)) {
    if (/^merge-(quick|group|mr)\./.test(key)) delete inputs[key];
    for (const prefix of ['release-review.', 'merge-repo.']) {
      if (key.startsWith(prefix) && !['repo', 'base', 'head', 'effort',
        ...(prefix === 'merge-repo.' ? ['confirmationRequired'] : [])].includes(key.slice(prefix.length))) delete inputs[key];
    }
  }
  if (removedMode) inputs['merge-repo.confirmationRequired'] = 'true';
  const migrationNotice = removedMode ? 'MergeReviewer 已更新為分支審查。原先選擇的模式已移除，請確認 Repo 與兩個分支後再複製。' : saved?.migrationNotice;
  return { tool, selections, inputs, ...(migrationNotice ? { migrationNotice } : {}),
    ...(saved?.commitRepositoryRequired ? { commitRepositoryRequired: saved.commitRepositoryRequired } : {}) };
}

export function legacyWikiInputs(inputs: SkillGuideInputValues): WikiGuideInputValues {
  const ids = new Set(wikiGuideCards.map(card => card.id));
  return Object.fromEntries(Object.entries(inputs).filter(([key]) => ids.has(key.split('.')[0])));
}

/** Saved names are accepted only when they identify one current workspace Repo. */
export function resolveReviewerRepository<T extends { name: string; path: string }>(input: string, repositories: readonly T[]): T | undefined {
  const key = normalizeProjectRoot;
  const requested = input.trim();
  if (!requested) return undefined;
  const paths = repositories.filter(repo => key(repo.path) === key(requested));
  if (paths.length) return paths.length === 1 ? paths[0] : undefined;
  const names = repositories.filter(repo => repo.name === requested);
  return names.length === 1 ? names[0] : undefined;
}

export function buildSkillGuideContext(card: SkillGuideCard, context: SkillGuideContext): string {
  if (card.tool === 'codebase-wiki') return buildWikiGuideContext(context);
  if (context.reviewLaunch) return `GitLab Workspace 工作流程包版本：${context.workflowKitVersion ?? '已安裝'}\nSkills 專案根目錄：${context.root ?? context.groupRoot}`;
  return [
    `GitLab Workspace 工作流程包版本：${context.workflowKitVersion ?? '尚未安裝'}`,
    `Skills 專案根目錄：${context.root ?? context.groupRoot ?? '尚未選擇'}`,
    ...(context.workflowKitRunner ? [`WorkflowKit helper runner：${JSON.stringify(workflowKitRunnerIdentity(context.workflowKitRunner))}。`] : []),
    `VSCode 工作區根目錄：${context.workspaceRoot ?? context.groupRoot ?? context.root ?? '尚未辨識'}`,
    '本機實際 Git Repo：',
    ...(context.repositories.length ? context.repositories.map(repo => `- ${repo.name} → ${repo.path}`) : ['（目前工作區尚未找到 Git Repo）'])
  ].join('\n');
}

function value(card: SkillGuideCard, id: string, inputs: SkillGuideInputValues): string {
  return inputs[`${card.id}.${id}`] ?? card.fields.find(item => item.id === id)?.defaultValue ?? '';
}

export function getSkillGuideFields(card: SkillGuideCard, inputs: SkillGuideInputValues): readonly SkillGuideField[] {
  if (card.tool === 'codebase-wiki') return getWikiGuideFields(card, inputs);
  return card.fields;
}

export function canCopySkillPrompt(card: SkillGuideCard, inputs: SkillGuideInputValues): boolean {
  if (card.tool === 'codebase-wiki') return canCopyWikiPrompt(card, inputs);
  if (card.tool === 'commit-reviewer') return validCommitInputs(card, inputs);
  if (['release-review', 'merge-repo'].includes(card.id) && Object.keys(inputs).some(key => key.startsWith(card.id + '.') && !['repo', 'base', 'head', 'effort'].includes(key.slice(card.id.length + 1)))) return false;
  if (!getSkillGuideFields(card, inputs).every(item => {
    if (card.id === 'ingest' && item.id === 'path' && value(card, 'scope', inputs) === '全部專案') return true;
    const input = value(card, item.id, inputs);
    return (!item.required || !!input.trim()) && (item.kind !== 'select' || !!item.options?.includes(input))
      && (item.kind === 'textarea' || !/[\r\n\0]/.test(input));
  })) return false;
  if (['release-review', 'merge-repo'].includes(card.id) && ['base', 'head'].some(id => !isExplicitBranch(value(card, id, inputs)))) return false;
  return true;
}

export function isExplicitBranch(input: string): boolean {
  const branch = input.trim();
  return !!branch && !/^(?:HEAD|refs\/tags\/.*|[a-f0-9]{40}|[a-f0-9]{64})$/i.test(branch)
    && !/^[/-]|[\s\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|\/$|\.lock$|\.$/.test(branch);
}

export function buildSkillGuidePrompt(card: SkillGuideCard, inputs: SkillGuideInputValues, context: SkillGuideContext): string {
  return withOutputStyle(buildSkillGuideTaskPrompt(card, inputs, context),
    ['merge-reviewer', 'release-reviewer'].includes(card.tool) ? 'report' : undefined);
}

function buildSkillGuideTaskPrompt(card: SkillGuideCard, inputs: SkillGuideInputValues, context: SkillGuideContext): string {
  if (card.tool === 'codebase-wiki') return buildWikiGuidePrompt(card.id, inputs, context);
  if (card.tool === 'commit-reviewer') return buildCommitGuidePrompt(card, inputs, context);
  const releaseWorkspace = context.workspaceRoot ?? context.groupRoot ?? context.root;
  if (['release-reviewer', 'merge-reviewer'].includes(card.tool) && (context.workspaceRootAmbiguous || !releaseWorkspace)) {
    throw new Error('無法辨識唯一 VSCode 工作區根目錄；請先儲存 multi-root 工作區或開啟明確資料夾。');
  }
  const input = (id: string) => value(card, id, inputs).trim();
  const quoted = (id: string) => JSON.stringify(input(id) || `〔請填寫${card.fields.find(item => item.id === id)?.label}〕`);
  const selectedRepo = resolveReviewerRepository(input('repo'), context.repositories);
  const project = JSON.stringify(selectedRepo?.path ?? '〔請選擇目前工作區的 Repo〕');
  if (card.tool === 'release-reviewer' && Object.keys(inputs).some(key => key.startsWith('release-review.') && !['repo', 'base', 'head', 'effort'].includes(key.slice('release-review.'.length)))) throw new Error('ReleaseReviewer 只接受 Repo、基礎分支、比較分支及思考強度；請重新載入已保存的輸入。');
  const release = card.tool === 'release-reviewer';
  const reviewer = release || card.tool === 'merge-reviewer';
  const runtime = release ? context.releaseReviewRuntimeRoot : context.reviewRuntimeRoot;
  const effort = input('effort') === 'auto' ? 'high' : input('effort') || 'high';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('Luna 思考強度無效。');
  if (context.reviewLaunch) {
    const launch = context.reviewLaunch, request = launch.request;
    if (card.tool !== request.tool || request.project !== selectedRepo?.path || request.base !== input('base') || request.head !== input('head') ||
      request.workspace !== releaseWorkspace || request.request_id !== context.reviewerRequestId) throw new Error('審查摘要與已保存的啟動輸入不符。');
    return [
      `$merge-reviewer ${launch.action === 'start' ? '執行分支合併審查' : '接續同一份固定版本審查'}。`,
      `Repo：${request.project}\n分支：${request.head} → ${request.base}\n工作區：${request.workspace}\nRequest：${request.request_id}`,
      '先讀已安裝 merge-reviewer/SKILL.md 與 references/session-workflow.md；依實際需要載入 authoring／契約文件。',
      `輸入檔：${launch.path}\nSHA-256：${launch.sha256}`,
      '執行下列固定命令；所有路徑、分支、runtime 與安裝綁定皆從輸入檔讀取。start 先做唯讀預檢，通過後才固定證據；既有 request 沿用原快照。',
      reviewLaunchCommand(launch),
      '後續沿用同一命令，只改 --action 為 status、view、check、finish 或 cancel；view 的續讀參數放在 -- 後。status/view 為唯讀。審查 step 依原生 Skill 操作。',
      '使用 compact 草稿。check 的 completion_preview 核對必要缺口與 scope_notes；finish 完整驗證後依收據區分報告發布與審查完整性。終止時檢視診斷，保留原 request。',
      '執行方式：單一 Agent。由目前 Agent 直接完成原生審查，沿用目前 CLI 模型與強度；Workbench 使用任務設定。本次停用 Model Routing，舊 profile 的 routing 指令不適用；不建立路由子 Agent。',
    ].join('\n');
  }
  const sessionCapabilities = context.reviewerCapabilities?.schema === 'ReviewCapabilities/v1'
    ? context.reviewerCapabilities : undefined;
  const nativeMergeCapabilities = context.reviewerCapabilities?.schema === 'MergeReviewCapabilities/v1'
    ? context.reviewerCapabilities : undefined;
  const prepared = sessionCapabilities?.prepare_evidence === true;
  const supports = (feature: keyof NonNullable<ReviewerSessionCapabilities['features']>): boolean =>
    sessionCapabilities?.features?.[feature] === true;
  const supportsRequestId = context.reviewerCapabilities === undefined ||
    (sessionCapabilities ? supports('request_id') : nativeMergeCapabilities?.protocol_version === 1);
  const statusCommand = supports('status_summary') ? 'status --summary' : 'status';
  const requestIdArg = supportsRequestId && context.reviewerRequestId ? ' --request-id ' + JSON.stringify(context.reviewerRequestId) : '';
  const runtimeArg = runtime ? ' --runtime-root ' + JSON.stringify(runtime) : '';
  const supportsUpdatesFile = prepared && (release
    ? supports('updates_file')
    : sessionCapabilities?.updates_schema === 'ReviewUpdates/v1');
  const balanced = !release && sessionCapabilities?.budget_schema === 'ReviewBudget/v1' &&
    sessionCapabilities.budget_profiles?.includes('balanced') === true;
  const unlimited = release && sessionCapabilities?.budget_schema === 'ReviewBudget/v1' &&
    sessionCapabilities.budget_profiles?.includes('unlimited') === true;
  const installedRoot = context.root ?? context.groupRoot;
  const workflowKitRunner = context.workflowKitRunner ?? context.reviewerBinding?.workflow_kit_runner;
  const script = context.reviewerBinding?.script_path
    ?? (installedRoot ? `${installedRoot.replace(/[\\/]$/, '')}/.agents/skills/${card.tool}/scripts/review_session.py` : 'review_session.py');
  if (context.reviewerBinding && context.reviewerBinding.tool !== card.tool) throw new Error('已安裝 Reviewer 身分不符合所選工具。');
  const python = (argumentsText: string): string => workflowKitRunner
    ? `python -X utf8 -B ${JSON.stringify(workflowKitRunner.script_path)} -- python -X utf8 -B ${argumentsText}`
    : `python ${argumentsText}`;
  return [
    `$${card.tool} 請依下列明確輸入執行${release ? '上版檢查' : '分支合併審查'}。`,
    '專案名稱：' + project, '基礎分支：' + quoted('base'), '比較分支：' + quoted('head'),
    (prepared ? '先讀上述已安裝 Skill 的 SKILL.md 與 references/fast-session.md；' : '先讀上述已安裝 Skill 的 SKILL.md 與 references/session-workflow.md；') + '審查準則、固定證據、報告與完成門檻以該 Skill 為準。依情境載入 Group、部署依賴或恢復文件。',
    ...(context.reviewerBinding ? ['已安裝入口：' + JSON.stringify(installedReviewerIdentity(context.reviewerBinding)),
      prepared ? 'helper 啟動前自動核對上述整套 payload SHA-256；不符時停止，請重新複製提示詞。'
        : nativeMergeCapabilities ? '使用 MergeReviewer 原生 session 介面；只呼叫其宣告的命令，不傳入新版 preparation、payload 或預算參數。'
          : sessionCapabilities ? '沿用已安裝 session 介面宣告的能力及選項。'
            : '入口未宣告 capabilities；依已安裝 Skill 驗證現有 CLI，不傳入新版選項。'] : []),
    ...(context.reviewerRequestId && supportsRequestId ? [`Review request ID: ${context.reviewerRequestId}. Reuse this ID for retries.`] : []),
    ...(release && supports('read_window') ? ['For large evidence, use read-window with a starting line and count, then follow next cursor.'] : []),
    ...(release && supports('literal_search_batch') ? ['Batch consecutive case-sensitive literal searches for the same Repo; keep one result record per query.'] : []),
    ...(release && supports('status_summary') ? ['Resume progress with status --summary.'] : []),
    ...(nativeMergeCapabilities?.features.read_only_artifact_view ? ['For large local artifacts, use the installed Skill documented view command and its continuation offsets.'] : []),
    ...(reviewer ? [`Session controls: status \u6062\u5fa9\u3001cancel \u53d6\u6d88\u3002 ${python(`${JSON.stringify(script)} ${statusCommand}${runtimeArg}${requestIdArg}`)}; ${python(`${JSON.stringify(script)} cancel${runtimeArg}${requestIdArg}`)}.`] : []),
    ...(release && supports('read_only_view') ? ['Use read-only view and its continuation cursor to inspect existing artifacts.'] : []),
    '執行方式：單一 Agent。由目前 Agent 直接完成原生審查，沿用目前 CLI 模型與強度；Workbench 使用任務設定。本次停用 Model Routing，舊 profile 的 routing 指令不適用；不建立路由子 Agent。',
    '啟動 helper：' + python(JSON.stringify(script) + (prepared ? ' start --prepare-evidence' : ' start') +
      requestIdArg +
      ' --workspace ' + JSON.stringify(releaseWorkspace) +
      (context.workspaceFile ? ' --workspace-file ' + JSON.stringify(context.workspaceFile) : '') +
      ' --project ' + project + ' --base ' + quoted('base') + ' --head ' + quoted('head') +
      (runtime ? ' --runtime-root ' + JSON.stringify(runtime) : '') +
      (context.reviewAuthScope ? ' --auth-scope ' + JSON.stringify(context.reviewAuthScope) : '') +
       (prepared && context.reviewerBinding ? ' --expected-payload-sha256 ' + context.reviewerBinding.payload_sha256 : '') +
      (nativeMergeCapabilities?.draft_formats.includes('compact') ? ' --draft-format compact' : '') +
      (balanced ? ' --budget-profile balanced' : unlimited ? ' --budget-profile unlimited' : '')) + '。',
    ...(balanced ? ['時間目標為單 Repo 3 分鐘、多 Repo 6 分鐘；有已讀證據的具體線索才申請一次 50% 延長。每次操作檢查預算，到期保存已確認問題與必要缺口並收尾；報告驗證仍須完成，不把未完成標為通過。'] : []),
    supportsUpdatesFile ? `Write draft updates to a UTF-8 ${release ? 'ReleaseReviewUpdates/v1' : 'ReviewUpdates/v1'} JSON file and pass them with --updates-file; retry with the same update ID.` : prepared ? '完成必要 step → finish；儲存每個步驟的結果與草稿，並使用回傳的 request 與 operation IDs 繼續。' : '完成必要 step → finish；儲存每個步驟的結果與草稿，並使用回傳的 request 與 operation IDs 繼續。',
  ].join('\n');
}
