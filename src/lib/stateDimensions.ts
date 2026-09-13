// Mirrors lambda/shared/azolla-state-dimensions.js — kept as a frontend
// constant rather than fetched over the network, same reasoning as the
// original taxonomy-as-constant decision: it changes rarely and is edited
// by a person, not user-configurable data.
//
// See docs/specs/azolla-impact-power-model.md §9 for why these specific
// dimensions/values were chosen (photo-observable, no lab equipment,
// decomposed rather than evaluative).

export interface StateDimensionSpec {
  label: string;
  values: string[];
}

export const STATE_DIMENSIONS: Record<string, StateDimensionSpec> = {
  azolla_color: { label: 'Azolla color', values: ['dark_green', 'light_green', 'yellow', 'red_brown'] },
  azolla_size: { label: 'Azolla size', values: ['small', 'large'] },
  azolla_texture: { label: 'Azolla texture', values: ['fluffy_full', 'flat_wilted'] },
  trend: { label: 'Trend', values: ['increasing', 'stable', 'decreasing'] },
  duckweed_color: { label: 'Duckweed color', values: ['green', 'pale'] },
  duckweed_spots: { label: 'Duckweed spots', values: ['present', 'absent'] },
  water_color: { label: 'Water color', values: ['clear', 'green', 'brown'] },
};

export const UNCLASSIFIED = 'unclassified';

// Human-readable label for a value within a dimension, e.g. "dark_green" -> "Dark green".
export function formatDimensionValue(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

// Short, stable label for a node's tag set — leads with azolla color+size
// (the primary crop) and appends anything else present, so labels stay
// readable without needing every dimension spelled out every time.
export function nodeLabel(tags: Record<string, string>): string {
  if (Object.keys(tags).length === 0) return 'Unclassified';
  const parts: string[] = [];
  if (tags.azolla_color || tags.azolla_size) {
    parts.push([tags.azolla_color, tags.azolla_size].filter(Boolean).map(formatDimensionValue).join(' '));
  }
  for (const dim of ['water_color', 'duckweed_color', 'duckweed_spots', 'azolla_texture', 'trend']) {
    if (tags[dim]) parts.push(formatDimensionValue(tags[dim]));
  }
  return parts.length ? parts.join(' · ') : 'Unclassified';
}
