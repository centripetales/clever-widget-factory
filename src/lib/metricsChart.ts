import type { MetricsChartRange } from '@/hooks/useMemberSettings';

// All observation/photo/action timestamps here are display-only, and this
// program runs in the Philippines — browser-local formatting (the default
// for toLocaleString/toLocaleDateString) would show whatever timezone the
// viewer's machine happens to be in instead, same class of bug fixed
// elsewhere in this project (scripts/azolla-weekly-report.js etc).
export const MANILA_TZ = 'Asia/Manila';
export function formatManila(value: string | number, opts: Intl.DateTimeFormatOptions): string {
  return new Date(value).toLocaleString('en-US', { timeZone: MANILA_TZ, ...opts });
}
export const MANILA_DATE_OPTS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' };
export const MANILA_DATETIME_OPTS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' };

// 2026-07-21 00:00 Asia/Manila. Everyone's first day (7/20) used a ziplock
// bag as a placeholder container before their real setup was ready, so that
// day's Coverage % numbers aren't representative of any actual container —
// dropped rather than plotted. This is an azolla-pilot-specific artifact, so
// it's applied only to the 'Coverage %' metric (see applyCutoff below) —
// every other tool's metrics (e.g. a composter's Temperature, which has real
// readings well before this date) must not be truncated by it.
export const CHART_START_MS = new Date('2026-07-20T16:00:00Z').getTime();

// The UTC instant of midnight-Manila for whatever Manila calendar day `iso`
// falls on — used as the chart-data grouping key so multiple same-day
// observations (e.g. two check-ins 46 minutes apart) collapse into one
// point instead of plotting as near-overlapping dots.
export function manilaDayKey(iso: string | number): number {
  const manila = new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000);
  return Date.UTC(manila.getUTCFullYear(), manila.getUTCMonth(), manila.getUTCDate()) - 8 * 60 * 60 * 1000;
}

// "Moisture: Squeeze Test" -> { family: "Moisture", subtype: "Squeeze Test" }.
// "Temperature" (no colon) -> { family: "Temperature", subtype: null }. This
// is a naming CONVENTION, not a schema field -- metrics.name has no
// dedicated subtype column, and adding one wasn't needed: metric_name is
// already the identity GroupMetricsGrid groups/merges by (see
// mergeObservations below), so a colon-delimited convention slots into that
// existing pattern instead of requiring a migration. A person creates
// "Moisture: Squeeze Test" and "Moisture: IR Meter" as two ordinary metrics
// via the existing Add Metric UI -- both land on one "Moisture Over Time"
// chart, each as its own line, so the two approaches can be contrasted.
export function parseMetricName(name: string): { family: string; subtype: string | null } {
  const colonIndex = name.indexOf(':');
  if (colonIndex === -1) return { family: name.trim(), subtype: null };
  return {
    family: name.slice(0, colonIndex).trim(),
    subtype: name.slice(colonIndex + 1).trim() || null,
  };
}

export interface GroupPhoto {
  id: string;
  photo_url: string;
  photo_description: string | null;
  captured_at: string | null;
}

export interface GroupMetric {
  metric_id: string;
  metric_name: string;
  value: string;
  unit: string | null;
  value_type: 'number' | 'text';
  // The metric's allowed range, when it has one.
  min_value: number | null;
  max_value: number | null;
}

export interface GroupObservation {
  id: string;
  observation_text: string | null;
  observed_by: string;
  observed_by_name: string;
  observed_at: string;
  photos: GroupPhoto[] | null;
  metrics: GroupMetric[] | null;
  // Set only on a synthetic observation built by mergeObservations() below,
  // to the real state ids it combines — the Coverage % edit feature checks
  // this and disables itself, since there's no single state to PUT to.
  mergedIds?: string[];
}

// Combines same-day observations into one for chart display: photos from
// every observation that day, notes joined in order, and every distinct
// metric name present that day taken as the day's max (same rule the
// Coverage % metric itself already used server-side — see
// scripts/azolla-wire-coverage-metric.js). Used only for Coverage %
// specifically (see collectContainerPoints below) — every other metric
// plots each reading at its own exact timestamp instead, so someone taking
// several readings in one day (e.g. a few coconut moisture checks) sees
// each one, not a single collapsed per-day max.
// The time to show for an observation: when its newest photo was taken.
// observed_at is only when it was submitted, often well after the event, so
// it's used only when there are no dated photos.
export function observationDisplayTime(obs: GroupObservation): string {
  const photoTimes = (obs.photos || []).map((p) => p.captured_at).filter((t): t is string => !!t);
  if (photoTimes.length === 0) return obs.observed_at;
  return photoTimes.reduce((latest, t) => (new Date(t).getTime() > new Date(latest).getTime() ? t : latest));
}

export function mergeObservations(obsList: GroupObservation[]): GroupObservation {
  const sorted = [...obsList].sort((a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime());
  const photos = sorted.flatMap((o) => o.photos || []);
  const texts = sorted.map((o) => o.observation_text).filter((t): t is string => !!t);
  // metric_name, not metric_id, is the identity used here: each metric_id is
  // a per-tool definition row (a farmer's own "Temperature" metric has a
  // different metric_id from another farmer's), so metric_name is the only
  // thing that actually identifies "the same metric" within one day's
  // readings for a single container.
  const metricNames = new Set<string>();
  sorted.forEach((o) => (o.metrics || []).forEach((m) => metricNames.add(m.metric_name)));
  const metrics: GroupMetric[] = Array.from(metricNames).map((name) => {
    const readings = sorted.flatMap((o) => (o.metrics || []).filter((m) => m.metric_name === name));
    const values = readings.map((m) => Number(m.value));
    const max = values.length ? Math.max(...values) : 0;
    const unit = readings.find((m) => m.unit)?.unit ?? null;
    return { metric_id: `merged-${readings[0]?.metric_id ?? name}`, metric_name: name, value: max.toFixed(2), unit, value_type: 'number', min_value: readings[0]?.min_value ?? null, max_value: readings[0]?.max_value ?? null };
  });
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    id: first.id,
    mergedIds: sorted.map((o) => o.id),
    observed_by: first.observed_by,
    observed_by_name: first.observed_by_name,
    // Latest submission time that day, so the popup header shows when the
    // last of the day's check-ins actually happened.
    observed_at: last.observed_at,
    observation_text: texts.length ? texts.join('\n\n') : null,
    photos: photos.length ? photos : null,
    metrics,
  };
}

export interface GroupAction {
  id: string;
  title: string;
  description: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
  // The action's own technically-dense account — a real CLAIM perspective
  // row (state_perspectives.action_id, migration 023) as of the v4+ pipeline.
  claim: string | null;
  // what_was_done: legacy fallback for actions created before that migration,
  // when this same text lived inline in scoring_data instead.
  scoring_data: { action_type?: string; what_was_done?: string } | null;
}

export function applyCoverageEdit(obs: GroupObservation, value: number): GroupObservation {
  return {
    ...obs,
    metrics: (obs.metrics || []).map((m) =>
      m.metric_name === 'Coverage %' ? { ...m, value: value.toFixed(2) } : m
    ),
  };
}

export function actionText(a: GroupAction): string {
  return a.claim || a.scoring_data?.what_was_done || a.description || a.title;
}

// One experience's member ids; the chart draws it as a band from its initial
// state to its final state, with its actions marked on it.
export interface GroupExperience {
  id: string;
  initial_state_ids: string[];
  final_state_ids: string[];
  action_ids: string[];
}

export interface GroupContainer {
  toolId: string;
  toolName: string;
  sourceOrgId: string;
  sourceOrgName: string;
  sourcePhone: string | null;
  observations: GroupObservation[];
  actions: GroupAction[];
  experiences: GroupExperience[];
}

// Ten hues 36° apart at a mid lightness so every series stays distinct
// against a white card and in print (the old neon set only worked on black).
export const LINE_COLORS = [
  '#d92626', '#d97a06', '#a3a30a', '#2fa32f', '#0f9e5e',
  '#0e9aa3', '#1f6fd9', '#5a2fd9', '#a02fd9', '#d92f8c',
];

export const RANGE_OPTIONS: { value: MetricsChartRange; label: string }[] = [
  { value: 'week', label: 'Last week' },
  { value: 'month', label: 'Last month' },
  { value: '3months', label: 'Last 3 months' },
  { value: 'all', label: 'All time' },
];

// null means "no cutoff" (All time). Computed from *now*, not from the
// data's own latest point -- "Last week" means the last 7 calendar days,
// same as a person would expect from any other app's time-range picker.
export function rangeStartMs(range: MetricsChartRange): number | null {
  const DAY_MS = 24 * 60 * 60 * 1000;
  switch (range) {
    case 'week': return Date.now() - 7 * DAY_MS;
    case 'month': return Date.now() - 30 * DAY_MS;
    case '3months': return Date.now() - 90 * DAY_MS;
    case 'all': return null;
  }
}

// One row per timestamp; every series' value and observation hang off it
// under dynamic keys (`${seriesKey}` and `${seriesKey}__obs`).
export type ChartRow = { timestamp: number; date: string } & Record<string, unknown>;

export interface SeriesInfo {
  toolId: string;
  name: string;
  color: string;
}

export interface DiscoveredMetric {
  name: string;
  unit: string | null;
}

// One resolved line on a chart: either a plain container (no subtype
// anywhere in this metric family, matching every chart's original
// behavior) or one (container, subtype) pair once a family has any
// "Family: Subtype"-named metric in it — see parseMetricName above.
export type MarkerShape = 'circle' | 'square' | 'triangle' | 'diamond';
const MARKER_SHAPES: MarkerShape[] = ['circle', 'square', 'triangle', 'diamond'];

// One toggle in the legend. `seriesKeys` are the lines it controls and
// `toolIds` the containers whose action markers go with it.
export interface LegendChip {
  id: string;
  label: string;
  // null: drawn neutral, because color is carrying the other dimension.
  color: string | null;
  marker: MarkerShape;
  seriesKeys: string[];
  toolIds: string[];
}

// Two dimensions: the sensor (color) and the container (marker shape).
// Either row is empty when it would only ever show one value.
export interface ChartLegend {
  sensors: LegendChip[];
  containers: LegendChip[];
}

export interface ChartSeriesInfo {
  key: string;
  toolId: string;
  subtype: string | null;
  // "Container" or "Container — Sensor"; used where a single name is needed
  // (popup titles).
  label: string;
  sensor: string | null;
  containerName: string;
  marker: MarkerShape;
  color: string;
  unit: string | null;
  // Which Y-axis this line plots against -- 'left' unless this family has
  // more than one distinct unit among its subtypes (e.g. a squeeze test's
  // "drips" alongside an IR meter's "%"), in which case the second unit
  // gets its own 'right' axis instead of being squeezed onto the first
  // one's scale. See MetricChartBundle.rightAxis.
  yAxisId: 'left' | 'right';
}

export interface AxisInfo {
  unit: string | null;
  domain: [number, number];
  // Set when the metric has a range: whole steps across it instead of ticks
  // picked from the padded domain.
  ticks?: number[];
}

// A thin connector from an action's marker (top of the plot) to one of its
// experience's initial/final readings, in left-axis coordinates.
export interface ExperienceLink {
  key: string;
  toolId: string;
  color: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface MetricChartBundle {
  metric: DiscoveredMetric;
  experienceLinks: ExperienceLink[];
  legend: ChartLegend;
  chartData: ChartRow[];
  actionMarkers: { timestamp: number; y: number; toolId: string; color: string; toolName: string; action: GroupAction; inExperience: boolean }[];
  // Explicit [min, max] rather than trusting Recharts' 'auto' keyword to
  // scale itself — with a real metric name (unlike the always-backend-
  // validated Coverage %), a bad manually-entered value (seen in practice:
  // a "Moisture" reading whose value was literally the string
  // "Temperature") produces NaN, and Recharts' own auto-scaling collapses
  // to a near-zero range when that happens instead of ignoring it.
  leftAxis: AxisInfo;
  // Present only when this family has more than one distinct unit among
  // its subtypes -- e.g. a squeeze test's "drips" alongside an IR meter's
  // "%". Every ChartSeriesInfo whose own unit isn't the left axis's gets
  // yAxisId: 'right' and plots against this instead, so a small drip
  // count doesn't sit visually flattened against a 0-100 percent scale.
  rightAxis: AxisInfo | null;
  // Every line this chart actually has data for, already resolved to a
  // color and legend label — see the hasSubtypes branch in buildMetricChart.
  chartSeries: ChartSeriesInfo[];
  // Set only when this family has subtypes AND every one of them belongs
  // to the same single tool (e.g. one composter's squeeze-test vs IR-meter
  // moisture readings) — the chart title becomes "{titlePrefix} — {metric}
  // Over Time" and legend labels drop the now-redundant container name,
  // since repeating "Rotary" next to "Squeeze Test"/"IR Meter" in the
  // legend read as three peers of the same kind when they aren't -- one
  // names a tool, the other two name a measurement approach.
  titlePrefix: string | null;
}

export interface ContainerPoint {
  timestamp: number;
  value: number;
  subtype: string | null;
  unit: string | null;
  // The metric's allowed range, carried so the axis can use it.
  min: number | null;
  max: number | null;
  obs: GroupObservation;
}

// One point per valid reading whose metric name's FAMILY (see
// parseMetricName) matches `familyName` for this container — e.g. both
// "Moisture: Squeeze Test" and "Moisture: IR Meter" readings when
// `familyName` is "Moisture", each keeping its own subtype. For
// 'Coverage %' specifically, same-day readings still collapse into one
// point (that metric's day-bucketed-max behavior predates this
// generalization and stays as-is, exact-match only — see
// mergeObservations above; Coverage % isn't expected to use the subtype
// convention). Every other metric plots each reading at its own exact
// observed_at timestamp, uncollapsed — multiple readings in one day (e.g.
// a morning and an afternoon coconut moisture check) show as separate
// points rather than a single per-day max.
export function collectContainerPoints(
  container: GroupContainer,
  familyName: string,
  applyCutoff: boolean
): ContainerPoint[] {
  const isCoverage = familyName === 'Coverage %';
  if (isCoverage) {
    const byDay = new Map<number, GroupObservation[]>();
    for (const obs of container.observations) {
      const reading = obs.metrics?.find((m) => m.metric_name === familyName);
      if (!reading || !Number.isFinite(Number(reading.value))) continue;
      const timestamp = new Date(obs.observed_at).getTime();
      if (applyCutoff && timestamp < CHART_START_MS) continue;
      const day = manilaDayKey(obs.observed_at);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(obs);
    }
    const points: ContainerPoint[] = [];
    for (const [day, obsList] of byDay) {
      const merged = obsList.length === 1 ? obsList[0] : mergeObservations(obsList);
      const reading = merged.metrics!.find((m) => m.metric_name === familyName)!;
      points.push({ timestamp: day, value: Number(reading.value), subtype: null, unit: reading.unit, min: reading.min_value, max: reading.max_value, obs: merged });
    }
    return points.sort((a, b) => a.timestamp - b.timestamp);
  }

  const familyLower = familyName.trim().toLowerCase();
  const points: ContainerPoint[] = [];
  for (const obs of container.observations) {
    // An observation can carry more than one matching reading at once --
    // e.g. a squeeze test AND an IR meter reading logged in the same
    // check-in -- each becomes its own point at the same timestamp.
    for (const reading of obs.metrics || []) {
      const parsed = parseMetricName(reading.metric_name);
      if (parsed.family.trim().toLowerCase() !== familyLower) continue;
      if (reading.value_type === 'text' || !Number.isFinite(Number(reading.value))) continue;
      const timestamp = new Date(obs.observed_at).getTime();
      points.push({ timestamp, value: Number(reading.value), subtype: parsed.subtype, unit: reading.unit, min: reading.min_value, max: reading.max_value, obs });
    }
  }
  return points.sort((a, b) => a.timestamp - b.timestamp);
}

// Ticks across a metric's range: every whole number for a small integer
// range (0-5), otherwise five even steps.
export function rangeTicks(min: number, max: number): number[] {
  if (Number.isInteger(min) && Number.isInteger(max) && max - min <= 10) {
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  }
  return Array.from({ length: 5 }, (_, i) => Number((min + ((max - min) * i) / 4).toFixed(2)));
}

export interface DiscoveredFamily extends DiscoveredMetric {
  // 'text' when every reading of the family is a text metric.
  kind: 'number' | 'text';
}

// Every distinct metric family recorded across the containers (the part of a
// name before a "Family: Sensor" colon, or the whole name), grouped
// case-insensitively: Coverage % first, the rest alphabetical.
export function discoverMetrics(containers: GroupContainer[]): DiscoveredFamily[] {
  const families = new Map<string, { name: string; unit: string | null; hasNumber: boolean }>();
  for (const c of containers) {
    for (const o of c.observations) {
      for (const m of o.metrics || []) {
        const { family } = parseMetricName(m.metric_name);
        const key = family.toLowerCase();
        const entry = families.get(key) ?? { name: family, unit: m.unit, hasNumber: false };
        if (m.value_type === 'number') entry.hasNumber = true;
        families.set(key, entry);
      }
    }
  }
  return Array.from(families.values())
    .map(({ name, unit, hasNumber }): DiscoveredFamily => ({ name, unit, kind: hasNumber ? 'number' : 'text' }))
    .sort((a, b) => {
      if (a.name === 'Coverage %') return -1;
      if (b.name === 'Coverage %') return 1;
      return a.name.localeCompare(b.name);
    });
}

// One row per container that has any text reading of the family, one dot per
// observation with something written: a timeline of when it was seen.
export interface PresenceRow {
  toolId: string;
  label: string;
  color: string;
  y: number;
}
export interface PresencePoint {
  key: string;
  timestamp: number;
  y: number;
  toolId: string;
  color: string;
  label: string;
  text: string;
  obs: GroupObservation;
}
export interface PresenceBundle {
  metric: DiscoveredMetric;
  rows: PresenceRow[];
  points: PresencePoint[];
}

export function buildPresenceChart(containers: GroupContainer[], series: SeriesInfo[], metric: DiscoveredMetric): PresenceBundle {
  const familyLower = metric.name.trim().toLowerCase();
  const perContainer = containers
    .map((c) => {
      const s = series.find((x) => x.toolId === c.toolId)!;
      const seen = c.observations.flatMap((obs) => {
        const parts = (obs.metrics || [])
          .filter((m) => m.value_type === 'text' && parseMetricName(m.metric_name).family.trim().toLowerCase() === familyLower && m.value.trim() !== '')
          .map((m) => {
            const { subtype } = parseMetricName(m.metric_name);
            return subtype ? `${subtype}: ${m.value.trim()}` : m.value.trim();
          });
        return parts.length ? [{ obs, text: parts.join('; ') }] : [];
      });
      return { s, seen };
    })
    .filter((x) => x.seen.length > 0);

  // First container on top: the axis counts upward.
  const rows: PresenceRow[] = perContainer.map(({ s }, i) => ({
    toolId: s.toolId,
    label: s.name,
    color: s.color,
    y: perContainer.length - 1 - i,
  }));
  const points: PresencePoint[] = perContainer.flatMap(({ s, seen }, i) =>
    seen.map(({ obs, text }) => {
      const timestamp = new Date(obs.observed_at).getTime();
      return { key: `${s.toolId}:${obs.id}`, timestamp, y: rows[i].y, toolId: s.toolId, color: s.color, label: s.name, text, obs };
    })
  );
  points.sort((a, b) => a.timestamp - b.timestamp);
  return { metric, rows, points };
}

// Builds one metric's chart data across every container — the same logic
// the old Coverage %-only chart used, generalized to whichever metric
// FAMILY (see parseMetricName) is passed in. `applyCutoff` (true only for
// 'Coverage %') is the one azolla-pilot-specific exception — see
// CHART_START_MS above.
export function buildMetricChart(containers: GroupContainer[], series: SeriesInfo[], metric: DiscoveredMetric): MetricChartBundle {
  const applyCutoff = metric.name === 'Coverage %';

  // Collect every point across every container up front, before deciding
  // series identity or axis assignment -- axis assignment needs to see
  // every reading's own unit first (below), so it can't happen in the same
  // pass that builds rows.
  const allPoints: { container: GroupContainer; point: ContainerPoint }[] = [];
  for (const container of containers) {
    // A metric value is free text entered by a person, unlike Coverage %
    // (always a backend-validated 0-100 number) — collectContainerPoints
    // already skips anything that doesn't parse, rather than plotting/
    // scaling around a NaN.
    for (const point of collectContainerPoints(container, metric.name, applyCutoff)) {
      allPoints.push({ container, point });
    }
  }

  // toolId/subtype/unit behind each distinct series key actually observed,
  // in first-seen order (Map preserves insertion order) -- used below to
  // resolve colors/labels/axis once every point has been collected. Two
  // different containers' own "Moisture" metric definitions have different
  // metric_ids (each tool's metrics are its own rows), so there's no
  // natural cross-container key besides composing one from the subtype
  // string -- matches how the family/subtype grouping itself already works
  // off metric_name rather than metric_id.
  const seriesMeta = new Map<string, { toolId: string; subtype: string | null; unit: string | null }>();
  for (const { container, point } of allPoints) {
    const seriesKey = point.subtype ? `${container.toolId}::${point.subtype}` : container.toolId;
    if (!seriesMeta.has(seriesKey)) seriesMeta.set(seriesKey, { toolId: container.toolId, subtype: point.subtype, unit: point.unit });
  }

  // True the moment ANY reading in this family used the "Family: Subtype"
  // convention -- switches every series in this chart (even a plain,
  // subtype-less reading from some other container) from the usual
  // per-container coloring to one distinct palette color per series, so a
  // 20-tree "Mature Nuts" family or a 2-approach "Moisture" family reads
  // clearly instead of collapsing onto a handful of container colors.
  const hasSubtypes = Array.from(seriesMeta.values()).some((m) => m.subtype !== null);
  const distinctToolIds = new Set(Array.from(seriesMeta.values()).map((m) => m.toolId));
  // Only meaningful once hasSubtypes is true and every subtype belongs to
  // the same tool -- e.g. one composter comparing squeeze-test vs IR-meter
  // moisture. With more than one tool involved, the container identity
  // still needs to live in each series' own label (below), so the title
  // stays generic instead.
  const soloContainer =
    hasSubtypes && distinctToolIds.size === 1
      ? containers.find((c) => c.toolId === [...distinctToolIds][0])
      : undefined;

  // A series with no unit of its own falls back to the family's default
  // unit, so a genuinely missing unit doesn't spuriously look like a
  // second distinct one. Units actually present, in first-seen order --
  // when more than one shows up (e.g. a squeeze test's "drips" alongside
  // an IR meter's "%"), the first gets the left axis and the second (and
  // any further ones, rare) share the right axis, rather than forcing
  // every subtype onto one scale where a small drip count would sit
  // visually flattened against a 0-100 percent range.
  const normalizeUnit = (u: string | null) => u ?? metric.unit ?? null;
  const distinctUnits: (string | null)[] = [];
  for (const meta of seriesMeta.values()) {
    const u = normalizeUnit(meta.unit);
    if (!distinctUnits.includes(u)) distinctUnits.push(u);
  }
  const axisForUnit = new Map<string | null, 'left' | 'right'>();
  distinctUnits.forEach((u, i) => axisForUnit.set(u, i === 0 ? 'left' : 'right'));

  // Sensors (the "Family: Sensor" part of a metric name) take the color,
  // shared across containers; containers take the marker shape, but only
  // when more than one is on the chart.
  const sensorLabelOf = (subtype: string | null) => subtype ?? metric.name;
  const sortedSensors = hasSubtypes
    ? Array.from(new Set(Array.from(seriesMeta.values()).map((m) => sensorLabelOf(m.subtype)))).sort((a, b) => a.localeCompare(b))
    : [];
  const containerOrder = Array.from(distinctToolIds);
  const markerFor = (toolId: string): MarkerShape =>
    containerOrder.length > 1 ? MARKER_SHAPES[containerOrder.indexOf(toolId) % MARKER_SHAPES.length] : 'circle';

  const chartSeries: ChartSeriesInfo[] = Array.from(seriesMeta.entries()).map(([key, { toolId, subtype, unit }]) => {
    const containerSeries = series.find((s) => s.toolId === toolId);
    const containerName = containerSeries?.name ?? toolId;
    const resolvedUnit = normalizeUnit(unit);
    const yAxisId = axisForUnit.get(resolvedUnit) ?? 'left';
    const marker = markerFor(toolId);
    if (!hasSubtypes) {
      // No sensor anywhere in this family (the common case): color is the
      // container's, the same on every chart, so the same container always
      // reads as the same color.
      return { key, toolId, subtype: null, label: containerName, sensor: null, containerName, marker, color: containerSeries?.color ?? LINE_COLORS[0], unit: resolvedUnit, yAxisId };
    }
    const sensor = sensorLabelOf(subtype);
    const color = LINE_COLORS[sortedSensors.indexOf(sensor) % LINE_COLORS.length];
    return { key, toolId, subtype, label: `${containerName} — ${sensor}`, sensor, containerName, marker, color, unit: resolvedUnit, yAxisId };
  });
  const legend: ChartLegend = {
    sensors: sortedSensors.map((sensor) => {
      const mine = chartSeries.filter((s) => s.sensor === sensor);
      return { id: sensor, label: sensor, color: mine[0].color, marker: 'circle', seriesKeys: mine.map((s) => s.key), toolIds: [] };
    }),
    containers: containerOrder.length > 1
      ? containerOrder.map((toolId) => {
          const mine = chartSeries.filter((s) => s.toolId === toolId);
          return {
            id: toolId,
            label: mine[0].containerName,
            color: hasSubtypes ? null : mine[0].color,
            marker: markerFor(toolId),
            seriesKeys: mine.map((s) => s.key),
            toolIds: [toolId],
          };
        })
      : [],
  };
  const seriesByKey = new Map(chartSeries.map((s) => [s.key, s]));

  const toTimestamp = (iso: string) => (applyCutoff ? manilaDayKey(iso) : new Date(iso).getTime());
  const rows = new Map<number, ChartRow>();
  const axisRange = new Map<'left' | 'right', { min: number; max: number }>();
  // The metric range shared by every reading on an axis, if there is one.
  const axisBounds = new Map<'left' | 'right', { min: number | null; max: number | null; consistent: boolean }>();
  for (const { container, point } of allPoints) {
    const seriesKey = point.subtype ? `${container.toolId}::${point.subtype}` : container.toolId;
    const row = rows.get(point.timestamp) || { timestamp: point.timestamp, date: formatManila(point.timestamp, MANILA_DATE_OPTS) };
    row[seriesKey] = point.value;
    row[`${seriesKey}__obs`] = point.obs;
    rows.set(point.timestamp, row);
    const yAxisId = seriesByKey.get(seriesKey)!.yAxisId;
    const bounds = axisBounds.get(yAxisId);
    if (!bounds) axisBounds.set(yAxisId, { min: point.min, max: point.max, consistent: true });
    else if (bounds.min !== point.min || bounds.max !== point.max) bounds.consistent = false;
    const range = axisRange.get(yAxisId) ?? { min: Infinity, max: -Infinity };
    if (point.value < range.min) range.min = point.value;
    if (point.value > range.max) range.max = point.value;
    axisRange.set(yAxisId, range);
  }

  const realChartData = Array.from(rows.values()).sort((a, b) => a.timestamp - b.timestamp);

  // The Brush snaps to whichever entries exist in chartData, by array
  // index -- with only a handful of real observations (this composter has
  // exactly 2 for Temperature), that means just 2 possible snap positions,
  // one at each end. Dragging anywhere short of the midpoint between them
  // then snaps right back to "unchanged," which reads as "the brush didn't
  // do anything" even though it's working exactly as designed. Filling in
  // one virtual (valueless) row per day between the first and last real
  // point gives the Brush day-level granularity regardless of how sparse
  // the underlying readings are, without affecting what's actually
  // plotted -- every <Line>'s dot renderer and connectNulls already treat
  // a row with no value for this container as a gap to skip over.
  let chartData: ChartRow[] = realChartData;
  if (realChartData.length >= 2) {
    const dayMs = 24 * 60 * 60 * 1000;
    const first = realChartData[0].timestamp;
    const last = realChartData[realChartData.length - 1].timestamp;
    const byTimestamp = new Map<number, ChartRow>();
    for (const row of realChartData) byTimestamp.set(row.timestamp, row);
    for (let t = first; t <= last; t += dayMs) {
      if (!byTimestamp.has(t)) byTimestamp.set(t, { timestamp: t, date: formatManila(t, MANILA_DATE_OPTS) });
    }
    chartData = Array.from(byTimestamp.values()).sort((a, b) => a.timestamp - b.timestamp);
  }
  // 10% padding on each side, same spirit as the X-axis's 2-day padding —
  // a flush [dataMin, dataMax] domain sits the extreme points exactly on
  // the axis edge, clipping their glow. A single-value series (min===max)
  // gets a flat +/-1 so the line isn't a degenerate zero-height range.
  const domainFor = (range: { min: number; max: number } | undefined): [number, number] => {
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return [0, 1];
    if (range.min === range.max) return [range.min - 1, range.max + 1];
    return [range.min - (range.max - range.min) * 0.1, range.max + (range.max - range.min) * 0.1];
  };
  // A metric with a range (0-5 smell strength, 0-100 coverage) plots on that
  // range, with a little room so the extremes aren't flush against the edge;
  // otherwise the axis fits the data.
  const axisFor = (yAxisId: 'left' | 'right', unit: string | null): AxisInfo => {
    const bounds = axisBounds.get(yAxisId);
    if (bounds?.consistent && bounds.min !== null && bounds.max !== null && bounds.max > bounds.min) {
      const pad = (bounds.max - bounds.min) * 0.05;
      return { unit, domain: [bounds.min - pad, bounds.max + pad], ticks: rangeTicks(bounds.min, bounds.max) };
    }
    return { unit, domain: domainFor(axisRange.get(yAxisId)) };
  };
  const leftAxis: AxisInfo = axisFor('left', distinctUnits[0] ?? null);
  const rightAxis: AxisInfo | null = distinctUnits.length > 1 ? axisFor('right', distinctUnits[1] ?? null) : null;

  // A marker per action, pinned to the top of the plot at the action's real
  // time — an action isn't a value, so it sits on the time axis, not on the
  // line (a value-anchored ring floated off the line between readings).
  // Skipped for a container that never records this metric: it has no line
  // to be an event on.
  const actionsInExperience = new Set(containers.flatMap((c) => c.experiences.flatMap((e) => e.action_ids)));
  const actionMarkers = containers.flatMap((c) => {
    const s = series.find((x) => x.toolId === c.toolId)!;
    if (collectContainerPoints(c, metric.name, applyCutoff).length === 0) return [];
    return (c.actions || [])
      .filter((a) => !applyCutoff || new Date(a.completed_at || a.created_at).getTime() >= CHART_START_MS)
      .map((a) => ({
        timestamp: toTimestamp(a.completed_at || a.created_at),
        y: leftAxis.domain[1],
        toolId: c.toolId,
        color: s.color,
        toolName: s.name,
        action: a,
        inExperience: actionsInExperience.has(a.id),
      }));
  });

  // From each action marker down to its experience's initial and final
  // readings. A reading on the right axis is mapped onto the left axis's
  // scale, since the connector is drawn in left-axis coordinates.
  const toLeftAxis = (value: number, yAxisId: 'left' | 'right'): number => {
    if (yAxisId === 'left' || !rightAxis) return value;
    const [rMin, rMax] = rightAxis.domain;
    const [lMin, lMax] = leftAxis.domain;
    return lMin + ((value - rMin) / (rMax - rMin)) * (lMax - lMin);
  };
  // Each end state attaches to the reading nearest it in time on every line
  // of its container, so a state that has no reading of this metric (e.g. a
  // photo-only outcome) still connects to the dot that stands for it.
  const experienceLinks: ExperienceLink[] = actionMarkers.flatMap((marker) => {
    const c = containers.find((x) => x.toolId === marker.toolId)!;
    return c.experiences
      .filter((e) => e.action_ids.includes(marker.action.id))
      .flatMap((e) => {
        const links = new Map<string, ExperienceLink>();
        for (const stateId of [...e.initial_state_ids, ...e.final_state_ids]) {
          const state = c.observations.find((o) => o.id === stateId);
          if (!state) continue;
          const stateTime = toTimestamp(state.observed_at);
          const nearestBySeries = new Map<string, ContainerPoint>();
          for (const { container, point } of allPoints) {
            if (container !== c) continue;
            const seriesKey = point.subtype ? `${c.toolId}::${point.subtype}` : c.toolId;
            const best = nearestBySeries.get(seriesKey);
            if (!best || Math.abs(point.timestamp - stateTime) < Math.abs(best.timestamp - stateTime)) {
              nearestBySeries.set(seriesKey, point);
            }
          }
          for (const [seriesKey, point] of nearestBySeries) {
            const key = `${e.id}:${marker.action.id}:${seriesKey}:${point.timestamp}`;
            links.set(key, {
              key,
              toolId: c.toolId,
              color: marker.color,
              from: { x: marker.timestamp, y: marker.y },
              to: { x: point.timestamp, y: toLeftAxis(point.value, seriesByKey.get(seriesKey)!.yAxisId) },
            });
          }
        }
        return Array.from(links.values());
      });
  });

  return { metric, experienceLinks, legend, chartData, actionMarkers, leftAxis, rightAxis, chartSeries, titlePrefix: soloContainer?.toolName ?? null };
}
