import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService, getApiData } from '@/lib/apiService';
import { positiveSumMineQueryKey, positiveSumOpportunitiesQueryKey } from '@/lib/queryKeys';
import type {
  MyPositiveSum,
  NewGoal,
  NewOption,
  NewPolicy,
  Opportunity,
  PositiveSumItem,
} from '@/types/positiveSum';

/**
 * My goals (with suggested options), my policies, and what's waiting on me,
 * in one org.
 * GET /api/positive-sum/mine?org_id=
 */
export function useMyPositiveSum(orgId: string | undefined) {
  return useQuery<MyPositiveSum>({
    queryKey: positiveSumMineQueryKey(orgId),
    queryFn: async () => getApiData(await apiService.get(`/positive-sum/mine?org_id=${orgId}`)),
    enabled: !!orgId,
  });
}

/**
 * Today's opportunities in the given orgs. Only fetched when the person asks;
 * the server refreshes the list at most once a day.
 * GET /api/positive-sum/opportunities
 */
export function useOpportunities(enabled: boolean, orgIds: string[]) {
  return useQuery<Opportunity[]>({
    queryKey: positiveSumOpportunitiesQueryKey(orgIds),
    queryFn: async () =>
      getApiData(await apiService.get(`/positive-sum/opportunities?org_ids=${orgIds.join(',')}`)) ?? [],
    enabled: enabled && orgIds.length > 0,
  });
}

// Every Positive Sum write can change both lists.
function usePositiveSumMutation<TVars>(request: (vars: TVars) => Promise<{ data?: PositiveSumItem }>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: TVars) => getApiData(await request(vars)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: positiveSumMineQueryKey() });
      queryClient.invalidateQueries({ queryKey: positiveSumOpportunitiesQueryKey() });
    },
  });
}

export const useCreateGoal = () =>
  usePositiveSumMutation((goal: NewGoal) => apiService.post('/positive-sum/goals', goal));

export const useCreatePolicy = () =>
  usePositiveSumMutation((policy: NewPolicy) => apiService.post('/positive-sum/policies', policy));

export const useCreateOption = () =>
  usePositiveSumMutation((option: NewOption) => apiService.post('/positive-sum/options', option));

export const useJoinOption = () =>
  usePositiveSumMutation((optionId: string) => apiService.post(`/positive-sum/options/${optionId}/join`, {}));

export const useApproveOption = () =>
  usePositiveSumMutation(({ optionId, goalId }: { optionId: string; goalId?: string }) =>
    apiService.post(`/positive-sum/options/${optionId}/approve`, goalId ? { goal_id: goalId } : {}));

// Passing works for goals and options alike (learning only).
export const usePass = () =>
  usePositiveSumMutation((itemId: string) => apiService.post(`/positive-sum/options/${itemId}/pass`, {}));
