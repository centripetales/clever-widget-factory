import { useQuery } from '@tanstack/react-query';
import { apiService } from '@/lib/apiService';
import { useOrganization } from '@/hooks/useOrganization';
import { sharedToolsQueryKey } from '@/lib/queryKeys';
import type { Tool } from '@/hooks/tools/useToolsData';

export type SharedTool = Tool & { source_org_name?: string };

type SharedEntity = { entity_type: string; source_org_id: string; source_org_name: string };

/**
 * Tools other orgs have shared with the current org (e.g. a member's tool
 * shared to the co-op, or a co-op tool shared to members), so actions can
 * require them.
 */
export function useSharedTools() {
  const { organization: currentOrg } = useOrganization();

  const { data: sharedTools = [] } = useQuery<SharedTool[]>({
    queryKey: sharedToolsQueryKey(currentOrg?.id),
    queryFn: async () => {
      const resp = await apiService.get<{ shared?: SharedEntity[] }>('/shared-with-me');
      const shared = (resp?.shared || []).filter(s => s.entity_type === 'tool');
      if (shared.length === 0) return [];

      const orgNames = new Map(shared.map(s => [s.source_org_id, s.source_org_name]));
      const result = await apiService.get<{ data?: Tool[] }>(
        `/tools?limit=2000&view_shared=${[...orgNames.keys()].join(',')}`
      );
      return (result?.data || [])
        .filter(t => t.is_shared_inbound)
        .map(t => ({ ...t, source_org_name: t.organization_id ? orgNames.get(t.organization_id) : undefined }));
    },
    enabled: !!currentOrg?.id,
    staleTime: 5 * 60 * 1000,
  });

  return sharedTools;
}
