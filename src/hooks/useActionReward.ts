import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiService } from '@/lib/apiService';
import { actionRewardQueryKey } from '@/lib/queryKeys';
import type { ActionRewards } from '@/types/rewards';

const POLL_MS = 3000;
const GIVE_UP_MS = 3 * 60 * 1000;

/**
 * The action's rewards, plus a rebuild that runs in the background: POST starts
 * it, then the query polls until a newer result (or a failure) is saved.
 */
export function useActionReward(actionId: string, enabled: boolean) {
  const [building, setBuilding] = useState<{ since: number; previous: string | null } | null>(null);

  const query = useQuery({
    queryKey: actionRewardQueryKey(actionId),
    queryFn: async () => {
      const result = await apiService.get<{ data: ActionRewards | null }>(`/actions/${actionId}/reward`);
      return result.data ?? null;
    },
    enabled: enabled && !!actionId,
    refetchInterval: building ? POLL_MS : false,
  });

  const latest = query.data?.created_at ?? null;
  useEffect(() => {
    if (!building) return;
    if (latest !== building.previous || Date.now() - building.since > GIVE_UP_MS) setBuilding(null);
  }, [building, latest]);

  const rebuild = useMutation({
    mutationFn: () => apiService.post(`/actions/${actionId}/reward`, {}),
    onSuccess: () => setBuilding({ since: Date.now(), previous: latest }),
  });

  return { ...query, rebuild, isBuilding: !!building || rebuild.isPending };
}
