import { useMemo, useState } from 'react';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import type { ActionPoint, ActionStatus, ClusterInfo, EnergeiaFilters } from '@/types/energeia';
import { CLUSTER_COLORS, personColor, buildPersonColorMap, STATUS_COLORS } from './ActionPointCloud';
import { TacticalLegend } from './TacticalLegend';

const ALL_STATUSES: ActionStatus[] = ['not_started', 'in_progress', 'completed'];

const TIME_WINDOW_OPTIONS = [
  { value: 7,   label: '7 days' },
  { value: 30,  label: '30 days' },
  { value: 90,  label: '90 days' },
  { value: 180, label: '6 months' },
  { value: 365, label: '1 year' },
];

// ─── Custom status indicator ────────────────────────────────────────────────

function StatusIndicator({ status, active }: { status: ActionStatus; active: boolean }) {
  if (status === 'in_progress') {
    return (
      <span className="relative flex h-4 w-4 items-center justify-center flex-shrink-0">
        {active && (
          <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-50 animate-ping" />
        )}
        <span
          className="relative inline-flex h-3 w-3 rounded-full border-2 transition-colors"
          style={{
            borderColor: active ? '#f59e0b' : '#4b5563',
            backgroundColor: active ? 'transparent' : 'transparent',
          }}
        />
      </span>
    );
  }
  if (status === 'completed') {
    // Solid diamond
    return (
      <span
        className="flex-shrink-0 transition-colors"
        style={{
          width: 12,
          height: 12,
          transform: 'rotate(45deg)',
          backgroundColor: active ? '#22c55e' : '#374151',
          boxShadow: active ? '0 0 6px #22c55e88' : 'none',
        }}
      />
    );
  }
  // not_started — hollow circle
  return (
    <span
      className="flex-shrink-0 rounded-full border-2 transition-colors"
      style={{
        width: 12,
        height: 12,
        borderColor: active ? '#6b7280' : '#374151',
        backgroundColor: 'transparent',
      }}
    />
  );
}

const STATUS_LABELS: Record<ActionStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  completed:   'Completed',
};

// ─── Relationship icons (inline SVG) ────────────────────────────────────────

function AssignedIcon({ active }: { active: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="4.5" r="2.5" fill={active ? '#00e5ff' : '#4b5563'} />
      <path d="M2 12c0-2.76 2.24-5 5-5s5 2.24 5 5" stroke={active ? '#00e5ff' : '#4b5563'} strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function ParticipantIcon({ active }: { active: boolean }) {
  const c = active ? '#00e5ff' : '#4b5563';
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" fill="none" aria-hidden="true">
      <circle cx="5.5" cy="4" r="2" fill={c} />
      <circle cx="10.5" cy="4" r="2" fill={c} opacity="0.7" />
      <path d="M1 12c0-2.21 2.01-4 4.5-4" stroke={c} strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M15 12c0-2.21-2.01-4-4.5-4" stroke={c} strokeWidth="1.5" strokeLinecap="round" fill="none" opacity="0.7" />
      <path d="M5.5 8c1.38 0 2.5 1.12 2.5 2.5S6.88 13 5.5 13" stroke={c} strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

// ─── Glassmorphism section label ─────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-widest text-cyan-400/60 mb-1 block">
      {children}
    </span>
  );
}

// ─── Holographic toggle pill ─────────────────────────────────────────────────

function HoloPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 px-2 py-1 rounded-full text-xs transition-all duration-150 cursor-pointer select-none"
      style={{
        border: `1px solid ${active ? 'rgba(0,229,255,0.4)' : 'rgba(255,255,255,0.08)'}`,
        backgroundColor: active ? 'rgba(0,229,255,0.08)' : 'rgba(255,255,255,0.03)',
        color: active ? '#e2f8ff' : '#6b7280',
        boxShadow: active ? '0 0 8px rgba(0,229,255,0.15)' : 'none',
      }}
    >
      {children}
    </button>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

interface EnergeiaControlsProps {
  k: number;
  onKChange: (k: number) => void;
  reductionMethod: 'pca' | 'tsne';
  onReductionMethodChange: (method: 'pca' | 'tsne') => void;
  colorMode: 'cluster' | 'person' | 'accountable' | 'status' | 'energy_type';
  onColorModeChange: (mode: 'cluster' | 'person' | 'accountable' | 'status' | 'energy_type') => void;
  filters: EnergeiaFilters;
  onFiltersChange: (filters: EnergeiaFilters) => void;
  points: ActionPoint[];
  clusters: ClusterInfo[];
  lastComputedK: number;
  lastComputedReductionMethod: 'pca' | 'tsne';
  lastComputedTimeWindowDays: number;
  personColorMap?: Map<string, string>;
  camera?: import('three').Camera;
  canvasRef?: React.RefObject<HTMLDivElement>;
  canvasHeight?: number;
  legendHoveredId?: string | null;
  onLegendHover?: (id: string | null) => void;
}

export function EnergeiaControls({
  k,
  onKChange,
  reductionMethod,
  onReductionMethodChange,
  colorMode,
  onColorModeChange,
  filters,
  onFiltersChange,
  points,
  clusters,
  lastComputedK,
  lastComputedReductionMethod,
  lastComputedTimeWindowDays,
  personColorMap: personColorMapProp,
  camera,
  canvasRef,
  canvasHeight = 560,
  legendHoveredId,
  onLegendHover,
}: EnergeiaControlsProps) {
  const uniquePersons = useMemo(() => {
    const seen = new Map<string, string>();
    for (const point of points) {
      if (!seen.has(point.person_id)) seen.set(point.person_id, point.person_name);
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [points]);

  // Use prop map if provided (built from full dataset in EnergeiaSchema), else build locally
  const personColorMap = useMemo(
    () => personColorMapProp ?? buildPersonColorMap(uniquePersons.map(p => p.id)),
    [personColorMapProp, uniquePersons]
  );

  // Legend — only for cluster / person / status modes (energy handled by triangle)
  const legendEntries = useMemo(() => {
    if (colorMode === 'cluster') {
      return clusters.map((c) => ({
        color: CLUSTER_COLORS[c.id % CLUSTER_COLORS.length],
        label: c.title,
      }));
    }
    if (colorMode === 'status') {
      return [
        { color: STATUS_COLORS.completed,   label: 'Completed' },
        { color: STATUS_COLORS.in_progress, label: 'In progress' },
        { color: STATUS_COLORS.not_started, label: 'Not started' },
      ];
    }
    if (colorMode === 'person' || colorMode === 'accountable') {
      return uniquePersons.map(({ id, name }) => ({
        color: personColor(id, personColorMap),
        label: name,
      }));
    }
    // energy_type — triangle is the legend
    return [];
  }, [colorMode, clusters, uniquePersons, personColorMap]);

  const handleRelationshipTypeToggle = (type: 'assigned' | 'participant') => {
    const has = filters.relationshipTypes.includes(type);
    const updated = has
      ? filters.relationshipTypes.filter((t) => t !== type)
      : ([...filters.relationshipTypes, type] as ('assigned' | 'participant')[]);
    onFiltersChange({ ...filters, relationshipTypes: updated });
  };

  const handleStatusToggle = (status: ActionStatus) => {
    const has = filters.statuses.includes(status);
    const updated = has
      ? filters.statuses.filter((s) => s !== status)
      : ([...filters.statuses, status] as ActionStatus[]);
    onFiltersChange({ ...filters, statuses: updated });
  };

  const handlePersonToggle = (personId: string) => {
    const has = filters.personIds.includes(personId);
    const updated = has
      ? filters.personIds.filter((id) => id !== personId)
      : [...filters.personIds, personId];
    onFiltersChange({ ...filters, personIds: updated });
  };

  const needsRefresh =
    k !== lastComputedK ||
    reductionMethod !== lastComputedReductionMethod ||
    filters.timeWindowDays !== lastComputedTimeWindowDays;

  return (
    <div
      className="flex flex-row flex-wrap gap-6 mt-4 p-4 rounded-xl w-full"
      style={{
        background: 'rgba(8, 13, 26, 0.75)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid rgba(0, 229, 255, 0.15)',
        boxShadow: '0 0 0 1px rgba(0,229,255,0.05), 0 4px 24px rgba(0,0,0,0.4)',
      }}
    >

      {/* K Slider */}
      <div className="flex flex-col gap-2 min-w-[160px]">
        <SectionLabel>
          Clusters (k): {k}
          {needsRefresh && (
            <span className="ml-2 text-amber-400/80 normal-case tracking-normal">↻ refresh</span>
          )}
        </SectionLabel>
        <Slider
          min={2} max={20} step={1}
          value={[k]}
          onValueChange={([value]) => onKChange(value)}
          className="w-36"
          aria-label="Number of clusters (k)"
        />
      </div>

      {/* Time Window */}
      <div className="flex flex-col gap-2">
        <SectionLabel>Time window</SectionLabel>
        <Select
          value={String(filters.timeWindowDays)}
          onValueChange={(v) => onFiltersChange({ ...filters, timeWindowDays: Number(v) })}
        >
          <SelectTrigger className="w-28 h-7 text-xs bg-transparent border-white/10 text-white/70" aria-label="Time window">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIME_WINDOW_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Layout */}
      <div className="flex flex-col gap-2">
        <SectionLabel>Layout</SectionLabel>
        <Select
          value={reductionMethod}
          onValueChange={(value) => onReductionMethodChange(value as 'pca' | 'tsne')}
        >
          <SelectTrigger className="w-36 h-7 text-xs bg-transparent border-white/10 text-white/70" aria-label="Reduction method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pca">PCA — fast</SelectItem>
            <SelectItem value="tsne">t-SNE — local</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Color by */}
      <div className="flex flex-col gap-2">
        <SectionLabel>Color by</SectionLabel>
        <Select
          value={colorMode}
          onValueChange={(value) => onColorModeChange(value as 'cluster' | 'person' | 'accountable' | 'status' | 'energy_type')}
        >
          <SelectTrigger className="w-40 h-7 text-xs bg-transparent border-white/10 text-white/70" aria-label="Color mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="energy_type">Energy</SelectItem>
            <SelectItem value="cluster">Cluster</SelectItem>
            <SelectItem value="person">Person</SelectItem>
            <SelectItem value="accountable">Accountable</SelectItem>
            <SelectItem value="status">Status</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Size by */}
      <div className="flex flex-col gap-2">
        <SectionLabel>Size by</SectionLabel>
        <Select
          value={filters.sizeMetric}
          onValueChange={(v) => onFiltersChange({ ...filters, sizeMetric: v as EnergeiaFilters['sizeMetric'] })}
        >
          <SelectTrigger className="w-36 h-7 text-xs bg-transparent border-white/10 text-white/70" aria-label="Size metric">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="observation_count">Observations</SelectItem>
            <SelectItem value="bloom_level">Bloom level</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Status filter — custom bio-digital toggles */}
      <div className="flex flex-col gap-2">
        <SectionLabel>Status</SectionLabel>
        <div className="flex flex-col gap-1.5">
          {ALL_STATUSES.map((status) => {
            const active = filters.statuses.includes(status);
            return (
              <button
                key={status}
                type="button"
                onClick={() => handleStatusToggle(status)}
                className="flex items-center gap-2 cursor-pointer group"
                aria-pressed={active}
                aria-label={STATUS_LABELS[status]}
              >
                <StatusIndicator status={status} active={active} />
                <span
                  className="text-xs transition-colors"
                  style={{ color: active ? '#e2f8ff' : '#4b5563' }}
                >
                  {STATUS_LABELS[status]}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Relationship filter — icon toggles */}
      <div className="flex flex-col gap-2">
        <SectionLabel>Relationship</SectionLabel>
        <div className="flex gap-2">
          <HoloPill
            active={filters.relationshipTypes.includes('assigned')}
            onClick={() => handleRelationshipTypeToggle('assigned')}
          >
            <AssignedIcon active={filters.relationshipTypes.includes('assigned')} />
            <span>Assigned</span>
          </HoloPill>
          <HoloPill
            active={filters.relationshipTypes.includes('participant')}
            onClick={() => handleRelationshipTypeToggle('participant')}
          >
            <ParticipantIcon active={filters.relationshipTypes.includes('participant')} />
            <span>Participant</span>
          </HoloPill>
        </div>
      </div>

      {/* People filter — shown always for filtering, but color dots only in person mode */}
      {uniquePersons.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionLabel>
            People
            {(colorMode === 'person' || colorMode === 'accountable') && (
              <span className="ml-1 normal-case tracking-normal text-white/30"> · legend</span>
            )}
          </SectionLabel>
          <div className="flex flex-wrap gap-1.5 max-w-[280px]">
            {uniquePersons.map(({ id, name }) => {
              const active = filters.personIds.includes(id);
              const isPersonMode = colorMode === 'person' || colorMode === 'accountable';
              return (
                <HoloPill
                  key={id}
                  active={active}
                  onClick={() => handlePersonToggle(id)}
                >
                  {/* Color dot only shown in person/accountable mode — in other modes it's just a filter */}
                  {isPersonMode && (
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{
                        backgroundColor: personColor(id, personColorMap),
                        boxShadow: `0 0 4px ${personColor(id, personColorMap)}88`,
                      }}
                    />
                  )}
                  <span className="truncate max-w-[100px]">{name.trim()}</span>
                </HoloPill>
              );
            })}
          </div>
        </div>
      )}

      {/* Legend — tactical bubble legend with HUD lines on hover */}
      {colorMode !== 'energy_type' && colorMode !== 'person' && colorMode !== 'accountable' && (
        <div className="flex flex-col gap-2">
          <SectionLabel>Legend</SectionLabel>
          <TacticalLegend
            colorMode={colorMode}
            points={points}
            clusters={clusters}
            personColorMap={personColorMap}
            camera={camera}
            canvasRef={canvasRef}
            canvasHeight={canvasHeight}
            hoveredId={legendHoveredId}
            onHoverChange={onLegendHover}
          />
        </div>
      )}

    </div>
  );
}

export default EnergeiaControls;
