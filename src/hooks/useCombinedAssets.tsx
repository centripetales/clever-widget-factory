import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { useUserNames } from '@/hooks/useUserNames';
import { useAssetMutations } from '@/hooks/useAssetMutations';
import { offlineQueryConfig } from '@/lib/queryConfig';
import { apiService, getApiData } from '@/lib/apiService';
import { toolsQueryKey, partsQueryKey } from '@/lib/queryKeys';
import { toolsQueryConfig, partsQueryConfig } from '@/lib/assetQueryConfigs';
import { useOrganization } from '@/hooks/useOrganization';
import { useSharedOrgs } from '@/hooks/useSharedOrgs';

export interface CombinedAsset {
  id: string;
  name: string;
  type: 'asset' | 'stock';
  description?: string;
  category?: string;
  status?: string;
  serial_number?: string;
  current_quantity?: number;
  minimum_quantity?: number;
  unit?: string;
  cost_per_unit?: number;
  cost_evidence_url?: string;
  supplier?: string;
  image_url?: string;
  storage_location?: string;
  storage_vicinity?: string;
  parent_structure_id?: string;
  parent_structure_name?: string; // Resolved name from parent_structure_id
  legacy_storage_vicinity?: string;
  area_display?: string; // Computed field: parent_structure_name || legacy_storage_vicinity
  has_issues?: boolean;
  is_checked_out?: boolean;
  checked_out_to?: string;
  checked_out_user_id?: string;
  checked_out_date?: string;
  checkout_action_id?: string;
  accountable_person_id?: string;
  accountable_person_name?: string; // Resolved name from accountable_person_id
  accountable_person_color?: string; // Favorite color of accountable person
  sellable?: boolean; // For stock items - whether available in Sari Sari store
  is_shared_inbound?: boolean; // true when asset belongs to a partner org shared with this org
  is_shared_outbound?: boolean; // true when this org has shared this asset to at least one other org
  shared_from_org?: string; // name/id of the org that owns the shared asset
  created_at: string;
  updated_at: string;
  gps_latitude?: number;
  gps_longitude?: number;
}

type AssetsQueryOptions = {
  search?: string;
  limit?: number;
  page?: number;
  searchDescriptions?: boolean;
  showLowStock?: boolean;
  skipPagination?: boolean;
};

// Build query key for shared-org data: separate from the base ['tools'] / ['parts'] key
// so mutations (which target base key) are not affected.
const sharedToolsQueryKey = (orgId: string, partnerOrgIds: string[]) =>
  ['tools_shared', orgId, ...partnerOrgIds.sort()];
const sharedPartsQueryKey = (orgId: string, partnerOrgIds: string[]) =>
  ['parts_shared', orgId, ...partnerOrgIds.sort()];

export const useCombinedAssets = (showRemovedItems: boolean = false, options?: AssetsQueryOptions) => {
  const [currentPage, setCurrentPage] = useState(0);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { createTool, createPart } = useAssetMutations();
  const { organization, accessibleOrganizations } = useOrganization();
  const { selectedOrgs } = useSharedOrgs();

  const orgId = organization?.id ?? null;
  const otherOrgs = useMemo(() => {
    if (!organization) return [];
    return accessibleOrganizations.filter((o) => o.id !== organization.id);
  }, [organization, accessibleOrganizations]);
  const partnerOrgIds = useMemo(() => otherOrgs.map(o => o.id), [otherOrgs]);

  const hasPartnerOrgs = partnerOrgIds.length > 0 && !!orgId;

  // ── Base org assets (always fetched via TanStack cache) ──────────────────
  const { data: toolsData = [], isLoading: toolsLoading } = useQuery({
    ...toolsQueryConfig,
    ...offlineQueryConfig,
  });

  const { data: partsData = [], isLoading: partsLoading } = useQuery({
    ...partsQueryConfig,
    ...offlineQueryConfig,
  });

  // ── Shared org assets (fetched for all partner orgs on load) ───────
  const { data: sharedToolsData = [], isLoading: sharedToolsLoading } = useQuery({
    queryKey: sharedToolsQueryKey(orgId ?? '', partnerOrgIds),
    queryFn: async () => {
      if (!orgId || partnerOrgIds.length === 0) return [];
      const params = new URLSearchParams({
        limit: '2000',
        organization_id: orgId,
        view_shared: partnerOrgIds.join(','),
      });
      // Use /api/tools (local Express server) — it has the view_shared JOIN logic.
      // The Lambda (/tools) does not support this parameter.
      const result = await apiService.get(`/api/tools?${params}`);
      return result.data || [];
    },
    enabled: hasPartnerOrgs,
    ...offlineQueryConfig,
  });

  const { data: sharedPartsData = [], isLoading: sharedPartsLoading } = useQuery({
    queryKey: sharedPartsQueryKey(orgId ?? '', partnerOrgIds),
    queryFn: async () => {
      if (!orgId || partnerOrgIds.length === 0) return [];
      const params = new URLSearchParams({
        limit: '2000',
        organization_id: orgId,
        view_shared: partnerOrgIds.join(','),
      });
      // Use /api/parts (local Express server) — it has the view_shared JOIN logic.
      const result = await apiService.get(`/api/parts?${params}`);
      return result.data || [];
    },
    enabled: hasPartnerOrgs,
    ...offlineQueryConfig,
  });

  // Fetch only context_ids of active issues for tools and inventory (parts)
  const fetchAssetIssueFlags = async () => {
    try {
      const response = await apiService.get('/issues?status=active&context_type=tool,inventory&fields=context_id');
      return getApiData(response) || [];
    } catch (error) {
      console.error('Error fetching asset issue flags:', error);
      return [];
    }
  };

  const { data: assetIssueFlagsRaw = [], isLoading: issuesLoading } = useQuery({
    queryKey: ['issues_asset_flags'],
    queryFn: fetchAssetIssueFlags,
    ...offlineQueryConfig,
  });
  const assetIssueFlags = Array.isArray(assetIssueFlagsRaw) ? assetIssueFlagsRaw : [];

  // Create a Set of asset IDs that have active issues
  const assetsWithIssues = useMemo(() => {
    const set = new Set<string>();
    assetIssueFlags.forEach((flag: any) => {
      if (flag.context_id) {
        set.add(flag.context_id);
      }
    });
    return set;
  }, [assetIssueFlags]);

  const loading =
    toolsLoading ||
    partsLoading ||
    issuesLoading ||
    (hasPartnerOrgs && (sharedToolsLoading || sharedPartsLoading));

  const { getUserName, getUserColor } = useUserNames([]);

  const fetchAssets = async (fetchOptions?: { search?: string; page?: number; limit?: number; append?: boolean; searchDescriptions?: boolean; showLowStock?: boolean }) => {
    // Update current page for pagination
    if (fetchOptions?.page !== undefined) {
      setCurrentPage(fetchOptions.page);
    }
  };

  const createAsset = async (assetData: Record<string, unknown>, isAsset: boolean) => {
    try {
      const mutation = isAsset ? createTool : createPart;
      const result = await mutation.mutateAsync(assetData);
      return result;
    } catch (error: any) {
      console.error(`Error creating ${isAsset ? 'asset' : 'stock item'}:`, error);
      const errorMessage = error?.message || error?.error || 'Unknown error';
      toast({
        title: "Error",
        description: `Failed to create ${isAsset ? 'asset' : 'stock item'}: ${errorMessage}`,
        variant: "destructive"
      });
      throw error;
    }
  };

  const updateAsset = async (assetId: string, updates: Partial<CombinedAsset>, isAsset: boolean) => {
    try {
      const endpoint = isAsset ? 'tools' : 'parts';
      await apiService.put(`/${endpoint}/${assetId}`, updates);

      // Note: Asset will update after refetch

      return true;
    } catch (error) {
      console.error(`Error updating ${isAsset ? 'asset' : 'stock item'}:`, error);
      toast({
        title: "Error",
        description: `Failed to update ${isAsset ? 'asset' : 'stock item'}`,
        variant: "destructive"
      });
      return false;
    }
  };

  // Process and paginate data
  const { assets: processedAssets, sharedOrgsCounts } = useMemo(() => {
    // Don't clear results during loading - keep showing previous results
    // This prevents the display from flickering/clearing while typing
    if (loading && (toolsData.length === 0 && partsData.length === 0)) {
      return { assets: [], sharedOrgsCounts: {} };
    }

    // Calculate shared asset counts per organization
    const counts: Record<string, number> = {};
    partnerOrgIds.forEach(id => {
      counts[id] = 0;
    });

    sharedToolsData.forEach((t: any) => {
      if (t.is_shared_inbound && t.organization_id && t.status !== 'removed') {
        counts[t.organization_id] = (counts[t.organization_id] || 0) + 1;
      }
    });

    sharedPartsData.forEach((p: any) => {
      if (p.is_shared_inbound && p.organization_id) {
        counts[p.organization_id] = (counts[p.organization_id] || 0) + 1;
      }
    });

    // ── Own org tools ──────────────────────────────────────────────────────
    // Process data directly from TanStack Query
    let filteredToolsData = toolsData || [];
    if (showRemovedItems) {
      filteredToolsData = filteredToolsData.filter((tool: any) => {
        if (tool.status === 'removed') return true;
        return false;
      });
    } else {
      filteredToolsData = filteredToolsData.filter((tool: any) => tool.status !== 'removed');
    }

    let filteredPartsData = partsData || [];
    // Note: Parts don't have a 'removed' status - they are deleted instead
    // When showRemovedItems is true, hide all stock items since deleted parts can't be retrieved
    if (showRemovedItems) {
      filteredPartsData = [];
    }

    // ── Shared org tools (deduplicate against own org by id) ───────────────
    const ownToolIds = new Set(filteredToolsData.map((t: any) => t.id));
    const ownPartIds = new Set(filteredPartsData.map((p: any) => p.id));

    const hasSharedOrgsSelected = selectedOrgs.length > 0 && !!orgId;

    const extraSharedTools = hasSharedOrgsSelected
      ? (sharedToolsData as any[]).filter(
          (t: any) => t.is_shared_inbound && selectedOrgs.includes(t.organization_id) && !ownToolIds.has(t.id) && t.status !== 'removed'
        )
      : [];
    const extraSharedParts = hasSharedOrgsSelected
      ? (sharedPartsData as any[]).filter(
          (p: any) => p.is_shared_inbound && selectedOrgs.includes(p.organization_id) && !ownPartIds.has(p.id)
        )
      : [];

    // Apply low stock filter
    if (options?.showLowStock) {
      filteredPartsData = filteredPartsData.filter((part: any) => {
        const isLowStock = part.current_quantity != null &&
          part.minimum_quantity != null &&
          part.current_quantity < part.minimum_quantity;
        return isLowStock;
      });
      // When low stock filter is active, exclude all tools/assets
      filteredToolsData = [];
    }

    // Apply search filter
    if (options?.search && options.search.trim()) {
      const searchTerm = options.search.trim().toLowerCase();

      filteredToolsData = filteredToolsData.filter((tool: any) =>
        tool.name?.toLowerCase().includes(searchTerm) ||
        tool.serial_number?.toLowerCase().includes(searchTerm) ||
        tool.category?.toLowerCase().includes(searchTerm) ||
        tool.storage_location?.toLowerCase().includes(searchTerm) ||
        (options.searchDescriptions && tool.description?.toLowerCase().includes(searchTerm))
      );

      filteredPartsData = filteredPartsData.filter((part: any) =>
        part.name?.toLowerCase().includes(searchTerm) ||
        part.category?.toLowerCase().includes(searchTerm) ||
        part.storage_location?.toLowerCase().includes(searchTerm) ||
        (options.searchDescriptions && part.description?.toLowerCase().includes(searchTerm))
      );
    }

    // Apply pagination to each type separately (unless skipPagination is true)
    let paginatedParts = filteredPartsData;
    let paginatedTools = filteredToolsData;

    if (!options?.skipPagination) {
      const limit = options?.limit || 50;
      const page = options?.page || 0;
      paginatedParts = filteredPartsData.slice(0, (page + 1) * limit);
      paginatedTools = filteredToolsData.slice(0, (page + 1) * limit);
    }

    const allAssets: CombinedAsset[] = [
      ...paginatedParts.map((part: any) => ({
        ...part,
        type: 'stock' as const,
        has_issues: assetsWithIssues.has(part.id),
        is_checked_out: false,
        is_shared_inbound: false,
        is_shared_outbound: Boolean(part.is_shared_outbound),
      })),
      ...paginatedTools.map((tool: any) => ({
        ...tool,
        type: 'asset' as const,
        has_issues: assetsWithIssues.has(tool.id),
        is_checked_out: Boolean(tool.is_checked_out),
        checked_out_user_id: tool.checked_out_user_id,
        checked_out_to: tool.checked_out_to,
        checked_out_date: tool.checked_out_date,
        checkout_action_id: tool.checkout_action_id,
        is_shared_inbound: false,
        is_shared_outbound: Boolean(tool.is_shared_outbound),
      })),
      // Append shared assets at the end (already filtered/deduped above)
      ...extraSharedParts.map((part: any) => ({
        ...part,
        type: 'stock' as const,
        has_issues: assetsWithIssues.has(part.id),
        is_checked_out: false,
        is_shared_inbound: true,
        is_shared_outbound: false,
      })),
      ...extraSharedTools.map((tool: any) => ({
        ...tool,
        type: 'asset' as const,
        has_issues: assetsWithIssues.has(tool.id),
        is_checked_out: Boolean(tool.is_checked_out),
        checked_out_user_id: tool.checked_out_user_id,
        checked_out_to: tool.checked_out_to,
        checked_out_date: tool.checked_out_date,
        checkout_action_id: tool.checkout_action_id,
        is_shared_inbound: true,
        is_shared_outbound: false,
      })),
    ];

    return { assets: allAssets, sharedOrgsCounts: counts };
  }, [
    showRemovedItems,
    toolsData,
    partsData,
    sharedToolsData,
    sharedPartsData,
    partnerOrgIds,
    selectedOrgs,
    orgId,
    assetsWithIssues,
    loading,
    options?.search,
    options?.searchDescriptions,
    options?.showLowStock,
    options?.limit,
    options?.page,
    options?.skipPagination,
  ]);

  return {
    assets: processedAssets,
    sharedOrgsCounts,
    loading,
    fetchAssets,
    createAsset,
    updateAsset,
    refetch: async () => {
      // Invalidate and refetch both tools and parts queries (base + shared)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: toolsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: partsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: ['tools_shared'] }),
        queryClient.invalidateQueries({ queryKey: ['parts_shared'] }),
      ]);
      // Reset to first page
      setCurrentPage(0);
    }
  };
};