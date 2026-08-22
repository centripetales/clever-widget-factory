import { useEffect, useMemo, useState } from 'react';
import { Loader2, Pencil, Check, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from '@/components/ui/dialog';
import { ComposedChart, Line, Scatter, XAxis, YAxis, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { apiService } from '@/lib/apiService';
import { PhotoThumb } from '@/components/shared/PhotoThumb';
import { getThumbnailUrl, getImageUrl, getOriginalUrl } from '@/lib/imageUtils';
import { useAuth } from '@/hooks/useCognitoAuth';
import { useOrganization } from '@/hooks/useOrganization';

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
// day's coverage numbers aren't representative of any actual container —
// dropped rather than plotted.
const CHART_START_MS = new Date('2026-07-20T16:00:00Z').getTime();

// The UTC instant of midnight-Manila for whatever Manila calendar day `iso`
// falls on — used as the chart-data grouping key so multiple same-day
// observations (e.g. two check-ins 46 minutes apart) collapse into one
// point instead of plotting as near-overlapping dots.
function manilaDayKey(iso: string | number): number {
  const manila = new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000);
  return Date.UTC(manila.getUTCFullYear(), manila.getUTCMonth(), manila.getUTCDate()) - 8 * 60 * 60 * 1000;
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
// every observation that day, notes joined in order, Coverage % taken as
// the day's max (same rule the metric itself now uses server-side — see
// scripts/azolla-wire-coverage-metric.js).
function mergeObservations(obsList: GroupObservation[]): GroupObservation {
  const sorted = [...obsList].sort((a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime());
  const photos = sorted.flatMap((o) => o.photos || []);
  const texts = sorted.map((o) => o.observation_text).filter((t): t is string => !!t);
  const coverageValues = sorted
    .flatMap((o) => o.metrics || [])
    .filter((m) => m.metric_name === 'Coverage %')
    .map((m) => Number(m.value));
  const maxCoverage = coverageValues.length ? Math.max(...coverageValues) : 0;
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
    metrics: [{ metric_id: 'merged-coverage', metric_name: 'Coverage %', value: maxCoverage.toFixed(2), unit: '%' }],
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

// "transformative" = an actual intervention that changes the system (add
// manure, move something); "entropy_reduction" = pure information-gathering
// (a measurement, a reading) — see scripts/azolla-experience-form.js.
function actionTypeLabel(a: GroupAction): 'intervention' | 'measurement' {
  return a.scoring_data?.action_type === 'entropy_reduction' ? 'measurement' : 'intervention';
}
function actionText(a: GroupAction): string {
  return a.claim || a.scoring_data?.what_was_done || a.description || a.title;
}

interface GroupContainer {
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

/**
 * One combined Coverage % chart, one line per container sharing this org
 * (matching scripts/azolla-coverage-chart.py's plot), with a clickable legend
 * to toggle people on/off, and click-through to that day's full observation —
 * photos included, no second fetch (the /coverage-snapshots response already
 * bundles everything per observation). Used both as its own page
 * (GroupCoverage.tsx) and embedded as a tab on a shared container's own
 * details page (ToolDetails.tsx).
 */
export function GroupCoverageGrid({ orgId }: { orgId: string }) {
  const { user } = useAuth();
  // Active-org-scoped, matching the backend's own check (an admin can only
  // edit observations belonging to whichever org is currently selected —
  // same rule ToolDetails.tsx's canEditObservation uses).
  const { isAdmin } = useOrganization();
  const [containers, setContainers] = useState<GroupContainer[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Set on click, rendered as a popup dialog (see the dark-styled Dialog
  // below) — a hover-preview doesn't have a touch-device equivalent, so
  // click/tap is the one interaction that works on both.
  const [selectedObservation, setSelectedObservation] = useState<{ obs: GroupObservation; toolName: string; color: string; priorActions: GroupAction[] } | null>(null);
  const [selectedAction, setSelectedAction] = useState<{ action: GroupAction; toolName: string; color: string } | null>(null);
  const [editingCoverage, setEditingCoverage] = useState(false);
  const [coverageDraft, setCoverageDraft] = useState('');
  const [savingCoverage, setSavingCoverage] = useState(false);
  const [coverageError, setCoverageError] = useState<string | null>(null);

  // "What did they do before this observation" — actions on this container
  // completed between the previous observation (for the same container) and
  // this one, so a coverage jump can be traced back to what caused it.
  const selectObservation = (container: GroupContainer, obs: GroupObservation, seriesName: string, color: string) => {
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
  const saveCoverage = async () => {
    if (!selectedObservation) return;
    const value = Number(coverageDraft);
    if (Number.isNaN(value) || value < 0 || value > 100) {
      setCoverageError('Enter a number between 0 and 100');
      return;
    }
    setSavingCoverage(true);
    setCoverageError(null);
    try {
      await apiService.put(`/api/states/${selectedObservation.obs.id}/coverage`, { value });
      const applyEdit = (obs: GroupObservation): GroupObservation => ({
        ...obs,
        metrics: (obs.metrics || []).map((m) =>
          m.metric_name === 'Coverage %' ? { ...m, value: value.toFixed(2) } : m
        ),
      });
      setSelectedObservation((prev) => (prev ? { ...prev, obs: applyEdit(prev.obs) } : prev));
      setContainers((prev) =>
        prev
          ? prev.map((c) => ({
              ...c,
              observations: c.observations.map((o) => (o.id === selectedObservation.obs.id ? applyEdit(o) : o)),
            }))
          : prev
      );
      setEditingCoverage(false);
    } catch (err: any) {
      setCoverageError(err.message || 'Failed to save coverage');
    } finally {
      setSavingCoverage(false);
    }
  };

  const [hiddenToolIds, setHiddenToolIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    apiService.get<{ containers: GroupContainer[] }>(`/organizations/${orgId}/coverage-snapshots`)
      .then((res) => setContainers(res.containers))
      .catch((err) => setError(err.message || 'Failed to load group coverage'))
      .finally(() => setLoading(false));
  }, [orgId]);

  // Merge every container's Coverage % points onto one shared timeline, keyed
  // by toolId per line — recharts needs one data array shared across all
  // <Line> series, with gaps where a given container has no point that day.
  const { chartData, series, weekTicks, actionMarkers } = useMemo(() => {
    if (!containers) return { chartData: [], series: [], weekTicks: [], actionMarkers: [] };
    const series = containers.map((c, i) => ({
      toolId: c.toolId,
      // Privacy: label by phone number (payment-roster convention, see
      // scripts/azolla-weekly-heatmap.js) rather than name — except Stefan
      // and Mae, who keep their first name since they aren't tracked by phone.
      name: c.sourcePhone || c.toolName.split(/['’]s\b/i)[0].trim().split(' ')[0],
      color: LINE_COLORS[i % LINE_COLORS.length],
    }));

    const rows = new Map<number, Record<string, unknown>>();
    for (const container of containers) {
      // Bucket this container's observations by Manila calendar day first —
      // two check-ins on the same day (e.g. Stefan submitting twice 46min
      // apart) used to render as two near-overlapping points; now they
      // collapse into one point per (container, day), matching how the
      // static azolla-coverage-chart.py already aggregates.
      const byDay = new Map<number, GroupObservation[]>();
      for (const obs of container.observations) {
        const coverage = obs.metrics?.find((m) => m.metric_name === 'Coverage %');
        if (!coverage) continue;
        const timestamp = new Date(obs.observed_at).getTime();
        if (timestamp < CHART_START_MS) continue;
        const day = manilaDayKey(obs.observed_at);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day)!.push(obs);
      }
      for (const [day, obsList] of byDay) {
        const merged = obsList.length === 1 ? obsList[0] : mergeObservations(obsList);
        const coverage = merged.metrics!.find((m) => m.metric_name === 'Coverage %')!;
        const row = rows.get(day) || { timestamp: day, date: formatManila(day, MANILA_DATE_OPTS) };
        row[container.toolId] = Number(coverage.value);
        row[`${container.toolId}__obs`] = merged;
        rows.set(day, row);
      }
    }
    const chartData = Array.from(rows.values()).sort((a: any, b: any) => a.timestamp - b.timestamp);

    // One tick per week rather than one per observation — otherwise the axis
    // gets unreadably dense once there are dozens of points.
    const weekTicks: number[] = [];
    if (chartData.length > 0) {
      const first = (chartData[0] as any).timestamp;
      const last = (chartData[chartData.length - 1] as any).timestamp;
      const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
      for (let t = first; t <= last; t += oneWeekMs) weekTicks.push(t);
      if (weekTicks[weekTicks.length - 1] !== last) weekTicks.push(last);
    }

    // A marker per action, placed directly on that person's own line (at the
    // coverage value nearest the action's date) rather than a separate lane —
    // so "what did they do before that jump" reads straight off the curve.
    // Uses the same day-bucketed max as the line above so a ring always
    // lands exactly on the plotted point, not some intermediate raw value.
    const actionMarkers = containers.flatMap((c) => {
      const s = series.find((x) => x.toolId === c.toolId)!;
      const byDay = new Map<number, number>();
      for (const obs of c.observations) {
        const coverage = obs.metrics?.find((m) => m.metric_name === 'Coverage %');
        if (!coverage) continue;
        const timestamp = new Date(obs.observed_at).getTime();
        if (timestamp < CHART_START_MS) continue;
        const day = manilaDayKey(obs.observed_at);
        byDay.set(day, Math.max(byDay.get(day) ?? -Infinity, Number(coverage.value)));
      }
      const coveragePoints = Array.from(byDay.entries())
        .map(([timestamp, value]) => ({ timestamp, value }))
        .sort((a, b) => a.timestamp - b.timestamp);

      const yForTimestamp = (t: number): number => {
        if (coveragePoints.length === 0) return 0;
        const next = coveragePoints.find((p) => p.timestamp >= t);
        if (next) return next.value;
        return coveragePoints[coveragePoints.length - 1].value;
      };

      return (c.actions || [])
        .filter((a) => new Date(a.completed_at || a.created_at).getTime() >= CHART_START_MS)
        .map((a) => {
          const timestamp = manilaDayKey(a.completed_at || a.created_at);
          // Centered on the actual data point — the marker is a hollow ring
          // (fill="none"), so it rings the dot rather than covering it.
          const y = yForTimestamp(timestamp);
          return {
            timestamp,
            y,
            toolId: c.toolId,
            color: s.color,
            toolName: s.name,
            action: a,
          };
        });
    });

    return { chartData, series, weekTicks, actionMarkers };
  }, [containers]);

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

  const toggleSeries = (toolId: string) => {
    setHiddenToolIds((prev) => {
      const next = new Set(prev);
      if (next.has(toolId)) next.delete(toolId);
      else next.add(toolId);
      return next;
    });
  };

  return (
    <>
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
            Azolla/Duckweed Container Coverage % Over Time
          </h2>
          <p
            className="mt-1"
            style={{
              fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace',
              fontSize: '0.7rem',
              letterSpacing: '0.02em',
              color: 'rgba(0,229,255,0.6)',
            }}
          >
            ◈ CLICK A NAME TO TOGGLE — CLICK A POINT FOR THAT DAY — RINGED POINT = ACTION TAKEN
          </p>
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
                // "data starts before the axis."
                domain={[
                  (dataMin: number) => dataMin - 2 * 24 * 60 * 60 * 1000,
                  (dataMax: number) => dataMax + 2 * 24 * 60 * 60 * 1000,
                ]}
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
                tick={{ fontSize: 11, fill: '#94a3b8' }}
                axisLine={{ stroke: 'rgba(0,229,255,0.25)' }}
                tickLine={{ stroke: 'rgba(0,229,255,0.25)' }}
                domain={[0, 100]}
                unit="%"
                label={{ value: 'Coverage %', angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: '#64748b', textAnchor: 'middle' } }}
              />
              <Legend
                content={() => (
                  <div className="flex flex-wrap justify-center gap-2 pt-3">
                    {series.map((s) => {
                      const active = !hiddenToolIds.has(s.toolId);
                      return (
                        <button
                          key={s.toolId}
                          type="button"
                          onClick={() => toggleSeries(s.toolId)}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all"
                          style={{
                            background: active ? `${s.color}1a` : 'rgba(255,255,255,0.03)',
                            border: `1px solid ${active ? `${s.color}55` : 'rgba(255,255,255,0.1)'}`,
                            color: active ? s.color : '#4b5563',
                          }}
                        >
                          <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: active ? s.color : '#4b5563' }} />
                          {s.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              />
              {series.map((s) => (
                <Line
                  key={s.toolId}
                  dataKey={s.toolId}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={2}
                  connectNulls
                  hide={hiddenToolIds.has(s.toolId)}
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
                    const obs = payload[`${s.toolId}__obs`];
                    if (!obs || payload[s.toolId] === undefined) return <g key={`dot-${s.toolId}-${index}`} />;
                    const onPick = () => {
                      const container = containers?.find((c) => c.toolId === s.toolId);
                      if (container) selectObservation(container, obs, s.name, s.color);
                    };
                    return (
                      <circle
                        key={`dot-${s.toolId}-${index}`}
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
                    const obs = payload[`${s.toolId}__obs`];
                    if (!obs || payload[s.toolId] === undefined) return <g key={`active-dot-${s.toolId}-${index}`} />;
                    const onPick = () => {
                      const container = containers?.find((c) => c.toolId === s.toolId);
                      if (container) selectObservation(container, obs, s.name, s.color);
                    };
                    return (
                      <circle
                        key={`active-dot-${s.toolId}-${index}`}
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
                // Always the full array, never filtered by hiddenToolIds —
                // filtering shrinks/grows the array on toggle, which shifts
                // every later marker's index. Recharts animates points by
                // array position, so a shifted index reads as "jump to
                // wherever the old occupant of that slot was" (the domain
                // start, when the slot didn't exist a moment ago) instead of
                // a clean appear/disappear. Hiding via an empty render (same
                // pattern the Line's own dot already uses) keeps the array
                // — and every marker's index — stable regardless of toggles.
                data={actionMarkers}
                dataKey="y"
                isAnimationActive
                animationDuration={700}
                animationEasing="ease-out"
                shape={(props: any) => {
                  const { cx, cy, payload } = props;
                  if (hiddenToolIds.has(payload.toolId)) return <g />;
                  const onClick = () => setSelectedAction({ action: payload.action, toolName: payload.toolName, color: payload.color });
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
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>

      </Card>

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
                    Combined from {selectedObservation.obs.mergedIds.length} check-ins this day — showing the max coverage.
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
