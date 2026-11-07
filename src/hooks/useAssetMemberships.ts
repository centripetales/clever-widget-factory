import { useQuery } from '@tanstack/react-query';
import { apiService } from '@/lib/apiService';

// One membership: a System a tool is part of, or a component of a System.
// `observation_id` is the part_of observation that started it; `until` is
// when a later observation ended it (null while current).
export interface Membership {
  asset_id: string;
  type: 'tool' | 'part';
  name: string;
  observation_id: string;
  since: string;
  until: string | null;
}

export interface AssetMemberships {
  part_of: Membership[];
  components: Membership[];
}

export const assetMembershipsQueryKey = (toolId: string) => ['asset_memberships', toolId];

export function useAssetMemberships(toolId: string | undefined) {
  return useQuery({
    queryKey: assetMembershipsQueryKey(toolId ?? ''),
    queryFn: async () => (await apiService.get<{ data: AssetMemberships }>(`/tools/${toolId}/memberships`)).data,
    enabled: !!toolId,
  });
}
