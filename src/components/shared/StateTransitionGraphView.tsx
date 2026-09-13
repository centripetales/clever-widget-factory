import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table';
import { apiService } from '@/lib/apiService';
import { formatDimensionValue } from '@/lib/stateDimensions';
import { createInitialPositions, tick, type LayoutNode, type LayoutEdge } from '@/lib/forceLayout';
import { PhotoThumb } from '@/components/shared/PhotoThumb';
import { getThumbnailUrl, getImageUrl, getOriginalUrl } from '@/lib/imageUtils';

interface EvidencePhoto {
  url: string;
  description: string | null;
}
interface EvidenceAction {
  id: string;
  title: string;
}
interface Evidence {
  state_id: string;
  tool_id: string;
  tool_name: string;
  captured_at: string;
  claim: string | null;
  photos: EvidencePhoto[];
  actions: EvidenceAction[];
}
interface EdgeExample {
  tool_name: string;
  from: Evidence;
  to: Evidence | null;
  actions: EvidenceAction[];
  experience_id: string;
}
interface GraphNode {
  key: string;
  value: string;
  state_count: number;
  tool_ids: string[];
  tool_names: string[];
  distinct_org_count: number;
  total_days: number;
  examples: Evidence[];
}
interface GraphEdge {
  from: string;
  to: string;
  count: number;
  tool_ids: string[];
  tool_names: string[];
  examples: EdgeExample[];
}
interface RawExperience {
  experience_id: string;
  tool_id: string;
  tool_name: string;
  initial: { state_id: string; captured_at: string; claim: string | null };
  final: { state_id: string; captured_at: string; claim: string | null } | null;
  actions: EvidenceAction[];
}
interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  experiences: RawExperience[];
}

const MANILA_TZ = 'Asia/Manila';
function formatManilaDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { timeZone: MANILA_TZ, year: 'numeric', month: 'short', day: 'numeric' });
}

function EvidencePhotoRow({ photos }: { photos: EvidencePhoto[] }) {
  if (photos.length === 0) return <p className="text-muted-foreground text-xs">No photos on this observation.</p>;
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {photos.map((photo, i) => (
        <PhotoThumb
          key={i}
          href={getOriginalUrl(photo.url) || getImageUrl(photo.url) || ''}
          src={getThumbnailUrl(photo.url) || getImageUrl(photo.url) || ''}
          alt={photo.description || 'Observation photo'}
          className="w-20 h-20 flex-shrink-0 rounded border"
        />
      ))}
    </div>
  );
}

function EvidenceCard({ evidence }: { evidence: Evidence }) {
  return (
    <div className="space-y-1.5 border rounded-md p-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{evidence.tool_name}</span>
        <span>{formatManilaDate(evidence.captured_at)}</span>
      </div>
      <EvidencePhotoRow photos={evidence.photos} />
      {evidence.claim && <p className="text-xs">{evidence.claim}</p>}
    </div>
  );
}

const WIDTH = 900;
const HEIGHT = 600;
// Wider spacing than the layout defaults — with labels rendered under each
// node, the default spring length packed nodes close enough that
// neighboring labels overlapped into an unreadable mess.
const LAYOUT_OPTIONS = { width: WIDTH, height: HEIGHT, springLength: 240, repulsion: 3200 };

function nodeLabel(node: Pick<GraphNode, 'value'>): string {
  return formatDimensionValue(node.value);
}

export function StateTransitionGraphView({ orgId }: { orgId: string }) {
  const navigate = useNavigate();
  const [showRawData, setShowRawData] = useState(false);
  const [data, setData] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const [selectedPerson, setSelectedPerson] = useState<string>('__all__');

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiService
      .get<GraphResponse>(`/organizations/${orgId}/state-transition-graph`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load graph'))
      .finally(() => setLoading(false));
  }, [orgId]);

  const layoutRef = useRef<Map<string, LayoutNode> | null>(null);
  const [positions, setPositions] = useState<Map<string, LayoutNode>>(new Map());
  const draggingKeyRef = useRef<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // A pointerdown+pointerup with no movement in between still fires a
  // synthetic click afterward — without tracking this, every drag also
  // opened the dragged node's detail dialog. dragStartRef records where the
  // gesture began; hasDraggedRef flips true once movement crosses a small
  // threshold, and the node's onClick checks it before opening anything.
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const hasDraggedRef = useRef(false);
  const DRAG_THRESHOLD = 4;

  // Every distinct container/participant across all nodes+edges, for the
  // "show this person's traversal" filter — highlighting rather than a
  // separate view, per-person path shown on the same shared graph.
  const people = useMemo(() => {
    if (!data) return [];
    const byId = new Map<string, string>();
    for (const n of data.nodes) n.tool_ids.forEach((id, i) => byId.set(id, n.tool_names[i]));
    for (const e of data.edges) e.tool_ids.forEach((id, i) => byId.set(id, e.tool_names[i]));
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  const edgesForLayout: LayoutEdge[] = useMemo(
    () => (data?.edges || []).filter((e) => e.from !== e.to).map((e) => ({ from: e.from, to: e.to, weight: Math.min(e.count, 5) })),
    [data]
  );

  // (Re)seed and run the simulation whenever the node set changes. Runs
  // until movement settles below a threshold, then stops — no continuous
  // redraw loop sitting idle on a phone once the layout is stable (mirrors
  // d3-force's own alpha-cooldown behavior; see src/lib/forceLayout.ts).
  useEffect(() => {
    if (!data) return;
    const keys = data.nodes.map((n) => n.key);
    const existing = layoutRef.current;
    const seeded = createInitialPositions(keys, WIDTH, HEIGHT);
    if (existing) {
      for (const key of keys) {
        const prior = existing.get(key);
        if (prior) seeded.set(key, prior);
      }
    }
    layoutRef.current = seeded;

    let raf: number;
    let stopped = false;
    const step = () => {
      if (stopped || !layoutRef.current) return;
      const movement = tick(layoutRef.current, edgesForLayout, LAYOUT_OPTIONS);
      setPositions(new Map(layoutRef.current));
      if (movement > 0.05) {
        raf = requestAnimationFrame(step);
      }
    };
    raf = requestAnimationFrame(step);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const maxStateCount = Math.max(1, ...(data?.nodes.map((n) => n.state_count) || [1]));
  const maxEdgeCount = Math.max(1, ...(data?.edges.map((e) => e.count) || [1]));

  const isPersonFiltered = selectedPerson !== '__all__';
  const nodeMatchesPerson = (n: GraphNode) => !isPersonFiltered || n.tool_ids.includes(selectedPerson);
  const edgeMatchesPerson = (e: GraphEdge) => !isPersonFiltered || e.tool_ids.includes(selectedPerson);

  const svgPointFromEvent = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * HEIGHT,
    };
  };

  const handlePointerDown = (key: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    draggingKeyRef.current = key;
    hasDraggedRef.current = false;
    dragStartRef.current = svgPointFromEvent(e);
    const node = layoutRef.current?.get(key);
    if (node) node.fixed = true;
    // Generous hit target for touch: the pointer capture below means we
    // keep receiving move/up events even if the finger drifts off the
    // (small) visible circle.
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const key = draggingKeyRef.current;
    if (!key || !layoutRef.current) return;
    const node = layoutRef.current.get(key);
    if (!node) return;
    const { x, y } = svgPointFromEvent(e);
    if (dragStartRef.current) {
      const dx = x - dragStartRef.current.x;
      const dy = y - dragStartRef.current.y;
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) hasDraggedRef.current = true;
    }
    node.x = x;
    node.y = y;
    node.vx = 0;
    node.vy = 0;
    // Keep ticking the rest of the simulation while dragging — node.fixed
    // (set in handlePointerDown) makes tick() skip re-positioning this node
    // itself, so it stays exactly where the pointer is, while every other
    // node keeps responding live. Without this, everything else sat frozen
    // until pointer-up, which lost the actual "pull a node and watch its
    // neighbors react" feel this layout is supposed to have.
    tick(layoutRef.current, edgesForLayout, LAYOUT_OPTIONS);
    setPositions(new Map(layoutRef.current));
  };

  const handlePointerUp = () => {
    const key = draggingKeyRef.current;
    if (key && layoutRef.current) {
      const node = layoutRef.current.get(key);
      if (node) node.fixed = false;
    }
    draggingKeyRef.current = null;
    // Re-heat the simulation briefly so releasing a dragged node settles
    // its neighbors back into place instead of freezing mid-drag.
    let raf: number;
    let ticks = 0;
    const step = () => {
      if (!layoutRef.current || ticks++ > 120) return;
      const movement = tick(layoutRef.current, edgesForLayout, LAYOUT_OPTIONS);
      setPositions(new Map(layoutRef.current));
      if (movement > 0.05) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mr-2" /> Loading graph...
      </div>
    );
  }
  if (error) {
    return <p className="text-destructive p-6">{error}</p>;
  }
  if (!data || data.nodes.length === 0) {
    return <p className="text-muted-foreground p-6">No classified states yet.</p>;
  }

  return (
    <div className="w-full space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-muted-foreground">Highlight:</span>
        <Select value={selectedPerson} onValueChange={setSelectedPerson}>
          <SelectTrigger className="w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Everyone</SelectItem>
            {people.map(([id, name]) => (
              <SelectItem key={id} value={id}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setShowRawData((v) => !v)}>
          {showRawData ? 'Hide raw data' : 'Show raw data'}
        </Button>
      </div>

      <div className="w-full overflow-x-auto">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full h-auto touch-none select-none bg-muted/20 rounded-lg"
          style={{ minHeight: 400, maxHeight: 700 }}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        >
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
            </marker>
          </defs>

          {data.edges.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            const isSelf = edge.from === edge.to;
            const strokeWidth = 1 + (edge.count / maxEdgeCount) * 6;
            const dimmed = !edgeMatchesPerson(edge);
            const strokeClass = dimmed
              ? 'stroke-muted-foreground/15'
              : isPersonFiltered
                ? 'stroke-primary'
                : 'stroke-primary/50 hover:stroke-primary';
            if (isSelf) {
              // Self-loop: a small arc above the node.
              const loopPath = `M ${from.x - 10} ${from.y - from.radius} C ${from.x - 40} ${from.y - from.radius - 50}, ${from.x + 40} ${from.y - from.radius - 50}, ${from.x + 10} ${from.y - from.radius}`;
              return (
                <path
                  key={`${edge.from}=>${edge.to}`}
                  d={loopPath}
                  fill="none"
                  strokeWidth={strokeWidth}
                  className={`cursor-pointer ${strokeClass}`}
                  onClick={() => setSelectedEdge(edge)}
                />
              );
            }
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            // Curve so a->b and b->a (if both exist) don't overlap.
            const midX = (from.x + to.x) / 2 - (dy / dist) * 25;
            const midY = (from.y + to.y) / 2 + (dx / dist) * 25;
            return (
              <path
                key={`${edge.from}=>${edge.to}`}
                d={`M ${from.x} ${from.y} Q ${midX} ${midY} ${to.x} ${to.y}`}
                fill="none"
                markerEnd="url(#arrow)"
                strokeWidth={strokeWidth}
                className={`cursor-pointer ${strokeClass}`}
                onClick={() => setSelectedEdge(edge)}
              />
            );
          })}

          {data.nodes.map((node) => {
            const pos = positions.get(node.key);
            if (!pos) return null;
            const radius = 18 + (node.state_count / maxStateCount) * 22;
            const dimmed = !nodeMatchesPerson(node);
            const circleClass = dimmed
              ? 'fill-muted/40 stroke-muted-foreground/20'
              : isPersonFiltered
                ? 'fill-primary/40 stroke-primary'
                : 'fill-primary/20 stroke-primary';
            const label = nodeLabel(node);
            // Rough per-character width estimate for an 11px label — good
            // enough to size a legible background plate, not pixel-exact.
            const labelWidth = label.length * 5.8 + 10;
            return (
              <g key={node.key} transform={`translate(${pos.x}, ${pos.y})`} opacity={dimmed ? 0.5 : 1}>
                <circle r={radius} className={circleClass} strokeWidth={2} />
                {/* Background plate behind the label — without this, labels
                    from nearby nodes/edges overlap into an unreadable mess
                    once the graph has more than a handful of nodes. */}
                <rect
                  x={-labelWidth / 2}
                  y={radius + 6}
                  width={labelWidth}
                  height={16}
                  rx={4}
                  className="fill-background/90 pointer-events-none"
                />
                <text textAnchor="middle" dy={radius + 17} className="fill-foreground text-[11px] pointer-events-none">
                  {label}
                </text>
                <text textAnchor="middle" dy={5} className="fill-foreground text-[11px] font-medium pointer-events-none">
                  {node.state_count}
                </text>
                {/* Generous invisible hit target, larger than the visible
                    circle so this is tappable on a phone — rendered LAST
                    (on top) so it actually captures clicks/drags over the
                    visible circle itself, not just the thin margin around
                    it. Drawn earlier, it sat underneath the opaque visible
                    circle and silently ate no events at all in the area
                    that matters most. */}
                <circle
                  r={radius + 16}
                  fill="transparent"
                  onPointerDown={handlePointerDown(node.key)}
                  onClick={() => {
                    if (!hasDraggedRef.current) setSelectedNode(node);
                  }}
                  className="cursor-pointer"
                />
              </g>
            );
          })}
        </svg>
      </div>

      <Dialog open={!!selectedNode} onOpenChange={(open) => !open && setSelectedNode(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogClose className="absolute right-4 top-4" />
          {selectedNode && (
            <>
              <DialogHeader>
                <DialogTitle>{nodeLabel(selectedNode)}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <div className="flex gap-4 flex-wrap">
                  <div className="border rounded-md px-3 py-2">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Observations</p>
                    <p className="text-lg font-medium">{selectedNode.state_count}</p>
                  </div>
                  <div className="border rounded-md px-3 py-2">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Containers affected</p>
                    <p className="text-lg font-medium">{selectedNode.distinct_org_count}</p>
                  </div>
                  <div className="border rounded-md px-3 py-2">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Days this state represents</p>
                    <p className="text-lg font-medium">{selectedNode.total_days}</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  "Days" sums, per container, the time until the next check-in while this state was active — the most
                  recent observation isn't counted yet since we don't know how long it will last.
                </p>

                <div className="grid grid-cols-2 gap-4 pt-2 border-t">
                  <div>
                    <p className="font-medium mb-1">Ways in</p>
                    {data.edges.filter((e) => e.to === selectedNode.key).length === 0 && (
                      <p className="text-muted-foreground text-xs">None yet.</p>
                    )}
                    {data.edges
                      .filter((e) => e.to === selectedNode.key)
                      .map((e) => (
                        <button key={`${e.from}=>${e.to}`} className="block text-left text-xs hover:underline" onClick={() => { setSelectedNode(null); setSelectedEdge(e); }}>
                          {nodeLabel(data.nodes.find((n) => n.key === e.from) || { value: '?' })} ({e.count})
                        </button>
                      ))}
                  </div>
                  <div>
                    <p className="font-medium mb-1">Ways out</p>
                    {data.edges.filter((e) => e.from === selectedNode.key).length === 0 && (
                      <p className="text-muted-foreground text-xs">None yet.</p>
                    )}
                    {data.edges
                      .filter((e) => e.from === selectedNode.key)
                      .map((e) => (
                        <button key={`${e.from}=>${e.to}`} className="block text-left text-xs hover:underline" onClick={() => { setSelectedNode(null); setSelectedEdge(e); }}>
                          {nodeLabel(data.nodes.find((n) => n.key === e.to) || { value: '?' })} ({e.count})
                        </button>
                      ))}
                  </div>
                </div>

                <div className="pt-2 border-t space-y-2">
                  <p className="font-medium">Observations in this state</p>
                  {selectedNode.examples.map((ev) => (
                    <EvidenceCard key={ev.state_id} evidence={ev} />
                  ))}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedEdge} onOpenChange={(open) => !open && setSelectedEdge(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogClose className="absolute right-4 top-4" />
          {selectedEdge && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {nodeLabel(data.nodes.find((n) => n.key === selectedEdge.from) || { value: '?' })} &rarr;{' '}
                  {nodeLabel(data.nodes.find((n) => n.key === selectedEdge.to) || { value: '?' })}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <p className="text-muted-foreground">
                  {selectedEdge.count} observation-to-observation transition(s) across {selectedEdge.tool_names.length} container(s): {selectedEdge.tool_names.join(', ')}
                </p>
                <div className="space-y-4 pt-2 border-t">
                  {selectedEdge.examples.map((ex, i) => (
                    <div key={i} className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium text-muted-foreground">{ex.tool_name}</p>
                        {/* Explicit "no action reported" rather than
                            omitting the line, so a genuine absence of
                            reporting isn't confused with there being
                            nothing to show. */}
                        {ex.actions.length > 0 ? (
                          <p className="text-xs">
                            <span className="text-muted-foreground">Action: </span>
                            <span className="font-medium">{ex.actions.map((a) => a.title).join(', ')}</span>
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground italic">No action reported</p>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Before</p>
                          <EvidenceCard evidence={ex.from} />
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">After</p>
                          {ex.to ? (
                            <EvidenceCard evidence={ex.to} />
                          ) : (
                            <p className="text-muted-foreground text-xs italic border rounded-md p-2">
                              In progress — no outcome recorded yet.
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {showRawData && (
        <div className="border rounded-lg overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Container</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Initial state</TableHead>
                <TableHead>Action(s)</TableHead>
                <TableHead>Final state</TableHead>
                <TableHead className="text-right">Edit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.experiences.map((exp) => (
                <TableRow key={exp.experience_id}>
                  <TableCell className="font-medium whitespace-nowrap">{exp.tool_name}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground text-xs">
                    {formatManilaDate(exp.initial.captured_at)}
                  </TableCell>
                  <TableCell className="max-w-xs text-xs">{exp.initial.claim || <span className="text-muted-foreground italic">No claim recorded</span>}</TableCell>
                  <TableCell className="text-xs">
                    {exp.actions.length > 0 ? exp.actions.map((a) => a.title).join(', ') : <span className="text-muted-foreground italic">No action reported</span>}
                  </TableCell>
                  <TableCell className="max-w-xs text-xs">
                    {exp.final ? (exp.final.claim || <span className="text-muted-foreground italic">No claim recorded</span>) : (
                      <span className="text-muted-foreground italic">In progress</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => navigate(`/experiences/${exp.experience_id}`)}>
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
