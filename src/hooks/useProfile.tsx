import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from "@/hooks/useCognitoAuth";
import { useToast } from '@/hooks/use-toast';
import { offlineQueryConfig, offlineMutationConfig } from '@/lib/queryConfig';
import { apiService, getApiData } from '@/lib/apiService';

interface OrganizationMember {
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  full_name?: string;
  is_active: boolean;
}

interface Organization {
  id: string;
  name: string;
  subdomain: string | null;
  settings: any;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface ProfileData {
  user_id: string;
  full_name?: string;
  favorite_color?: string;
  super_admin?: boolean;
}

const fetchProfile = async (userId: string): Promise<ProfileData | null> => {
  try {
    const response = await apiService.get(`/profiles?user_id=${userId}`);
    const data = getApiData(response);
    if (!data || (Array.isArray(data) && data.length === 0)) return null;
    return Array.isArray(data) ? (data[0] as ProfileData || null) : (data as ProfileData || null);
  } catch (error) {
    // Return null instead of undefined when profile doesn't exist
    return null;
  }
};

// Create organization object from membership
// The organization_members query doesn't include org name, so we use a default
// The organization_id is the key piece of data we need
const createOrganizationFromMembership = (membership: OrganizationMember | null): Organization | null => {
  if (!membership?.organization_id) return null;
  
  // Default to "Stargazer Farm" for the default organization ID
  // This matches the default org used throughout the codebase
  const defaultOrgId = '00000000-0000-0000-0000-000000000001';
  const orgName = membership.organization_id === defaultOrgId 
    ? 'Stargazer Farm' 
    : 'Organization';
  
  return {
    id: membership.organization_id,
    name: orgName,
    subdomain: null,
    settings: {},
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
};

const updateProfile = async ({ userId, full_name, favorite_color }: { userId: string, full_name?: string, favorite_color?: string }) => {
  const response = await apiService.post('/profiles', {
    user_id: userId,
    full_name,
    favorite_color
  });
  return response;
};

export function useProfile() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch profile data
  const { data: profile, isLoading: profileLoading } = useQuery<ProfileData | null>({
    queryKey: ['profile', user?.userId],
    queryFn: () => fetchProfile(user!.userId),
    enabled: !!user,
    ...offlineQueryConfig,
  });

  // Fetch organization memberships
  // Use shorter staleTime than offlineQueryConfig so org changes are picked up quickly
  const { data: memberships = [], isLoading: membershipsLoading } = useQuery<OrganizationMember[]>({
    queryKey: ['organization_memberships', user?.userId],
    queryFn: async () => {
      if (!user?.userId) return [];

      // Fetch all memberships for this user (includes organization_id for each)
      // Skip org header — this query must return ALL memberships across all orgs
      const response = await apiService.get(
        `/organization_members?cognito_user_id=${encodeURIComponent(user.userId)}`,
        { skipOrgHeader: true } as any
      );
      const data = getApiData(response);
      return Array.isArray(data) ? (data as OrganizationMember[]) : [];
    },
    enabled: !!user?.userId,
    staleTime: 5 * 60 * 1000, // 5 minutes — memberships can change when orgs are created
    gcTime: 30 * 60 * 1000,
    networkMode: 'offlineFirst' as const,
  });

  // Get primary organization (oldest membership by created_at to match backend authorizer)
  const primaryMembership = memberships.length > 0 ? memberships[0] : null;
  const primaryOrganizationId = primaryMembership?.organization_id;
  
  // Create organization object from membership (minimal for now)
  const organization = createOrganizationFromMembership(primaryMembership);

  const mutation = useMutation({
    mutationFn: updateProfile,
    ...offlineMutationConfig,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile', user?.userId] });
      toast({
        title: "Profile updated",
        description: "Your profile has been updated successfully.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update your profile. Please try again.",
        variant: "destructive",
      });
    }
  });

  const updateFullName = async (newName: string) => {
    if (!user) return false;
    try {
      await mutation.mutateAsync({ userId: user.userId, full_name: newName, favorite_color: profile?.favorite_color });
      return true;
    } catch {
      return false;
    }
  };

  const isLoading = profileLoading || membershipsLoading;
  const isSuperAdmin = Boolean(profile?.super_admin);

  // Fallback to auth context name if no profile full_name exists
  const displayName = profile?.full_name || user?.name || '';

  return {
    // Profile data
    fullName: profile?.full_name || '',
    displayName,
    favoriteColor: profile?.favorite_color || '#6B7280',
    updateFullName,
    isLoading: isLoading || mutation.isPending,
    isSuperAdmin,
    
    // Organization data (from memberships)
    organization: organization as Organization | null,
    organizationMember: primaryMembership as OrganizationMember | null,
    organizationId: primaryOrganizationId || null,
    role: primaryMembership?.role || null,
    isAdmin: primaryMembership?.role === 'admin',
    allMemberships: memberships as OrganizationMember[],
  };
}