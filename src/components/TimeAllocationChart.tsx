import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, Cell } from 'recharts';
import { apiService } from '@/lib/apiService';
import { Loader2, Clock } from 'lucide-react';
import { useOrganizationMembers } from '@/hooks/useOrganizationMembers';

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

// Energy type colors matching Energeia Schema
const ENERGY_COLORS = {
  dynamis: '#ff6b35',    // orange — exploration/growth
  oikonomia: '#00e5ff',  // cyan — sustaining operations
  techne: '#a855f7',     // purple — improving process
};

const BOUNDARY_COLORS = {
  internal: '#22c55e',   // green
  external: '#ef4444',   // red
};

export default function TimeAllocationChart({ startDate, endDate, selectedUsers }: TimeAllocationChartProps) {
  const [loading, setLoading] = useState(false);
  const [computing, setComputing] = useState(false);
  const [summaries, setSummaries] = useState<DaySummary[]>([]);
  const [computationStatus, setComputationStatus] = useState<any>(null);
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
        const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
        if (selectedUsers.length > 0) {
          // Filter will be applied client-side from full data
        }
        const result = await apiService.get(`/analytics/time-summaries?${params}`);
        setSummaries(result.summaries || []);
        setComputationStatus(result.computation_status || null);
        setComputing(false);
      } catch (err) {
        console.error('Failed to fetch time summaries:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchSummaries();
  }, [startDate, endDate]);

  // Transform data for recharts — stacked by dominant energy type per day
  const chartData = useMemo(() => {
    return summaries.map(day => {
      let dynamis = 0;
      let oikonomia = 0;
      let techne = 0;

      const filteredEntries = selectedUsers.length > 0
        ? day.entries.filter(e => selectedUsers.includes(e.user_id))
        : day.entries;

      for (const entry of filteredEntries) {
        const hours = entry.hours || 0;
        const w = entry.energy_weights || { dynamis: 0, oikonomia: 1, techne: 0 };
        dynamis += hours * w.dynamis;
        oikonomia += hours * w.oikonomia;
        techne += hours * w.techne;
      }

      const dateLabel = new Date(day.date + 'T00:00:00').toLocaleDateString('en-US', {
        month: 'short', day: 'numeric'
      });

      return {
        date: day.date,
        label: dateLabel,
        dynamis: Math.round(dynamis * 10) / 10,
        oikonomia: Math.round(oikonomia * 10) / 10,
        techne: Math.round(techne * 10) / 10,
        total: Math.round((dynamis + oikonomia + techne) * 10) / 10,
        entries: filteredEntries,
      };
    });
  }, [summaries, selectedUsers]);

  // Total hours
  const totalHours = useMemo(() =>
    chartData.reduce((sum, d) => sum + d.total, 0),
    [chartData]
  );

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Time Allocation
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center h-48">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">
            {computing ? 'Computing summaries...' : 'Loading...'}
          </span>
        </CardContent>
      </Card>
    );
  }

  if (summaries.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Time Allocation
          </CardTitle>
        </CardHeader>
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
            <span className="text-sm font-normal text-muted-foreground ml-2">
              {totalHours.toFixed(1)}h total
            </span>
          </CardTitle>
          {computationStatus && computationStatus.stale_count > 0 && (
            <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded">
              {computationStatus.stale_count} day(s) stale
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              label={{ value: 'hours', angle: -90, position: 'insideLeft', style: { fontSize: 10 } }}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const data = payload[0]?.payload;
                return (
                  <div className="bg-background border rounded-lg shadow-lg p-3 text-xs max-w-64">
                    <p className="font-semibold mb-1">{label} — {data?.total}h</p>
                    {data?.entries?.map((entry: TimeSummaryEntry, i: number) => (
                      <div key={i} className="py-0.5 border-t border-border/50">
                        <span className="font-medium">{nameMap[entry.user_id] || 'Unknown'}</span>
                        {': '}
                        {entry.activity} ({entry.hours}h, {entry.confidence})
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: '11px' }}
              formatter={(value) => {
                if (value === 'dynamis') return 'Exploration (dynamis)';
                if (value === 'oikonomia') return 'Operations (oikonomia)';
                if (value === 'techne') return 'Process (techne)';
                return value;
              }}
            />
            <Bar dataKey="oikonomia" stackId="energy" fill={ENERGY_COLORS.oikonomia} radius={[0, 0, 0, 0]} />
            <Bar dataKey="dynamis" stackId="energy" fill={ENERGY_COLORS.dynamis} radius={[0, 0, 0, 0]} />
            <Bar dataKey="techne" stackId="energy" fill={ENERGY_COLORS.techne} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
