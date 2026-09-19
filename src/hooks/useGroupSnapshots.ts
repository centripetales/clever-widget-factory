import { useQuery } from '@tanstack/react-query';
import { apiService } from '@/lib/apiService';
import { groupSnapshotsQueryKey } from '@/lib/queryKeys';
import { offlineQueryConfig } from '@/lib/queryConfig';
import type { GroupContainer } from '@/components/shared/GroupMetricsGrid';

export const fetchGroupSnapshots = async (orgId: string): Promise<GroupContainer[]> => {
  const res = await apiService.get<{ containers: GroupContainer[] }>(`/organizations/${orgId}/coverage-snapshots`);
  return res.containers;
};

/** Every container shared into the org, with observations/actions for the Metrics tab. */
export function useGroupSnapshots(orgId: string | undefined) {
  return useQuery<GroupContainer[]>({
    queryKey: groupSnapshotsQueryKey(orgId ?? ''),
    queryFn: () => fetchGroupSnapshots(orgId!),
    enabled: !!orgId,
    ...offlineQueryConfig,
  });
}
