import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useCognitoAuth';
import { useNavigate } from 'react-router-dom';
import { useProfile } from '@/hooks/useProfile';
import { setActiveOrganizationId } from '@/lib/apiService';
import { apiService, getApiData } from '@/lib/apiService';
import { queryCachePersister } from '@/lib/queryPersistAdapter';

interface Organization {
  id: string;
  name: string;
  subdomain: string | null;
  settings: any;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface OrganizationMember {
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  invited_by: string | null;
}

interface OrganizationContextType {
  organization: Organization | null;
  organizationMember: OrganizationMember | null;
  isAdmin: boolean;
  loading: boolean;
  refreshOrganization: () => Promise<void>;
  /** All organizations the user can access */
  accessibleOrganizations: Organization[];
  /** Switch the active organization */
  switchOrganization: (orgId: string) => void;
  /** Whether the user has multiple orgs and can switch */
  canSwitchOrganization: boolean;
}

const OrganizationContext = createContext<OrganizationContextType | undefined>(undefined);

const ACTIVE_ORG_KEY = 'cwf_active_organization_id';

export function OrganizationProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  
  const {
    organization: primaryOrganization,
    organizationMember: primaryMember,
    isAdmin: primaryIsAdmin,
    isLoading,
    allMemberships,
  } = useProfile();

  // Accessible organizations with full details (name, subdomain, etc.)
  const [accessibleOrganizations, setAccessibleOrganizations] = useState<Organization[]>([]);
  const [orgsLoaded, setOrgsLoaded] = useState(false);

  // Active org ID — persisted in localStorage
  const [activeOrgId, setActiveOrgId] = useState<string | null>(() => {
    try {
      const stored = localStorage.getItem(ACTIVE_ORG_KEY);
      // Set the header immediately on init so first API calls use the right org
      if (stored) {
        setActiveOrganizationId(stored);
      }
      return stored;
    } catch {
      return null;
    }
  });

  // Fetch full org details when memberships are available
  // Re-run when membership count changes (e.g., from 1 to 2 as data loads)
  const membershipCount = allMemberships?.length || 0;
  
  useEffect(() => {
    if (!allMemberships || allMemberships.length === 0) return;

    const fetchOrgs = async () => {
      try {
        // Skip org header so we get ALL orgs, not just the active one
        const response = await apiService.get('/api/organizations', {
          skipOrgHeader: true
        } as any);
        const orgs: Organization[] = getApiData(response) || [];
        // Filter to only orgs the user is a member of
        const memberOrgIds = new Set(allMemberships.map((m: any) => m.organization_id));
        const accessible = orgs.filter(org => memberOrgIds.has(org.id));
        setAccessibleOrganizations(accessible);
        setOrgsLoaded(true);
      } catch (error) {
        console.error('Failed to fetch accessible organizations:', error);
      }
    };

    fetchOrgs();
  }, [membershipCount]);

  // Determine the effective active org and membership
  const effectiveOrgId = activeOrgId && allMemberships?.some((m: any) => m.organization_id === activeOrgId)
    ? activeOrgId
    : primaryOrganization?.id || null;

  const effectiveMembership = allMemberships?.find((m: any) => m.organization_id === effectiveOrgId) || primaryMember;
  const effectiveRole = effectiveMembership?.role || null;
  const effectiveIsAdmin = effectiveRole === 'admin';

  // Build the effective organization object
  const effectiveOrganization: Organization | null = effectiveOrgId
    ? accessibleOrganizations.find(org => org.id === effectiveOrgId) 
      || (primaryOrganization?.id === effectiveOrgId ? primaryOrganization : null)
    : primaryOrganization;

  // Keep the header in sync when primary org info becomes available
  // Also invalidate data caches when the effective org changes (e.g., on page load from localStorage)
  const prevEffectiveOrgRef = { current: null as string | null };
  useEffect(() => {
    if (!effectiveOrgId) return;
    // Don't clear the header if we're still waiting for memberships to load
    if (!allMemberships || allMemberships.length === 0) return;
    
    if (effectiveOrgId !== primaryOrganization?.id) {
      setActiveOrganizationId(effectiveOrgId);
    } else {
      setActiveOrganizationId(null);
    }
    
    // If the effective org is different from primary (i.e., user switched orgs),
    // clear data caches so they refetch with the org header
    if (effectiveOrgId !== primaryOrganization?.id) {
      queryClient.removeQueries({
        predicate: (query) => {
          const key = query.queryKey;
          if (Array.isArray(key) && (key[0] === 'organization_memberships' || key[0] === 'profile')) {
            return false;
          }
          return true;
        }
      });
    }
  }, [effectiveOrgId, primaryOrganization?.id, allMemberships]);

  const switchOrganization = useCallback((orgId: string) => {
    // Validate the user has access
    const hasMembership = allMemberships?.some((m: any) => m.organization_id === orgId);
    const hasAccess = hasMembership || accessibleOrganizations.some(org => org.id === orgId);
    if (!hasAccess) {
      console.warn('Cannot switch to org — no membership:', orgId);
      return;
    }

    // Set the header BEFORE invalidating queries so refetches use the new org
    if (orgId !== primaryOrganization?.id) {
      setActiveOrganizationId(orgId);
    } else {
      setActiveOrganizationId(null);
    }

    setActiveOrgId(orgId);
    try {
      localStorage.setItem(ACTIVE_ORG_KEY, orgId);
    } catch {
      // localStorage not available
    }

    // Remove all data caches so components show loading states while fresh data loads.
    // invalidateQueries only marks as stale (old data still visible during refetch);
    // removeQueries actually clears the cache, preventing cross-org data leaks.
    queryClient.removeQueries({
      predicate: (query) => {
        const key = query.queryKey;
        // Don't remove membership or profile queries — those are user-level, not org-scoped
        if (Array.isArray(key) && (key[0] === 'organization_memberships' || key[0] === 'profile')) {
          return false;
        }
        return true;
      }
    });

    // Purge the IndexedDB persisted snapshot so PersistQueryClientProvider cannot
    // re-hydrate the old org's data on the next page load or tab re-focus.
    // The next persist cycle after navigation will write the fresh (empty) cache.
    queryCachePersister.removeClient().catch((err) => {
      console.warn('[switchOrganization] Failed to clear persisted cache:', err);
    });

    navigate('/');
  }, [allMemberships, accessibleOrganizations, queryClient, primaryOrganization?.id, navigate]);

  const refreshOrganization = async () => {
    if (user?.userId) {
      setOrgsLoaded(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['profile', user.userId] }),
        queryClient.invalidateQueries({ queryKey: ['organization_memberships', user.userId] }),
      ]);
    }
  };

  const canSwitchOrganization = (allMemberships?.length || 0) > 1;

  return (
    <OrganizationContext.Provider value={{
      organization: effectiveOrganization,
      organizationMember: effectiveMembership ? {
        id: effectiveMembership.id,
        organization_id: effectiveMembership.organization_id,
        user_id: effectiveMembership.user_id,
        role: effectiveMembership.role,
        invited_by: null
      } : null,
      isAdmin: effectiveIsAdmin,
      loading: isLoading,
      refreshOrganization,
      accessibleOrganizations,
      switchOrganization,
      canSwitchOrganization,
    }}>
      {children}
    </OrganizationContext.Provider>
  );
}

export function useOrganization() {
  const context = useContext(OrganizationContext);
  if (context === undefined) {
    throw new Error('useOrganization must be used within an OrganizationProvider');
  }
  return context;
}
