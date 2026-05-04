import { useState, useRef, useCallback } from 'react';
import * as THREE from 'three';
import type { ActionPoint, ClusterInfo } from '@/types/energeia';
import { CLUSTER_COLORS, STATUS_COLORS, personColor } from './ActionPointCloud';

interface LegendEntry {
  id: string;
  label: string;
  color: string;
}

interface TacticalLegendProps {
  colorMode: 'cluster' | 'person' | 'accountable' | 'status' | 'energy_type';
  points: ActionPoint[];
  clusters: ClusterInfo[];
  personColorMap?: Map<string, string>;
  /** R3F camera for projecting 3D → screen coords */
  camera?: THREE.Camera;
  /** Ref to the canvas container div */
  canvasRef?: React.RefObject<HTMLDivElement>;
  /** Canvas height in px */
  canvasHeight?: number;
  /** When true, renders only the HUD SVG overlay (no bubble pills) */
  hudOnly?: boolean;
  /** Externally controlled hovered ID — shared between pills and HUD overlay */
  hoveredId?: string | null;
  /** Callback when hover changes — used in full mode to lift state up */
  onHoverChange?: (id: string | null) => void;
}

function projectToScreen(
  worldPos: THREE.Vector3,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number } | null {
  const v = worldPos.clone().project(camera);
  if (v.z > 1) return null;
  return {
    x: (v.x * 0.5 + 0.5) * canvasWidth,
    y: (-v.y * 0.5 + 0.5) * canvasHeight,
  };
}

function buildEntries(
  colorMode: TacticalLegendProps['colorMode'],
  points: ActionPoint[],
  clusters: ClusterInfo[],
  personColorMap?: Map<string, string>
): LegendEntry[] {
  if (colorMode === 'cluster') {
    return clusters.map(c => ({
      id: String(c.id),
      label: c.title,
      color: CLUSTER_COLORS[c.id % CLUSTER_COLORS.length],
    }));
  }
  if (colorMode === 'status') {
    return [
      { id: 'completed',   label: 'Completed',   color: STATUS_COLORS.completed },
      { id: 'in_progress', label: 'In Progress',  color: STATUS_COLORS.in_progress },
      { id: 'not_started', label: 'Not Started',  color: STATUS_COLORS.not_started },
    ];
  }
  if (colorMode === 'person' || colorMode === 'accountable') {
    const seen = new Map<string, string>();
    for (const p of points) {
      if (!seen.has(p.person_id)) seen.set(p.person_id, p.person_name);
    }
    return Array.from(seen.entries()).map(([id, name]) => ({
      id,
      label: name.trim(),
      color: personColor(id, personColorMap),
    }));
  }
  return [];
}

/**
 * TacticalLegend — bubble legend with HUD vector lines on hover.
 *
 * Two modes:
 * - Normal (hudOnly=false): renders bubble pills. Hover state is lifted to parent via onHoverChange.
 * - HUD-only (hudOnly=true): renders only the SVG overlay inside the canvas, driven by hoveredId.
 *
 * The parent (EnergeiaSchema) owns hoveredId and passes it to both instances so the
 * HUD lines always reflect what the user is hovering in the legend.
 */
export function TacticalLegend({
  colorMode,
  points,
  clusters,
  personColorMap,
  camera,
  canvasRef,
  canvasHeight = 560,
  hudOnly = false,
  hoveredId = null,
  onHoverChange,
}: TacticalLegendProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const legendRef = useRef<HTMLDivElement>(null);

  const entries = buildEntries(colorMode, points, clusters, personColorMap);

  const getHudLines = useCallback((): { x1: number; y1: number; x2: number; y2: number; color: string }[] => {
    if (!hoveredId || !camera || !canvasRef?.current) return [];

    const canvasEl = canvasRef.current;
    const canvasRect = canvasEl.getBoundingClientRect();
    const canvasWidth = canvasRect.width;

    // Default anchor: bottom-left of canvas
    let legendX = canvasWidth * 0.12;
    let legendY = canvasHeight * 0.88;

    // If the pill element is in the DOM, use its actual position relative to the canvas
    if (legendRef.current) {
      const bubbleEl = legendRef.current.querySelector(`[data-id="${hoveredId}"]`) as HTMLElement | null;
      if (bubbleEl) {
        const bubbleRect = bubbleEl.getBoundingClientRect();
        legendX = bubbleRect.left + bubbleRect.width / 2 - canvasRect.left;
        legendY = bubbleRect.top + bubbleRect.height / 2 - canvasRect.top;
      }
    }

    const matchingPoints = points.filter(p => {
      if (colorMode === 'cluster') return String(p.cluster_id) === hoveredId;
      if (colorMode === 'person' || colorMode === 'accountable') return p.person_id === hoveredId;
      if (colorMode === 'status') return p.status === hoveredId;
      return false;
    });

    const entry = entries.find(e => e.id === hoveredId);
    const color = entry?.color ?? '#ffffff';
    const lines: { x1: number; y1: number; x2: number; y2: number; color: string }[] = [];

    for (const pt of matchingPoints) {
      const worldPos = new THREE.Vector3(pt.x, pt.y, pt.z);
      const screen = projectToScreen(worldPos, camera, canvasWidth, canvasHeight);
      if (!screen) continue;
      lines.push({ x1: legendX, y1: legendY, x2: screen.x, y2: screen.y, color });
    }

    return lines;
  }, [hoveredId, camera, canvasRef, points, colorMode, entries, canvasHeight]);

  if (entries.length === 0 && !hudOnly) return null;

  const hudLines = getHudLines();

  // HUD-only mode: SVG overlay inside the canvas container
  if (hudOnly) {
    if (hudLines.length === 0) return null;
    return (
      <svg
        className="absolute inset-0 pointer-events-none z-10"
        style={{ width: '100%', height: canvasHeight }}
      >
        {hudLines.map((line, i) => (
          <line
            key={i}
            x1={line.x1} y1={line.y1}
            x2={line.x2} y2={line.y2}
            stroke={line.color}
            strokeWidth="0.75"
            strokeOpacity="0.4"
            strokeDasharray="3 5"
          />
        ))}
        {hudLines.map((line, i) => (
          <circle key={`dot-${i}`} cx={line.x2} cy={line.y2} r="2.5" fill={line.color} opacity="0.7" />
        ))}
      </svg>
    );
  }

  // Full mode: bubble pills only — HUD lines are drawn by the hudOnly instance in EnergeiaMap
  return (
    <div ref={legendRef} className="flex flex-wrap gap-1.5 max-w-[280px]">
      {entries.map(entry => {
        const isHovered = hoveredId === entry.id;
        const isExpanded = expandedId === entry.id;
        const showFull = isHovered || isExpanded;
        return (
          <button
            key={entry.id}
            type="button"
            data-id={entry.id}
            className="flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium transition-all duration-200 cursor-pointer"
            style={{
              border: `1px solid ${isHovered || isExpanded ? entry.color : `${entry.color}40`}`,
              backgroundColor: isHovered || isExpanded ? `${entry.color}18` : `${entry.color}08`,
              color: isHovered || isExpanded ? '#fff' : '#9ca3af',
              boxShadow: isHovered || isExpanded ? `0 0 10px ${entry.color}50` : 'none',
              maxWidth: showFull ? '280px' : '160px',
            }}
            onMouseEnter={() => onHoverChange?.(entry.id)}
            onMouseLeave={() => onHoverChange?.(null)}
            onClick={() => setExpandedId(prev => prev === entry.id ? null : entry.id)}
          >
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: entry.color, boxShadow: `0 0 4px ${entry.color}` }}
            />
            <span
              className="text-left"
              style={{
                whiteSpace: showFull ? 'normal' : 'nowrap',
                overflow: showFull ? 'visible' : 'hidden',
                textOverflow: showFull ? 'unset' : 'ellipsis',
                maxWidth: showFull ? 'none' : '120px',
              }}
            >
              {entry.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default TacticalLegend;
