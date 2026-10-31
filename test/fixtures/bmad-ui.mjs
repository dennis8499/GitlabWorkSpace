export function bmadUiSnapshot(root = 'C:/專案/服務 A') {
  const definitions = [
    ['brief', 'bmad-product-brief', 'Create Brief', 'plan'],
    ['prd', 'bmad-prd', 'Create Edit and Review PRD', 'planning'],
    ['ux', 'bmad-ux', 'Create UX', 'planning'],
    ['arch', 'bmad-architecture', 'Architecture', 'solutioning'],
    ['epics', 'bmad-create-epics-and-stories', 'Create Epics and Stories', 'solutioning'],
    ['sprint', 'bmad-sprint-planning', 'Sprint Planning', 'solutioning'],
    ['build', 'bmad-build', 'Build', 'ship'],
    ['review', 'bmad-code-review', 'Code Review', 'ship'],
    ['qa', 'bmad-qa-generate-e2e-tests', 'QA Automation Test', 'ship'],
    ['help', 'bmad-help', 'BMad Help', 'anytime'],
    ['context', 'bmad-project-context', 'Project Context', 'anytime'],
    ['spec', 'bmad-spec', 'Spec', 'anytime'],
    ['research', 'bmad-deep-recon', 'Deep Recon', 'anytime'],
    ['document-review', 'bmad-review', 'Review', 'anytime'],
    ['sprint-status', 'bmad-sprint-planning', 'Sprint Status', 'anytime', 'status'],
    ['correct-course', 'bmad-correct-course', 'Correct Course', 'anytime']
  ];
  const nodes = definitions.map(([id, skill, displayName, phase, action = '']) => ({ id, skill, displayName, phase, action,
    required: ['prd', 'arch', 'epics', 'sprint', 'build'].includes(id), module: 'BMad Method', menuCode: id.toUpperCase(),
    description: `${displayName} 的官方工作說明`, args: '', precededBy: [], followedBy: [], outputLocation: '_bmad-output', outputs: [`${id}.md`] }));
  const storyPath = `${root}/_bmad-output/specs/spec-checkout/stories/1-checkout.md`;
  const inventoryPath = `${root}/_bmad-output/specs/spec-checkout/stories.yaml`;
  const storyId = `${inventoryPath}#1`;
  return { root, revision: `${root}:revision-1`, version: '6.12.4', guidanceVersion: '6.12.4', compatibility: 'verified',
    installation: { state: 'ready', reason: '已偵測專案原生 BMAD 安裝。' },
    codex: { state: 'ready', skills: [...new Set(nodes.map(item => item.skill))], reason: '已偵測專案 Codex Skills。' },
    observation: { state: 'watching', lastSuccessfulAt: '2026-10-18T09:00:00Z' }, observedAt: '2026-10-18T09:00:00Z',
    catalogSource: 'installed', nodes,
    phases: [['plan', '探索'], ['planning', '需求規劃'], ['solutioning', '設計與拆分'], ['ship', '實作與交付'], ['anytime', '隨時可用']]
      .map(([id, label]) => ({ id, label, nodeIds: nodes.filter(node => node.phase === id).map(node => node.id) })),
    edges: [{ from: 'brief', to: 'prd' }, { from: 'prd', to: 'arch' }, { from: 'arch', to: 'epics' },
      { from: 'epics', to: 'sprint' }, { from: 'sprint', to: 'build' }, { from: 'build', to: 'review' }],
    steps: nodes.map(item => ({ id: item.id, status: item.id === 'brief' ? 'complete' : item.id === 'build' ? 'draft' : 'not-observed',
      summary: `${item.displayName} 狀態`, artifacts: item.id === 'build' ? [{ id: 'story-a', path: storyPath,
        relativePath: '_bmad-output/specs/spec-checkout/stories/1-checkout.md', fingerprint: 'story-a-sha', status: 'draft',
        reason: '工作文件明確標示實作中。', nativeStatus: 'in-progress', stage: '實作中', marker: 'status: in-progress', observedAt: '2026-10-18T08:55:00Z' }] : [] })),
    stories: [{ id: storyId, label: '購物車結帳', mode: 'spec', path: storyPath, inventoryPath, status: 'in-progress', reason: '正在實作。',
      stage: '實作中', nativeStatus: 'in-progress', observedAt: '2026-10-18T08:55:00Z' },
      { id: 'story-b', label: '收據寄送', mode: 'classic', path: `${root}/_bmad-output/implementation-artifacts/story-b.md`, status: 'review', reason: '等待審查。' }],
    currentCandidates: [{ stepId: 'build', artifactId: 'story-a', storyId, label: '購物車結帳', reason: '開發進行中。' },
      { stepId: 'review', storyId: 'story-b', label: '收據寄送', reason: '等待程式碼審查。' }],
    recommendations: [{ stepId: 'arch', reason: '接續確認整體架構。' }], watchDirectories: [`${root}/_bmad-output`], diagnostics: [] };
}

export function bmadEnvironmentSnapshot(root = 'C:/專案/服務 A') {
  return { root, checkedAt: '2026-10-18T09:00:00Z', tools: [
    { id: 'codex', label: 'Codex CLI', state: 'found', reason: '已在 PATH 找到 codex.cmd。' },
    { id: 'uv', label: 'uv', state: 'ready', version: '0.11.0', reason: 'uv 可執行。' }
  ] };
}

export function bmadWorkspaceSnapshot(root = 'C:/專案/服務 A', bmad = bmadUiSnapshot(root)) {
  const installed = { status: 'missing', capabilities: [] };
  const repositories = root ? [{ name: '目前專案', path: root, matched: true }] : [];
  return { connected: false, groups: [], projects: [], issues: [], mergeRequests: [], groupMilestones: [], groupIssueBoards: [],
    groupRoot: root, cloneRoot: root, groupRepositories: repositories, groupRepositoryScanStatus: 'ready', localRepositories: {},
    projectLocalRepositories: {}, projectMembers: [], timers: [], activeMode: 'bmad', accounts: [],
    scopeEpoch: 1, operationScope: `offline:${root ?? 'none'}`,
    operationSnapshot: { sessionId: 'bmad-test-host', revision: 0, operations: [] },
    workflowKit: installed, workflowKitInstallTarget: { root, manual: false, profile: 'repository', state: installed },
    workflowKitReleases: [], workflowKitSource: 'bundled', busy: false,
    projectContext: { folders: root ? [{ uri: `file:${root}`, path: root, name: '目前專案' }] : [],
      selectedFolderUri: root ? `file:${root}` : undefined, root, manual: false, revision: `project:${root ?? 'none'}` },
    skillsContext: { mode: root ? 'repository' : 'unavailable', root, revision: `skills:${root ?? 'none'}`,
      repositories, installed, availableFeatures: [],
      groupMatch: { status: root ? 'matched' : 'unverified', root, profile: 'repository', repositories } },
    bmad, bmadEnvironment: bmadEnvironmentSnapshot(root) };
}
