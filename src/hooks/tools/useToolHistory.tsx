import { useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';
import { apiService } from '@/lib/apiService';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toolHistoryQueryKey } from '@/lib/queryKeys';

export interface ObservationHistoryEntry {
  id: string;
  type: 'observation';
  observation_text?: string;
  observed_by: string;
  observed_by_name: string;
  observed_at: string;
  photos?: Array<{
    id: string;
    photo_url: string;
    photo_description?: string;
    photo_order: number;
  }>;
  metrics?: Array<{
    snapshot_id: string;
    metric_id: string;
    metric_name: string;
    value: string;
    unit?: string;
    notes?: string;
  }>;
}

export interface AssetHistoryEntry {
  id: string;
  type: 'asset_change';
  asset_id: string;
  change_type: 'created' | 'updated' | 'removed' | 'status_change' | 'action_created';
  changed_at: string;
  changed_by: string;
  user_name?: string;
  field_changed?: string;
  old_value?: string;
  new_value?: string;
  notes?: string;
  // Action-specific fields (optional)
  action_id?: string;
  action_title?: string;
  action_status?: string;
}

export interface ShareHistoryEntry {
  id: string;
  type: 'share';
  note?: string;
  shared_by: string;
  shared_by_name: string;
  shared_at: string;
  target_org_id: string;
  target_org_name: string;
}

export type HistoryEntry = ObservationHistoryEntry | AssetHistoryEntry | ShareHistoryEntry;

export const useToolHistory = (toolId?: string) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: toolId ? toolHistoryQueryKey(toolId) : ['tool_history'],
    queryFn: async () => {
      if (!toolId) return { asset: null, timeline: [] };
      const historyResult = await apiService.get(`/history/tools/${toolId}`);
      return historyResult.data || { asset: null, timeline: [], actions: [], observations: [] };
    },
    enabled: !!toolId,
    staleTime: 5 * 60 * 1000, // 5 minutes stale time
  });

  const rawData = query.data || { asset: null, timeline: [] };
  const assetInfo = rawData.asset;
  const historyData = rawData.timeline || [];

  const allHistory: HistoryEntry[] = historyData.map((entry: any) => {
    switch (entry.type) {
      case 'observation':
        return {
          id: entry.data.id,
          type: 'observation',
          observation_text: entry.data.observation_text,
          observed_by: entry.data.observed_by,
          observed_by_name: entry.data.observed_by_name,
          observed_at: entry.data.observed_at,
          photos: entry.data.photos,
          metrics: entry.data.metrics
        } as ObservationHistoryEntry;

      case 'share':
        return {
          id: entry.data.id,
          type: 'share',
          note: entry.data.observation_text,
          shared_by: entry.data.observed_by,
          shared_by_name: entry.data.observed_by_name,
          shared_at: entry.data.observed_at,
          target_org_id: entry.data.share_info?.target_org_id,
          target_org_name: entry.data.share_info?.target_org_name
        } as ShareHistoryEntry;

      case 'asset_change':
      case 'asset_created':
        return {
          id: entry.data?.id || `asset-${Date.now()}-${Math.random()}`,
          type: 'asset_change',
          asset_id: toolId || '',
          change_type: entry.type === 'asset_created' ? 'created' : (entry.data?.change_type || 'updated'),
          changed_at: entry.timestamp,
          changed_by: entry.data?.changed_by || 'system',
          user_name: entry.data?.user_name || 'System',
          field_changed: entry.data?.field_changed,
          old_value: entry.data?.old_value,
          new_value: entry.data?.new_value,
          notes: entry.data?.notes || entry.description
        } as AssetHistoryEntry;

      case 'action_created':
        return {
          id: entry.data.id,
          type: 'asset_change',
          asset_id: toolId || '',
          change_type: 'action_created',
          changed_at: entry.timestamp,
          changed_by: entry.data.created_by || 'system',
          user_name: entry.data.created_by_name || 'System',
          notes: entry.data.description,
          action_id: entry.data.id,
          action_title: entry.data.title,
          action_status: entry.data.status
        } as AssetHistoryEntry;

      default:
        return {
          id: `unknown-${Date.now()}-${Math.random()}`,
          type: 'asset_change',
          asset_id: toolId || '',
          change_type: 'updated',
          changed_at: entry.timestamp || new Date().toISOString(),
          changed_by: 'system',
          user_name: 'System'
        } as AssetHistoryEntry;
    }
  });

  // Group asset_change entries that happened within 5 seconds of each other
  const groupedHistory: HistoryEntry[] = [];
  let currentGroup: HistoryEntry[] = [];
  let currentTimestamp: number | null = null;

  allHistory.forEach((entry) => {
    const entryTime = new Date(
      'observed_at' in entry ? entry.observed_at : entry.changed_at
    ).getTime();

    if (currentTimestamp === null || Math.abs(entryTime - currentTimestamp) <= 5000) {
      currentGroup.push(entry);
      currentTimestamp = entryTime;
    } else {
      if (currentGroup.length > 1 && currentGroup.every(e => e.type === 'asset_change')) {
        const combined = currentGroup[0] as AssetHistoryEntry;
        combined.notes = currentGroup.map(e => {
          const ae = e as AssetHistoryEntry;
          return ae.field_changed ? `${ae.field_changed}: ${ae.new_value || 'null'}` : '';
        }).filter(Boolean).join(', ');
        groupedHistory.push(combined);
      } else {
        groupedHistory.push(...currentGroup);
      }
      currentGroup = [entry];
      currentTimestamp = entryTime;
    }
  });

  if (currentGroup.length > 1 && currentGroup.every(e => e.type === 'asset_change')) {
    const combined = currentGroup[0] as AssetHistoryEntry;
    combined.notes = currentGroup.map(e => {
      const ae = e as AssetHistoryEntry;
      return ae.field_changed ? `${ae.field_changed}: ${ae.new_value || 'null'}` : '';
    }).filter(Boolean).join(', ');
    groupedHistory.push(combined);
  } else {
    groupedHistory.push(...currentGroup);
  }

  const fetchToolHistory = useCallback(async (id: string, forceRefetch: boolean = false) => {
    if (forceRefetch) {
      await queryClient.invalidateQueries({ queryKey: toolHistoryQueryKey(id) });
    } else {
      try {
        await queryClient.ensureQueryData({
          queryKey: toolHistoryQueryKey(id),
          queryFn: async () => {
            const historyResult = await apiService.get(`/history/tools/${id}`);
            return historyResult.data || { asset: null, timeline: [], actions: [], observations: [] };
          },
        });
      } catch (error) {
        console.error('Error fetching tool history:', error);
      }
    }
  }, [queryClient]);

  return {
    toolHistory: groupedHistory,
    assetInfo,
    loading: query.isLoading || query.isFetching,
    fetchToolHistory,
    refetch: query.refetch,
  };
};

