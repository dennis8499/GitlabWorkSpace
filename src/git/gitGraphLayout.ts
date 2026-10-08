import type { GitCommitSummary } from './gitProtocol';

export interface GitGraphSegment { from: number; to: number; start: 'top' | 'node'; end: 'node' | 'bottom'; color: number; }
export interface GitGraphRow { lane: number; color: number; segments: GitGraphSegment[]; }
export interface GitGraphLayout { rows: Map<string, GitGraphRow>; lanes: number; }

/** Topological rows share lanes for pending parents; unresolved parents continue below the page. */
export function layoutGitGraph(commits: readonly GitCommitSummary[]): GitGraphLayout {
  const active: Array<{ hash: string; color: number } | undefined> = [];
  const rows = new Map<string, GitGraphRow>();
  let nextColor = 0;
  let lanes = 1;
  const allocate = () => { const free = active.findIndex((item) => !item); return free < 0 ? active.length : free; };
  for (const commit of commits) {
    let lane = active.findIndex((item) => item?.hash === commit.hash);
    const color = lane >= 0 ? active[lane]!.color : nextColor++;
    if (lane < 0) lane = allocate();
    const segments: GitGraphSegment[] = [];
    active.forEach((item, index) => {
      if (!item) return;
      segments.push({ from: index, to: item.hash === commit.hash ? lane : index, start: 'top', end: item.hash === commit.hash ? 'node' : 'bottom', color: item.color });
      if (item.hash === commit.hash) active[index] = undefined;
    });
    commit.parents.forEach((parent, index) => {
      let target = active.findIndex((item) => item?.hash === parent);
      const parentColor = target >= 0 ? active[target]!.color : index === 0 ? color : nextColor++;
      if (target < 0) {
        target = index === 0 && !active[lane] ? lane : allocate();
        active[target] = { hash: parent, color: parentColor };
      }
      segments.push({ from: lane, to: target, start: 'node', end: 'bottom', color: parentColor });
    });
    lanes = Math.max(lanes, lane + 1, active.length);
    rows.set(commit.hash, { lane, color, segments });
  }
  return { rows, lanes };
}
