export function buildLoadIssueWork(projectIds) {
  if (projectIds.length !== 20 || new Set(projectIds).size !== 20 || projectIds.some((projectId) => !Number.isSafeInteger(projectId) || projectId <= 0)) {
    throw new Error('A live load fixture requires 20 valid project IDs.');
  }
  return projectIds.flatMap((projectId, projectIndex) => Array.from({ length: 25 }, (_, issueIndex) => {
    const graph = issueIndex < 10;
    return {
      projectId,
      ordinal: projectIndex * 25 + issueIndex + 1,
      graph,
      graphOrdinal: graph ? projectIndex * 10 + issueIndex + 1 : undefined
    };
  }));
}

export function buildLoadMergeRequestBranches() {
  return Array.from({ length: 20 }, (_, index) => ({
    projectIndex: index + 1,
    branches: Array.from({ length: index < 10 ? 3 : 2 }, (_, branchIndex) => `mr-${index + 1}-${branchIndex + 1}`)
  }));
}

export function buildLoadGraphEdges(issues) {
  return issues.slice(0, -1).map((source, index) => ({ source, target: issues[index + 1] }));
}
