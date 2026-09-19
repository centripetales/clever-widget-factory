import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, Check, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ComposedChart, Line, Scatter, XAxis, YAxis, Legend, ResponsiveContainer, CartesianGrid, Brush } from 'recharts';
import { apiService } from '@/lib/apiService';
import { useGroupSnapshots } from '@/hooks/useGroupSnapshots';
import { groupSnapshotsQueryKey } from '@/lib/queryKeys';
import { PhotoThumb } from '@/components/shared/PhotoThumb';
import { getThumbnailUrl, getImageUrl, getOriginalUrl } from '@/lib/imageUtils';
import { useAuth } from '@/hooks/useCognitoAuth';
import { useOrganization } from '@/hooks/useOrganization';
import { useMemberSettings, useUpdateMemberSettings, type MetricsChartRange } from '@/hooks/useMemberSettings';

// All observation/photo/action timestamps here are display-only, and this
// program runs in the Philippines — browser-local formatting (the default
// for toLocaleString/toLocaleDateString) would show whatever timezone the
// viewer's machine happens to be in instead, same class of bug fixed
// elsewhere in this project (scripts/azolla-weekly-report.js etc).
const MANILA_TZ = 'Asia/Manila';
function formatManila(value: string | number, opts: Intl.DateTimeFormatOptions): string {
  return new Date(value).toLocaleString('en-US', { timeZone: MANILA_TZ, ...opts });
}
const MANILA_DATE_OPTS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' };
const MANILA_DATETIME_OPTS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' };

// 2026-07-21 00:00 Asia/Manila. Everyone's first day (7/20) used a ziplock
// bag as a placeholder container before their real setup was ready, so that
// day's Coverage % numbers aren't representative of any actual container —
// dropped rather than plotted. This is an azolla-pilot-specific artifact, so
// it's applied only to the 'Coverage %' metric (see applyCutoff below) —
// every other tool's metrics (e.g. a composter's Temperature, which has real
// readings well before this date) must not be truncated by it.
const CHART_START_MS = new Date('2026-07-20T16:00:00Z').getTime();

// The UTC instant of midnight-Manila for whatever Manila calendar day `iso`
// falls on — used as the chart-data grouping key so multiple same-day
// observations (e.g. two check-ins 46 minutes apart) collapse into one
// point instead of plotting as near-overlapping dots.
function manilaDayKey(iso: string | number): number {
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
function parseMetricName(name: string): { family: string; subtype: string | null } {
  const colonIndex = name.indexOf(':');
  if (colonIndex === -1) return { family: name.trim(), subtype: null };
  return {
    family: name.slice(0, colonIndex).trim(),
    subtype: name.slice(colonIndex + 1).trim() || null,
  };
}

interface GroupPhoto {
  id: string;
  photo_url: string;
  photo_description: string | null;
  captured_at: string | null;
}

interface GroupMetric {
  metric_id: string;
  metric_name: string;
  value: string;
  unit: string | null;
}

interface GroupObservation {
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
function mergeObservations(obsList: GroupObservation[]): GroupObservation {
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
    return { metric_id: `merged-${readings[0]?.metric_id ?? name}`, metric_name: name, value: max.toFixed(2), unit };
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

interface GroupAction {
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

function applyCoverageEdit(obs: GroupObservation, value: number): GroupObservation {
  return {
    ...obs,
    metrics: (obs.metrics || []).map((m) =>
      m.metric_name === 'Coverage %' ? { ...m, value: value.toFixed(2) } : m
    ),
  };
}

// "transformative" = an actual intervention that changes the system (add
// manure, move something); "entropy_reduction" = pure information-gathering
// (a measurement, a reading) — see scripts/azolla-experience-form.js.
function actionTypeLabel(a: GroupAction): 'intervention' | 'measurement' {
  return a.scoring_data?.action_type === 'entropy_reduction' ? 'measurement' : 'intervention';
}
function actionText(a: GroupAction): string {
  return a.claim || a.scoring_data?.what_was_done || a.description || a.title;
}

export interface GroupContainer {
  toolId: string;
  toolName: string;
  sourceOrgId: string;
  sourceOrgName: string;
  sourcePhone: string | null;
  observations: GroupObservation[];
  actions: GroupAction[];
}

// Neon hues evenly spaced around the color wheel (36° apart, fixed
// saturation/lightness) so all 10 stay distinguishable even with every
// series shown at once — same "glows on black" spirit as Energeia's
// PERSON_COLORS, but that palette only guarantees 4 distinct colors before
// repeating similar hues (it was built for ≤4 primary people + filler).
const LINE_COLORS = [
  '#FF2828', '#FFA928', '#D4FF28', '#53FF28', '#28FF7E',
  '#28FEFF', '#287EFF', '#5328FF', '#D428FF', '#FF28A9',
];

const RANGE_OPTIONS: { value: MetricsChartRange; label: string }[] = [
  { value: 'week', label: 'Last week' },
  { value: 'month', label: 'Last month' },
  { value: '3months', label: 'Last 3 months' },
  { value: 'all', label: 'All time' },
];

// null means "no cutoff" (All time). Computed from *now*, not from the
// data's own latest point -- "Last week" means the last 7 calendar days,
// same as a person would expect from any other app's time-range picker.
function rangeStartMs(range: MetricsChartRange): number | null {
  const DAY_MS = 24 * 60 * 60 * 1000;
  switch (range) {
    case 'week': return Date.now() - 7 * DAY_MS;
    case 'month': return Date.now() - 30 * DAY_MS;
    case '3months': return Date.now() - 90 * DAY_MS;
    case 'all': return null;
  }
}

interface SeriesInfo {
  toolId: string;
  name: string;
  color: string;
}

interface DiscoveredMetric {
  name: string;
  unit: string | null;
}

// One resolved line on a chart: either a plain container (no subtype
// anywhere in this metric family, matching every chart's original
// behavior) or one (container, subtype) pair once a family has any
// "Family: Subtype"-named metric in it — see parseMetricName above.
interface ChartSeriesInfo {
  key: string;
  toolId: string;
  subtype: string | null;
  label: string;
  color: string;
  unit: string | null;
  // Which Y-axis this line plots against -- 'left' unless this family has
  // more than one distinct unit among its subtypes (e.g. a squeeze test's
  // "drips" alongside an IR meter's "%"), in which case the second unit
  // gets its own 'right' axis instead of being squeezed onto the first
  // one's scale. See MetricChartBundle.rightAxis.
  yAxisId: 'left' | 'right';
}

interface AxisInfo {
  unit: string | null;
  domain: [number, number];
}

interface MetricChartBundle {
  metric: DiscoveredMetric;
  chartData: Record<string, unknown>[];
  actionMarkers: { timestamp: number; y: number; toolId: string; color: string; toolName: string; action: GroupAction }[];
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

interface ContainerPoint {
  timestamp: number;
  value: number;
  subtype: string | null;
  unit: string | null;
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
function collectContainerPoints(
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
      points.push({ timestamp: day, value: Number(reading.value), subtype: null, unit: reading.unit, obs: merged });
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
      if (!Number.isFinite(Number(reading.value))) continue;
      const timestamp = new Date(obs.observed_at).getTime();
      points.push({ timestamp, value: Number(reading.value), subtype: parsed.subtype, unit: reading.unit, obs });
    }
  }
  return points.sort((a, b) => a.timestamp - b.timestamp);
}

// Builds one metric's chart data across every container — the same logic
// the old Coverage %-only chart used, generalized to whichever metric
// FAMILY (see parseMetricName) is passed in. `applyCutoff` (true only for
// 'Coverage %') is the one azolla-pilot-specific exception — see
// CHART_START_MS above.
function buildMetricChart(containers: GroupContainer[], series: SeriesInfo[], metric: DiscoveredMetric): MetricChartBundle {
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

  let paletteIndex = 0;
  const chartSeries: ChartSeriesInfo[] = Array.from(seriesMeta.entries()).map(([key, { toolId, subtype, unit }]) => {
    const containerSeries = series.find((s) => s.toolId === toolId);
    const resolvedUnit = normalizeUnit(unit);
    const yAxisId = axisForUnit.get(resolvedUnit) ?? 'left';
    if (!hasSubtypes) {
      // No subtype anywhere in this family (the common case) -- keep
      // exactly today's per-container identity: same color and label on
      // every chart, so "the same farmer/tool always reads as the same
      // color" invariant holds regardless of which chart you're looking at.
      return { key, toolId, subtype: null, label: containerSeries?.name ?? toolId, color: containerSeries?.color ?? LINE_COLORS[0], unit: resolvedUnit, yAxisId };
    }
    const color = LINE_COLORS[paletteIndex++ % LINE_COLORS.length];
    // With the container's own name already moved into the chart title
    // (soloContainer, used below), repeating it in every series label too
    // would read like three tools being compared instead of one tool's
    // several measurement approaches -- so it's dropped here. A
    // subtype-less reading (someone's older un-tagged "Moisture" entry,
    // say) falls back to the bare family name instead of the container
    // name for the same reason.
    const label = soloContainer
      ? subtype ?? metric.name
      : subtype
        ? `${containerSeries?.name ?? toolId} — ${subtype}`
        : containerSeries?.name ?? toolId;
    return { key, toolId, subtype, label, color, unit: resolvedUnit, yAxisId };
  });
  const seriesByKey = new Map(chartSeries.map((s) => [s.key, s]));

  const rows = new Map<number, Record<string, unknown>>();
  const axisRange = new Map<'left' | 'right', { min: number; max: number }>();
  for (const { container, point } of allPoints) {
    const seriesKey = point.subtype ? `${container.toolId}::${point.subtype}` : container.toolId;
    const row = rows.get(point.timestamp) || { timestamp: point.timestamp, date: formatManila(point.timestamp, MANILA_DATE_OPTS) };
    row[seriesKey] = point.value;
    row[`${seriesKey}__obs`] = point.obs;
    rows.set(point.timestamp, row);
    const yAxisId = seriesByKey.get(seriesKey)!.yAxisId;
    const range = axisRange.get(yAxisId) ?? { min: Infinity, max: -Infinity };
    if (point.value < range.min) range.min = point.value;
    if (point.value > range.max) range.max = point.value;
    axisRange.set(yAxisId, range);
  }

  const realChartData = Array.from(rows.values()).sort((a: any, b: any) => a.timestamp - b.timestamp);

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
  let chartData: Record<string, unknown>[] = realChartData;
  if (realChartData.length >= 2) {
    const dayMs = 24 * 60 * 60 * 1000;
    const first = (realChartData[0] as any).timestamp as number;
    const last = (realChartData[realChartData.length - 1] as any).timestamp as number;
    const byTimestamp = new Map<number, Record<string, unknown>>();
    for (const row of realChartData) byTimestamp.set((row as any).timestamp, row);
    for (let t = first; t <= last; t += dayMs) {
      if (!byTimestamp.has(t)) byTimestamp.set(t, { timestamp: t, date: formatManila(t, MANILA_DATE_OPTS) });
    }
    chartData = Array.from(byTimestamp.values()).sort((a: any, b: any) => a.timestamp - b.timestamp);
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
  const leftAxis: AxisInfo = {
    unit: distinctUnits[0] ?? null,
    domain: applyCutoff ? [0, 100] : domainFor(axisRange.get('left')),
  };
  const rightAxis: AxisInfo | null =
    distinctUnits.length > 1 ? { unit: distinctUnits[1] ?? null, domain: domainFor(axisRange.get('right')) } : null;

  // A marker per action, placed directly on that person's own line (at the
  // value nearest the action's date) rather than a separate lane — so "what
  // did they do before that jump" reads straight off the curve. Reuses the
  // same points collectContainerPoints built for the line above, so a ring
  // always lands exactly on a plotted point, not some intermediate raw
  // value the line itself doesn't show. Skipped entirely once this family
  // has subtypes OR a second axis: an action isn't naturally "about" one
  // subtype/unit over another (which line would a ring on "Moisture" even
  // belong to -- squeeze test or IR meter?), and a single Scatter layer
  // can only bind to one Y-axis, so mixed-axis markers would plot wrong
  // anyway.
  const actionMarkers = hasSubtypes || rightAxis ? [] : containers.flatMap((c) => {
    const s = series.find((x) => x.toolId === c.toolId)!;
    const points = collectContainerPoints(c, metric.name, applyCutoff);

    // A container that never records this metric at all has no line to
    // ring a marker onto — unlike Coverage % (which every azolla container
    // tracks, so this case never came up for it), a metric like a
    // composter's Temperature may only ever apply to one container.
    // Fabricating a y=0 marker for every other container's actions instead
    // of skipping them is what produced a wall of rings sitting on the
    // axis floor and, worse, dragging the domain calc down with them.
    if (points.length === 0) return [];

    const yForTimestamp = (t: number): number => {
      const next = points.find((p) => p.timestamp >= t);
      if (next) return next.value;
      return points[points.length - 1].value;
    };

    return (c.actions || [])
      .filter((a) => !applyCutoff || new Date(a.completed_at || a.created_at).getTime() >= CHART_START_MS)
      .map((a) => {
        const actionDate = a.completed_at || a.created_at;
        // Coverage % still rounds to its day bucket, matching the line's
        // own day-bucketed points; every other metric places the ring at
        // the action's real timestamp, matching the line's now-unbucketed
        // points.
        const timestamp = applyCutoff ? manilaDayKey(actionDate) : new Date(actionDate).getTime();
        // Centered on the actual data point — the marker is a hollow ring
        // (fill="none"), so it rings the dot rather than covering it.
        const y = yForTimestamp(timestamp);
        return { timestamp, y, toolId: c.toolId, color: s.color, toolName: s.name, action: a };
      });
  });

  return { metric, chartData, actionMarkers, leftAxis, rightAxis, chartSeries, titlePrefix: soloContainer?.toolName ?? null };
}

/**
 * One line chart for a single metric family, one line per (container,
 * subtype) pair actually observed — the rendering half of
 * buildMetricChart's data. Extracted so GroupMetricsGrid can render one of
 * these per distinct metric family found across the org's containers,
 * instead of a single hardcoded chart.
 */
function MetricChartCard({
  bundle,
  hiddenSeriesKeys,
  toggleSeries,
  onPickObservation,
  onPickAction,
  hideContainerName,
}: {
  bundle: MetricChartBundle;
  hiddenSeriesKeys: Set<string>;
  toggleSeries: (key: string) => void;
  onPickObservation: (toolId: string, obs: GroupObservation, seriesName: string, color: string) => void;
  onPickAction: (payload: { action: GroupAction; toolName: string; color: string }) => void;
  hideContainerName?: boolean;
}) {
  const { metric, chartData, actionMarkers, leftAxis, rightAxis, chartSeries, titlePrefix } = bundle;
  const isCoverage = metric.name === 'Coverage %';

  // Recharts' own automatic brush-to-chart data slicing (an uncontrolled
  // <Brush> is supposed to filter every sibling series by index on drag)
  // did not actually update the chart when tested against this Recharts
  // version — the Brush's own DOM state changed but the Line/XAxis never
  // re-rendered. Also, this Recharts version's <Brush> has no `data` prop
  // at all (it reads the enclosing chart's own data via context), so it
  // can't hold a full-range preview while the chart shows a sliced-down
  // array. Zooming via an explicit XAxis domain sidesteps both issues:
  // <ComposedChart> keeps the full chartData always, and dragging the
  // brush just narrows [start, end] timestamps fed to the XAxis's domain.
  const [zoomDomain, setZoomDomain] = useState<[number, number] | null>(null);
  // brushResetKey forces <Brush> to remount (and so reset its own internal
  // slider position) whenever the underlying data changes out from under
  // it -- e.g. the persisted time-range dropdown reloading a different
  // window -- rather than leaving its handles pointing at stale indices.
  const [brushResetKey, setBrushResetKey] = useState(0);
  useEffect(() => {
    setZoomDomain(null);
    setBrushResetKey((k) => k + 1);
  }, [chartData]);

  const handleBrushChange = ({ startIndex, endIndex }: { startIndex: number; endIndex: number }) => {
    const startTs = (chartData[startIndex] as { timestamp: number } | undefined)?.timestamp;
    const endTs = (chartData[endIndex] as { timestamp: number } | undefined)?.timestamp;
    if (startTs == null || endTs == null) return;
    // Dragging both handles back out to the full extent restores the
    // original auto-padded domain (matches the unzoomed default exactly,
    // rather than freezing it at today's timestamps). Anything else -- even
    // a drag that lands both handles on the SAME index, easy to do with
    // only a couple of data points -- is honored as a real (if narrow) zoom
    // rather than silently discarded back to full: the XAxis domain's own
    // 2-day padding (below) still gives a single-point selection a sensible
    // window instead of a zero-width one. Discarding it back to full used
    // to leave the Brush's own handles visually pinched together while the
    // chart kept showing everything -- confusing, looked like the drag did
    // nothing.
    const isFullExtent = startIndex === 0 && endIndex === chartData.length - 1;
    setZoomDomain(isFullExtent ? null : [Math.min(startTs, endTs), Math.max(startTs, endTs)]);
  };

  const rangeStart = zoomDomain ? zoomDomain[0] : (chartData[0] as { timestamp: number } | undefined)?.timestamp;
  const rangeEnd = zoomDomain ? zoomDomain[1] : (chartData[chartData.length - 1] as { timestamp: number } | undefined)?.timestamp;

  // One tick per week across whatever's currently zoomed in on, not the
  // full dataset — otherwise a narrow zoom range could land zero of the
  // original full-range ticks inside its domain and the axis would go
  // blank. Same logic buildMetricChart uses for the unzoomed case.
  const weekTicks = useMemo(() => {
    const ticks: number[] = [];
    if (rangeStart != null && rangeEnd != null) {
      const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
      for (let t = rangeStart; t <= rangeEnd; t += oneWeekMs) ticks.push(t);
      if (ticks[ticks.length - 1] !== rangeEnd) ticks.push(rangeEnd);
    }
    return ticks;
  }, [rangeStart, rangeEnd]);

  // Action-ring markers outside the zoomed window would otherwise still
  // plot (Recharts clips them at the SVG edge, which reads as broken/
  // missing rings rather than "zoomed past this one").
  const visibleActionMarkers =
    rangeStart == null || rangeEnd == null
      ? []
      : actionMarkers.filter((m) => m.timestamp >= rangeStart && m.timestamp <= rangeEnd);

  return (
    <Card
      className="border-0 rounded-xl overflow-hidden relative"
      style={{ background: 'radial-gradient(ellipse at 50% 0%, #0a0a18 0%, #020408 65%)' }}
    >
      {/* CSS starfield — same idea as OikonomiaBackground's Three.js scene,
          done cheaply here since this is a 2D recharts panel, not a canvas. */}
      <div
        className="absolute inset-0 pointer-events-none opacity-60"
        style={{
          backgroundImage: [
            'radial-gradient(1px 1px at 10% 15%, #fff, transparent)',
            'radial-gradient(1px 1px at 25% 60%, #fff, transparent)',
            'radial-gradient(1.5px 1.5px at 40% 25%, #fff, transparent)',
            'radial-gradient(1px 1px at 55% 80%, #fff, transparent)',
            'radial-gradient(1px 1px at 70% 10%, #fff, transparent)',
            'radial-gradient(1.5px 1.5px at 85% 55%, #fff, transparent)',
            'radial-gradient(1px 1px at 95% 30%, #fff, transparent)',
            'radial-gradient(1px 1px at 15% 90%, #fff, transparent)',
            'radial-gradient(1px 1px at 60% 45%, #fff, transparent)',
            'radial-gradient(1px 1px at 30% 5%, #fff, transparent)',
          ].join(', '),
        }}
      />
      <div className="relative px-5 pt-4 pb-2 text-center">
        <h2 className="text-white font-semibold tracking-tight" style={{ fontSize: '1.05rem', letterSpacing: '-0.01em' }}>
          {!hideContainerName && titlePrefix ? `${titlePrefix} — ` : ''}{metric.name} Over Time
        </h2>
      </div>
      <CardContent className="relative">
        <ResponsiveContainer width="100%" height={480}>
          {/* left/right margin wider than default: the first/last rotated
              date labels (angle=-45, textAnchor="end") extend past their
              tick's x position, and without this room they (and the first
              point's glow) got clipped by the chart's SVG edge. */}
          <ComposedChart data={chartData} margin={{ top: 5, right: 30, left: 30, bottom: 45 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,229,255,0.12)" />
            <XAxis
              dataKey="timestamp"
              type="number"
              // A couple days of padding on each side, not a flush
              // ['dataMin','dataMax'] domain — otherwise the first/last
              // point sits exactly on the axis line, and its glow
              // (drop-shadow filter) bleeds a few px past it, reading as
              // "data starts before the axis." When zoomed (zoomDomain
              // set), <ComposedChart> still holds the FULL chartData (see
              // above), so the domain has to be pinned to explicit
              // timestamps here rather than the usual dataMin/dataMax
              // functions -- those would recompute from the full,
              // un-zoomed dataset and undo the zoom entirely.
              domain={
                zoomDomain
                  ? [zoomDomain[0] - 2 * 24 * 60 * 60 * 1000, zoomDomain[1] + 2 * 24 * 60 * 60 * 1000]
                  : [
                      (dataMin: number) => dataMin - 2 * 24 * 60 * 60 * 1000,
                      (dataMax: number) => dataMax + 2 * 24 * 60 * 60 * 1000,
                    ]
              }
              ticks={weekTicks}
              tickFormatter={(ts: number) => formatManila(ts, MANILA_DATE_OPTS)}
              tick={{ fontSize: 11, fill: '#94a3b8' }}
              axisLine={{ stroke: 'rgba(0,229,255,0.25)' }}
              tickLine={{ stroke: 'rgba(0,229,255,0.25)' }}
              angle={-45}
              textAnchor="end"
              height={60}
              label={{ value: 'Date', position: 'insideBottom', offset: -40, style: { fontSize: 12, fill: '#64748b' } }}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 11, fill: '#94a3b8' }}
              axisLine={{ stroke: 'rgba(0,229,255,0.25)' }}
              tickLine={{ stroke: 'rgba(0,229,255,0.25)' }}
              domain={leftAxis.domain}
              // Ticks interpolated across a padded floating-point domain
              // land on values like 40.999999999994 — round for display,
              // the underlying data stays exact.
              tickFormatter={isCoverage ? undefined : (v: number) => Number(v.toFixed(2)).toString()}
              unit={leftAxis.unit ?? undefined}
              label={{
                value: rightAxis ? `${metric.name}${leftAxis.unit ? ` (${leftAxis.unit})` : ''}` : metric.name,
                angle: -90,
                position: 'insideLeft',
                style: { fontSize: 12, fill: '#64748b', textAnchor: 'middle' },
              }}
            />
            {/* A second Y-axis only ever appears when this family's
                subtypes genuinely don't share a unit (e.g. a squeeze
                test's "drips" alongside an IR meter's "%") -- see
                buildMetricChart's distinctUnits/axisForUnit. Its own label
                carries the unit directly since there's no room to also
                repeat the metric name on the right side. */}
            {rightAxis && (
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 11, fill: '#94a3b8' }}
                axisLine={{ stroke: 'rgba(255,169,40,0.35)' }}
                tickLine={{ stroke: 'rgba(255,169,40,0.35)' }}
                domain={rightAxis.domain}
                tickFormatter={(v: number) => Number(v.toFixed(2)).toString()}
                unit={rightAxis.unit ?? undefined}
                label={{
                  value: rightAxis.unit ?? '',
                  angle: 90,
                  position: 'insideRight',
                  style: { fontSize: 12, fill: '#64748b', textAnchor: 'middle' },
                }}
              />
            )}
            <Legend
              content={() => (
                <div className="flex flex-wrap justify-center gap-2 pt-3">
                  {chartSeries.map((s) => {
                    const active = !hiddenSeriesKeys.has(s.key);
                    return (
                      <button
                        key={s.key}
                        type="button"
                        onClick={() => toggleSeries(s.key)}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all"
                        style={{
                          background: active ? `${s.color}1a` : 'rgba(255,255,255,0.03)',
                          border: `1px solid ${active ? `${s.color}55` : 'rgba(255,255,255,0.1)'}`,
                          color: active ? s.color : '#4b5563',
                        }}
                      >
                        <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: active ? s.color : '#4b5563' }} />
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              )}
            />
            {chartSeries.map((s) => (
              <Line
                key={s.key}
                yAxisId={s.yAxisId}
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                connectNulls
                hide={hiddenSeriesKeys.has(s.key)}
                // A toggled-back-on series fully remounts (hide returns
                // null, not just opacity:0), so this mount animation is
                // what makes the dots "fly in" from the 0% baseline every
                // time — same effect on the initial load, just less
                // noticeable there since everything appears together.
                isAnimationActive
                animationDuration={700}
                animationEasing="ease-out"
                dot={(dotProps: any) => {
                  const { cx, cy, payload, index } = dotProps;
                  const obs = payload[`${s.key}__obs`];
                  if (!obs || payload[s.key] === undefined) return <g key={`dot-${s.key}-${index}`} />;
                  const onPick = () => onPickObservation(s.toolId, obs, s.label, s.color);
                  return (
                    <circle
                      key={`dot-${s.key}-${index}`}
                      cx={cx}
                      cy={cy}
                      r={5}
                      fill={s.color}
                      stroke="#020408"
                      strokeWidth={1.5}
                      style={{ cursor: 'pointer', filter: `drop-shadow(0 0 3px ${s.color}aa)` }}
                      onClick={onPick}
                    />
                  );
                }}
                activeDot={(dotProps: any) => {
                  const { cx, cy, payload, index } = dotProps;
                  const obs = payload[`${s.key}__obs`];
                  if (!obs || payload[s.key] === undefined) return <g key={`active-dot-${s.key}-${index}`} />;
                  const onPick = () => onPickObservation(s.toolId, obs, s.label, s.color);
                  return (
                    <circle
                      key={`active-dot-${s.key}-${index}`}
                      cx={cx}
                      cy={cy}
                      r={7}
                      fill={s.color}
                      stroke="#020408"
                      strokeWidth={2}
                      style={{ cursor: 'pointer', filter: `drop-shadow(0 0 6px ${s.color})` }}
                      onClick={onPick}
                    />
                  );
                }}
              />
            ))}
            <Scatter
              yAxisId="left"
              // Always the full array, never filtered by hiddenSeriesKeys —
              // filtering shrinks/grows the array on toggle, which shifts
              // every later marker's index. Recharts animates points by
              // array position, so a shifted index reads as "jump to
              // wherever the old occupant of that slot was" (the domain
              // start, when the slot didn't exist a moment ago) instead of
              // a clean appear/disappear. Hiding via an empty render (same
              // pattern the Line's own dot already uses) keeps the array
              // — and every marker's index — stable regardless of toggles.
              data={visibleActionMarkers}
              dataKey="y"
              isAnimationActive
              animationDuration={700}
              animationEasing="ease-out"
              shape={(props: any) => {
                const { cx, cy, payload } = props;
                if (hiddenSeriesKeys.has(payload.toolId)) return <g />;
                const onClick = () => onPickAction({ action: payload.action, toolName: payload.toolName, color: payload.color });
                return (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={10}
                    fill="none"
                    stroke={payload.color}
                    strokeWidth={2}
                    style={{ cursor: 'pointer', filter: `drop-shadow(0 0 4px ${payload.color})` }}
                    onClick={onClick}
                  />
                );
              }}
            />
            {/* Drag either handle to zoom into a range, drag the middle to
                pan. This Recharts version's <Brush> reads its data straight
                from the enclosing chart's own (always-full) data, so its
                mini-preview never needs a separate prop -- dragging it just
                reports index positions, which handleBrushChange turns into
                the actual timestamps driving the XAxis's domain above. This
                is purely an in-session zoom, layered on top of whatever the
                persisted time-range preference already loaded -- it doesn't
                touch that preference. */}
            <Brush
              key={brushResetKey}
              dataKey="timestamp"
              onChange={handleBrushChange}
              height={20}
              stroke="rgba(0,229,255,0.4)"
              fill="rgba(10,10,24,0.6)"
              tickFormatter={(ts: number) => formatManila(ts, MANILA_DATE_OPTS)}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

/**
 * One chart per distinct metric name recorded across every container
 * sharing this org (matching scripts/azolla-coverage-chart.py's original
 * Coverage %-only plot, generalized to whichever metrics a container
 * happens to track — e.g. a composter's Temperature shows up here exactly
 * the same way azolla's Coverage % does, automatically, once it's shared
 * into the org), with a clickable legend to toggle people on/off, and
 * click-through to that day's full observation — photos included, no
 * second fetch (the /coverage-snapshots response already bundles
 * everything per observation). Used both as its own page
 * (GroupCoverage.tsx) and embedded as a tab on a shared container's own
 * details page (ToolDetails.tsx).
 */
export function GroupMetricsGrid({ orgId, hideContainerName }: { orgId: string; hideContainerName?: boolean }) {
  const { user } = useAuth();
  // Active-org-scoped, matching the backend's own check (an admin can only
  // edit observations belonging to whichever org is currently selected —
  // same rule ToolDetails.tsx's canEditObservation uses).
  const { isAdmin } = useOrganization();
  const queryClient = useQueryClient();
  const { data: containersData, isLoading: loading, error: loadError } = useGroupSnapshots(orgId);
  const containers = containersData ?? null;
  const error = loadError ? (loadError as Error).message || 'Failed to load group data' : null;
  // Set on click, rendered as a popup dialog (see the dark-styled Dialog
  // below) — a hover-preview doesn't have a touch-device equivalent, so
  // click/tap is the one interaction that works on both.
  const [selectedObservation, setSelectedObservation] = useState<{ obs: GroupObservation; toolName: string; color: string; priorActions: GroupAction[] } | null>(null);
  const [selectedAction, setSelectedAction] = useState<{ action: GroupAction; toolName: string; color: string } | null>(null);
  const [editingCoverage, setEditingCoverage] = useState(false);
  const [coverageDraft, setCoverageDraft] = useState('');
  const [coverageError, setCoverageError] = useState<string | null>(null);

  // "What did they do before this observation" — actions on this container
  // completed between the previous observation (for the same container) and
  // this one, so a value jump can be traced back to what caused it.
  const selectObservation = (toolId: string, obs: GroupObservation, seriesName: string, color: string) => {
    const container = containers?.find((c) => c.toolId === toolId);
    if (!container) return;
    const sorted = [...container.observations].sort((a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime());
    const idx = sorted.findIndex((o) => o.id === obs.id);
    const windowStart = idx > 0 ? new Date(sorted[idx - 1].observed_at).getTime() : -Infinity;
    const windowEnd = new Date(obs.observed_at).getTime();
    const priorActions = (container.actions || [])
      .filter((a) => {
        const t = new Date(a.completed_at || a.created_at).getTime();
        return t > windowStart && t <= windowEnd;
      })
      .sort((a, b) => new Date(a.completed_at || a.created_at).getTime() - new Date(b.completed_at || b.created_at).getTime());
    setEditingCoverage(false);
    setCoverageError(null);
    setSelectedObservation({ obs, toolName: seriesName, color, priorActions });
  };

  // Merged (multi-observation) days have no single state to send a PUT to
  // — obs.id is just the first of several real states, so editing it would
  // silently update the wrong observation's snapshot.
  const canEditObservation = (obs: GroupObservation) => !obs.mergedIds && !!user && (user.userId === obs.observed_by || isAdmin);

  // Updates both the open dialog and the underlying containers/chart data in
  // place, so the line reflects the correction immediately instead of
  // needing a refetch of the whole /coverage-snapshots response.
  const saveCoverageMutation = useMutation<unknown, Error, { stateId: string; value: number }>({
    mutationFn: ({ stateId, value }) => apiService.put(`/api/states/${stateId}/coverage`, { value }),
    onSuccess: (_res, { stateId, value }) => {
      queryClient.setQueryData<GroupContainer[]>(groupSnapshotsQueryKey(orgId), (prev) =>
        prev?.map((c) => ({
          ...c,
          observations: c.observations.map((o) => (o.id === stateId ? applyCoverageEdit(o, value) : o)),
        }))
      );
      // The same state shows in History/Observations views elsewhere.
      queryClient.invalidateQueries({ queryKey: ['states'] });
      queryClient.invalidateQueries({ queryKey: ['tool_history'] });
    },
  });
  const savingCoverage = saveCoverageMutation.isPending;

  const saveCoverage = () => {
    if (!selectedObservation) return;
    const value = Number(coverageDraft);
    if (Number.isNaN(value) || value < 0 || value > 100) {
      setCoverageError('Enter a number between 0 and 100');
      return;
    }
    setCoverageError(null);
    saveCoverageMutation.mutate(
      { stateId: selectedObservation.obs.id, value },
      {
        onSuccess: () => {
          setSelectedObservation((prev) => (prev ? { ...prev, obs: applyCoverageEdit(prev.obs, value) } : prev));
          setEditingCoverage(false);
        },
        onError: (err) => setCoverageError(err.message || 'Failed to save coverage'),
      }
    );
  };

  // Keyed by plain toolId for a metric family with no subtypes, or
  // `${toolId}::${subtype}` once one exists -- see ChartSeriesInfo/
  // buildMetricChart. A toggle only ever affects the exact series it
  // belongs to; two different subtype lines for the same container toggle
  // independently.
  const [hiddenSeriesKeys, setHiddenSeriesKeys] = useState<Set<string>>(new Set());

  // Persisted per (user, org) -- same member-settings store growth_intents
  // already uses (src/hooks/useMemberSettings.ts). Defaults to 'all' until
  // a person picks something, matching the chart's original behavior.
  const { data: memberSettings } = useMemberSettings(user?.userId, orgId);
  const updateMemberSettings = useUpdateMemberSettings();
  const range: MetricsChartRange = memberSettings?.metrics_chart_range ?? 'all';
  const setRange = (next: MetricsChartRange) => {
    if (!user?.userId) return;
    // Spread the existing settings object rather than sending only the
    // changed field -- the PUT replaces the whole settings blob, so a
    // person with growth_intents already set would otherwise lose them.
    updateMemberSettings.mutate({ userId: user.userId, organizationId: orgId, settings: { ...memberSettings, metrics_chart_range: next } });
  };

  // The persisted range trims each container's observations/actions down to
  // the selected window before anything downstream (metric discovery, chart
  // data, action markers) ever sees them -- a metric whose only data falls
  // outside the window simply won't get a chart, same as it having no data
  // at all. `containers` itself stays untouched so dialogs opened from a
  // still-visible point (selectObservation's prior-actions lookup) keep
  // full history context rather than being clipped by the same window.
  const filteredContainers = useMemo<GroupContainer[] | null>(() => {
    if (!containers) return containers;
    const cutoff = rangeStartMs(range);
    if (cutoff == null) return containers;
    return containers.map((c) => ({
      ...c,
      observations: c.observations.filter((o) => new Date(o.observed_at).getTime() >= cutoff),
      actions: (c.actions || []).filter((a) => new Date(a.completed_at || a.created_at).getTime() >= cutoff),
    }));
  }, [containers, range]);

  // Every distinct metric FAMILY recorded anywhere across this org's
  // containers (the part of the name before a "Family: Subtype" colon, or
  // the whole name if there's no colon — see parseMetricName) — 'Coverage
  // %' first (today's primary chart), the rest alphabetical. This is the
  // one line of code that actually generalizes the chart: whatever a
  // farmer or a composter operator happens to track shows up here
  // automatically, no per-metric wiring needed. Grouped case-insensitively
  // so e.g. "moisture: ..." and "Moisture: ..." still land on one chart.
  const metricsPresent = useMemo<DiscoveredMetric[]>(() => {
    if (!filteredContainers) return [];
    const families = new Map<string, { name: string; unit: string | null }>();
    for (const c of filteredContainers) {
      for (const o of c.observations) {
        for (const m of o.metrics || []) {
          const { family } = parseMetricName(m.metric_name);
          const key = family.toLowerCase();
          if (!families.has(key)) families.set(key, { name: family, unit: m.unit });
        }
      }
    }
    return Array.from(families.values())
      .sort((a, b) => {
        if (a.name === 'Coverage %') return -1;
        if (b.name === 'Coverage %') return 1;
        return a.name.localeCompare(b.name);
      });
  }, [filteredContainers]);

  // One color per container, computed from the full (unfiltered) container
  // list so a color never reassigns when the time range changes — shared
  // across every metric's chart so the same farmer/tool always reads as the
  // same color no matter which chart or which range you're looking at.
  const series = useMemo<SeriesInfo[]>(() => {
    if (!containers) return [];
    return containers.map((c, i) => ({
      toolId: c.toolId,
      // Privacy: label by phone number (payment-roster convention, see
      // scripts/azolla-weekly-heatmap.js) rather than name — except Stefan
      // and Mae, who keep their first name since they aren't tracked by phone.
      name: c.sourcePhone || c.toolName.split(/['’]s\b/i)[0].trim().split(' ')[0],
      color: LINE_COLORS[i % LINE_COLORS.length],
    }));
  }, [containers]);

  const metricCharts = useMemo<MetricChartBundle[]>(() => {
    if (!filteredContainers) return [];
    return metricsPresent.map((metric) => buildMetricChart(filteredContainers, series, metric));
  }, [filteredContainers, series, metricsPresent]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mr-2" /> Loading group data...
      </div>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive/50">
        <CardContent className="pt-6 text-destructive">{error}</CardContent>
      </Card>
    );
  }

  if (!containers || containers.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="pt-6 text-center text-muted-foreground">
          No containers are shared into this organization yet.
        </CardContent>
      </Card>
    );
  }

  const toggleSeries = (key: string) => {
    setHiddenSeriesKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <>
      <div className="flex justify-end mb-4">
        <Select value={range} onValueChange={(v) => setRange(v as MetricsChartRange)}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-6">
        {metricCharts.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="pt-6 text-center text-muted-foreground">
              No metrics have been recorded yet for any container shared into this organization.
            </CardContent>
          </Card>
        ) : (
          metricCharts.map((bundle) => (
            <MetricChartCard
              key={bundle.metric.name}
              bundle={bundle}
              hiddenSeriesKeys={hiddenSeriesKeys}
              toggleSeries={toggleSeries}
              onPickObservation={selectObservation}
              onPickAction={setSelectedAction}
              hideContainerName={hideContainerName}
            />
          ))
        )}
      </div>

      {/* Click-triggered popup (not hover — hover has no equivalent on
          touch, so a mobile tap needs to open something, not preview it
          inline while the finger is already gone). Styled to match the
          chart's dark theme instead of the default light Dialog. */}
      <Dialog open={!!selectedObservation} onOpenChange={(open) => !open && setSelectedObservation(null)}>
        <DialogContent
          className="max-w-2xl max-h-[85vh] overflow-y-auto border-0"
          style={{
            background: 'radial-gradient(ellipse at 50% 0%, #0a0a18 0%, #020408 65%)',
            boxShadow: selectedObservation ? `0 0 32px ${selectedObservation.color}33` : undefined,
          }}
        >
          {/* The Dialog's own built-in close button inherits the light
              theme's dark text color with no override here, so it renders
              invisible against this black background — easy to miss on
              desktop (tap-outside still closes it) but a real problem on
              mobile, where there's no "outside" to tap. This one is sized
              for a thumb, not a cursor. */}
          <DialogClose
            className="absolute right-3 top-3 rounded-full p-2 z-10"
            style={{ background: 'rgba(255,255,255,0.08)', color: '#94a3b8' }}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </DialogClose>
          {selectedObservation && (
            <>
              <DialogHeader>
                <DialogTitle style={{ color: selectedObservation.color }}>{selectedObservation.toolName}</DialogTitle>
              </DialogHeader>
              <div className="space-y-1 text-sm">
                {/* Skip this when it just repeats the title — series names
                    are phone numbers except Stefan/Mae, whose title IS
                    their first name (see the `name` field in `series`
                    above), so observed_by_name would otherwise duplicate it
                    ("Stefan" title + "Stefan Hamilton" right below it). */}
                {!selectedObservation.obs.observed_by_name.startsWith(selectedObservation.toolName) && (
                  <p className="font-medium text-slate-200">{selectedObservation.obs.observed_by_name}</p>
                )}
                <p className="text-slate-500">{formatManila(selectedObservation.obs.observed_at, MANILA_DATETIME_OPTS)}</p>
                {selectedObservation.obs.mergedIds && (
                  <p className="text-xs text-slate-500">
                    Combined from {selectedObservation.obs.mergedIds.length} check-ins this day — showing each metric's max.
                  </p>
                )}
              </div>
              {selectedObservation.obs.observation_text && (
                <p className="text-sm text-slate-200">{selectedObservation.obs.observation_text}</p>
              )}
              {selectedObservation.obs.metrics && selectedObservation.obs.metrics.length > 0 && (
                <div
                  className="p-2 rounded text-sm space-y-0.5"
                  style={{ background: 'rgba(0,229,255,0.06)', border: '1px solid rgba(0,229,255,0.2)' }}
                >
                  {selectedObservation.obs.metrics.map((m) => {
                    const isCoverage = m.metric_name === 'Coverage %';
                    if (isCoverage && editingCoverage) {
                      return (
                        <div key={m.metric_id} className="flex items-center gap-1.5">
                          <span className="font-medium text-cyan-300">{m.metric_name}:</span>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step="0.01"
                            autoFocus
                            value={coverageDraft}
                            onChange={(e) => setCoverageDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveCoverage();
                              if (e.key === 'Escape') setEditingCoverage(false);
                            }}
                            className="w-16 px-1 py-0.5 rounded text-cyan-100"
                            style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(0,229,255,0.4)' }}
                          />
                          <span className="text-cyan-400/80">{m.unit}</span>
                          <button
                            type="button"
                            onClick={saveCoverage}
                            disabled={savingCoverage}
                            className="ml-1 text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
                            aria-label="Save"
                          >
                            {savingCoverage ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingCoverage(false)}
                            disabled={savingCoverage}
                            className="text-slate-500 hover:text-slate-300 disabled:opacity-50"
                            aria-label="Cancel"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    }
                    return (
                      <div key={m.metric_id} className="flex items-center gap-1.5">
                        <span className="font-medium text-cyan-300">{m.metric_name}:</span>{' '}
                        <span className="text-cyan-400/80">{m.value}{m.unit}</span>
                        {isCoverage && canEditObservation(selectedObservation.obs) && (
                          <button
                            type="button"
                            onClick={() => {
                              setCoverageDraft(m.value);
                              setCoverageError(null);
                              setEditingCoverage(true);
                            }}
                            className="text-cyan-500/60 hover:text-cyan-300"
                            aria-label="Edit coverage"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {editingCoverage && coverageError && (
                    <p className="text-xs text-red-400">{coverageError}</p>
                  )}
                </div>
              )}
              {selectedObservation.obs.photos && selectedObservation.obs.photos.length > 0 && (
                <div className="flex flex-col gap-2">
                  {selectedObservation.obs.photos.map((photo) => (
                    <div key={photo.id} className="flex gap-3 items-start">
                      <PhotoThumb
                        href={getOriginalUrl(photo.photo_url) || getImageUrl(photo.photo_url) || ''}
                        src={getThumbnailUrl(photo.photo_url) || getImageUrl(photo.photo_url) || ''}
                        alt={photo.photo_description || 'Observation photo'}
                        className={`w-28 h-28 flex-shrink-0 rounded border ${
                          selectedObservation.priorActions.length > 0 ? 'border-2 border-purple-500' : 'border-white/10'
                        }`}
                      />
                      <div className="pt-1">
                        {photo.captured_at && (
                          <p className="text-xs text-slate-500">
                            {formatManila(photo.captured_at, MANILA_DATETIME_OPTS)}
                          </p>
                        )}
                        {photo.photo_description && (
                          <p className="text-sm text-slate-400">{photo.photo_description}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedAction} onOpenChange={(open) => !open && setSelectedAction(null)}>
        <DialogContent className="max-w-md">
          {/* Same reasoning as the observation dialog above — a bigger,
              unambiguous touch target than the default close button. */}
          <DialogClose
            className="absolute right-3 top-3 rounded-full p-2 z-10 hover:bg-accent"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </DialogClose>
          {selectedAction && (
            <>
              <DialogHeader>
                <DialogTitle style={{ color: selectedAction.color }}>{selectedAction.toolName}</DialogTitle>
              </DialogHeader>
              <div className="space-y-1.5 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{selectedAction.action.title}</span>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground border rounded px-1.5 py-0.5">
                    {actionTypeLabel(selectedAction.action)}
                  </span>
                </div>
                <p className="text-muted-foreground">
                  {formatManila(selectedAction.action.completed_at || selectedAction.action.created_at, MANILA_DATE_OPTS)}
                </p>
                <p>{actionText(selectedAction.action)}</p>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
