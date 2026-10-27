import type { ReviewerCapabilities } from '../workspace/reviewSessionProtocol';
import { withOutputStyle } from '../workspace/outputStyle';
import { REVIEWER_EXECUTION_FIELDS, resolveReviewerExecution,
  type ReviewerExecutionOverrides, type InstalledReviewerBinding } from '../workspace/reviewExecution';
import {
  buildWikiGuideContext, buildWikiGuidePrompt, canCopyWikiPrompt, createDefaultWikiGuideInputs, DEFAULT_WIKI_GUIDE_CARD_ID, getWikiGuideFields, migrateWikiGuideInputs, wikiGuideCards,
  type WikiGuideCard, type WikiGuideContext, type WikiGuideField, type WikiGuideInputValues
} from './codebaseWikiGuideData';

export type SkillGuideToolId = 'codebase-wiki' | 'merge-reviewer' | 'release-reviewer';
export type SkillGuideInputValues = WikiGuideInputValues;
export type SkillGuideContext = WikiGuideContext & { reviewRuntimeRoot?: string; releaseReviewRuntimeRoot?: string; reviewAuthScope?: string;
  reviewerExecution?: ReviewerExecutionOverrides; reviewerExecutionError?: string; reviewerBinding?: InstalledReviewerBinding; reviewerCapabilities?: ReviewerCapabilities };
export type SkillGuideField = WikiGuideField;
export interface SkillGuideCard extends WikiGuideCard {
  tool: SkillGuideToolId;
}
export interface SkillGuideState {
  tool: SkillGuideToolId;
  selections: Partial<Record<SkillGuideToolId, string>>;
  inputs: SkillGuideInputValues;
  migrationNotice?: string;
}

export const skillGuideTools: ReadonlyArray<{ id: SkillGuideToolId; title: string; defaultCard: string }> = [
  { id: 'codebase-wiki', title: 'Codebase LLM Wiki', defaultCard: DEFAULT_WIKI_GUIDE_CARD_ID },
  { id: 'merge-reviewer', title: 'MergeReviewer', defaultCard: 'merge-repo' },
  { id: 'release-reviewer', title: 'ReleaseReviewer', defaultCard: 'release-review' }
];

const field = (id: string, label: string, options: Partial<SkillGuideField> = {}): SkillGuideField => ({ id, label, ...options });
const repoField = () => field('repo', 'Repo', { required: true });
const releaseFields = (): SkillGuideField[] => [repoField(),
  field('base', '基礎分支', { required: true, placeholder: '例如 main 或 origin/main' }),
  field('head', '比較分支', { required: true, placeholder: '例如 feature/payment 或 origin/feature/payment' })
];

export const skillGuideCards: readonly SkillGuideCard[] = [
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
  const removedMode = ['merge-quick', 'merge-group', 'merge-mr'].includes(saved?.selections?.['merge-reviewer'] ?? '')
    || !!inputs['merge-repo.target'] && inputs['merge-repo.target'] !== '分支比較'
    || inputs['merge-repo.mode'] === '直接比較' || inputs['merge-repo.output'] === 'Markdown＋JSON';
  for (const key of Object.keys(inputs)) {
    if (/^merge-(quick|group|mr)\./.test(key)) delete inputs[key];
    for (const prefix of ['release-review.', 'merge-repo.']) {
      if (key.startsWith(prefix) && !['repo', 'base', 'head', ...REVIEWER_EXECUTION_FIELDS,
        ...(prefix === 'merge-repo.' ? ['confirmationRequired'] : [])].includes(key.slice(prefix.length))) delete inputs[key];
    }
  }
  if (removedMode) inputs['merge-repo.confirmationRequired'] = 'true';
  const migrationNotice = removedMode ? 'MergeReviewer 已更新為分支審查。原先選擇的模式已移除，請確認 Repo 與兩個分支後再複製。' : saved?.migrationNotice;
  return { tool, selections, inputs, ...(migrationNotice ? { migrationNotice } : {}) };
}

export function legacyWikiInputs(inputs: SkillGuideInputValues): WikiGuideInputValues {
  const ids = new Set(wikiGuideCards.map(card => card.id));
  return Object.fromEntries(Object.entries(inputs).filter(([key]) => ids.has(key.split('.')[0])));
}

/** Saved names are accepted only when they identify one current workspace Repo. */
export function resolveReviewerRepository<T extends { name: string; path: string }>(input: string, repositories: readonly T[]): T | undefined {
  const key = (value: string): string => {
    const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  const requested = input.trim();
  if (!requested) return undefined;
  const paths = repositories.filter(repo => key(repo.path) === key(requested));
  if (paths.length) return paths.length === 1 ? paths[0] : undefined;
  const names = repositories.filter(repo => repo.name === requested);
  return names.length === 1 ? names[0] : undefined;
}

export function buildSkillGuideContext(card: SkillGuideCard, context: SkillGuideContext): string {
  if (card.tool === 'codebase-wiki') return buildWikiGuideContext(context);
  return [
    `GitLab Workspace 工作流程包版本：${context.workflowKitVersion ?? '尚未安裝'}`,
    `Skills 專案根目錄：${context.root ?? context.groupRoot ?? '尚未選擇'}`,
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
  if (['release-review', 'merge-repo'].includes(card.id) && Object.keys(inputs).some(key => key.startsWith(card.id + '.') && !['repo', 'base', 'head', ...REVIEWER_EXECUTION_FIELDS].includes(key.slice(card.id.length + 1)))) return false;
  try { resolveReviewerExecution(inputs, card.id); } catch { return false; }
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
    && !/^[/-]|[\s\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{|\/\/|\/$|\.lock$|\.$/.test(branch);
}

export function buildSkillGuidePrompt(card: SkillGuideCard, inputs: SkillGuideInputValues, context: SkillGuideContext): string {
  return withOutputStyle(buildSkillGuideTaskPrompt(card, inputs, context));
}

function buildSkillGuideTaskPrompt(card: SkillGuideCard, inputs: SkillGuideInputValues, context: SkillGuideContext): string {
  if (card.tool === 'codebase-wiki') return buildWikiGuidePrompt(card.id, inputs, context);
  const releaseWorkspace = context.workspaceRoot ?? context.groupRoot ?? context.root;
  if (['release-reviewer', 'merge-reviewer'].includes(card.tool) && (context.workspaceRootAmbiguous || !releaseWorkspace)) {
    throw new Error('無法辨識唯一 VSCode 工作區根目錄；請先儲存 multi-root 工作區或開啟明確資料夾。');
  }
  const input = (id: string) => value(card, id, inputs).trim();
  const quoted = (id: string) => JSON.stringify(input(id) || `〔請填寫${card.fields.find(item => item.id === id)?.label}〕`);
  const selectedRepo = resolveReviewerRepository(input('repo'), context.repositories);
  const project = JSON.stringify(selectedRepo?.path ?? '〔請選擇目前工作區的 Repo〕');
  if (card.tool === 'release-reviewer' && Object.keys(inputs).some(key => key.startsWith('release-review.') && !['repo', 'base', 'head', ...REVIEWER_EXECUTION_FIELDS].includes(key.slice('release-review.'.length)))) throw new Error('ReleaseReviewer 只接受 Repo、基礎分支、比較分支；請重新載入已保存的輸入。');
  const release = card.tool === 'release-reviewer';
  const runtime = release ? context.releaseReviewRuntimeRoot : context.reviewRuntimeRoot;
  if (context.reviewerExecutionError) throw new Error(context.reviewerExecutionError);
  const execution = resolveReviewerExecution(inputs, card.id, context.reviewerExecution);
  const prepared = context.reviewerCapabilities?.prepare_evidence === true;
  const balanced = context.reviewerCapabilities?.budget_schema === 'ReviewBudget/v1' &&
    context.reviewerCapabilities.budget_profiles?.includes('balanced') === true;
  if (prepared && execution.mode !== 'single') throw new Error('目前安裝的 Reviewer 採單一 Agent，請選擇單一模式。');
  const installedRoot = context.root ?? context.groupRoot;
  const script = context.reviewerBinding?.script_path
    ?? (installedRoot ? `${installedRoot.replace(/[\\/]$/, '')}/.agents/skills/${card.tool}/scripts/review_session.py` : 'review_session.py');
  if (context.reviewerBinding && context.reviewerBinding.tool !== card.tool) throw new Error('已安裝 Reviewer 身分不符合所選工具。');
  return [
    `$${card.tool} 請依下列明確輸入執行${release ? '上版檢查' : '分支合併審查'}。`,
    '專案名稱：' + project, '基礎分支：' + quoted('base'), '比較分支：' + quoted('head'),
    (prepared ? '先讀上述已安裝 Skill 的 SKILL.md 與 references/fast-session.md；' : '先讀上述已安裝 Skill 的 SKILL.md 與 references/session-workflow.md；') + '審查準則、固定證據、報告與完成門檻以該 Skill 為準。依情境載入 Group、部署依賴或恢復文件。',
    ...(context.reviewerBinding ? ['已安裝入口：' + JSON.stringify(context.reviewerBinding),
      prepared ? 'helper 啟動前自動核對上述整套 payload SHA-256；不符時停止，請重新複製提示詞。'
        : '沿用已安裝入口的既有 CLI；尚未宣告 capabilities 的入口不傳入新版選項。'] : []),
    '執行政策：' + JSON.stringify(execution),
    '政策優先序：本次輸入、Reviewer 工作區設定、single/inherit/default。只套用本次呼叫；模型由 Codex 宿主建立子 agent 時套用，實際設定未知則記 null。不另開模型服務或修改全域設定。',
    ...(execution.mode === 'single' ? ['本次使用單一 agent；子 Agent 設定僅保存，未執行。'] : []),
    ...(execution.mode === 'parallel' ? [
      '任何 capture／fetch 以前，先按 spawn 工具本機說明核對模型、強度與 fork 能力；不可用或不支援時停止、保留請求並回報，不能默默替換。最多主 agent＋一名子 agent；主 agent 唯一擁有擷取、補查、草稿與發布。',
      'inherit/default 不覆寫父模型與強度；指定模型加 default 時省略 effort，採該模型預設。明確指定 effort 才覆寫，並使用宿主允許覆寫的 fork 方式。'
    ] : []),
    '啟動 helper：python ' + JSON.stringify(script) + (prepared ? ' start --prepare-evidence --workspace ' : ' start --workspace ') + JSON.stringify(releaseWorkspace) +
      (context.workspaceFile ? ' --workspace-file ' + JSON.stringify(context.workspaceFile) : '') +
      ' --project ' + project + ' --base ' + quoted('base') + ' --head ' + quoted('head') +
      (runtime ? ' --runtime-root ' + JSON.stringify(runtime) : '') +
      (context.reviewAuthScope ? ' --auth-scope ' + JSON.stringify(context.reviewAuthScope) : '') +
       (prepared && context.reviewerBinding ? ' --expected-payload-sha256 ' + context.reviewerBinding.payload_sha256 : '') +
      (balanced ? ' --budget-profile balanced' : '') + '。',
    ...(balanced ? ['時間目標為單 Repo 3 分鐘、多 Repo 6 分鐘；有已讀證據的具體線索才申請一次 50% 延長。每次操作檢查預算，到期保存已確認問題與必要缺口並收尾；報告驗證仍須完成，不把未完成標為通過。'] : []),
    prepared ? '沿 start → 必要 step → finish 完成同一 request_id；以 --updates-file 保存已讀證據上的判斷，再取得下一批內容。status 恢復、cancel 取消；check 僅供手動修稿。保留 helper 輸入骨架與 revision，必要語意判斷由 agent 明確結案。' : '沿 start → 必要 step → finish 完成同一 request_id；status 恢復、cancel 取消，check 供修稿。依已安裝 Skill 的既有草稿與批次操作完成審查。',
  ].join('\n');
}
