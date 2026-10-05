import type { GitLabGraphLabel, GitLabUser } from '../api/types';

export type IssueGraphNodeKind = 'issue' | 'task' | 'epic';
export type IssueGraphEdgeType = 'parent' | 'relates_to' | 'blocks';

export interface IssueGraphNode {
  id: string;
  sourceIds: string[];
  kind: IssueGraphNodeKind;
  namespacePath: string;
  iid: string;
  title: string;
  state: string;
  projectId?: number;
  projectPath?: string;
  webUrl?: string;
  labels: GitLabGraphLabel[];
  assignees: GitLabUser[];
  boardIds: number[];
  assignedToMe: boolean;
  isRoot: boolean;
  relationsStatus?: 'loading' | 'ready' | 'error';
}

export interface IssueGraphEdge {
  id: string;
  source: string;
  target: string;
  type: IssueGraphEdgeType;
}

export interface IssueGraphSnapshot {
  connectedScope: string;
  status: 'loading' | 'partial' | 'ready' | 'error';
  roots: string[];
  nodes: IssueGraphNode[];
  edges: IssueGraphEdge[];
  boardIssueIds: Record<number, number[]>;
  boardStatus: Record<number, { status: 'loading' | 'ready' | 'error'; error?: string }>;
  errors: string[];
  updatedAt: number;
}

export interface IssueGraphPatch {
  connectedScope: string;
  upsertNodes: IssueGraphNode[];
  removeNodeIds: string[];
  upsertEdges: IssueGraphEdge[];
  removeEdgeIds: string[];
  addRootIds: string[];
  removeRootIds: string[];
  boardIssueIds: Partial<Record<number, number[]>>;
  removeBoardIds: number[];
  boardStatus: Partial<Record<number, IssueGraphSnapshot['boardStatus'][number]>>;
  removeBoardStatusIds: number[];
  status: IssueGraphSnapshot['status'];
  errors: string[];
  updatedAt: number;
}

export function createIssueGraphPatch(previous: IssueGraphSnapshot | undefined, current: IssueGraphSnapshot): IssueGraphPatch {
  const priorNodes = new Map((previous?.nodes ?? []).map((node) => [node.id, JSON.stringify(node)]));
  const nextNodes = new Map(current.nodes.map((node) => [node.id, JSON.stringify(node)]));
  const priorEdges = new Map((previous?.edges ?? []).map((edge) => [edge.id, JSON.stringify(edge)]));
  const nextEdges = new Map(current.edges.map((edge) => [edge.id, JSON.stringify(edge)]));
  const priorRoots = new Set(previous?.roots ?? []);
  const nextRoots = new Set(current.roots);
  const boardIssueIds: Partial<Record<number, number[]>> = {};
  const removeBoardIds: number[] = [];
  for (const [id, issues] of Object.entries(current.boardIssueIds)) {
    if (JSON.stringify(previous?.boardIssueIds[Number(id)] ?? null) !== JSON.stringify(issues)) boardIssueIds[Number(id)] = issues;
  }
  for (const id of Object.keys(previous?.boardIssueIds ?? {})) if (!Object.hasOwn(current.boardIssueIds, id)) removeBoardIds.push(Number(id));
  const boardStatus: Partial<Record<number, IssueGraphSnapshot['boardStatus'][number]>> = {};
  const removeBoardStatusIds: number[] = [];
  for (const [id, status] of Object.entries(current.boardStatus)) {
    if (JSON.stringify(previous?.boardStatus[Number(id)] ?? null) !== JSON.stringify(status)) boardStatus[Number(id)] = status;
  }
  for (const id of Object.keys(previous?.boardStatus ?? {})) if (!Object.hasOwn(current.boardStatus, id)) removeBoardStatusIds.push(Number(id));
  return {
    connectedScope: current.connectedScope,
    upsertNodes: current.nodes.filter((node) => priorNodes.get(node.id) !== nextNodes.get(node.id)),
    removeNodeIds: [...priorNodes.keys()].filter((id) => !nextNodes.has(id)),
    upsertEdges: current.edges.filter((edge) => priorEdges.get(edge.id) !== nextEdges.get(edge.id)),
    removeEdgeIds: [...priorEdges.keys()].filter((id) => !nextEdges.has(id)),
    addRootIds: current.roots.filter((id) => !priorRoots.has(id)),
    removeRootIds: [...priorRoots].filter((id) => !nextRoots.has(id)),
    boardIssueIds, removeBoardIds, boardStatus, removeBoardStatusIds,
    status: current.status,
    errors: [...current.errors],
    updatedAt: current.updatedAt
  };
}

export function applyIssueGraphPatch(snapshot: IssueGraphSnapshot, patch: IssueGraphPatch): IssueGraphSnapshot {
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  for (const id of patch.removeNodeIds) nodes.delete(id);
  for (const node of patch.upsertNodes) nodes.set(node.id, node);
  const edges = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
  for (const id of patch.removeEdgeIds) edges.delete(id);
  for (const edge of patch.upsertEdges) edges.set(edge.id, edge);
  const roots = new Set(snapshot.roots);
  for (const id of patch.removeRootIds) roots.delete(id);
  for (const id of patch.addRootIds) roots.add(id);
  const boardIssueIds = { ...snapshot.boardIssueIds };
  for (const id of patch.removeBoardIds) delete boardIssueIds[id];
  Object.assign(boardIssueIds, patch.boardIssueIds);
  const boardStatus = { ...snapshot.boardStatus };
  for (const id of patch.removeBoardStatusIds) delete boardStatus[id];
  Object.assign(boardStatus, patch.boardStatus);
  return { ...snapshot, nodes: [...nodes.values()], edges: [...edges.values()], roots: [...roots], boardIssueIds, boardStatus,
    status: patch.status, errors: [...patch.errors], updatedAt: patch.updatedAt };
}

const BOARD_COLORS = ['#e7815c', '#50a88b', '#6b91db', '#be83ce', '#c19d46', '#47aeb6', '#d46a8e', '#7e9c53'];

/** WorkItem and REST representations of an Issue use the same project/IID identity. */
export function issueGraphNodeKey(projectId: number | undefined, namespacePath: string, iid: string | number): string {
  const normalizedIid = String(iid);
  return projectId !== undefined && projectId > 0
    ? `project:${projectId}:issue:${normalizedIid}`
    : `namespace:${namespacePath.trim().toLocaleLowerCase()}:item:${normalizedIid}`;
}

/** Keep each Board's visual identity stable between refreshes and machines. */
export function issueGraphBoardColor(boardId: number): string {
  let hash = boardId | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return BOARD_COLORS[hash % BOARD_COLORS.length];
}

export function issueGraphEdge(source: string, target: string, type: IssueGraphEdgeType): IssueGraphEdge | undefined {
  if (!source || !target || source === target) return undefined;
  if (type === 'relates_to' && source.localeCompare(target) > 0) [source, target] = [target, source];
  return { id: `${type}:${source}\0${target}`, source, target, type };
}

/** Keep matching primary Issues and their immediate relations, including out-of-filter context. */
export function selectIssueGraph(
  graph: IssueGraphSnapshot,
  matchingRootIds: ReadonlySet<string>,
  boardId: number | 'all'
): { nodes: IssueGraphNode[]; edges: IssueGraphEdge[]; rootCount: number } {
  const rootIds = new Set(graph.nodes
    .filter((node) => node.isRoot && matchingRootIds.has(node.id) && (boardId === 'all' || node.boardIds.includes(boardId)))
    .map((node) => node.id));
  const includedIds = new Set(rootIds);
  for (const edge of graph.edges) {
    if (rootIds.has(edge.source)) includedIds.add(edge.target);
    if (rootIds.has(edge.target)) includedIds.add(edge.source);
  }
  return {
    nodes: graph.nodes.filter((node) => includedIds.has(node.id)),
    edges: graph.edges.filter((edge) => includedIds.has(edge.source) && includedIds.has(edge.target) &&
      (rootIds.has(edge.source) || rootIds.has(edge.target))),
    rootCount: rootIds.size
  };
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  callback: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Concurrency limit must be a positive integer.');
  const results: R[] = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await callback(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

