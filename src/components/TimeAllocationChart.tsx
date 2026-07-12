import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { apiService } from '@/lib/apiService';
import { Loader2, Clock, ExternalLink } from 'lucide-react';
import { useOrganizationMembers } from '@/hooks/useOrganizationMembers';
import { cn } from '@/lib/utils';

interface TimeAllocationChartProps {
  startDate: string;
  endDate: string;
  selectedUsers: string[];
}

interface TimeSummaryEntry {
  user_id: string;
  activity: string;
  hours: number;
  confidence: string;
  evidence: string;
  source_ids: string[];
  energy_weights: { dynamis: number; oikonomia: number; techne: number };
  boundary_type: string;
  tags: string[];
}

interface DaySummary {
  date: string;
  state_id: string;
  entries: TimeSummaryEntry[];
  notes: string;
  is_stale: boolean;
}

type ViewMode = 'energy' | 'person' | 'boundary';

// Energy type colors matching Energeia Schema
const ENERGY_COLORS = {
  dynamis: '#ff6b35',
  oikonomia: '#00e5ff',
  techne: '#a855f7',
};

const PERSON_COLORS = [
  '#3b82f6', // blue
  '#22c55e', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
];

const BOUNDARY_COLORS = {
  internal: '#22c55e',
  external: '#ef4444',
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  low: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  unknown: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
};

export default function TimeAllocationChart({ startDate, endDate, selectedUsers }: TimeAllocationChartProps) {
  const [loading, setLoading] = useState(false);
  const [summaries, setSummaries] = useState<DaySummary[]>([]);
  const [computationStatus, setComputationStatus] = useState<any>(null);
  const [activePeople, setActivePeople] = useState<Set<string>>(new Set());
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>('energy');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const { members } = useOrganizationMembers();

  const nameMap = useMemo(() => {
    const map: Record<string, string> = {};
    members.forEach(m => {
      if (m.user_id) map[m.user_id] = m.full_name?.split(' ')[0] || 'Unknown';
    });
    return map;
  }, [members]);

  useEffect(() => {
    if (!startDate || !endDate) return;

    const fetchSummaries = async () => {
      setLoading(true);
      try {
        // Temporarily limit to last 3 days for testing
        const today = new Date();
        const threeDaysAgo = new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000);
        const effectiveStart = threeDaysAgo.toISOString().split('T')[0];
        const effectiveEnd = today.toISOString().split('T')[0];
        const params = new URLSearchParams({ start_date: effectiveStart, end_date: effectiveEnd });
        const result = await apiService.get(`/analytics/time-summaries?${params}`);
        const data = result.summaries || [];
        setSummaries(data);
        setComputationStatus(result.computation_status || null);

        // Initialize active people from data
        const people = new Set<string>();
        data.forEach((day: DaySummary) => day.entries.forEach(e => people.add(e.user_id)));
        setActivePeople(people);
      } catch (err) {
        console.error('Failed to fetch time summaries:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchSummaries();
  }, [startDate, endDate]);

  // Extract all unique tags from data
  const allTags = useMemo(() => {
    const tags = new Set<string>();
    summaries.forEach(day => day.entries.forEach(e => e.tags?.forEach(t => tags.add(t))));
    return Array.from(tags).sort();
  }, [summaries]);

  // Extract all unique people from data
  const allPeople = useMemo(() => {
    const people = new Set<string>();
    summaries.forEach(day => day.entries.forEach(e => people.add(e.user_id)));
    return Array.from(people);
  }, [summaries]);

  // Filter entries based on active people and tags
  const filterEntries = (entries: TimeSummaryEntry[]) => {
    let filtered = entries.filter(e => activePeople.has(e.user_id));
    if (activeTags.size > 0) {
      filtered = filtered.filter(e => e.tags?.some(t => activeTags.has(t)));
    }
    return filtered;
  };

  // Chart data based on view mode
  const chartData = useMemo(() => {
    return summaries.map(day => {
      const filtered = filterEntries(day.entries);
      const dateLabel = new Date(day.date + 'T00:00:00').toLocaleDateString('en-US', {
        month: 'short', day: 'numeric'
      });

      if (viewMode === 'energy') {
        let dynamis = 0, oikonomia = 0, techne = 0;
        for (const entry of filtered) {
          const h = entry.hours || 0;
          const w = entry.energy_weights || { dynamis: 0, oikonomia: 1, techne: 0 };
          dynamis += h * w.dynamis;
          oikonomia += h * w.oikonomia;
          techne += h * w.techne;
        }
        return { date: day.date, label: dateLabel, dynamis: +dynamis.toFixed(1), oikonomia: +oikonomia.toFixed(1), techne: +techne.toFixed(1), total: +(dynamis + oikonomia + techne).toFixed(1), entries: filtered };
      }

      if (viewMode === 'person') {
        const data: any = { date: day.date, label: dateLabel, entries: filtered, total: 0 };
        for (const personId of allPeople) {
          if (!activePeople.has(personId)) continue;
          const hours = filtered.filter(e => e.user_id === personId).reduce((sum, e) => sum + (e.hours || 0), 0);
          data[personId] = +hours.toFixed(1);
          data.total += hours;
        }
        data.total = +data.total.toFixed(1);
        return data;
      }

      // boundary
      const internal = filtered.filter(e => e.boundary_type === 'internal').reduce((sum, e) => sum + (e.hours || 0), 0);
      const external = filtered.filter(e => e.boundary_type === 'external').reduce((sum, e) => sum + (e.hours || 0), 0);
      return { date: day.date, label: dateLabel, internal: +internal.toFixed(1), external: +external.toFixed(1), total: +(internal + external).toFixed(1), entries: filtered };
    });
  }, [summaries, activePeople, activeTags, viewMode, allPeople]);

  const totalHours = useMemo(() => chartData.reduce((sum, d) => sum + (d.total || 0), 0), [chartData]);

  // Detail panel data for selected day
  const selectedDayData = useMemo(() => {
    if (!selectedDay) return null;
    const day = summaries.find(d => d.date === selectedDay);
    if (!day) return null;
    return { ...day, entries: filterEntries(day.entries) };
  }, [selectedDay, summaries, activePeople, activeTags]);

  const togglePerson = (id: string) => {
    setActivePeople(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleTag = (tag: string) => {
    setActiveTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  };

  if (loading) {
    return (
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Clock className="h-5 w-5" />Time Allocation</CardTitle></CardHeader>
        <CardContent className="flex items-center justify-center h-48">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">Computing summaries...</span>
        </CardContent>
      </Card>
    );
  }

  if (summaries.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Clock className="h-5 w-5" />Time Allocation</CardTitle></CardHeader>
        <CardContent className="flex items-center justify-center h-48 text-sm text-muted-foreground">
          No time data available for this period. Observations are needed to compute estimates.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Time Allocation
            <span className="text-sm font-normal text-muted-foreground ml-2">{totalHours.toFixed(1)}h total</span>
          </CardTitle>
          {computationStatus?.stale_count > 0 && (
            <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded">{computationStatus.stale_count} stale</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Controls */}
        <div className="space-y-2">
          {/* People pills */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground w-12">People</span>
            {allPeople.map((id, idx) => {
              const active = activePeople.has(id);
              const hours = summaries.reduce((sum, day) => sum + day.entries.filter(e => e.user_id === id).reduce((s, e) => s + e.hours, 0), 0);
              return (
                <button
                  key={id}
                  onClick={() => togglePerson(id)}
                  className={cn(
                    'px-2 py-0.5 rounded-full text-xs font-medium transition-all',
                    active
                      ? 'text-white'
                      : 'bg-muted text-muted-foreground opacity-50'
                  )}
                  style={active ? { backgroundColor: PERSON_COLORS[idx % PERSON_COLORS.length] } : undefined}
                >
                  {nameMap[id] || id.slice(0, 6)} ({hours.toFixed(1)}h)
                </button>
              );
            })}
          </div>

          {/* Tag pills */}
          {allTags.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-muted-foreground w-12">Tags</span>
              {allTags.map(tag => {
                const active = activeTags.has(tag);
                return (
                  <button
                    key={tag}
                    onClick={() => toggleTag(tag)}
                    className={cn(
                      'px-2 py-0.5 rounded-full text-xs transition-all border',
                      active
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background text-muted-foreground border-border hover:border-primary/50'
                    )}
                  >
                    {tag}
                  </button>
                );
              })}
              {activeTags.size > 0 && (
                <button onClick={() => setActiveTags(new Set())} className="text-xs text-muted-foreground hover:text-foreground underline">
                  clear
                </button>
              )}
            </div>
          )}

          {/* View mode */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground w-12">View</span>
            {(['energy', 'person', 'boundary'] as ViewMode[]).map(mode => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={cn(
                  'px-2 py-0.5 rounded text-xs transition-all',
                  viewMode === mode ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                )}
              >
                {mode === 'energy' ? 'By Energy' : mode === 'person' ? 'By Person' : 'By Boundary'}
              </button>
            ))}
          </div>
        </div>

        {/* Chart */}
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }} onClick={(e) => {
            if (e?.activePayload?.[0]?.payload?.date) {
              setSelectedDay(prev => prev === e.activePayload![0].payload.date ? null : e.activePayload![0].payload.date);
            }
          }}>
            <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
            <Tooltip content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const data = payload[0]?.payload;
              return (
                <div className="bg-background border rounded-lg shadow-lg p-2 text-xs">
                  <p className="font-semibold">{data?.label} — {data?.total}h</p>
                  <p className="text-muted-foreground">Click for details</p>
                </div>
              );
            }} />

            {viewMode === 'energy' && (
              <>
                <Bar dataKey="oikonomia" stackId="a" fill={ENERGY_COLORS.oikonomia} radius={[0, 0, 0, 0]} cursor="pointer" />
                <Bar dataKey="dynamis" stackId="a" fill={ENERGY_COLORS.dynamis} radius={[0, 0, 0, 0]} cursor="pointer" />
                <Bar dataKey="techne" stackId="a" fill={ENERGY_COLORS.techne} radius={[2, 2, 0, 0]} cursor="pointer" />
              </>
            )}

            {viewMode === 'person' && allPeople.filter(id => activePeople.has(id)).map((id, idx) => (
              <Bar key={id} dataKey={id} stackId="a" fill={PERSON_COLORS[idx % PERSON_COLORS.length]} radius={idx === allPeople.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0]} cursor="pointer" name={nameMap[id] || id.slice(0, 6)} />
            ))}

            {viewMode === 'boundary' && (
              <>
                <Bar dataKey="internal" stackId="a" fill={BOUNDARY_COLORS.internal} radius={[0, 0, 0, 0]} cursor="pointer" name="Internal" />
                <Bar dataKey="external" stackId="a" fill={BOUNDARY_COLORS.external} radius={[2, 2, 0, 0]} cursor="pointer" name="External" />
              </>
            )}

            <Legend wrapperStyle={{ fontSize: '11px' }} formatter={(value) => {
              if (viewMode === 'energy') {
                if (value === 'dynamis') return 'Exploration';
                if (value === 'oikonomia') return 'Operations';
                if (value === 'techne') return 'Process';
              }
              if (viewMode === 'person') return nameMap[value] || value;
              return value;
            }} />
          </BarChart>
        </ResponsiveContainer>

        {/* Detail panel for selected day */}
        {selectedDayData && (
          <div className="border-t pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold">
                {new Date(selectedDayData.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
              </h4>
              <button onClick={() => setSelectedDay(null)} className="text-xs text-muted-foreground hover:text-foreground">✕ close</button>
            </div>

            {selectedDayData.entries.map((entry, i) => (
              <div key={i} className="flex items-start gap-2 py-1.5 border-b border-border/50 last:border-0">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-semibold">{nameMap[entry.user_id] || 'Unknown'}</span>
                    <span className="text-xs text-muted-foreground">·</span>
                    <span className="text-xs">{entry.activity}</span>
                    <span className={cn('text-[10px] px-1.5 py-0 rounded-full', CONFIDENCE_COLORS[entry.confidence])}>
                      {entry.confidence}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{entry.evidence}</p>
                  {entry.tags?.length > 0 && (
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {entry.tags.map(tag => (
                        <span key={tag} className="text-[10px] bg-muted px-1.5 py-0 rounded">{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  <span className="text-sm font-semibold">{entry.hours}h</span>
                  {entry.source_ids?.length > 0 && (
                    <a
                      href={`/observations?date=${selectedDayData.date}&highlight=${entry.source_ids.join(',')}`}
                      className="block text-[10px] text-primary hover:underline mt-0.5"
                    >
                      <ExternalLink className="h-2.5 w-2.5 inline" /> sources
                    </a>
                  )}
                </div>
              </div>
            ))}

            {selectedDayData.notes && (
              <p className="text-xs text-muted-foreground italic pt-1">{selectedDayData.notes}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
