import type { BmadCommandRequest, BmadWorkflowSnapshot } from './bmadProtocol';

/** Generated mirror of WorkflowKit's common/bmad-entrypoints.json; parity is tested. */
export const BMAD_ENTRY_REGISTRY = {
  "schema": "workflowkit-bmad-entrypoints/v1",
  "bmadVersion": "6.12.4",
  "entries": [
    {
      "id": "goal",
      "label": "/goal",
      "title": "描述目標，讓 BMAD 選流程",
      "description": "分類任務、核對目前階段並協調下一步。",
      "skills": [
        "bmad-help"
      ]
    },
    {
      "id": "plan",
      "label": "/plan",
      "title": "規劃需求與 Story",
      "description": "從構想探索、研究、需求到架構與可執行 Story。",
      "skills": [
        "bmad-brainstorming",
        "bmad-forge-idea",
        "bmad-deep-recon",
        "bmad-product-brief",
        "bmad-prfaq",
        "bmad-prd",
        "bmad-spec",
        "bmad-ux",
        "bmad-architecture",
        "bmad-create-epics-and-stories",
        "bmad-sprint-planning",
        "bmad-correct-course",
        "bmad-advanced-elicitation"
      ]
    },
    {
      "id": "build",
      "label": "/build",
      "title": "實作與修改",
      "description": "完成明確變更、Bug 或 Story，執行測試並展示成果。",
      "skills": [
        "bmad-build",
        "bmad-build-auto"
      ]
    },
    {
      "id": "verify",
      "label": "/verify",
      "title": "檢查、測試與驗收",
      "description": "審查程式或文件、建立測試、導覽變更與回顧。",
      "skills": [
        "bmad-review",
        "bmad-code-review",
        "bmad-qa-generate-e2e-tests",
        "bmad-walkthrough",
        "bmad-retrospective"
      ]
    },
    {
      "id": "project",
      "label": "/project",
      "title": "專案規則與進度",
      "description": "維護代理指引、自訂設定、討論及查看進度。",
      "skills": [
        "bmad-project-context",
        "bmad-customize",
        "bmad-party-mode",
        "bmad-help",
        "bmad-sprint-planning"
      ]
    }
  ],
  "operations": [
    {
      "id": "change",
      "title": "開始明確變更",
      "entry": "build",
      "action": "start"
    },
    {
      "id": "continue",
      "title": "繼續既有工作",
      "entry": "project",
      "action": "resume"
    },
    {
      "id": "progress",
      "title": "查看進度與下一步",
      "entry": "project",
      "action": "status"
    }
  ]
} as const;
export const BMAD_ENTRIES = BMAD_ENTRY_REGISTRY.entries;
export const BMAD_QUICK_OPERATIONS = BMAD_ENTRY_REGISTRY.operations;
export type BmadEntryId = typeof BMAD_ENTRIES[number]['id'];
export type BmadQuickOperation = typeof BMAD_QUICK_OPERATIONS[number]['id'];

export function bmadEntry(id: string) { return BMAD_ENTRIES.find(entry => entry.id === id); }
export function bmadEntrySkills(snapshot: BmadWorkflowSnapshot, id: BmadEntryId): string[] {
  return (bmadEntry(id)?.skills as readonly string[] ?? []).filter(skill => snapshot.codex.skills.includes(skill));
}
export function bmadAutoBuildIssue(snapshot: BmadWorkflowSnapshot): string | undefined {
  return snapshot.autoBuild?.state === 'ready' && snapshot.autoBuild.synchronousSubagents && snapshot.autoBuild.gitSandbox === 'verified'
    ? undefined : snapshot.autoBuild?.reason?.trim() || 'Build Auto 需要已驗證的同步子代理與 sandbox 本機 Git 提交能力；目前請使用一般 Build。';
}
/** Resolve only the router; native candidates are loaded just in time by that entry. */
export function bmadRequestSkill(snapshot: BmadWorkflowSnapshot, request: BmadCommandRequest): string {
  if (request.command !== 'entry') return request.command === 'task' ? (snapshot.codex.skills.includes('wk-goal') ? 'wk-goal' : 'bmad-help') : request.skill ?? '';
  const entry = bmadEntry(request.entry ?? '');
  if (!entry) throw new Error('找不到此 BMAD 入口，請重新選擇。');
  if (!snapshot.codex.skills.includes('wk-' + entry.id)) throw new Error('此專案尚未安裝 BMAD 簡化入口，請更新 WorkflowKit。');
  const candidates = bmadEntrySkills(snapshot, entry.id);
  if (!candidates.length) throw new Error('外部 BMAD 尚未提供此入口所需的能力。');
  if (request.nativeSkill && (!candidates.includes(request.nativeSkill) || request.nativeSkill === 'bmad-build-auto' && bmadAutoBuildIssue(snapshot))) {
    throw new Error(request.nativeSkill === 'bmad-build-auto' ? bmadAutoBuildIssue(snapshot) ?? 'Build Auto 尚未準備完成。' : '所選能力不屬於此入口或尚未安裝。');
  }
  return 'wk-' + entry.id;
}
