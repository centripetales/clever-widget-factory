import { useQuery } from '@tanstack/react-query';
import { apiService } from '@/lib/apiService';
import { toolSharesQueryKey } from '@/lib/queryKeys';
import { offlineQueryConfig } from '@/lib/queryConfig';

export interface ToolShare {
  target_org_id: string;
  target_org_name: string;
}

/** Orgs this tool is share-granted into. GET /shares/tool/:toolId */
export function useToolShares(toolId: string | undefined) {
  return useQuery<ToolShare[]>({
    queryKey: toolSharesQueryKey(toolId ?? ''),
    queryFn: async () => {
      const res = await apiService.get<{ shares: ToolShare[] }>(`/shares/tool/${toolId}`);
      return res.shares || [];
    },
    enabled: !!toolId,
    ...offlineQueryConfig,
  });
}
