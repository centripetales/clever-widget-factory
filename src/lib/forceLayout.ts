// Small, hand-rolled 2D force-directed layout — deliberately not d3-force.
// d3-force's complexity (Barnes-Hut quadtree approximation for repulsion)
// exists to make large graphs (hundreds+ nodes) tractable; this graph is
// capped at a few dozen nodes by construction (only tag-combinations that
// actually occur become nodes, docs/specs/azolla-impact-power-model.md §9),
// where the naive O(n^2) version of the same physics is trivially cheap.
// Same algorithm, minus an optimization this graph doesn't need — not a
// lesser version of d3-force, just the small-n case of it. Matches this
// codebase's existing precedent of hand-computing layout rather than
// pulling in a layout library (EnergeiaSchema/CentroidStars.tsx does this
// for a harder, 3D case).

export interface LayoutNode {
  key: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  // Set while the user is dragging this node — pins position, simulation
  // skips physics for it until released.
  fixed?: boolean;
}

export interface LayoutEdge {
  from: string;
  to: string;
  // Higher weight = stronger spring pull (used for higher-count edges).
  weight: number;
}

export interface ForceLayoutOptions {
  width: number;
  height: number;
  repulsion?: number; // how strongly nodes push each other apart
  springLength?: number; // rest length of an edge's spring
  springStrength?: number;
  centerStrength?: number; // pulls the whole graph gently toward center
  damping?: number; // velocity decay per tick, keeps the simulation from oscillating forever
  minMovement?: number; // below this average movement, the simulation is considered settled
}

const DEFAULTS: Required<Omit<ForceLayoutOptions, 'width' | 'height'>> = {
  repulsion: 2400,
  springLength: 140,
  springStrength: 0.02,
  centerStrength: 0.01,
  damping: 0.85,
  minMovement: 0.05,
};

export function createInitialPositions(keys: string[], width: number, height: number): Map<string, LayoutNode> {
  const nodes = new Map<string, LayoutNode>();
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.3;
  keys.forEach((key, i) => {
    // Seed on a circle rather than all at the same point — the simulation
    // still relaxes to a proper layout, but avoids the "everything explodes
    // outward from a single point" transient on the first few ticks.
    const angle = (2 * Math.PI * i) / Math.max(keys.length, 1);
    nodes.set(key, {
      key,
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
      vx: 0,
      vy: 0,
      radius: 24,
    });
  });
  return nodes;
}

// Advances the simulation by one tick, mutating node positions in place.
// Returns the average movement this tick, so the caller can stop animating
// once it drops below `minMovement` (mirrors d3-force's alpha cooldown —
// this doesn't spin the CPU/battery indefinitely once the layout settles).
export function tick(nodes: Map<string, LayoutNode>, edges: LayoutEdge[], opts: ForceLayoutOptions): number {
  const o = { ...DEFAULTS, ...opts };
  const list = [...nodes.values()];
  const cx = opts.width / 2;
  const cy = opts.height / 2;

  const fx = new Map<string, number>();
  const fy = new Map<string, number>();
  for (const n of list) {
    fx.set(n.key, 0);
    fy.set(n.key, 0);
  }

  // Pairwise repulsion — O(n^2), fine at this node count (see file header).
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 1) {
        // Nodes on top of each other: nudge apart in a deterministic-ish
        // direction rather than dividing by ~zero.
        dx = (i - j) || 1;
        dy = (j - i) || 1;
        distSq = dx * dx + dy * dy;
      }
      const dist = Math.sqrt(distSq);
      const force = o.repulsion / distSq;
      const fxContribution = (dx / dist) * force;
      const fyContribution = (dy / dist) * force;
      fx.set(a.key, fx.get(a.key)! + fxContribution);
      fy.set(a.key, fy.get(a.key)! + fyContribution);
      fx.set(b.key, fx.get(b.key)! - fxContribution);
      fy.set(b.key, fy.get(b.key)! - fyContribution);
    }
  }

  // Springs along edges — pulls connected nodes toward springLength apart,
  // stronger for higher-weight (higher-count) edges.
  for (const edge of edges) {
    const a = nodes.get(edge.from);
    const b = nodes.get(edge.to);
    if (!a || !b || a === b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const displacement = dist - o.springLength;
    const force = displacement * o.springStrength * edge.weight;
    const fxContribution = (dx / dist) * force;
    const fyContribution = (dy / dist) * force;
    fx.set(a.key, fx.get(a.key)! + fxContribution);
    fy.set(a.key, fy.get(a.key)! + fyContribution);
    fx.set(b.key, fx.get(b.key)! - fxContribution);
    fy.set(b.key, fy.get(b.key)! - fyContribution);
  }

  // Gentle center gravity so the whole graph doesn't drift off-screen.
  for (const n of list) {
    fx.set(n.key, fx.get(n.key)! + (cx - n.x) * o.centerStrength);
    fy.set(n.key, fy.get(n.key)! + (cy - n.y) * o.centerStrength);
  }

  let totalMovement = 0;
  for (const n of list) {
    if (n.fixed) continue;
    n.vx = (n.vx + fx.get(n.key)!) * o.damping;
    n.vy = (n.vy + fy.get(n.key)!) * o.damping;
    n.x += n.vx;
    n.y += n.vy;
    totalMovement += Math.abs(n.vx) + Math.abs(n.vy);
  }

  return list.length ? totalMovement / list.length : 0;
}

export { DEFAULTS as FORCE_DEFAULTS };
