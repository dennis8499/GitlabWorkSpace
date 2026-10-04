/** @jsxImportSource preact */
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force';
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { GitLabIssueBoard, GitLabProject } from '../api/types';
import type { IssueRelationAction, IssueRelationsData } from '../issues/protocol';
import type { IssueGraphEdge, IssueGraphNode } from '../workspace/issueGraph';
import type { IssueGraphSnapshot } from '../workspace/issueGraph';
import { issueGraphBoardColor } from '../workspace/issueGraph';
import { IssueRelationsEditor } from './issue-relations';

export interface GraphPosition { x: number; y: number; }
export interface GraphCamera { x: number; y: number; scale: number; }

interface SimNode extends IssueGraphNode, SimulationNodeDatum {
  x: number;
  y: number;
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  id: string;
  source: string | SimNode;
  target: string | SimNode;
  type: IssueGraphEdge['type'];
}

interface IssueGraphProps {
  nodes: IssueGraphNode[];
  edges: IssueGraphEdge[];
  boards: GitLabIssueBoard[];
  boardStatuses: IssueGraphSnapshot['boardStatus'];
  boardLoadError?: string;
  projects: GitLabProject[];
  matchingRoots: Set<string>;
  selectedId?: string;
  initialPositions: Record<string, GraphPosition>;
  initialCamera: GraphCamera;
  animationEnabled: boolean;
  active: boolean;
  onAnimationEnabledChange: (enabled: boolean) => void;
  onPositionsChange: (positions: Record<string, GraphPosition>) => void;
  onCameraChange: (camera: GraphCamera) => void;
  onSelect: (id: string) => void;
  onOpenIssue: (node: IssueGraphNode) => void;
  relations?: IssueRelationsData;
  relationBusy?: boolean;
  relationError?: string;
  relationMutationApplied?: boolean;
  onLoadRelations?: () => void;
  onRelationAction?: (action: IssueRelationAction) => void;
  onOpenLink?: (url: string) => void;
}

const MIN_SCALE = 0.12;
const MAX_SCALE = 3.5;
const NODE_R = 10;

export function IssueGraphView(props: IssueGraphProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const sceneRef = useRef<SVGGElement>(null);
  const nodeElementsRef = useRef(new Map<string, SVGGElement>());
  const edgeElementsRef = useRef(new Map<string, SVGLineElement>());
  const positionsRef = useRef<Record<string, GraphPosition>>(props.initialPositions);
  const onPositionsChangeRef = useRef(props.onPositionsChange);
  onPositionsChangeRef.current = props.onPositionsChange;
  const onCameraChangeRef = useRef(props.onCameraChange);
  onCameraChangeRef.current = props.onCameraChange;
  const cameraRef = useRef<GraphCamera>({ ...props.initialCamera, scale: clamp(props.initialCamera.scale, MIN_SCALE, MAX_SCALE) });
  const pointerRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const dragRef = useRef<{ pointerId: number; id: string; mode: 'node' | 'pan'; startX: number; startY: number; originX: number; originY: number }>();
  const simulationRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null);
  const simulatedNodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const dimensionsRef = useRef({ width: 960, height: 580 });
  const requestRef = useRef<number>();
  const saveTimerRef = useRef<number>();
  const cameraTimerRef = useRef<number>();
  const [dimensions, setDimensions] = useState(dimensionsRef.current);
  const [systemReducedMotion, setSystemReducedMotion] = useState(() => prefersReducedMotion());
  const [zoom, setZoom] = useState(cameraRef.current.scale);
  const projectById = useMemo(() => new Map(props.projects.map((project) => [project.id, project])), [props.projects]);
  const boardById = useMemo(() => new Map(props.boards.map((board) => [board.id, board])), [props.boards]);
  const effectiveAnimation = props.animationEnabled && !systemReducedMotion;
  const runSimulation = effectiveAnimation && props.active && document.visibilityState !== 'hidden';
  const selected = props.nodes.find((node) => node.id === props.selectedId);
  const rootCount = props.nodes.filter((node) => node.isRoot).length;
  const contextCount = props.nodes.length - rootCount;
  const nodeLayoutKey = props.nodes.map((node) => `${node.id}:${node.isRoot ? 'root' : 'context'}`).join('|');
  const edgeKey = props.edges.map((edge) => edge.id).join('|');
  const adjacentIds = useMemo(() => {
    const ids = new Set<string>();
    if (props.selectedId) {
      ids.add(props.selectedId);
      for (const edge of props.edges) {
        if (edge.source === props.selectedId) ids.add(edge.target);
        if (edge.target === props.selectedId) ids.add(edge.source);
      }
    }
    return ids;
  }, [edgeKey, props.selectedId]);

  const saveCamera = (next: GraphCamera): void => {
    cameraRef.current = next;
    setZoom(next.scale);
    if (cameraTimerRef.current !== undefined) window.clearTimeout(cameraTimerRef.current);
    cameraTimerRef.current = window.setTimeout(() => onCameraChangeRef.current({ ...cameraRef.current }), 320);
    drawFrame();
  };

  const savePositions = (): void => {
    const next = Object.fromEntries(simulatedNodesRef.current.flatMap((node) =>
      Number.isFinite(node.x) && Number.isFinite(node.y) ? [[node.id, { x: node.x, y: node.y }]] : []
    ));
    positionsRef.current = next;
    onPositionsChangeRef.current(next);
  };

  const schedulePositionSave = (): void => {
    if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(savePositions, 700);
  };

  function drawFrame(): void {
    if (requestRef.current !== undefined) return;
    requestRef.current = window.requestAnimationFrame(() => {
      requestRef.current = undefined;
      drawNow();
    });
  }

  function drawNow(): void {
    const scene = sceneRef.current;
    if (!scene) return;
    const camera = cameraRef.current;
    scene.setAttribute('transform', `translate(${camera.x} ${camera.y}) scale(${camera.scale})`);
    const centers = new Map<string, { x: number; y: number }>();
    for (const node of simulatedNodesRef.current) {
      const baseX = node.x;
      const baseY = node.y;
      const point = pointerRef.current;
      let offsetX = 0;
      let offsetY = 0;
      if (effectiveAnimation && point.active && dragRef.current?.mode !== 'node') {
        const dx = baseX - point.x;
        const dy = baseY - point.y;
        const distance = Math.hypot(dx, dy);
        const radius = 128 / camera.scale;
        if (distance < radius) {
          const force = Math.min(8 / camera.scale, (radius - distance) * 0.1);
          const angle = stableAngle(node.id);
          offsetX = (dx / (distance || 1) || Math.cos(angle)) * force;
          offsetY = (dy / (distance || 1) || Math.sin(angle)) * force;
        }
      }
      const x = baseX + offsetX;
      const y = baseY + offsetY;
      centers.set(node.id, { x, y });
      nodeElementsRef.current.get(node.id)?.setAttribute('transform', `translate(${x} ${y})`);
    }
    for (const link of linksRef.current) {
      const source = typeof link.source === 'string' ? centers.get(link.source) : centers.get(link.source.id);
      const target = typeof link.target === 'string' ? centers.get(link.target) : centers.get(link.target.id);
      const line = edgeElementsRef.current.get(link.id);
      if (!line || !source || !target) continue;
      line.setAttribute('x1', String(source.x));
      line.setAttribute('y1', String(source.y));
      line.setAttribute('x2', String(target.x));
      line.setAttribute('y2', String(target.y));
    }
  }

  useEffect(() => {
    const host = viewportRef.current;
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(320, rect.width || 960);
      const height = Math.max(300, rect.height || 580);
      if (width === dimensionsRef.current.width && height === dimensionsRef.current.height) return;
      dimensionsRef.current = { width, height };
      setDimensions(dimensionsRef.current);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) => setSystemReducedMotion(event.matches);
    setSystemReducedMotion(query.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);

  useEffect(() => {
    const previousPositions = positionsRef.current;
    const width = dimensionsRef.current.width;
    const height = dimensionsRef.current.height;
    const centerX = width / 2;
    const centerY = height / 2;
    const nodes: SimNode[] = props.nodes.map((node, index) => {
      const stored = previousPositions[node.id] ?? props.initialPositions[node.id];
      const angle = index * 2.399963229728653;
      const radius = 28 * Math.sqrt(index + 1);
      return {
        ...node,
        index,
        x: stored?.x ?? centerX + Math.cos(angle) * radius,
        y: stored?.y ?? centerY + Math.sin(angle) * radius,
        vx: 0,
        vy: 0
      };
    });
    const links: SimLink[] = props.edges.map((edge) => ({ ...edge, source: edge.source, target: edge.target }));
    const simulation = forceSimulation<SimNode>(nodes)
      .force('charge', forceManyBody<SimNode>().strength(-205).distanceMax(520))
      .force('link', forceLink<SimNode, SimLink>(links).id((node) => node.id).distance(112).strength(0.34))
      .force('center', forceCenter(centerX, centerY))
      .force('collide', forceCollide<SimNode>((node) => (node.isRoot ? NODE_R : NODE_R - 1) + 11).iterations(2));
    simulatedNodesRef.current = nodes;
    linksRef.current = links;
    simulationRef.current = simulation;
    simulation.on('tick', drawFrame);
    simulation.on('end', schedulePositionSave);
    if (!runSimulation) simulation.stop();
    drawFrame();

    return () => {
      simulation.stop();
      simulation.on('tick', null);
      simulation.on('end', null);
      if (requestRef.current !== undefined) window.cancelAnimationFrame(requestRef.current);
      requestRef.current = undefined;
      positionsRef.current = Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
    };
  }, [nodeLayoutKey, edgeKey, dimensions.width, dimensions.height]);

  useEffect(() => {
    const simulation = simulationRef.current;
    if (!simulation) return;
    if (runSimulation) simulation.alpha(Math.max(simulation.alpha(), 0.16)).alphaTarget(0).restart();
    else simulation.stop();
    drawFrame();
  }, [runSimulation]);

  useEffect(() => {
    const onVisibilityChange = () => {
      const simulation = simulationRef.current;
      if (!simulation) return;
      if (document.visibilityState === 'hidden' || !props.active || !effectiveAnimation) simulation.stop();
      else simulation.alpha(Math.max(simulation.alpha(), 0.16)).restart();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [props.active, effectiveAnimation]);

  useEffect(() => () => {
    if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current);
    if (cameraTimerRef.current !== undefined) window.clearTimeout(cameraTimerRef.current);
    savePositions();
    onCameraChangeRef.current({ ...cameraRef.current });
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onPointerMove = (event: PointerEvent) => {
      const rect = svg.getBoundingClientRect();
      const drag = dragRef.current;
      if (drag?.pointerId === event.pointerId && drag.mode === 'pan') {
        saveCamera({ ...cameraRef.current, x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY });
        return;
      }
      const scaleX = rect.width ? dimensionsRef.current.width / rect.width : 1;
      const scaleY = rect.height ? dimensionsRef.current.height / rect.height : 1;
      const screenX = (event.clientX - rect.left) * scaleX;
      const screenY = (event.clientY - rect.top) * scaleY;
      if (drag?.pointerId === event.pointerId && drag.mode === 'node') {
        const node = simulatedNodesRef.current.find((item) => item.id === drag.id);
        if (!node) return;
        const x = (screenX - cameraRef.current.x) / cameraRef.current.scale;
        const y = (screenY - cameraRef.current.y) / cameraRef.current.scale;
        node.fx = x;
        node.fy = y;
        node.x = x;
        node.y = y;
        if (!effectiveAnimation) { node.fx = null; node.fy = null; }
        schedulePositionSave();
        drawFrame();
        return;
      }
      pointerRef.current = {
        x: (screenX - cameraRef.current.x) / cameraRef.current.scale,
        y: (screenY - cameraRef.current.y) / cameraRef.current.scale,
        active: true
      };
      drawFrame();
    };
    const onPointerEnd = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = undefined;
      if (drag.mode === 'node') {
        const node = simulatedNodesRef.current.find((item) => item.id === drag.id);
        if (node) {
          node.fx = null;
          node.fy = null;
        }
        if (runSimulation) simulationRef.current?.alpha(0.22).alphaTarget(0).restart();
        schedulePositionSave();
      }
      drawFrame();
    };
    const onPointerLeave = () => {
      if (dragRef.current) return;
      pointerRef.current.active = false;
      drawFrame();
    };
    svg.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
    svg.addEventListener('pointerleave', onPointerLeave);
    return () => {
      svg.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      svg.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [dimensions.width, dimensions.height, effectiveAnimation, runSimulation]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const ratioX = rect.width ? dimensionsRef.current.width / rect.width : 1;
      const ratioY = rect.height ? dimensionsRef.current.height / rect.height : 1;
      const focusX = (event.clientX - rect.left) * ratioX;
      const focusY = (event.clientY - rect.top) * ratioY;
      const current = cameraRef.current;
      const nextScale = clamp(current.scale * Math.exp(-event.deltaY * 0.001), MIN_SCALE, MAX_SCALE);
      const graphX = (focusX - current.x) / current.scale;
      const graphY = (focusY - current.y) / current.scale;
      saveCamera({ scale: nextScale, x: focusX - graphX * nextScale, y: focusY - graphY * nextScale });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const fitGraph = (): void => {
    const nodes = simulatedNodesRef.current;
    if (!nodes.length) { saveCamera({ x: 0, y: 0, scale: 1 }); return; }
    const minX = Math.min(...nodes.map((node) => node.x));
    const maxX = Math.max(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxY = Math.max(...nodes.map((node) => node.y));
    const padding = 92;
    const scale = clamp(Math.min((dimensions.width - padding * 2) / Math.max(100, maxX - minX), (dimensions.height - padding * 2) / Math.max(100, maxY - minY)), MIN_SCALE, 1.5);
    saveCamera({ scale, x: dimensions.width / 2 - ((minX + maxX) / 2) * scale, y: dimensions.height / 2 - ((minY + maxY) / 2) * scale });
  };

  const zoomBy = (factor: number): void => {
    const focusX = dimensionsRef.current.width / 2;
    const focusY = dimensionsRef.current.height / 2;
    const current = cameraRef.current;
    const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
    const graphX = (focusX - current.x) / current.scale;
    const graphY = (focusY - current.y) / current.scale;
    saveCamera({ scale, x: focusX - graphX * scale, y: focusY - graphY * scale });
  };

  const resetLayout = (): void => {
    positionsRef.current = {};
    const simulation = simulationRef.current;
    if (simulation) {
      const { width, height } = dimensionsRef.current;
      simulatedNodesRef.current.forEach((node, index) => {
        const angle = index * 2.399963229728653;
        const radius = 28 * Math.sqrt(index + 1);
        node.x = width / 2 + Math.cos(angle) * radius;
        node.y = height / 2 + Math.sin(angle) * radius;
        node.vx = 0; node.vy = 0; node.fx = null; node.fy = null;
      });
      if (runSimulation) simulation.alpha(1).restart();
      else simulation.stop();
      drawFrame();
    }
    saveCamera({ x: 0, y: 0, scale: 1 });
    savePositions();
  };

  const startNodeDrag = (event: PointerEvent, id: string): void => {
    event.stopPropagation();
    event.preventDefault();
    const node = simulatedNodesRef.current.find((item) => item.id === id);
    if (!node) return;
    dragRef.current = { pointerId: event.pointerId, id, mode: 'node', startX: event.clientX, startY: event.clientY, originX: node.x, originY: node.y };
    node.fx = node.x;
    node.fy = node.y;
    if (effectiveAnimation) simulationRef.current?.alphaTarget(0.17).restart();
  };

  const startPan = (event: PointerEvent): void => {
    if (event.button !== 0 || (event.target as Element).closest?.('.graph-node')) return;
    dragRef.current = { pointerId: event.pointerId, id: '', mode: 'pan', startX: event.clientX, startY: event.clientY, originX: cameraRef.current.x, originY: cameraRef.current.y };
  };

  const shortenedTitle = (title: string): string => title.length > 25 ? `${title.slice(0, 23)}…` : title;
  const boardCountLabel = `${rootCount} 張主要 Issue · ${contextCount} 張關聯項目`;

  return <section class="issue-graph-workspace" aria-label="Issue 關聯圖譜">
    <div class="issue-graph-main">
      <div class="issue-graph-toolbar" aria-label="圖譜工具">
        <span class="graph-tally">{boardCountLabel}</span>
        <span class="graph-zoom">{Math.round(zoom * 100)}%</span>
        <button class="quiet small graph-zoom-button" type="button" onClick={() => zoomBy(0.8)} aria-label="縮小圖譜">−</button>
        <button class="quiet small graph-zoom-button" type="button" onClick={() => zoomBy(1.25)} aria-label="放大圖譜">＋</button>
        <button class="quiet small" type="button" onClick={fitGraph} aria-label="符合畫面">適合畫面</button>
        <button class="quiet small" type="button" onClick={resetLayout}>重設佈局</button>
        <label class="graph-animation-toggle"><input type="checkbox" checked={effectiveAnimation} disabled={systemReducedMotion} onChange={(event) => props.onAnimationEnabledChange(event.currentTarget.checked)} /><span>{systemReducedMotion ? '系統已減少動態效果' : '跟隨動畫'}</span></label>
      </div>
      <div class="issue-graph-viewport" ref={viewportRef}>
        {!props.nodes.length && <div class="graph-empty" role="status"><strong>{props.nodes.length === 0 && props.edges.length === 0 ? '目前篩選條件沒有符合的 Issue' : '沒有可顯示的關聯'}</strong><p>調整篩選或更新 GitLab 資料後再試。</p></div>}
        <svg ref={svgRef} class="issue-graph-svg" role="img" aria-label={`Issue 關聯圖譜，${rootCount} 張主要 Issue、${contextCount} 張關聯工作`} viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} onPointerDown={startPan}>
          <defs>
            <marker id="issue-graph-arrow-blocks" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="graph-marker-blocks" /></marker>
            <marker id="issue-graph-arrow-parent" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="graph-marker-parent" /></marker>
          </defs>
          <g ref={sceneRef}>
            {props.edges.map((edge) => <line
              key={edge.id}
              ref={(element) => { if (element) edgeElementsRef.current.set(edge.id, element); else edgeElementsRef.current.delete(edge.id); }}
              class={`graph-edge graph-edge-${edge.type} ${props.selectedId && (edge.source === props.selectedId || edge.target === props.selectedId) ? 'selected' : ''} ${props.selectedId && edge.source !== props.selectedId && edge.target !== props.selectedId ? 'dimmed' : ''}`}
              marker-end={edge.type === 'blocks' ? 'url(#issue-graph-arrow-blocks)' : edge.type === 'parent' ? 'url(#issue-graph-arrow-parent)' : undefined}
            />)}
            {props.nodes.map((node) => {
              const boardColors = node.boardIds.map((id) => issueGraphBoardColor(id));
              const matchingRoot = node.isRoot && props.matchingRoots.has(node.id);
              const selectedNode = node.id === props.selectedId;
              const hasBoardLoading = Object.values(props.boardStatuses).some((item) => item.status === 'loading');
              const hasBoardFailure = !!props.boardLoadError || Object.values(props.boardStatuses).some((item) => item.status === 'error');
              return <g
                key={node.id}
                ref={(element) => { if (element) nodeElementsRef.current.set(node.id, element); else nodeElementsRef.current.delete(node.id); }}
                class={`graph-node ${matchingRoot ? 'primary' : 'context'} ${node.boardIds.length ? '' : 'boardless'} ${node.boardIds.length ? '' : hasBoardLoading ? 'board-loading' : hasBoardFailure ? 'board-error' : 'no-board'} ${node.assignedToMe ? 'assigned' : 'unassigned'} ${node.state === 'closed' ? 'closed' : ''} ${matchingRoot ? 'root-match' : ''} ${selectedNode ? 'selected' : ''} ${props.selectedId && !adjacentIds.has(node.id) ? 'dimmed' : ''}`}
                role="button"
                tabIndex={0}
                aria-pressed={selectedNode}
                aria-label={`${matchingRoot ? '符合篩選的主要 Issue' : `關聯${kindName(node.kind)}${node.isRoot ? ' · 不符合篩選' : ''}`}，${projectById.get(node.projectId ?? 0)?.path_with_namespace ?? node.namespacePath} #${node.iid}，${node.title}${node.boardIds.length ? `，${node.boardIds.map((id) => boardById.get(id)?.name ?? `Board #${id}`).join('、')}` : `，${hasBoardLoading ? 'Board 歸屬載入中' : hasBoardFailure ? 'Board 歸屬讀取失敗' : '沒有 Group Board 歸屬'}`}`}
                onPointerDown={(event) => startNodeDrag(event as unknown as PointerEvent, node.id)}
                onClick={() => props.onSelect(node.id)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onSelect(node.id); } }}
              >
                <title>{node.title}</title>
                {boardColors.length <= 1
                  ? <circle class="graph-node-core" r={NODE_R} fill={boardColors[0] ?? '#777982'} />
                  : boardColors.map((color, index) => <path class="graph-node-sector" d={pieSector(boardColors.length, index, NODE_R)} fill={color} key={`${node.id}:board:${node.boardIds[index]}`} />)}
                {node.labels.map((label, index) => {
                  const color = safeGitLabColor(label.color, index);
                  return <path class="graph-label-sector" d={ringSector(node.labels.length, index, NODE_R + 3, NODE_R + 7)} fill={color} key={`${node.id}:label:${label.name}`} />;
                })}
                {node.state === 'closed' && <path class="graph-closed-mark" d="M -4 0 L -1 3 L 5 -4" />}
                <text class={`graph-node-caption ${selectedNode ? 'selected' : ''} ${zoom < 0.55 && !selectedNode ? 'zoomed-out' : ''}`} text-anchor="middle" y={NODE_R + 20}>{`#${node.iid} ${selectedNode || zoom >= 0.9 ? node.title : shortenedTitle(node.title)}`}</text>
                {!node.assignedToMe && <text class={`graph-context-mark ${zoom < 0.55 && !selectedNode ? 'zoomed-out' : ''}`} text-anchor="middle" y={NODE_R + 34}>關聯工作</text>}
              </g>;
            })}
          </g>
        </svg>
      </div>
      <div class="graph-board-legend" aria-label="Issue Board 顏色圖例">
        {props.boards.map((board) => <span class="graph-legend-item" key={board.id}><i style={{ backgroundColor: issueGraphBoardColor(board.id) }} />{board.name}</span>)}
        {!props.boards.length && <span class="subtle">沒有可用的 Group Issue Board</span>}
        {props.boardLoadError && <span class="graph-board-fetch error" role="status" title={props.boardLoadError}>Board 清單讀取失敗</span>}
        {props.boards.map((board) => props.boardStatuses[board.id]?.status === 'loading'
          ? <span class="graph-board-fetch" key={`fetch:${board.id}`} role="status">{board.name}：載入歸屬中</span>
          : props.boardStatuses[board.id]?.status === 'error'
            ? <span class="graph-board-fetch error" key={`fetch:${board.id}`} role="status" title={props.boardStatuses[board.id].error}>{board.name}：讀取失敗</span>
            : null)}
        <span class="graph-legend-rule"><i class="graph-label-legend" />Label 色環</span>
        <span class="graph-legend-rule"><i class="graph-context-legend" />未指派給我</span>
      </div>
    </div>

    <details class="issue-graph-detail" open>
      <summary>Issue 摘要</summary>
      {selected ? <div class="graph-selected-detail">
        <span class="eyebrow">{props.matchingRoots.has(selected.id) ? '符合篩選 · 指派給我的 Issue' : `一層關聯${kindName(selected.kind)}${selected.isRoot ? ' · 不符合篩選' : ''} · ${selected.assignedToMe ? '也指派給我' : '未指派給我'}`}</span>
        <h2>{selected.title}</h2>
        <span class="subtle">{projectById.get(selected.projectId ?? 0)?.path_with_namespace ?? selected.namespacePath} #{selected.iid}</span>
        <div class="graph-detail-state"><span class={`state ${selected.state === 'closed' ? 'closed' : 'opened'}`}>{selected.state === 'closed' ? '已結案' : '未結案'}</span><span class="subtle">{kindName(selected.kind)}</span></div>
        <div class="graph-detail-section"><strong>Issue Board</strong>{selected.boardIds.length
          ? selected.boardIds.map((boardId) => <span class="graph-board-chip" key={boardId}><i style={{ backgroundColor: issueGraphBoardColor(boardId) }} />{boardById.get(boardId)?.name ?? `Board #${boardId}`}</span>)
          : <span class="subtle">{props.boardLoadError || selected.isRoot && Object.values(props.boardStatuses).some((item) => item.status === 'error') ? 'Board 歸屬讀取失敗' : selected.isRoot && Object.values(props.boardStatuses).some((item) => item.status === 'loading') ? '正在載入 Board 歸屬' : '無 Group Board 歸屬'}</span>}</div>
        <div class="graph-detail-section"><strong>Labels</strong>{selected.labels.length
          ? <div class="graph-detail-labels">{selected.labels.map((label, index) => <span class="graph-label-chip" style={{ borderColor: safeGitLabColor(label.color, index), color: safeGitLabColor(label.textColor, index) }} key={`${selected.id}:label:${label.name}`}>{label.name}</span>)}</div>
          : <span class="subtle">沒有 Labels</span>}</div>
        <div class="graph-detail-section"><strong>指派對象</strong>{selected.assignees.length
          ? selected.assignees.map((assignee) => <span class="subtle" key={`${selected.id}:assignee:${assignee.id}`}>{assignee.name}</span>)
          : <span class="subtle">未指派</span>}</div>
        <div class="graph-related-list"><strong>直接關聯</strong>{props.edges.filter((edge) => edge.source === selected.id || edge.target === selected.id).map((edge) => {
          const related = props.nodes.find((node) => node.id === (edge.source === selected.id ? edge.target : edge.source));
          return related ? <button class="graph-related-link" key={edge.id} type="button" onClick={() => props.onSelect(related.id)}><span>{edge.type === 'parent' ? edge.source === selected.id ? '子項' : '父項' : edge.type === 'blocks' ? edge.source === selected.id ? '阻擋' : '阻擋此 Issue' : '關聯'}</span><span>{`#${related.iid} ${related.title}`}</span></button> : null;
        })}{!props.edges.some((edge) => edge.source === selected.id || edge.target === selected.id) && <span class="subtle">沒有已載入的直接關聯</span>}</div>
        {selected.relationsStatus === 'loading' && <span class="subtle" role="status">正在載入關聯…</span>}
        {selected.relationsStatus === 'error' && <span class="warning" role="status">部分關聯無法載入；可重試「更新資料」。</span>}
        {selected.kind === 'issue' && selected.projectId !== undefined && props.onRelationAction && props.onLoadRelations && props.onOpenLink && <IssueRelationsEditor
          key={selected.id} issue={{ id: selected.id, project_id: selected.projectId, iid: Number(selected.iid), title: selected.title }}
          data={props.relations?.issue.project_id === selected.projectId && props.relations.issue.iid === Number(selected.iid) ? props.relations : undefined}
          projects={props.projects} busy={props.relationBusy} error={props.relationError} mutationApplied={props.relationMutationApplied}
          onReload={props.onLoadRelations} onAction={props.onRelationAction} onOpenLink={props.onOpenLink} />}
        {selected.webUrl && <button class="primary" type="button" onClick={() => props.onOpenIssue(selected)}>{selected.kind === 'issue' && selected.projectId !== undefined ? '開啟 Issue 詳情' : '在 GitLab 開啟'}</button>}
      </div> : <div class="graph-no-selection"><span class="empty-mark">◇</span><p>選取一個節點，查看 Issue 狀態與關聯。</p></div>}
      <div class="graph-relation-legend" aria-label="關聯線條圖例"><strong>關聯線條</strong><span><i class="parent-line" />父項目與 Child Items</span><span><i class="block-line" />阻擋關係</span><span><i class="related-line" />一般 Linked Item</span></div>
    </details>
  </section>;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }

function stableAngle(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0) / 0xffffffff * Math.PI * 2;
}

function safeGitLabColor(color: string | null | undefined, seed: number): string {
  if (color && /^#[0-9a-f]{6}$/i.test(color)) return color;
  return ['#77a7ee', '#d79050', '#6eb99b', '#c183cf', '#d57889'][seed % 5];
}

function kindName(kind: IssueGraphNode['kind']): string {
  return kind === 'epic' ? 'Epic' : kind === 'task' ? 'Child Item' : 'Issue';
}

function pieSector(count: number, index: number, radius: number): string {
  const start = -Math.PI / 2 + index * Math.PI * 2 / count;
  const end = -Math.PI / 2 + (index + 1) * Math.PI * 2 / count;
  const x1 = Math.cos(start) * radius;
  const y1 = Math.sin(start) * radius;
  const x2 = Math.cos(end) * radius;
  const y2 = Math.sin(end) * radius;
  return `M 0 0 L ${x1} ${y1} A ${radius} ${radius} 0 ${end - start > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`;
}

function ringSector(count: number, index: number, inner: number, outer: number): string {
  const start = -Math.PI / 2 + index * Math.PI * 2 / count + 0.025;
  const end = -Math.PI / 2 + (index + 1) * Math.PI * 2 / count - 0.025;
  if (end <= start) return '';
  const large = end - start > Math.PI ? 1 : 0;
  const point = (radius: number, angle: number) => `${Math.cos(angle) * radius} ${Math.sin(angle) * radius}`;
  return `M ${point(inner, start)} L ${point(outer, start)} A ${outer} ${outer} 0 ${large} 1 ${point(outer, end)} L ${point(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${point(inner, start)} Z`;
}
