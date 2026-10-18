import type { BmadCatalogNode, BmadPromptInputs, BmadWorkflowSnapshot } from './bmadProtocol';
import { withOutputStyle } from './outputStyle';

export interface BmadPromptField {
  id: keyof BmadPromptInputs; label: string; kind: 'textarea' | 'text' | 'select';
  options?: Array<{ value: string; label: string }>; required?: boolean; placeholder?: string;
}
const textKeys = ['intent', 'goal', 'background', 'constraints', 'references', 'target', 'acceptance', 'parameter', 'artifactId', 'storyId'] as const;
const reviewSkills = new Set(['bmad-review', 'bmad-code-review', 'bmad-walkthrough', 'bmad-qa-generate-e2e-tests']);
const ideaSkills = new Set(['bmad-brainstorming', 'bmad-product-brief', 'bmad-prfaq', 'bmad-forge-idea', 'bmad-deep-recon', 'bmad-party-mode']);
const field = (id: keyof BmadPromptInputs, label: string, required = false, kind: BmadPromptField['kind'] = 'textarea'): BmadPromptField => ({ id, label, kind, required });

export function getDefaultBmadPromptInputs(node: BmadCatalogNode): BmadPromptInputs {
  if (node.skill === 'bmad-prd' || node.skill === 'bmad-spec') return { intent: 'create' };
  if (node.skill === 'bmad-build') return { intent: 'new' };
  if (node.skill === 'bmad-help') return { goal: '根據目前專案產物判斷階段，建議下一步。' };
  if (node.skill === 'bmad-sprint-planning' && node.action === 'status') return { goal: '整理目前 Sprint 進度、風險與下一步。' };
  return {};
}

export function getBmadPromptFields(node: BmadCatalogNode, values: BmadPromptInputs): BmadPromptField[] {
  const inputs = { ...getDefaultBmadPromptInputs(node), ...values };
  const fields: BmadPromptField[] = [];
  const choices = node.skill === 'bmad-prd' ? [['create', '建立'], ['edit', '修改'], ['validate', '檢查']]
    : node.skill === 'bmad-spec' ? [['create', '整理規格'], ['validate', '驗證既有規格']]
    : node.skill === 'bmad-build' ? [['new', '新建工作'], ['resume', '續作既有工作']] : undefined;
  if (choices) fields.push({ id: 'intent', label: '處理方式', kind: 'select', required: true,
    options: choices.map(([value, label]) => ({ value, label })) });
  const existing = ['edit', 'validate', 'resume'].includes(inputs.intent ?? '');
  fields.push(field('goal', ideaSkills.has(node.skill) ? '主題與目標' : node.skill === 'bmad-build' ? '需求與本次目標' : '本次目標', !existing));
  if (existing || reviewSkills.has(node.skill) || ['bmad-advanced-elicitation', 'bmad-customize', 'bmad-project-context'].includes(node.skill)) {
    fields.push({ ...field('target', existing ? '既有文件／工作路徑' : '工作目標與範圍',
      ((existing || reviewSkills.has(node.skill)) && !inputs.artifactId && !inputs.storyId) || node.skill === 'bmad-advanced-elicitation', 'text'),
      placeholder: node.skill === 'bmad-build' ? '選取下方既有工作，或輸入 Build 記錄／Story 路徑' : '文件路徑、程式範圍、分支或變更說明' });
  }
  fields.push(field('references', '參考文件與資料'), field('background', '補充背景'), field('constraints', '限制與注意事項'));
  if (node.skill === 'bmad-build' || node.skill === 'bmad-qa-generate-e2e-tests') fields.push(field('acceptance', '驗收重點'));
  if (/\[[^\]]+\]/.test(node.args)) fields.push({ ...field('parameter', '功能參數', false, 'text'), placeholder: node.args });
  return fields;
}

/** Used by both the preview and Extension Host; no agent or shell is invoked. */
export function validateBmadPromptInputs(node: BmadCatalogNode, values: BmadPromptInputs, snapshot: BmadWorkflowSnapshot): string[] {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return ['表單內容格式無效。'];
  const errors: string[] = [];
  const allowed = new Set<string>([...textKeys, 'repositoryPaths']);
  for (const key of Object.keys(values)) if (!allowed.has(key)) errors.push('表單包含不支援的欄位。');
  for (const key of textKeys) if (values[key] !== undefined && (typeof values[key] !== 'string' || values[key]!.length > 32_000)) errors.push('表單欄位格式無效或過長。');
  if (values.repositoryPaths !== undefined && (!Array.isArray(values.repositoryPaths) || values.repositoryPaths.length > 200 ||
    values.repositoryPaths.some(value => typeof value !== 'string' || value.length > 4000 || !value.trim()))) errors.push('目標 Repo 格式無效。');
  if (errors.length) return [...new Set(errors)];
  const inputs = { ...getDefaultBmadPromptInputs(node), ...values };
  for (const item of getBmadPromptFields(node, inputs)) {
    const value = inputs[item.id];
    if (item.required && (typeof value !== 'string' || !value.trim())) errors.push(`請填寫「${item.label}」。`);
    if (item.options && !item.options.some(option => option.value === value)) errors.push(`「${item.label}」的選項無效。`);
  }
  if (inputs.artifactId && !snapshot.steps.find(step => step.id === node.id)?.artifacts.some(artifact => artifact.id === inputs.artifactId)) errors.push('所選產物已不存在或不屬於此功能，請重新選擇。');
  if (inputs.storyId && (!snapshot.stories.some(story => story.id === inputs.storyId) ||
    !snapshot.currentCandidates.some(candidate => candidate.stepId === node.id && candidate.storyId === inputs.storyId) && node.skill !== 'bmad-build')) errors.push('所選 Story 已不存在或不屬於此功能，請重新選擇。');
  return errors;
}

export function buildBmadPrompt(node: BmadCatalogNode, values: BmadPromptInputs, snapshot: BmadWorkflowSnapshot): string {
  if (!/^bmad-[a-z0-9-]+$/.test(node.skill)) throw new Error('BMAD Skill 名稱無效。');
  if (!values || typeof values !== 'object' || Array.isArray(values)) return '';
  const inputs = { ...getDefaultBmadPromptInputs(node), ...values };
  const root = snapshot.root?.replaceAll('\\', '/').replace(/\/+$/, '');
  if (!root && snapshot.root !== '/') return '';
  const artifact = snapshot.steps.find(step => step.id === node.id)?.artifacts.find(item => item.id === inputs.artifactId);
  const story = snapshot.stories.find(item => item.id === inputs.storyId);
  const inventory = story?.inventoryPath?.replaceAll('\\', '/');
  const nativeStoryId = story?.inventoryPath && story.id.startsWith(`${story.inventoryPath}#`)
    ? story.id.slice(story.inventoryPath.length + 1) : undefined;
  const labels = getBmadPromptFields(node, inputs);
  const repositories = Array.isArray(inputs.repositoryPaths) ? inputs.repositoryPaths.filter(value => typeof value === 'string') : [];
  const lines = [
    `BMAD 工作根目錄：${snapshot.root}`,
    '請在此根目錄操作，先讀取 AGENTS.md 與 .agents/gitlab-workspace-kit/profile.md。',
    `請讀取並遵循 ${root}/.agents/skills/${node.skill}/SKILL.md，使用 $${node.skill} 處理「${node.displayName}」。`,
    node.action ? `官方操作意圖：${node.action}` : '',
    node.args ? `官方參數提示：${node.args}` : '',
    repositories.length ? `目標 Repo：\n${repositories.map(value => `- ${value}`).join('\n')}` : '',
    ...labels.map(item => {
      const value = inputs[item.id];
      if (typeof value !== 'string' || !value.trim()) return '';
      return `${item.label}：${item.options?.find(option => option.value === value)?.label ?? value.trim()}`;
    }),
    artifact ? `已選產物：${artifact.path}` : '',
    story ? `已選 Story：${story.label}\nStory 識別：${story.id}\n正式記錄：${story.path}${story.inventoryPath ? `\nStory 清單：${story.inventoryPath}` : ''}` : '',
    nativeStoryId && inventory ? `續作參數：spec_folder = ${inventory.slice(0, inventory.lastIndexOf('/'))}\nstory_id = ${nativeStoryId}` : '',
    '請以繁體中文互動，依官方 Skill 核對輸入、適用流程及目前狀態；保留原生產物格式、狀態欄位與完成條件，將產物儲存至此專案設定的 BMAD 輸出位置。',
    '本提示詞不代表工作已開始或完成；頁面會依實際儲存的產物與正式狀態更新進度。'
  ];
  return withOutputStyle(lines.filter(Boolean).join('\n\n'));
}
