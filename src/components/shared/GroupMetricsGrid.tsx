import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Loader2, Pencil, Check, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ComposedChart, Line, Scatter, ReferenceArea, XAxis, YAxis, Legend, ResponsiveContainer, CartesianGrid, Brush } from 'recharts';
import { apiService } from '@/lib/apiService';
import { useGroupSnapshots } from '@/hooks/useGroupSnapshots';
import { groupSnapshotsQueryKey } from '@/lib/queryKeys';
import { PhotoThumb } from '@/components/shared/PhotoThumb';
import { getThumbnailUrl, getImageUrl, getOriginalUrl, preloadImages } from '@/lib/imageUtils';
import { useAuth } from '@/hooks/useCognitoAuth';
import { useOrganization } from '@/hooks/useOrganization';
import { useMemberSettings, useUpdateMemberSettings, type MetricsChartRange } from '@/hooks/useMemberSettings';
import {
  ChartRow,
  ChartSeriesInfo,
  DiscoveredMetric,
  GroupAction,
  GroupContainer,
  GroupObservation,
  LINE_COLORS,
  MANILA_DATETIME_OPTS,
  MANILA_DATE_OPTS,
  MetricChartBundle,
  RANGE_OPTIONS,
  SeriesInfo,
  actionText,
  applyCoverageEdit,
  buildMetricChart,
  formatManila,
  parseMetricName,
  rangeStartMs,
} from '@/lib/metricsChart';

// Recharts hands custom dot/shape renderers loosely typed props; these are
// just the fields actually read here.
interface DotProps {
  cx: number;
  cy: number;
  index: number;
  payload: ChartRow;
}
type ActionMarker = MetricChartBundle['actionMarkers'][number];
interface ActionShapeProps {
  cx: number;
  cy: number;
  // An action marker, or (for the entries Recharts adds per chart row) a row.
  payload: unknown;
}
const isActionMarker = (p: unknown): p is ActionMarker => typeof p === 'object' && p !== null && 'action' in p;

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
  onPickExperience,
  hideContainerName,
}: {
  bundle: MetricChartBundle;
  hiddenSeriesKeys: Set<string>;
  toggleSeries: (key: string) => void;
  onPickObservation: (toolId: string, obs: GroupObservation, seriesName: string, color: string) => void;
  onPickAction: (payload: { action: GroupAction; toolId: string; toolName: string; color: string }) => void;
  onPickExperience: (experienceId: string, toolId: string) => void;
  hideContainerName?: boolean;
}) {
  const { metric, experienceBands, coveredLines, chartData, actionMarkers, leftAxis, rightAxis, chartSeries, titlePrefix } = bundle;
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
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          {!hideContainerName && titlePrefix ? `${titlePrefix} — ` : ''}{metric.name} Over Time
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={480}>
          {/* left/right margin wider than default: the first/last rotated
              date labels (angle=-45, textAnchor="end") extend past their
              tick's x position, and without this room they (and the first
              point's glow) got clipped by the chart's SVG edge. */}
          <ComposedChart data={chartData} margin={{ top: 16, right: 30, left: 40, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
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
              tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
              axisLine={{ stroke: 'hsl(var(--border))' }}
              tickLine={{ stroke: 'hsl(var(--border))' }}
              angle={-45}
              textAnchor="end"
              height={60}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
              axisLine={{ stroke: 'hsl(var(--border))' }}
              tickLine={{ stroke: 'hsl(var(--border))' }}
              domain={leftAxis.domain}
              // Ticks interpolated across a padded floating-point domain
              // land on values like 40.999999999994 — round for display,
              // the underlying data stays exact.
              tickFormatter={isCoverage ? undefined : (v: number) => Number(v.toFixed(2)).toString()}
              label={{
                value: `${metric.name}${leftAxis.unit && !isCoverage ? ` (${leftAxis.unit})` : ''}`,
                angle: -90,
                position: 'insideLeft',
                offset: -15,
                style: { fontSize: 12, fill: 'hsl(var(--muted-foreground))', textAnchor: 'middle' },
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
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                axisLine={{ stroke: 'hsl(var(--border))' }}
                tickLine={{ stroke: 'hsl(var(--border))' }}
                domain={rightAxis.domain}
                tickFormatter={(v: number) => Number(v.toFixed(2)).toString()}
                label={{
                  value: rightAxis.unit ?? '',
                  angle: 90,
                  position: 'insideRight',
                  style: { fontSize: 12, fill: 'hsl(var(--muted-foreground))', textAnchor: 'middle' },
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
                          background: active ? `${s.color}1a` : 'transparent',
                          border: `1px solid ${active ? `${s.color}66` : 'hsl(var(--border))'}`,
                          color: active ? s.color : 'hsl(var(--muted-foreground))',
                        }}
                      >
                        <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: active ? s.color : 'hsl(var(--muted-foreground))' }} />
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              )}
            />
            {/* One translucent band per experience, from its initial state
                to its final state (dashed edge and open-ended when it has no
                final state yet). Click to open the experience. */}
            {experienceBands.map((band) => (
              <ReferenceArea
                key={`band-${band.id}`}
                yAxisId="left"
                x1={band.start}
                x2={band.end}
                ifOverflow="hidden"
                fill={band.color}
                fillOpacity={hiddenSeriesKeys.has(band.toolId) ? 0 : 0.12}
                stroke={band.color}
                strokeOpacity={hiddenSeriesKeys.has(band.toolId) ? 0 : 0.4}
                strokeDasharray={band.open ? '4 3' : undefined}
                style={{ cursor: 'pointer' }}
                onClick={() => onPickExperience(band.id, band.toolId)}
              />
            ))}
            {chartSeries.map((s) => (
              <Line
                key={s.key}
                yAxisId={s.yAxisId}
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                // Dashed wherever no experience explains the movement; the
                // covered stretches are redrawn solid on top (below).
                strokeDasharray={experienceBands.length > 0 ? '5 4' : undefined}
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
                dot={(rawProps: unknown) => {
                  const { cx, cy, payload, index } = rawProps as DotProps;
                  const obs = payload[`${s.key}__obs`] as GroupObservation | undefined;
                  if (!obs || payload[s.key] === undefined) return <g key={`dot-${s.key}-${index}`} />;
                  const onPick = () => onPickObservation(s.toolId, obs, s.label, s.color);
                  return (
                    <circle
                      key={`dot-${s.key}-${index}`}
                      cx={cx}
                      cy={cy}
                      r={5}
                      fill={s.color}
                      stroke="#fff"
                      strokeWidth={1.5}
                      style={{ cursor: 'pointer' }}
                      onClick={onPick}
                    />
                  );
                }}
                activeDot={(rawProps: unknown) => {
                  const { cx, cy, payload, index } = rawProps as DotProps;
                  const obs = payload[`${s.key}__obs`] as GroupObservation | undefined;
                  if (!obs || payload[s.key] === undefined) return <g key={`active-dot-${s.key}-${index}`} />;
                  const onPick = () => onPickObservation(s.toolId, obs, s.label, s.color);
                  return (
                    <circle
                      key={`active-dot-${s.key}-${index}`}
                      cx={cx}
                      cy={cy}
                      r={7}
                      fill={s.color}
                      stroke="#fff"
                      strokeWidth={2}
                      style={{ cursor: 'pointer' }}
                      onClick={onPick}
                    />
                  );
                }}
              />
            ))}
            {coveredLines.map((cl) => {
              const s = chartSeries.find((x) => x.key === cl.seriesKey);
              if (!s || hiddenSeriesKeys.has(s.key)) return null;
              return (
                <Line
                  key={cl.key}
                  yAxisId={s.yAxisId}
                  dataKey={cl.key}
                  stroke={s.color}
                  strokeWidth={2}
                  connectNulls
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                  legendType="none"
                />
              );
            })}
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
              shape={(rawProps: unknown) => {
                const { cx, cy, payload } = rawProps as ActionShapeProps;
                // Besides the action markers, Recharts also passes this shape
                // one entry per chart row (no action, no y, so cy is null).
                if (!isActionMarker(payload)) return <g />;
                if (hiddenSeriesKeys.has(payload.toolId)) return <g />;
                const onClick = () => onPickAction({ action: payload.action, toolId: payload.toolId, toolName: payload.toolName, color: payload.color });
                // A small lightning bolt (the History feed's action icon) on
                // a white disc so it reads over the band and the grid.
                // Filled when the action belongs to an experience, an
                // outline when it doesn't.
                return (
                  <g style={{ cursor: 'pointer' }} onClick={onClick}>
                    <circle cx={cx} cy={cy} r={9} fill="#fff" stroke={payload.color} strokeWidth={1.5} />
                    <path
                      d="M 1.5 -6 L -4 1 L -0.5 1 L -1.5 6 L 4 -1 L 0.5 -1 Z"
                      transform={`translate(${cx} ${cy})`}
                      fill={payload.inExperience ? payload.color : 'none'}
                      stroke={payload.color}
                      strokeWidth={1}
                      strokeLinejoin="round"
                    />
                  </g>
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
              stroke="hsl(var(--border))"
              fill="hsl(var(--muted))"
              tickFormatter={(ts: number) => formatManila(ts, MANILA_DATE_OPTS)}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// One state inside the experience dialog: when, what was written, its
// readings, and its photos.
function ExperienceStateView({ obs }: { obs: GroupObservation }) {
  return (
    <div className="rounded-md border p-3 space-y-2 text-sm">
      <p className="text-xs text-muted-foreground">
        {formatManila(obs.observed_at, MANILA_DATETIME_OPTS)} · {obs.observed_by_name}
      </p>
      {obs.observation_text && <p>{obs.observation_text}</p>}
      {obs.metrics && obs.metrics.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {obs.metrics.map((m) => (
            <Badge key={m.metric_id} variant="secondary" className="text-xs">
              {m.metric_name}: {m.value}{m.unit ? ` ${m.unit}` : ''}
            </Badge>
          ))}
        </div>
      )}
      {obs.photos && obs.photos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {obs.photos.map((photo) => (
            <PhotoThumb
              key={photo.id}
              href={getOriginalUrl(photo.photo_url) || getImageUrl(photo.photo_url) || ''}
              src={getThumbnailUrl(photo.photo_url) || getImageUrl(photo.photo_url) || ''}
              alt={photo.photo_description || 'Photo'}
              className="w-24 h-24 rounded border"
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ExperienceActionView({ action }: { action: GroupAction }) {
  return (
    <div className="rounded-md border p-3 space-y-1 text-sm">
      <p className="font-medium">{action.title}</p>
      <p className="text-xs text-muted-foreground">
        {formatManila(action.completed_at || action.created_at, MANILA_DATE_OPTS)}
      </p>
      <p>{actionText(action)}</p>
    </div>
  );
}

// Cap on popup thumbnails warmed when the tab opens.
const MAX_PRELOADED_THUMBNAILS = 60;

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
  const navigate = useNavigate();
  const { data: containersData, isLoading: loading, error: loadError } = useGroupSnapshots(orgId);
  const containers = containersData ?? null;
  const error = loadError ? (loadError as Error).message || 'Failed to load group data' : null;
  // Set on click, rendered as a popup dialog (see the Dialog
  // below) — a hover-preview doesn't have a touch-device equivalent, so
  // click/tap is the one interaction that works on both.
  const [selectedObservation, setSelectedObservation] = useState<{ obs: GroupObservation; toolName: string; color: string; priorActions: GroupAction[] } | null>(null);
  const [selectedAction, setSelectedAction] = useState<{ action: GroupAction; toolName: string; color: string } | null>(null);
  const [selectedExperience, setSelectedExperience] = useState<{ experienceId: string; toolId: string; toolName: string; color: string } | null>(null);
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

  // This component only mounts when its tab is opened, so warming the
  // popup thumbnails here (newest first, within the selected range) means the
  // tiles are already cached by the time a chart point is clicked.
  useEffect(() => {
    if (!filteredContainers) return;
    const photos = filteredContainers
      .flatMap((c) => c.observations)
      .sort((a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime())
      .flatMap((o) => o.photos || []);
    const urls = photos
      .map((p) => getThumbnailUrl(p.photo_url))
      .filter((u): u is string => !!u)
      .slice(0, MAX_PRELOADED_THUMBNAILS);
    return preloadImages(urls);
  }, [filteredContainers]);

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

  // An action that belongs to an experience opens the whole experience; a
  // standalone action opens just itself.
  const pickAction = (payload: { action: GroupAction; toolId: string; toolName: string; color: string }) => {
    const experience = containers
      ?.find((c) => c.toolId === payload.toolId)
      ?.experiences.find((e) => e.action_ids.includes(payload.action.id));
    if (experience) {
      setSelectedExperience({ experienceId: experience.id, toolId: payload.toolId, toolName: payload.toolName, color: payload.color });
    } else {
      setSelectedAction(payload);
    }
  };

  const pickExperience = (experienceId: string, toolId: string) => {
    const s = series.find((x) => x.toolId === toolId);
    if (!s) return;
    setSelectedExperience({ experienceId, toolId, toolName: s.name, color: s.color });
  };

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
              onPickAction={pickAction}
              onPickExperience={pickExperience}
              hideContainerName={hideContainerName}
            />
          ))
        )}
      </div>

      {/* Click-triggered popup (not hover — hover has no equivalent on
          touch, so a mobile tap needs to open something, not preview it
          inline while the finger is already gone). */}
      <Dialog open={!!selectedObservation} onOpenChange={(open) => !open && setSelectedObservation(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
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
                  <p className="font-medium text-foreground">{selectedObservation.obs.observed_by_name}</p>
                )}
                <p className="text-muted-foreground">{formatManila(selectedObservation.obs.observed_at, MANILA_DATETIME_OPTS)}</p>
                {selectedObservation.obs.mergedIds && (
                  <p className="text-xs text-muted-foreground">
                    Combined from {selectedObservation.obs.mergedIds.length} check-ins this day — showing each metric's max.
                  </p>
                )}
              </div>
              {selectedObservation.obs.observation_text && (
                <p className="text-sm text-foreground">{selectedObservation.obs.observation_text}</p>
              )}
              {selectedObservation.obs.metrics && selectedObservation.obs.metrics.length > 0 && (
                <div
                  className="p-2 rounded text-sm space-y-0.5 bg-muted/50 border"

                >
                  {selectedObservation.obs.metrics.map((m) => {
                    const isCoverage = m.metric_name === 'Coverage %';
                    if (isCoverage && editingCoverage) {
                      return (
                        <div key={m.metric_id} className="flex items-center gap-1.5">
                          <span className="font-medium">{m.metric_name}:</span>
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
                            className="w-16 px-1 py-0.5 rounded border bg-background"

                          />
                          <span className="text-muted-foreground">{m.unit}</span>
                          <button
                            type="button"
                            onClick={saveCoverage}
                            disabled={savingCoverage}
                            className="ml-1 text-emerald-600 hover:text-emerald-500 disabled:opacity-50"
                            aria-label="Save"
                          >
                            {savingCoverage ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingCoverage(false)}
                            disabled={savingCoverage}
                            className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                            aria-label="Cancel"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    }
                    return (
                      <div key={m.metric_id} className="flex items-center gap-1.5">
                        <span className="font-medium">{m.metric_name}:</span>{' '}
                        <span className="text-muted-foreground">{m.value}{m.unit}</span>
                        {isCoverage && canEditObservation(selectedObservation.obs) && (
                          <button
                            type="button"
                            onClick={() => {
                              setCoverageDraft(m.value);
                              setCoverageError(null);
                              setEditingCoverage(true);
                            }}
                            className="text-muted-foreground hover:text-foreground"
                            aria-label="Edit coverage"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {editingCoverage && coverageError && (
                    <p className="text-xs text-destructive">{coverageError}</p>
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
                          selectedObservation.priorActions.length > 0 ? 'border-2 border-purple-500' : 'border-border'
                        }`}
                      />
                      <div className="pt-1">
                        {photo.captured_at && (
                          <p className="text-xs text-muted-foreground">
                            {formatManila(photo.captured_at, MANILA_DATETIME_OPTS)}
                          </p>
                        )}
                        {photo.photo_description && (
                          <p className="text-sm text-muted-foreground">{photo.photo_description}</p>
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

      <Dialog open={!!selectedExperience} onOpenChange={(open) => !open && setSelectedExperience(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          {selectedExperience && (() => {
            const container = containers?.find((c) => c.toolId === selectedExperience.toolId);
            const experience = container?.experiences.find((e) => e.id === selectedExperience.experienceId);
            if (!container || !experience) return null;
            const byTime = (a: GroupObservation, b: GroupObservation) =>
              new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime();
            const statesFor = (ids: string[]) =>
              ids.map((id) => container.observations.find((o) => o.id === id)).filter((o): o is GroupObservation => !!o).sort(byTime);
            const actions = experience.action_ids
              .map((id) => container.actions.find((a) => a.id === id))
              .filter((a): a is GroupAction => !!a);
            const initialStates = statesFor(experience.initial_state_ids);
            const finalStates = statesFor(experience.final_state_ids);
            return (
              <>
                <DialogHeader>
                  <DialogTitle style={{ color: selectedExperience.color }}>{selectedExperience.toolName} — Experience</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Initial state</h3>
                    {initialStates.length > 0
                      ? initialStates.map((o) => <ExperienceStateView key={o.id} obs={o} />)
                      : <p className="text-sm text-muted-foreground">No starting state recorded.</p>}
                  </section>
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Action(s)</h3>
                    {actions.length > 0
                      ? actions.map((a) => <ExperienceActionView key={a.id} action={a} />)
                      : <p className="text-sm text-muted-foreground">No actions attached.</p>}
                  </section>
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Final state</h3>
                    {finalStates.length > 0
                      ? finalStates.map((o) => <ExperienceStateView key={o.id} obs={o} />)
                      : <p className="text-sm text-muted-foreground">No outcome observed yet.</p>}
                  </section>
                  <Button variant="outline" size="sm" onClick={() => navigate(`/experiences/${experience.id}`)}>
                    Open experience
                  </Button>
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedAction} onOpenChange={(open) => !open && setSelectedAction(null)}>
        <DialogContent className="max-w-md">
          {selectedAction && (
            <>
              <DialogHeader>
                <DialogTitle style={{ color: selectedAction.color }}>{selectedAction.toolName}</DialogTitle>
              </DialogHeader>
              <div className="space-y-1.5 text-sm">
                <p className="font-medium">{selectedAction.action.title}</p>
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
