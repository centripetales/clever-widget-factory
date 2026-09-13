import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService, getApiData } from '@/lib/apiService';
import { memberSettingsQueryKey } from '@/lib/queryKeys';

/**
 * Member settings shape stored in organization_members.settings JSONB.
 */
export type MetricsChartRange = 'week' | 'month' | '3months' | 'all';

export interface MemberSettings {
  growth_intents?: string[];
  // Preferred visible time range for the org-wide metrics charts
  // (GroupMetricsGrid.tsx). Defaults to 'all' when unset, matching the
  // chart's pre-existing behavior for anyone who hasn't picked a range yet.
  metrics_chart_range?: MetricsChartRange;
}

/**
 * Query hook to fetch member settings.
 * GET /api/members/:userId/settings → { data: MemberSettings }
 *
 * Requirements: 4.1, 4.2
 */
export function useMemberSettings(
  userId: string | undefined,
  organizationId: string | undefined
) {
  return useQuery<MemberSettings>({
    queryKey: memberSettingsQueryKey(userId ?? '', organizationId),
    queryFn: async () => {
      const response = await apiService.get(`/members/${userId}/settings`);
      return getApiData(response) ?? {};
    },
    enabled: !!(userId && organizationId),
  });
}

/**
 * Mutation hook to update member settings.
 * PUT /api/members/:userId/settings { settings: MemberSettings }
 *
 * Uses optimistic updates to keep the UI responsive.
 * Requirements: 4.1, 4.2
 */
export function useUpdateMemberSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      userId,
      settings,
    }: {
      userId: string;
      organizationId?: string;
      settings: MemberSettings;
    }) => {
      const result = await apiService.put(`/members/${userId}/settings`, {
        settings,
      });
      return getApiData(result) as MemberSettings;
    },
    // organizationId must match what the corresponding useMemberSettings
    // call was given -- memberSettingsQueryKey folds a missing
    // organizationId to the literal 'default', a DIFFERENT cache entry
    // from the real org-scoped one every caller here actually reads from.
    // Omitting it (as this used to) meant every optimistic update/rollback/
    // invalidation silently touched the wrong entry, so a save always hit
    // the backend correctly but the UI never showed it without a manual
    // full cache wipe.
    onMutate: async (variables) => {
      // Cancel any outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({
        queryKey: memberSettingsQueryKey(variables.userId, variables.organizationId),
      });

      const previous = queryClient.getQueryData<MemberSettings>(
        memberSettingsQueryKey(variables.userId, variables.organizationId)
      );

      // Optimistically update the cache
      queryClient.setQueryData<MemberSettings>(
        memberSettingsQueryKey(variables.userId, variables.organizationId),
        variables.settings
      );

      return { previous };
    },
    onError: (_error, variables, context) => {
      // Roll back on error
      if (context?.previous) {
        queryClient.setQueryData(
          memberSettingsQueryKey(variables.userId, variables.organizationId),
          context.previous
        );
      }
    },
    onSettled: (_data, _error, variables) => {
      // Refetch to ensure server state is in sync
      queryClient.invalidateQueries({
        queryKey: memberSettingsQueryKey(variables.userId, variables.organizationId),
      });
    },
  });
}
