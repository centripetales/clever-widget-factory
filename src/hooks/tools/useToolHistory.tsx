import { useState, useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';
import { apiService } from '@/lib/apiService';

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

export type HistoryEntry = ObservationHistoryEntry | AssetHistoryEntry;

export const useToolHistory = () => {
  const [toolHistory, setToolHistory] = useState<HistoryEntry[]>([]);
  const [assetInfo, setAssetInfo] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const fetchToolHistory = useCallback(async (toolId: string) => {
    setLoading(true);
    setToolHistory([]);
    try {
      const historyResult = await apiService.get(`/history/tools/${toolId}`);
      const historyResponse = historyResult.data || { asset: null, timeline: [], actions: [], observations: [] };

      const historyData = historyResponse.timeline || [];

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

          case 'asset_change':
          case 'asset_created':
            return {
              id: entry.data?.id || `asset-${Date.now()}-${Math.random()}`,
              type: 'asset_change',
              asset_id: toolId,
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
              asset_id: toolId,
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
              asset_id: toolId,
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

      setToolHistory(groupedHistory);
    } catch (error) {
      console.error('Error fetching tool history:', error);
      toast({
        title: "Error",
        description: "Failed to load tool history",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  return {
    toolHistory,
    assetInfo,
    loading,
    fetchToolHistory,
  };
};
