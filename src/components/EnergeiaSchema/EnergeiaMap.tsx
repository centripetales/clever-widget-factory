import { useState, useRef, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { Stars } from '@react-three/drei';
import * as THREE from 'three';
import type { ActionPoint, ClusterInfo, EnergeiaFilters, EnergyType } from '@/types/energeia';
import { ActionPointCloud } from './ActionPointCloud';
import { CentroidStars } from './CentroidStars';
import { HoverTooltip } from './HoverTooltip';
import { MembraneShell } from './MembraneShell';
import { EnergyTriangle } from './EnergyTriangle';
import { SceneControls } from './SceneControls';
import { VelocityStreaks } from './VelocityStreaks';
import { OikonomiaBackground } from './OikonomiaBackground';
import { CameraCapture } from './CameraCapture';
import { TacticalLegend } from './TacticalLegend';

interface EnergeiaMapProps {
  points: ActionPoint[];
  clusters: ClusterInfo[];
  colorMode: 'cluster' | 'person' | 'accountable' | 'status' | 'energy_type';
  filters: EnergeiaFilters;
  activeEnergyFilter: EnergyType | null;
  onActiveEnergyFilterChange: (type: EnergyType | null) => void;
  onPointClick: (actionId: string) => void;
  membraneBoundaryDistance: number;
  personColorMap?: Map<string, string>;
  onCamera?: (cam: THREE.Camera) => void;
  canvasContainerRef?: React.RefObject<HTMLDivElement>;
  legendHoveredId?: string | null;
}

const CANVAS_HEIGHT = 560;

export function EnergeiaMap({
  points,
  clusters,
  colorMode,
  filters,
  activeEnergyFilter,
  onActiveEnergyFilterChange,
  onPointClick,
  membraneBoundaryDistance,
  personColorMap,
  onCamera: onCameraProp,
  canvasContainerRef: externalCanvasRef,
  legendHoveredId,
}: EnergeiaMapProps) {
  const [hoveredPoint, setHoveredPoint] = useState<ActionPoint | null>(null);
  const [hoveredCluster, setHoveredCluster] = useState<ClusterInfo | null>(null);
  const [camera, setCamera] = useState<THREE.Camera | null>(null);
  const internalCanvasRef = useRef<HTMLDivElement>(null);
  const canvasContainerRef = externalCanvasRef ?? internalCanvasRef;

  const handleCamera = useCallback((cam: THREE.Camera) => {
    setCamera(cam);
    onCameraProp?.(cam);
  }, [onCameraProp]);

  const filteredPoints = points.filter((point) => {
    if (!filters.personIds.includes(point.person_id)) return false;
    if (filters.relationshipTypes.length > 0 && !filters.relationshipTypes.includes(point.relationship_type)) return false;
    if (filters.statuses.length > 0 && !filters.statuses.includes(point.status)) return false;
    return true;
  });

  return (
    <div>
      {/* ── Canvas + overlays ── */}
      <div
        ref={canvasContainerRef}
        className="relative"
        style={{ height: CANVAS_HEIGHT }}
      >
        <Canvas
          camera={{ position: [0, 0, 30], fov: 60 }}
          style={{ height: CANVAS_HEIGHT }}
          gl={{ antialias: true, toneMapping: 4 }}
        >
          <CameraCapture onCamera={handleCamera} />
          <OikonomiaBackground points={points} />
          <pointLight position={[10, 10, 10]} intensity={1} />
          <Stars radius={100} depth={50} count={3000} factor={4} fade />

          <MembraneShell clusters={clusters} />

          <ActionPointCloud
            points={filteredPoints}
            clusters={clusters}
            colorMode={colorMode}
            sizeMetric={filters.sizeMetric}
            activeEnergyFilter={activeEnergyFilter}
            personColorMap={personColorMap}
            onHover={setHoveredPoint}
            onPointClick={onPointClick}
          />

          <VelocityStreaks points={filteredPoints} clusters={clusters} />
          <SceneControls />
        </Canvas>

        {/* HUD lines from TacticalLegend — rendered as absolute SVG overlay */}
        <TacticalLegend
          colorMode={colorMode}
          points={filteredPoints}
          clusters={clusters}
          personColorMap={personColorMap}
          camera={camera ?? undefined}
          canvasRef={canvasContainerRef}
          canvasHeight={CANVAS_HEIGHT}
          hudOnly
          hoveredId={legendHoveredId}
        />

        {/* Energy triangle — only in energy_type mode */}
        {colorMode === 'energy_type' && (
          <div className="absolute bottom-4 right-4 z-10">
            <EnergyTriangle
              points={points}
              activeEnergyFilter={activeEnergyFilter}
              onFilterChange={onActiveEnergyFilterChange}
            />
          </div>
        )}

        <HoverTooltip
          hoveredPoint={hoveredPoint}
          hoveredCluster={hoveredCluster}
          clusters={clusters}
        />
      </div>
    </div>
  );
}

export default EnergeiaMap;
