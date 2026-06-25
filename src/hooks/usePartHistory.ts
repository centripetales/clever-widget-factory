import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiService } from '@/lib/apiService';
import { partHistoryQueryKey } from '@/lib/queryKeys';
import { useCallback } from 'react';

export interface HistoryEntry {
  id: string;
  change_type: string;
  old_quantity: number | null;
  new_quantity: number | null;
  quantity_change: number | null;
  changed_by: string;
  changed_by_name?: string;
  change_reason: string | null;
  changed_at: string;
  mission_id?: string;
  mission_number?: number;
  mission_title?: string;
  usage_description?: string;
  action_id?: string | null;
  action_title?: string | null;
  action_status?: string | null;
}

export interface Observation {
  id: string;
  observation_text: string | null;
  observed_by: string;
  observed_by_name: string;
  observed_at: string;
  photos?: Array<{ id: string; photo_url: string; photo_description: string | null }>;
  metrics?: Array<{ snapshot_id: string; metric_name: string; value: number; unit: string | null }>;
  share_info?: {
    target_org_id: string;
    target_org_name: string;
  } | null;
}

export function usePartHistory(partId: string) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: partId ? partHistoryQueryKey(partId) : ['part_history'],
    queryFn: async () => {
      if (!partId) return { history: [], observations: [] };
      const result = await apiService.get(`/history/parts/${partId}`);
      return result.data || { history: [], observations: [] };
    },
    enabled: !!partId,
    staleTime: 5 * 60 * 1000, // 5 minutes stale time
  });

  const rawData = query.data || {};
  const partsHistory: HistoryEntry[] = rawData.history || [];
  const observationsData: Observation[] = rawData.observations || [];

  const historyMap = new Map<string, HistoryEntry>();
  partsHistory.forEach((entry) => {
    const existing = historyMap.get(entry.id);
    if (!existing || new Date(entry.changed_at) > new Date(existing.changed_at)) {
      historyMap.set(entry.id, entry);
    }
  });

  const history = Array.from(historyMap.values()).sort(
    (a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime()
  );

  const observations = observationsData.sort(
    (a, b) => new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime()
  );

  const fetchPartHistory = useCallback(async (id: string, forceRefetch: boolean = false) => {
    if (forceRefetch) {
      await queryClient.invalidateQueries({ queryKey: partHistoryQueryKey(id) });
    } else {
      try {
        await queryClient.ensureQueryData({
          queryKey: partHistoryQueryKey(id),
          queryFn: async () => {
            const result = await apiService.get(`/history/parts/${id}`);
            return result.data || { history: [], observations: [] };
          },
        });
      } catch (error) {
        console.error('Error prefetching part history:', error);
      }
    }
  }, [queryClient]);

  return {
    history,
    observations,
    loading: query.isLoading || query.isFetching,
    fetchPartHistory,
    refetch: query.refetch,
  };
}
