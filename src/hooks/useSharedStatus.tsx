import { useQuery } from '@tanstack/react-query';
import { apiService } from '@/lib/apiService';
import { shareStatusQueryKey } from '@/lib/queryKeys';

export type ShareEntityType = 'action' | 'part' | 'tool';

// One org an entity is shared with; the share is a state, hence state_id.
export interface EntityShare {
  state_id: string;
  target_org_id: string;
  target_org_name: string;
  note: string;
}

export interface ShareStatus {
  isShared: boolean;
  shares: EntityShare[];
}

export function useSharedStatus(entityId: string, entityType: ShareEntityType) {
  const queryKey = shareStatusQueryKey(entityType, entityId);
  const queryFn = async (): Promise<ShareStatus> => {
    const resp = await apiService.get<{ shares?: EntityShare[] }>(`/api/shares/${entityType}/${entityId}`);
    const shares = resp?.shares || [];
    return { isShared: shares.length > 0, shares };
  };

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn,
    enabled: !!entityId,
    staleTime: 30 * 1000, // 30 seconds — short enough to reflect saves promptly
    retry: false,
  });

  return { isShared: data?.isShared ?? false, shares: data?.shares ?? [], isLoading, error };
}
