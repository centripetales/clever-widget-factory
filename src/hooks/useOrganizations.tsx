import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { apiService, getApiData } from '@/lib/apiService';
import { organizationsQueryKey } from '@/lib/queryKeys';
import { offlineMutationConfig } from '@/lib/queryConfig';
import { useAuth } from '@/hooks/useCognitoAuth';

interface Organization {
  id: string;
  name: string;
  subdomain: string | null;
  settings: any;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  member_count?: number;
}

interface OrganizationWithMembers extends Organization {
  organization_members: Array<{
    id: string;
    user_id: string;
    role: string;
    profiles: {
      full_name: string | null;
    } | null;
  }>;
}

export function useOrganizations() {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Query to fetch all organizations
  const { data: organizations = [], isLoading } = useQuery<Organization[]>({
    queryKey: organizationsQueryKey(),
    queryFn: async () => {
      const response = await apiService.get('/api/organizations');
      return getApiData(response) || [];
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  const getAllOrganizations = async (): Promise<Organization[]> => {
    return queryClient.ensureQueryData({
      queryKey: organizationsQueryKey(),
      queryFn: async () => {
        const response = await apiService.get('/api/organizations');
        return getApiData(response) || [];
      },
    });
  };

  const getOrganizationWithMembers = async (orgId: string): Promise<OrganizationWithMembers | null> => {
    try {
      const orgData = await apiService.get(`/api/organizations/${orgId}`);
      const membersResponse = await apiService.get(`/api/organization_members?organization_id=${orgId}`);
      const membersData = getApiData(membersResponse) || [];

      const membersWithProfiles = membersData.map((member: any) => ({
        id: member.id,
        user_id: member.user_id,
        role: member.role,
        profiles: { full_name: member.full_name || null }
      }));

      return {
        ...orgData,
        organization_members: membersWithProfiles
      } as OrganizationWithMembers;
    } catch (error) {
      console.error('Error in getOrganizationWithMembers:', error);
      return null;
    }
  };

  // Mutation to create an organization with optimistic updates
  const createOrgMutation = useMutation({
    mutationFn: async (data: { name: string; subdomain: string | null; __tempId?: string }) => {
      const tempId = data.__tempId;
      const payload = { ...data };
      delete payload.__tempId;

      const response = await apiService.post('/api/organizations', payload, { optimisticId: tempId });
      return getApiData(response);
    },
    onMutate: async (newOrg) => {
      await queryClient.cancelQueries({ queryKey: organizationsQueryKey() });
      const previousOrgs = queryClient.getQueryData<Organization[]>(organizationsQueryKey());

      const tempId = 'temp-' + Date.now();
      queryClient.setQueryData(organizationsQueryKey(), (old: Organization[] = []) => [
        ...old,
        {
          id: tempId,
          name: newOrg.name,
          subdomain: newOrg.subdomain,
          is_active: true,
          settings: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
      ]);

      newOrg.__tempId = tempId;
      return { previousOrgs, tempId };
    },
    onError: (err, variables, context) => {
      if (context?.previousOrgs) {
        queryClient.setQueryData(organizationsQueryKey(), context.previousOrgs);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: organizationsQueryKey() });
      // Invalidate memberships so the new org's seeded membership row is
      // picked up before the user tries to switch to the freshly created org.
      queryClient.invalidateQueries({ queryKey: ['organization_memberships', user?.userId] });
    },
    ...offlineMutationConfig,
  });

  // Mutation to update an organization with optimistic updates
  const updateOrgMutation = useMutation({
    mutationFn: async ({ orgId, updates }: { orgId: string; updates: Partial<Pick<Organization, 'name' | 'subdomain' | 'is_active' | 'settings'>> }) => {
      const response = await apiService.put(`/api/organizations/${orgId}`, updates);
      return getApiData(response);
    },
    onMutate: async ({ orgId, updates }) => {
      await queryClient.cancelQueries({ queryKey: organizationsQueryKey() });
      const previousOrgs = queryClient.getQueryData<Organization[]>(organizationsQueryKey());

      queryClient.setQueryData(organizationsQueryKey(), (old: Organization[] = []) => 
        old.map(org => org.id === orgId ? { ...org, ...updates } : org)
      );

      return { previousOrgs };
    },
    onError: (err, variables, context) => {
      if (context?.previousOrgs) {
        queryClient.setQueryData(organizationsQueryKey(), context.previousOrgs);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: organizationsQueryKey() });
    },
    ...offlineMutationConfig,
  });

  const createOrganization = async (name: string, subdomain?: string): Promise<boolean> => {
    try {
      await createOrgMutation.mutateAsync({
        name,
        subdomain: subdomain || null
      });

      toast({
        title: "Success",
        description: "Organization created successfully",
      });
      return true;
    } catch (error) {
      console.error('Error in createOrganization:', error);
      toast({
        title: "Error",
        description: "Failed to create organization",
        variant: "destructive",
      });
      return false;
    }
  };

  const updateOrganization = async (
    orgId: string, 
    updates: Partial<Pick<Organization, 'name' | 'subdomain' | 'is_active' | 'settings'>>
  ): Promise<boolean> => {
    try {
      await updateOrgMutation.mutateAsync({ orgId, updates });

      toast({
        title: "Success",
        description: "Organization updated successfully",
      });
      return true;
    } catch (error) {
      console.error('Error in updateOrganization:', error);
      toast({
        title: "Error",
        description: "Failed to update organization",
        variant: "destructive",
      });
      return false;
    }
  };

  return {
    organizations,
    getAllOrganizations,
    getOrganizationWithMembers,
    createOrganization,
    updateOrganization,
    loading: isLoading || createOrgMutation.isPending || updateOrgMutation.isPending,
  };
}