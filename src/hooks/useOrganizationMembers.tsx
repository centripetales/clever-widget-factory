import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiService, getApiData } from '@/lib/apiService';
import { offlineQueryConfig } from '@/lib/queryConfig';
import { useOrganization } from '@/hooks/useOrganization';

export interface OrganizationMember {
  id: string;
  user_id: string;
  full_name: string;
  role: string;
  favorite_color?: string;
  cognito_user_id?: string;
  is_active?: boolean;
  organization_id?: string;
  auth_data?: {
    email: string;
    last_sign_in_at: string | null;
    created_at: string;
  };
}

/**
 * Fetch organization members for a specific organization
 */
async function fetchOrganizationMembersByOrg(organizationId: string): Promise<any[]> {
  const response = await apiService.get(`/organization_members?organization_id=${organizationId}`);
  const memberData = getApiData<any[]>(response);
  return memberData || [];
}

/**
 * Hook to fetch organization members for a specific organization
 * Uses TanStack Query for caching and automatic updates
 * 
 * Returns:
 * - members: All signed-in members (both enabled and disabled, sorted with enabled first)
 * - pendingMembers: Pending invitations (no cognito_user_id yet)
 * - allMembers: All members including pending
 */
export function useOrganizationMembersByOrg(organizationId: string | null | undefined) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['organization_members', organizationId],
    queryFn: async () => {
      if (!organizationId) return [];
      const memberData = await fetchOrganizationMembersByOrg(organizationId);
      
      // Transform the data to match the expected structure
      return memberData.map((member: any) => {
        const hasAccount = !!member.cognito_user_id;
        return {
          id: member.id || member.user_id || member.cognito_user_id,
          user_id: member.user_id || member.cognito_user_id,
          role: member.role,
          is_active: member.is_active ?? true, // Default to enabled if not specified
          organization_id: organizationId,
          full_name: member.full_name || member.user_id || 'Unknown',
          favorite_color: member.favorite_color,
          cognito_user_id: member.cognito_user_id,
          auth_data: {
            email: member.cognito_user_id || member.user_id || 'Unknown',
            last_sign_in_at: hasAccount ? new Date().toISOString() : null,
            created_at: member.created_at || new Date().toISOString()
          }
        } as OrganizationMember;
      });
    },
    enabled: !!organizationId,
    staleTime: Infinity,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    placeholderData: offlineQueryConfig.placeholderData,
    networkMode: offlineQueryConfig.networkMode,
  });

  // Split members into signed-in and pending
  // Signed-in members: have cognito_user_id (accepted invitation)
  // Pending members: no cognito_user_id (invitation not yet accepted)
  const signedInMembers = useMemo(() => {
    return (query.data ?? []).filter((m: OrganizationMember) => m.cognito_user_id !== null);
  }, [query.data]);

  const pendingMembers = useMemo(() => {
    return (query.data ?? []).filter((m: OrganizationMember) => m.cognito_user_id === null);
  }, [query.data]);

  // Sort signed-in members: enabled first, then disabled, then by name
  const sortedSignedInMembers = useMemo(() => {
    return [...signedInMembers].sort((a, b) => {
      // Enabled members first
      if (a.is_active && !b.is_active) return -1;
      if (!a.is_active && b.is_active) return 1;
      // Then sort by name
      return (a.full_name || '').localeCompare(b.full_name || '');
    });
  }, [signedInMembers]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['organization_members', organizationId] });
    // Also invalidate the general cache for backwards compatibility
    queryClient.invalidateQueries({ queryKey: ['organization_members'] });
  };

  return {
    members: sortedSignedInMembers, // All signed-in members (enabled + disabled)
    pendingMembers,
    allMembers: query.data ?? [],
    loading: query.isLoading,
    error: query.error,
    refetch: invalidate,
  };
}

/**
 * Legacy hook for backwards compatibility
 * Fetches all organization members (no organization filter)
 */
export function useOrganizationMembers() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['organization_members'],
    queryFn: async () => {
      const response = await apiService.get('/organization_members');
      const members = getApiData<any[]>(response) || [];
      return members.map((member: any) => ({
        id: member.user_id,
        user_id: member.user_id,
        full_name: member.full_name,
        role: member.role,
        favorite_color: member.favorite_color,
        cognito_user_id: member.cognito_user_id,
        is_active: member.is_active ?? true,
      })) as OrganizationMember[];
    },
    staleTime: Infinity,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    placeholderData: offlineQueryConfig.placeholderData,
    networkMode: offlineQueryConfig.networkMode,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['organization_members'] });

  return {
    members: query.data ?? [],
    loading: query.isLoading,
    refetch: invalidate,
  };
}

/**
 * Hook to get only enabled members for dropdowns and assignments.
 * Scoped to the current organization so cross-org assignee bleed doesn't occur.
 */
export function useEnabledMembers() {
  const { organization } = useOrganization();
  const { members, loading, refetch } = useOrganizationMembersByOrg(organization?.id ?? null);

  const enabledMembers = useMemo(() => {
    return members.filter((m) => m.is_active !== false);
  }, [members]);

  return { members: enabledMembers, loading, refetch };
}
