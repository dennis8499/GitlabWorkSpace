export function bmadUiSnapshot(root = 'C:/專案/服務 A') {
  const node = (id, displayName, phase, required = true) => ({ id, displayName, phase, required,
    module: 'BMad Method', skill: `bmad-${id}`, menuCode: id.toUpperCase(), description: `${displayName}的工作說明`,
    action: '', args: '', precededBy: [], followedBy: [], outputLocation: '_bmad-output', outputs: [`${id}.md`] });
  const nodes = [node('brief', '產品簡報', 'plan', false), node('prd', '需求文件', 'planning'),
    node('arch', '架構設計', 'solutioning'), node('build', '故事開發', 'ship'), node('review', '程式碼審查', 'ship')];
  return { root, revision: `${root}:revision-1`, version: '6.12.4', installation: { state: 'ready', reason: 'BMAD 已安裝。' },
    catalogSource: 'installed', nodes,
    phases: [{ id: 'plan', label: '探索', nodeIds: ['brief'] }, { id: 'planning', label: '規劃', nodeIds: ['prd'] },
      { id: 'solutioning', label: '設計', nodeIds: ['arch'] }, { id: 'ship', label: '實作', nodeIds: ['build', 'review'] }],
    edges: [{ from: 'brief', to: 'prd' }, { from: 'prd', to: 'arch' }, { from: 'arch', to: 'build' }, { from: 'build', to: 'review' }],
    steps: nodes.map(item => ({ id: item.id, status: item.id === 'brief' ? 'complete' : item.id === 'build' ? 'draft' : 'not-observed',
      summary: `${item.displayName}狀態`, artifacts: item.id === 'build' ? [{ id: 'story-a', path: `${root}/_bmad-output/specs/spec-checkout/story-a.md`,
        relativePath: '_bmad-output/specs/spec-checkout/story-a.md', fingerprint: 'story-a-sha', status: 'needs-confirmation',
        reason: '已偵測到故事文件，請確認內容。', canConfirm: true, confirmed: false }] : [] })),
    stories: [{ id: 'story-a', label: '購物車結帳', mode: 'spec', path: '_bmad-output/specs/spec-checkout/story-a.md', status: 'in-progress', reason: '正在實作。' },
      { id: 'story-b', label: '收據寄送', mode: 'classic', path: '_bmad-output/implementation-artifacts/story-b.md', status: 'review', reason: '等待審查。' }],
    currentCandidates: [{ stepId: 'build', artifactId: 'story-a', storyId: 'story-a', label: '購物車結帳', reason: '開發進行中。' },
      { stepId: 'review', artifactId: 'story-b', storyId: 'story-b', label: '收據寄送', reason: '等待程式碼審查。' }],
    recommendations: [{ stepId: 'arch', reason: '接續確認整體架構。' }], watchDirectories: [`${root}/_bmad-output`], diagnostics: [] };
}

export function bmadWorkspaceSnapshot(root = 'C:/專案/服務 A', bmad = bmadUiSnapshot(root)) {
  const installed = { status: 'installed', version: '0.25.0', profile: 'repository', source: 'bundled',
    capabilities: ['bmad-workflow'], upstreamVersions: { 'bmad-method': '6.12.4' } };
  const repositories = root ? [{ name: '目前專案', path: root, matched: true }] : [];
  return { connected: false, groups: [], projects: [], issues: [], mergeRequests: [], groupMilestones: [], groupIssueBoards: [],
    groupRoot: root, cloneRoot: root, groupRepositories: repositories, groupRepositoryScanStatus: 'ready', localRepositories: {},
    projectLocalRepositories: {}, projectMembers: [], timers: [], activeMode: 'bmad', accounts: [],
    scopeEpoch: 1, operationScope: `offline:${root ?? 'none'}`,
    operationSnapshot: { sessionId: 'bmad-test-host', revision: 0, operations: [] },
    workflowKit: installed, workflowKitInstallTarget: { root, manual: false, profile: 'repository', state: installed },
    workflowKitPackages: [], workflowKitSource: 'bundled', busy: false,
    projectContext: { folders: root ? [{ uri: `file:${root}`, path: root, name: '目前專案' }] : [],
      selectedFolderUri: root ? `file:${root}` : undefined, root, manual: false, revision: `project:${root ?? 'none'}` },
    skillsContext: { mode: root ? 'repository' : 'unavailable', root, revision: `skills:${root ?? 'none'}`,
      repositories, installed, availableFeatures: installed.capabilities,
      groupMatch: { status: root ? 'matched' : 'unverified', root, profile: 'repository', repositories } },
    bmad, bmadLaunchAvailable: true };
}
