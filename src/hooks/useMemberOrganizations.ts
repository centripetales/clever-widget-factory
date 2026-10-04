import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiService, getApiData } from '@/lib/apiService';
import { memberOrganizationsQueryKey, organizationsQueryKey } from '@/lib/queryKeys';

export interface MemberOrganization {
  id: string;
  member_organization_id: string;
  name: string;
  created_at: string;
}

/**
 * Orgs that are members of `orgId` and receive what is shared with it.
 * Requests skip the active-org header so any org you belong to can be managed.
 */
export function useMemberOrganizations(orgId: string | undefined) {
  const queryClient = useQueryClient();
  const path = `/api/organizations/${orgId}/member-organizations`;
  const options = { skipOrgHeader: true } as any;

  const query = useQuery<MemberOrganization[]>({
    queryKey: memberOrganizationsQueryKey(orgId ?? ''),
    queryFn: async () => getApiData(await apiService.get(path, options)) || [],
    enabled: !!orgId,
  });

  const onSuccess = (response: unknown) => {
    queryClient.setQueryData<MemberOrganization[]>(memberOrganizationsQueryKey(orgId ?? ''), getApiData(response as any) || []);
    queryClient.invalidateQueries({ queryKey: organizationsQueryKey() });
  };

  const add = useMutation({
    mutationFn: (memberOrganizationId: string) =>
      apiService.post(path, { member_organization_id: memberOrganizationId }, options),
    onSuccess,
  });

  const remove = useMutation({
    mutationFn: (memberOrganizationId: string) => apiService.delete(`${path}/${memberOrganizationId}`, options),
    onSuccess,
  });

  return { ...query, add, remove };
}
