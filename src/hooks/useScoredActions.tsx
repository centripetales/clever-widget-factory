import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchActionScores, fetchActions, fetchOrganizationMembers } from '@/lib/queryFetchers';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useCognitoAuth';
import { allActionsQueryKey, actionScoresQueryKey } from '@/lib/queryKeys';
import type { OrganizationMemberSummary } from '@/types/organization';
import { offlineQueryConfig } from '@/lib/queryConfig';

export interface ScoredAction {
  id: string;
  action_id: string;
  asset_context_id: string;
  asset_context_name: string;
  prompt_id: string;
  scores: Array<{ score_name: string; score: number; reason: string; how_to_improve?: string }>;
  attributes?: Array<{ attribute_name: string; attribute_values: string[] }>;
  contexts?: Array<{ context_service: string; context_id: string }>;
  likely_root_causes?: string[];
  ai_response: unknown;
  created_at: string;
  updated_at: string;
  source_type: string;
  score_attribution_type: string;
  // Related action data
  action?: {
    id: string;
    title: string;
    description: string;
    status: string;
    assigned_to?: string;
    assignee?: {
      full_name: string;
      role: string;
    };
  };
}

export interface ScoredActionFilters {
  userIds?: string[];
  startDate?: string;
  endDate?: string;
  viewShared?: string[];
}

const serializeUserIds = (userIds?: string[]) =>
  (userIds ?? []).slice().sort().join(',');

const buildScoredActionsKey = (filters: ScoredActionFilters) => [
  'scoredActions',
  filters.startDate ?? 'all',
  filters.endDate ?? 'all',
  serializeUserIds(filters.userIds),
  serializeUserIds(filters.viewShared),
];

type RawActionScore = {
  id: string;
  prompt_id: string;
  scores: Array<{ score_name: string; score: number; reason: string; how_to_improve?: string }>;
  attributes?: Array<{ attribute_name: string; attribute_values: string[] }>;
  contexts?: Array<{ context_service: string; context_id: string }>;
  ai_response: unknown;
  created_at: string;
  updated_at: string;
};

type ActionRecord = {
  id: string;
  title: string;
  description: string;
  status: string;
  assigned_to?: string | null;
};

export function useScoredActions(filters: ScoredActionFilters = {}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const scoredActionsQuery = useQuery<ScoredAction[]>({
    queryKey: buildScoredActionsKey(filters),
    queryFn: async () => {
      // Always check cache first - reuse data from useEnhancedStrategicAttributes if available
      // This prevents duplicate analysis fetches (which is a large data pull)
      const actionScoresKey = actionScoresQueryKey(filters.startDate, filters.endDate);
      const actionsKey = [...allActionsQueryKey(), serializeUserIds(filters.viewShared)];
      
      // getQueryData returns cached data regardless of staleness
      // We prefer using cached data to avoid duplicate network calls
      let scoresData = queryClient.getQueryData<RawActionScore[]>(actionScoresKey);
      let actionsData = queryClient.getQueryData<ActionRecord[]>(actionsKey);
      
      // Only fetch if data doesn't exist in cache at all
      // ensureQueryData will dedupe with any in-flight queries from useEnhancedStrategicAttributes
      if (!scoresData) {
        scoresData = await queryClient.ensureQueryData<RawActionScore[]>({
          queryKey: actionScoresKey,
          queryFn: () => fetchActionScores({ startDate: filters.startDate, endDate: filters.endDate }),
          staleTime: 60 * 1000,
        });
      }
      
      if (!actionsData) {
        actionsData = await queryClient.ensureQueryData<ActionRecord[]>({
          queryKey: actionsKey,
          queryFn: () => fetchActions(filters.viewShared) as Promise<ActionRecord[]>,
          staleTime: 60 * 1000,
        });
      }
      
      // Type assertions for safety
      if (!scoresData || !actionsData) {
        throw new Error('Failed to fetch required data');
      }

      let organizationMembers = queryClient.getQueryData<OrganizationMemberSummary[]>(['organization_members']);
      if (!organizationMembers) {
        organizationMembers = await fetchOrganizationMembers();
        queryClient.setQueryData(['organization_members'], organizationMembers);
      }

      const actionIds = new Set(
        scoresData
          .map((score) => {
            const actionContext = score.contexts?.find(c => c.context_service === 'action_score');
            return actionContext?.context_id;
          })
          .filter(Boolean)
      );
      const filteredActions = (actionsData || []).filter((action) => actionIds.has(action.id));

      const actionsMap = new Map(filteredActions.map((action) => [action.id, action]));
      const membersMap = new Map(
        (organizationMembers || []).map((member) => [member.user_id, member])
      );

      const baseData = scoresData || [];
      const filteredData = filters.userIds?.length
        ? baseData.filter(item => {
            const actionContext = item.contexts?.find(c => c.context_service === 'action_score');
            const actionId = actionContext?.context_id;
            const action = actionId ? actionsMap.get(actionId) : null;
            return action?.assigned_to && filters.userIds!.includes(action.assigned_to);
          })
        : baseData;

      return filteredData.map(item => {
        const actionContext = item.contexts?.find(c => c.context_service === 'action_score');
        const actionId = actionContext?.context_id || '';
        const action = actionsMap.get(actionId);
        const assignee = action?.assigned_to ? membersMap.get(action.assigned_to) : null;
        
        // Extract likely_root_causes from attributes
        const rootCauseAttr = item.attributes?.find(a => a.attribute_name === 'likely_root_cause');
        const likelyRootCauses = rootCauseAttr?.attribute_values || [];

        return {
          id: item.id,
          action_id: actionId,
          asset_context_id: '',
          asset_context_name: 'Unknown Asset',
          prompt_id: item.prompt_id,
          scores: item.scores || [],
          attributes: item.attributes,
          contexts: item.contexts,
          likely_root_causes: likelyRootCauses,
          ai_response: item.ai_response,
          created_at: item.created_at,
          updated_at: item.updated_at,
          source_type: 'action',
          score_attribution_type: 'action_score',
          action: action ? {
            id: action.id,
            title: action.title,
            description: action.description,
            status: action.status,
            assigned_to: action.assigned_to,
            assignee: assignee ? {
              full_name: assignee.full_name,
              role: assignee.role
            } : undefined
          } : undefined
        };
      });
    },
    enabled: Boolean(user?.userId && filters.startDate && filters.endDate), // Only fetch when dates are available
    ...offlineQueryConfig,
    staleTime: 60 * 1000, // Override with shorter staleTime for scored actions
    retry: 1,
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to fetch scored actions",
        variant: "destructive",
      });
    },
  });

  const fetchScoredActions = useCallback(async (userIds?: string[], startDate?: string, endDate?: string) => {
    const nextFilters: ScoredActionFilters = {
      userIds: userIds ?? filters.userIds,
      startDate: startDate ?? filters.startDate,
      endDate: endDate ?? filters.endDate,
    };
    await queryClient.invalidateQueries({ queryKey: buildScoredActionsKey(nextFilters) });
  }, [filters.endDate, filters.startDate, filters.userIds, queryClient]);

  return {
    scoredActions: scoredActionsQuery.data ?? [],
    isLoading: scoredActionsQuery.isLoading,
    fetchScoredActions,
  };
}