import { useQuery } from '@tanstack/react-query';
import { apiService } from '@/lib/apiService';

type EntityType = 'action' | 'part' | 'tool';

export function useSharedStatus(entityId: string, entityType: EntityType) {
  const queryKey = ['shareStatus', entityType, entityId] as const;
  const queryFn = async () => {
    const resp = await apiService.get(`/api/shares/${entityType}/${entityId}`);
    // Assuming response shape { shares: Array<any> }
    const shares = (resp as any)?.shares || [];
    return { isShared: shares.length > 0, shares };
  };

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn,
    staleTime: 30 * 1000, // 30 seconds — short enough to reflect saves promptly
    retry: false,
  });

  return { isShared: data?.isShared ?? false, shares: data?.shares ?? [], isLoading, error };
}
