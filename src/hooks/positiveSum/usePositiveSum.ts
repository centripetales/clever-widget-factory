import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService, getApiData } from '@/lib/apiService';
import { positiveSumEvidenceQueryKey, positiveSumMineQueryKey, positiveSumOpportunitiesQueryKey } from '@/lib/queryKeys';
import type {
  ActionEvidence,
  MyPositiveSum,
  NewGoal,
  NewOption,
  NewPolicy,
  Opportunity,
  PositiveSumItem,
} from '@/types/positiveSum';

/**
 * My goals (with suggested options), my policies, and what's waiting on me.
 * GET /api/positive-sum/mine
 */
export function useMyPositiveSum() {
  return useQuery<MyPositiveSum>({
    queryKey: positiveSumMineQueryKey(),
    queryFn: async () => getApiData(await apiService.get('/positive-sum/mine')),
  });
}

/**
 * Today's opportunities. Only fetched when the person asks (enabled = true);
 * the server refreshes the list at most once a day.
 * GET /api/positive-sum/opportunities
 */
export function useOpportunities(enabled: boolean) {
  return useQuery<Opportunity[]>({
    queryKey: positiveSumOpportunitiesQueryKey(),
    queryFn: async () => getApiData(await apiService.get('/positive-sum/opportunities')) ?? [],
    enabled,
  });
}

/**
 * Photos still needed before an action that came from an option can be
 * completed (association default evidence).
 * GET /api/positive-sum/actions/:id/evidence
 */
export function useActionEvidence(actionId: string | undefined) {
  return useQuery<ActionEvidence>({
    queryKey: positiveSumEvidenceQueryKey(actionId),
    queryFn: async () => getApiData(await apiService.get(`/positive-sum/actions/${actionId}/evidence`)),
    enabled: !!actionId,
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
