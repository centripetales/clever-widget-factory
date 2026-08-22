import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ComposedChart, Line, Scatter, XAxis, YAxis, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { apiService } from '@/lib/apiService';
import { PhotoThumb } from '@/components/shared/PhotoThumb';
import { getThumbnailUrl, getImageUrl, getOriginalUrl } from '@/lib/imageUtils';

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
  observed_by_name: string;
  observed_at: string;
  photos: GroupPhoto[] | null;
  metrics: GroupMetric[] | null;
}

interface GroupAction {
  id: string;
  title: string;
  description: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
  scoring_data: { action_type?: string; what_was_done?: string } | null;
}

// "transformative" = an actual intervention that changes the system (add
// manure, move something); "entropy_reduction" = pure information-gathering
// (a measurement, a reading) — see scripts/azolla-experience-form.js.
function actionTypeLabel(a: GroupAction): 'intervention' | 'measurement' {
  return a.scoring_data?.action_type === 'entropy_reduction' ? 'measurement' : 'intervention';
}
function actionText(a: GroupAction): string {
  return a.scoring_data?.what_was_done || a.description || a.title;
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

const LINE_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#ca8a04', '#9333ea',
  '#0891b2', '#e11d48', '#65a30d', '#c026d3', '#ea580c',
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
  const [containers, setContainers] = useState<GroupContainer[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedObservation, setSelectedObservation] = useState<{ obs: GroupObservation; toolName: string; priorActions: GroupAction[] } | null>(null);
  const [selectedAction, setSelectedAction] = useState<{ action: GroupAction; toolName: string; color: string } | null>(null);

  // "What did they do before this observation" — actions on this container
  // completed between the previous observation (for the same container) and
  // this one, so a coverage jump can be traced back to what caused it.
  const selectObservation = (container: GroupContainer, obs: GroupObservation, seriesName: string) => {
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
    setSelectedObservation({ obs, toolName: seriesName, priorActions });
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
      for (const obs of container.observations) {
        const coverage = obs.metrics?.find((m) => m.metric_name === 'Coverage %');
        if (!coverage) continue;
        const timestamp = new Date(obs.observed_at).getTime();
        const row = rows.get(timestamp) || { timestamp, date: new Date(obs.observed_at).toLocaleDateString() };
        row[container.toolId] = Number(coverage.value);
        row[`${container.toolId}__obs`] = obs;
        rows.set(timestamp, row);
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
    const actionMarkers = containers.flatMap((c) => {
      const s = series.find((x) => x.toolId === c.toolId)!;
      const coveragePoints = c.observations
        .map((obs) => {
          const coverage = obs.metrics?.find((m) => m.metric_name === 'Coverage %');
          if (!coverage) return null;
          return { timestamp: new Date(obs.observed_at).getTime(), value: Number(coverage.value) };
        })
        .filter((p): p is { timestamp: number; value: number } => p !== null)
        .sort((a, b) => a.timestamp - b.timestamp);

      const yForTimestamp = (t: number): number => {
        if (coveragePoints.length === 0) return 0;
        const next = coveragePoints.find((p) => p.timestamp >= t);
        if (next) return next.value;
        return coveragePoints[coveragePoints.length - 1].value;
      };

      return (c.actions || []).map((a) => {
        const timestamp = new Date(a.completed_at || a.created_at).getTime();
        // Nudged a few points above the actual value so the marker doesn't
        // sit directly on top of the same-colored line stroke and vanish.
        const y = Math.min(100, yForTimestamp(timestamp) + 6);
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
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-lg">Azolla/Duckweed Container Coverage % Over Time</CardTitle>
          <CardDescription>
            Click a name below to show or hide that container. Click a point to see that day's observation.
            {' '}▲ on a line = an action taken — click it for details.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={480}>
            <ComposedChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 45 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis
                dataKey="timestamp"
                type="number"
                domain={['dataMin', 'dataMax']}
                ticks={weekTicks}
                tickFormatter={(ts: number) => new Date(ts).toLocaleDateString()}
                tick={{ fontSize: 11 }}
                angle={-45}
                textAnchor="end"
                height={60}
                label={{ value: 'Date', position: 'insideBottom', offset: -40, style: { fontSize: 12, fill: '#374151' } }}
              />
              <YAxis
                tick={{ fontSize: 11 }}
                domain={[0, 100]}
                unit="%"
                label={{ value: 'Coverage %', angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: '#374151', textAnchor: 'middle' } }}
              />
              <Legend
                content={() => (
                  <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 pt-3 text-sm">
                    {series.map((s) => (
                      <button
                        key={s.toolId}
                        type="button"
                        onClick={() => toggleSeries(s.toolId)}
                        className="flex items-center gap-1.5"
                        style={{ opacity: hiddenToolIds.has(s.toolId) ? 0.4 : 1 }}
                      >
                        <span className="inline-block w-3 h-0.5 rounded" style={{ backgroundColor: s.color }} />
                        <span style={{ color: s.color }}>{s.name}</span>
                      </button>
                    ))}
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
                  dot={(dotProps: any) => {
                    const { cx, cy, payload, index } = dotProps;
                    const obs = payload[`${s.toolId}__obs`];
                    if (!obs || payload[s.toolId] === undefined) return <g key={`dot-${s.toolId}-${index}`} />;
                    return (
                      <circle
                        key={`dot-${s.toolId}-${index}`}
                        cx={cx}
                        cy={cy}
                        r={5}
                        fill={s.color}
                        stroke="#fff"
                        strokeWidth={1.5}
                        style={{ cursor: 'pointer' }}
                        onClick={() => {
                          const container = containers?.find((c) => c.toolId === s.toolId);
                          if (container) selectObservation(container, obs, s.name);
                        }}
                      />
                    );
                  }}
                  activeDot={(dotProps: any) => {
                    const { cx, cy, payload, index } = dotProps;
                    const obs = payload[`${s.toolId}__obs`];
                    if (!obs || payload[s.toolId] === undefined) return <g key={`active-dot-${s.toolId}-${index}`} />;
                    return (
                      <circle
                        key={`active-dot-${s.toolId}-${index}`}
                        cx={cx}
                        cy={cy}
                        r={7}
                        fill={s.color}
                        stroke="#fff"
                        strokeWidth={2}
                        style={{ cursor: 'pointer' }}
                        onClick={() => {
                          const container = containers?.find((c) => c.toolId === s.toolId);
                          if (container) selectObservation(container, obs, s.name);
                        }}
                      />
                    );
                  }}
                />
              ))}
              <Scatter
                data={actionMarkers.filter((m: any) => !hiddenToolIds.has(m.toolId))}
                dataKey="y"
                shape={(props: any) => {
                  const { cx, cy, payload } = props;
                  const onClick = () => setSelectedAction({ action: payload.action, toolName: payload.toolName, color: payload.color });
                  return (
                    <polygon
                      points={`${cx},${cy - 7} ${cx - 7},${cy + 6} ${cx + 7},${cy + 6}`}
                      fill={payload.color}
                      stroke="#fff"
                      strokeWidth={2}
                      style={{ cursor: 'pointer' }}
                      onClick={onClick}
                    />
                  );
                }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Dialog open={!!selectedObservation} onOpenChange={(open) => !open && setSelectedObservation(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          {selectedObservation && (
            <>
              <DialogHeader>
                <DialogTitle>{selectedObservation.toolName}</DialogTitle>
              </DialogHeader>
              <div className="space-y-1 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">{selectedObservation.obs.observed_by_name}</p>
                <p>{new Date(selectedObservation.obs.observed_at).toLocaleString()}</p>
              </div>
              {selectedObservation.obs.observation_text && (
                <p className="text-sm">{selectedObservation.obs.observation_text}</p>
              )}
              {selectedObservation.obs.metrics && selectedObservation.obs.metrics.length > 0 && (
                <div className="bg-blue-50 border border-blue-200 p-2 rounded text-sm space-y-0.5">
                  {selectedObservation.obs.metrics.map((m) => (
                    <div key={m.metric_id}>
                      <span className="font-medium text-blue-900">{m.metric_name}:</span>{' '}
                      <span className="text-blue-700">{m.value}{m.unit}</span>
                    </div>
                  ))}
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
                          selectedObservation.priorActions.length > 0 ? 'border-2 border-purple-500' : ''
                        }`}
                      />
                      <div className="pt-1">
                        {photo.captured_at && (
                          <p className="text-xs text-muted-foreground/70">
                            {new Date(photo.captured_at).toLocaleString()}
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

      <Dialog open={!!selectedAction} onOpenChange={(open) => !open && setSelectedAction(null)}>
        <DialogContent className="max-w-md">
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
                  {new Date(selectedAction.action.completed_at || selectedAction.action.created_at).toLocaleDateString()}
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
