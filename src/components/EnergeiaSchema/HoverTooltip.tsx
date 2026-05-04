import type { ActionPoint, ClusterInfo, EnergyWeights } from '@/types/energeia';
import { barycentricColor, ENERGY_TYPE_COLORS } from './ActionPointCloud';

const ENERGY_LABELS: Record<string, string> = {
  dynamis:   'Dynamis',
  oikonomia: 'Oikonomia',
  techne:    'Techne',
};

// Legacy map for cached data that still has old names
const LEGACY_ENERGY_LABELS: Record<string, { label: string; color: string }> = {
  growth:              { label: 'Dynamis',   color: '#00e5ff' },
  maintenance:         { label: 'Oikonomia', color: '#4f46e5' },
  hexis:               { label: 'Oikonomia', color: '#4f46e5' },
  process_improvement: { label: 'Techne',    color: '#a855f7' },
};

function resolveEnergyLabel(energy_type: string): { label: string; color: string } {
  if (energy_type in ENERGY_TYPE_COLORS) {
    return { label: ENERGY_LABELS[energy_type], color: ENERGY_TYPE_COLORS[energy_type] };
  }
  return LEGACY_ENERGY_LABELS[energy_type] ?? { label: energy_type, color: '#6b7280' };
}

/** Resolve energy weights — use stored weights or synthesize from discrete type. */
function resolveWeights(point: ActionPoint): EnergyWeights {
  if (point.energy_weights) return point.energy_weights;
  const LEGACY_MAP: Record<string, keyof EnergyWeights> = {
    growth: 'dynamis', maintenance: 'oikonomia', hexis: 'oikonomia', process_improvement: 'techne',
  };
  const key: keyof EnergyWeights =
    (point.energy_type in { dynamis: 1, oikonomia: 1, techne: 1 }
      ? point.energy_type
      : LEGACY_MAP[point.energy_type] ?? 'oikonomia') as keyof EnergyWeights;
  return { dynamis: 0, oikonomia: 0, techne: 0, [key]: 1 } as EnergyWeights;
}

interface HoverTooltipProps {
  hoveredPoint: ActionPoint | null;
  hoveredCluster: ClusterInfo | null;
  clusters: ClusterInfo[];
}

export function buildTooltipContent(
  point: ActionPoint,
  clusters: ClusterInfo[]
): { actionTitle: string; personName: string; clusterTitle: string } {
  const cluster = clusters.find((c) => c.id === point.cluster_id);
  return {
    actionTitle: point.action_title,
    personName: point.person_name,
    clusterTitle: cluster?.title ?? `Cluster ${point.cluster_id}`,
  };
}

const STATUS_STYLES: Record<string, { className: string; label: string }> = {
  completed:   { className: 'bg-green-500/20 text-green-300',  label: 'Completed' },
  in_progress: { className: 'bg-amber-500/20 text-amber-300',  label: 'In Progress' },
  not_started: { className: 'bg-zinc-500/20 text-zinc-400',    label: 'Not Started' },
};

const ENERGY_SEGMENTS: { key: keyof EnergyWeights; label: string; color: string }[] = [
  { key: 'dynamis',   label: 'Dynamis',   color: '#00e5ff' },
  { key: 'oikonomia', label: 'Oikonomia', color: '#4f46e5' },
  { key: 'techne',    label: 'Techne',    color: '#a855f7' },
];

/** Mini proportional bar + percentage labels for energy weights. */
function EnergyBreakdown({ weights }: { weights: EnergyWeights }) {
  const blendColor = barycentricColor(weights);
  const segments = ENERGY_SEGMENTS.map(s => ({
    ...s,
    pct: Math.round(weights[s.key] * 100),
  })).filter(s => s.pct > 0);

  return (
    <div className="pt-1 space-y-1">
      {/* Blended color swatch + proportional bar */}
      <div className="flex h-2 w-full rounded-full overflow-hidden gap-px">
        {segments.map(({ key, color, pct }) => (
          <div
            key={key}
            style={{ width: `${pct}%`, backgroundColor: color }}
            className="h-full"
          />
        ))}
      </div>
      {/* Per-type percentage labels */}
      <div className="flex flex-wrap gap-x-2 gap-y-0.5">
        {segments.map(({ key, label, color, pct }) => (
          <span
            key={key}
            className="text-[10px] font-medium"
            style={{ color }}
          >
            {label} {pct}%
          </span>
        ))}
      </div>
    </div>
  );
}

export function HoverTooltip({ hoveredPoint, hoveredCluster, clusters }: HoverTooltipProps) {
  if (!hoveredPoint && !hoveredCluster) {
    return null;
  }

  return (
    <div
      className="absolute pointer-events-none z-30"
      style={{ top: 16, right: 16 }}
    >
      <div className="border border-white/10 rounded-lg px-3 py-2 shadow-xl max-w-[240px]"
        style={{ backgroundColor: '#050510' }}
      >
        {hoveredPoint && (() => {
          const { actionTitle, personName, clusterTitle } = buildTooltipContent(hoveredPoint, clusters);
          const statusStyle = STATUS_STYLES[hoveredPoint.status] ?? { className: 'bg-zinc-500/20 text-zinc-400', label: hoveredPoint.status };

          return (
            <div className="space-y-1">
              <p className="text-white text-sm font-medium leading-snug">{actionTitle}</p>
              <p className="text-white/70 text-xs">{personName}</p>

              {/* Status badge */}
              <div className="flex items-center gap-1.5 pt-0.5">
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full uppercase tracking-wide ${statusStyle.className}`}>
                  {statusStyle.label}
                </span>
              </div>

              {/* Energy breakdown — always show weights (synthesized from discrete type for legacy data) */}
              <EnergyBreakdown weights={resolveWeights(hoveredPoint)} />

              <p className="text-white/50 text-[11px] pt-0.5">{clusterTitle}</p>
            </div>
          );
        })()}

        {hoveredCluster && !hoveredPoint && (
          <div className="space-y-1">
            <p className="text-white text-sm font-semibold leading-snug">{hoveredCluster.title}</p>
            <p className="text-white/60 text-xs leading-relaxed">{hoveredCluster.description}</p>
            <span
              className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full uppercase tracking-wide"
              style={{
                backgroundColor: hoveredCluster.boundary_type === 'internal' ? '#00e5ff18' : '#6b728018',
                color: hoveredCluster.boundary_type === 'internal' ? '#00e5ff' : '#9ca3af',
              }}
            >
              {hoveredCluster.boundary_type}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default HoverTooltip;
