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

