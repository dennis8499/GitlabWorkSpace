import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from 'd3-force';

interface LayoutNode extends SimulationNodeDatum { id: string; x: number; y: number; isRoot: boolean; }
type LayoutRequest =
  | { type: 'start'; epoch: number; nodes: LayoutNode[]; links: Array<{ source: string; target: string }>; width: number; height: number; active: boolean }
  | { type: 'activity'; epoch: number; active: boolean }
  | { type: 'pin'; epoch: number; id: string; x: number; y: number; release?: boolean }
  | { type: 'reset'; epoch: number };

let epoch = 0, width = 0, height = 0, active = false, lastFrame = 0;
let nodes: LayoutNode[] = [];
let byId = new Map<string, LayoutNode>();
let simulation: ReturnType<typeof forceSimulation<LayoutNode>> | undefined;
function frame(settled = false): void {
  const now = performance.now();
  if (!settled && now - lastFrame < 32) return;
  lastFrame = now;
  const positions = new Float32Array(nodes.length * 2);
  nodes.forEach((node, index) => { positions[index * 2] = node.x; positions[index * 2 + 1] = node.y; });
  postMessage({ epoch, positions, settled }, { transfer: [positions.buffer] });
}
self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const message = event.data;
  if (message.type === 'start') {
    simulation?.stop(); epoch = message.epoch; nodes = message.nodes; width = message.width; height = message.height; active = message.active;
    byId = new Map(nodes.map(node => [node.id, node]));
    simulation = forceSimulation(nodes)
      .force('charge', forceManyBody<LayoutNode>().strength(-205).distanceMax(520))
      .force('link', forceLink<LayoutNode, { source: string; target: string }>(message.links).id(node => node.id).distance(112).strength(0.34))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide<LayoutNode>(node => (node.isRoot ? 10 : 9) + 11).iterations(2))
      .on('tick', () => frame()).on('end', () => frame(true));
    if (!active) simulation.stop();
    frame(true); return;
  }
  if (message.epoch !== epoch || !simulation) return;
  if (message.type === 'activity') {
    active = message.active;
    if (active) simulation.alpha(Math.max(simulation.alpha(), .16)).alphaTarget(0).restart();
    else simulation.stop();
  } else if (message.type === 'pin') {
    const node = byId.get(message.id); if (!node) return;
    node.x = message.x; node.y = message.y;
    node.fx = message.release ? null : message.x; node.fy = message.release ? null : message.y;
    if (active) simulation.alpha(message.release ? .22 : .17).alphaTarget(message.release ? 0 : .17).restart();
    frame(true);
  } else if (message.type === 'reset') {
    nodes.forEach((node, index) => {
      const angle = index * 2.399963229728653, radius = 28 * Math.sqrt(index + 1);
      node.x = width / 2 + Math.cos(angle) * radius; node.y = height / 2 + Math.sin(angle) * radius;
      node.vx = 0; node.vy = 0; node.fx = null; node.fy = null;
    });
    if (active) simulation.alpha(1).restart();
    frame(true);
  }
};
