import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import * as THREE from 'three';
import { useEnergeiaSchema } from '@/hooks/useEnergeiaSchema';
import type { EnergeiaFilters, EnergyType } from '@/types/energeia';
import { buildPersonColorMap } from './ActionPointCloud';
import { KinesisBar } from './KinesisBar';
import { EnergeiaEmptyState } from './EnergeiaEmptyState';
import { EnergeiaMap } from './EnergeiaMap';
import { EnergeiaControls } from './EnergeiaControls';

interface EnergeiaSchemaProps {
  startDate: string;
  endDate: string;
  selectedUsers: string[];
}

export function EnergeiaSchema({ startDate, endDate, selectedUsers }: EnergeiaSchemaProps) {
  const { data, isRefreshing, isEmpty, computedAt, refresh } = useEnergeiaSchema();

  const [k, setK] = useState(8);
  const [reductionMethod, setReductionMethod] = useState<'pca' | 'tsne'>('pca');
  const [colorMode, setColorMode] = useState<'cluster' | 'person' | 'accountable' | 'status' | 'energy_type'>('energy_type');
  const [activeEnergyFilter, setActiveEnergyFilter] = useState<EnergyType | null>(null);
  const [filters, setFilters] = useState<EnergeiaFilters>({
    personIds: [],
    relationshipTypes: ['assigned', 'participant'],
    statuses: ['in_progress', 'completed'],
    timeWindowDays: 30,
    sizeMetric: 'observation_count',
  });

  useEffect(() => {
    if (!data) return;
    const allIds = Array.from(new Set(data.points.map((p) => p.person_id)));
    setFilters((prev) => ({
      ...prev,
      personIds: prev.personIds.length === 0 ? allIds : prev.personIds,
    }));
  }, [data]);

  const handleRefresh = () => {
    refresh(k, filters.timeWindowDays, reductionMethod);
  };

  const handlePointClick = (actionId: string) => {
    window.location.href = `/actions/${actionId}`;
  };

  // Build person color map by encounter order — stable across Map and Controls
  const personColorMap = useMemo(() => {
    if (!data) return new Map<string, string>();
    const seen = new Map<string, string>();
    for (const p of data.points) {
      if (!seen.has(p.person_id)) seen.set(p.person_id, p.person_name);
    }
    return buildPersonColorMap(Array.from(seen.keys()));
  }, [data]);

  // Camera and canvas refs shared between EnergeiaMap and EnergeiaControls for HUD lines
  const cameraRef = useRef<THREE.Camera | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const handleCamera = useCallback((cam: THREE.Camera) => { cameraRef.current = cam; }, []);

  // Lifted legend hover state — shared between Controls (sets it) and Map (draws HUD lines)
  const [legendHoveredId, setLegendHoveredId] = useState<string | null>(null);

  return (
    <div className="relative rounded-xl overflow-hidden w-full" style={{ background: '#050510' }}>

      {isEmpty && !isRefreshing ? (
        <EnergeiaEmptyState />
      ) : (
        <div className="relative overflow-x-hidden w-full">

          {/* ── Canvas / starfield ── */}
          {data && (
            <EnergeiaMap
              points={data.points}
              clusters={data.clusters}
              colorMode={colorMode}
              filters={filters}
              activeEnergyFilter={activeEnergyFilter}
              onActiveEnergyFilterChange={setActiveEnergyFilter}
              onPointClick={handlePointClick}
              membraneBoundaryDistance={data.membrane_boundary_distance ?? 0}
              personColorMap={personColorMap}
              onCamera={handleCamera}
              canvasContainerRef={canvasContainerRef}
              legendHoveredId={legendHoveredId}
            />
          )}

          {/* ── Header overlay — floats above the starfield ── */}
          <div
            className="absolute top-0 left-0 right-0 z-20 flex items-start justify-between px-5 pt-4 pb-10 pointer-events-none"
            style={{
              background: 'linear-gradient(to bottom, rgba(5,5,16,0.85) 0%, rgba(5,5,16,0.4) 60%, transparent 100%)',
            }}
          >
            {/* Title + timestamp */}
            <div className="flex flex-col gap-0.5">
              <h2
                className="text-white font-semibold tracking-tight"
                style={{ fontSize: '1.05rem', letterSpacing: '-0.01em' }}
              >
                The Energeia Schema
              </h2>
              {computedAt && (
                <span
                  className="text-cyan-400/60"
                  style={{
                    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace',
                    fontSize: '0.68rem',
                    letterSpacing: '0.04em',
                  }}
                >
                  ◈ COMPUTED {new Date(computedAt).toLocaleString().toUpperCase()}
                </span>
              )}
            </div>

            {/* Refresh button — re-enable pointer events just for this element */}
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="pointer-events-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-50"
              style={{
                background: 'rgba(0,229,255,0.08)',
                border: '1px solid rgba(0,229,255,0.25)',
                color: '#00e5ff',
                backdropFilter: 'blur(8px)',
                boxShadow: '0 0 12px rgba(0,229,255,0.1)',
              }}
              aria-label="Refresh Energeia Schema"
            >
              {isRefreshing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Refresh
            </button>
          </div>

          {/* ── Kinesis bar — liquid energy compass below header ── */}
          {data && (
            <div className="absolute left-0 right-0 z-20 pointer-events-auto px-5" style={{ top: 56 }}>
              <KinesisBar
                points={data.points}
                activeEnergyFilter={activeEnergyFilter}
                onFilterChange={setActiveEnergyFilter}
              />
            </div>
          )}

          {/* ── Refreshing overlay ── */}
          {isRefreshing && (
            <div className="absolute inset-0 z-30 flex items-center justify-center"
              style={{ background: 'rgba(5,5,16,0.5)', backdropFilter: 'blur(2px)' }}
            >
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
                <span
                  className="text-cyan-400/70 text-xs tracking-widest uppercase"
                  style={{ fontFamily: 'ui-monospace, monospace' }}
                >
                  Computing schema…
                </span>
              </div>
            </div>
          )}

          {/* ── Controls ── */}
          {data && (
            <EnergeiaControls
              k={k}
              onKChange={setK}
              reductionMethod={reductionMethod}
              onReductionMethodChange={setReductionMethod}
              colorMode={colorMode}
              onColorModeChange={setColorMode}
              filters={filters}
              onFiltersChange={setFilters}
              points={data.points}
              clusters={data.clusters}
              lastComputedK={data.k}
              lastComputedReductionMethod={data.reduction_method}
              lastComputedTimeWindowDays={data.time_window_days}
              personColorMap={personColorMap}
              camera={cameraRef.current ?? undefined}
              canvasRef={canvasContainerRef}
              legendHoveredId={legendHoveredId}
              onLegendHover={setLegendHoveredId}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default EnergeiaSchema;
