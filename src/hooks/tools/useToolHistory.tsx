import { useState, useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';
import { apiService } from '@/lib/apiService';

export interface CheckoutHistory {
  id: string;
  type?: string;
  checkout_date: string | null;
  created_at: string;
  expected_return_date?: string;
  user_name: string;
  user_display_name?: string;  // From API JOIN with organization_members
  intended_usage?: string;
  notes?: string;
  is_returned: boolean;
  action_id?: string | null;
  action_title?: string | null;
  checkin?: {
    id: string;
    checkin_date: string;
    problems_reported?: string;
    notes?: string;
    user_name?: string;
    hours_used?: number;
    after_image_urls?: string[];
    sop_best_practices?: string;
    what_did_you_do?: string;
    checkin_reason?: string;
  };
}

export interface IssueHistoryEntry {
  id: string;
  type: 'issue_change';
  issue_id: string;
  issue_description?: string;
  issue_type?: string;
  change_type: 'created' | 'updated' | 'resolved' | 'removed';
  changed_at: string;
  changed_by: string;
  user_name?: string;
  field_changed?: string;
  old_value?: string;
  new_value?: string;
  old_status?: string;
  new_status?: string;
  notes?: string;
  damage_assessment?: string;
}

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
  const [currentCheckout, setCurrentCheckout] = useState<{user_name: string} | null>(null);
  const [assetInfo, setAssetInfo] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const fetchToolHistory = useCallback(async (toolId: string) => {
    setLoading(true);
    setToolHistory([]); // Clear previous history while loading
    try {
      // Fetch unified history from new history Lambda endpoint
      const historyResult = await apiService.get(`/history/tools/${toolId}`);
      const historyResponse = historyResult.data || { asset: null, timeline: [], checkouts: [], issues: [], actions: [], observations: [] };
      
      // Use timeline directly - it's already sorted by backend
      const historyData = historyResponse.timeline || [];

      // Find current checkout (not returned) - get from checkouts array
      const checkouts = historyResponse.checkouts || [];
      const activeCheckout = checkouts.find(
        (entry: any) => !entry.is_returned
      );
      setCurrentCheckout(activeCheckout ? { user_name: activeCheckout.user_name } : null);

      // Transform to HistoryEntry format
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

          case 'checkout':
            return {
              id: entry.data.id,
              checkout_date: entry.data.checkout_date || entry.data.created_at,
              created_at: entry.data.created_at,
              user_name: entry.data.user_display_name || entry.data.user_name || 'Unknown',
              user_display_name: entry.data.user_display_name,
              is_returned: entry.data.is_returned || false,
              intended_usage: entry.data.intended_usage,
              notes: entry.data.notes,
              action_id: entry.data.action_id,
              action_title: entry.data.action_title,
              checkin: undefined
            } as CheckoutHistory;

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

          case 'issue_reported':
          case 'issue_resolved':
            return {
              id: entry.data?.id || `issue-timeline-${Date.now()}-${Math.random()}`,
              type: 'issue_change',
              issue_id: entry.data?.id || '',
              issue_description: entry.data?.description,
              issue_type: entry.data?.issue_type,
              change_type: entry.type === 'issue_resolved' ? 'resolved' : 'created',
              changed_at: entry.timestamp,
              changed_by: entry.data?.reported_by || 'system',
              user_name: entry.data?.reported_by_name || 'System',
              old_status: undefined,
              new_status: entry.data?.status || (entry.type === 'issue_resolved' ? 'resolved' : 'active'),
              notes: entry.data?.description,
              damage_assessment: entry.data?.damage_assessment
            } as IssueHistoryEntry;

          default:
            console.warn('Unknown timeline entry type:', entry.type, entry);
            // Return a minimal entry to avoid breaking
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

      // Timeline is already sorted by backend - no need to re-sort

      // Group entries that happened within 5 seconds of each other
      const groupedHistory: HistoryEntry[] = [];
      let currentGroup: HistoryEntry[] = [];
      let currentTimestamp: number | null = null;

      allHistory.forEach((entry) => {
        const entryTime = new Date(
          'checkout_date' in entry ? (entry.checkout_date || entry.created_at) : 
          'observed_at' in entry ? entry.observed_at : entry.changed_at
        ).getTime();
        
        if (currentTimestamp === null || Math.abs(entryTime - currentTimestamp) <= 5000) {
          currentGroup.push(entry);
          currentTimestamp = entryTime;
        } else {
          if (currentGroup.length > 1 && currentGroup.every(e => e.type === 'asset_change')) {
            // Only combine asset_change entries
            const combined = currentGroup[0] as AssetHistoryEntry;
            combined.notes = currentGroup.map(e => {
              const ae = e as AssetHistoryEntry;
              return ae.field_changed ? `${ae.field_changed}: ${ae.new_value || 'null'}` : '';
            }).filter(Boolean).join(', ');
            groupedHistory.push(combined);
          } else {
            // Push all entries individually (including observations)
            groupedHistory.push(...currentGroup);
          }
          currentGroup = [entry];
          currentTimestamp = entryTime;
        }
      });

      // Push last group
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
    currentCheckout,
    assetInfo,
    loading,
    fetchToolHistory,
    setCurrentCheckout
  };
};