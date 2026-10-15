import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService, getApiData } from '@/lib/apiService';
import { offlineMutationConfig } from '@/lib/queryConfig';
import { stateService } from '@/services/stateService';
import { positiveSumMineQueryKey, positiveSumOpportunitiesQueryKey } from '@/lib/queryKeys';
import type {
  MyPositiveSum,
  NewGoal,
  NewOption,
  Opportunity,
  PositiveSumItem,
} from '@/types/positiveSum';

// Whether any offer is still reading one of the viewer's observations.
export function awaitsReading(data?: MyPositiveSum): boolean {
  return (data?.offers ?? []).some(offer => offer.rewards.some(reward => !!reward.my_reading?.waiting));
}

/**
 * My desired states (with suggested options) and what's ready for me,
 * in one org.
 * GET /api/positive-sum/mine?org_id=
 */
export function useMyPositiveSum(orgId: string | undefined) {
  return useQuery<MyPositiveSum>({
    queryKey: positiveSumMineQueryKey(orgId),
    queryFn: async () => getApiData(await apiService.get(`/positive-sum/mine?org_id=${orgId}`)),
    enabled: !!orgId,
    // Other people change this list, so fetch it on every visit instead of
    // trusting the saved copy for a day (the app's default); the saved copy
    // still shows first.
    staleTime: 0,
    // While one of the person's observations is being read, look again every few seconds.
    refetchInterval: query => (awaitsReading(query.state.data) ? 5000 : false),
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

export const useCreateOption = () =>
  usePositiveSumMutation((option: NewOption) => apiService.post('/positive-sum/options', option));

export const useJoinOption = () =>
  usePositiveSumMutation((optionId: string) => apiService.post(`/positive-sum/options/${optionId}/join`, {}));

export const useApproveOption = () =>
  usePositiveSumMutation(({ optionId, goalId }: { optionId: string; goalId?: string }) =>
    apiService.post(`/positive-sum/options/${optionId}/approve`, goalId ? { goal_id: goalId } : {}));

// A challenge someone is running into, in their words (same route as a desired state).
export const useCreateChallenge = () =>
  usePositiveSumMutation(({ organizationId, challenge }: { organizationId: string; challenge: string }) =>
    apiService.post('/positive-sum/goals', { organization_id: organizationId, challenge }));

// The owner rewords their challenge, or assigns it to someone else in the org.
// The same call rewords a proposed collaboration for its author.
export const useEditChallenge = () =>
  usePositiveSumMutation(({ organizationId, id, text, assignedTo }: {
    organizationId: string; id: string; text: string; assignedTo?: string;
  }) => apiService.post('/positive-sum/goals', { organization_id: organizationId, edit: { id, text, assigned_to: assignedTo } }));

// Vote for a challenge: "this matters to me too". Same route as joining; the
// server tells a challenge from a desired state or an option.
export const useVoteForChallenge = () =>
  usePositiveSumMutation((challengeId: string) => apiService.post(`/positive-sum/options/${challengeId}/join`, {}));

// Rewards on a proposed collaboration: its author attaches one (paid by the
// organization they are working as), a person accepts its terms, its owner
// closes it. What people have earned comes back from the server.
export const useAddReward = () =>
  usePositiveSumMutation(({ organizationId, actionId, php, capPerPerson, ask, budget, image }: {
    organizationId: string; actionId: string; php: number; capPerPerson: number | null;
    ask?: string; budget?: number | null; image?: string | null;
  }) => apiService.post('/positive-sum/goals', {
    organization_id: organizationId, reward: { action_id: actionId, php, cap_php_per_person: capPerPerson, ask, budget_php: budget, image },
  }));

// A person changes what they wrote in an observation they shared for an offer:
// its description, or what they wrote on its photos (all of them are sent, in
// order, since the ones left out would be removed). Saving it sends it to be
// read again; the page then shows it as being read.
export function useEditSharedObservation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, text, photos }: { id: string; text?: string; photos?: { url: string; description: string }[] }) =>
      stateService.updateState(id, {
        ...(text !== undefined ? { state_text: text } : {}),
        ...(photos ? { photos: photos.map((p, i) => ({ photo_url: p.url, photo_description: p.description, photo_order: i })) } : {}),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: positiveSumMineQueryKey() }),
  });
}

export const useEditReward = () =>
  usePositiveSumMutation(({ organizationId, rewardId, php, capPerPerson, ask, budget, image }: {
    organizationId: string; rewardId: string; php: number; capPerPerson: number | null; ask: string; budget?: number | null;
    image?: string | null;
  }) => apiService.post('/positive-sum/goals', {
    organization_id: organizationId,
    reward_edit: { reward_id: rewardId, php, cap_php_per_person: capPerPerson, budget_php: budget, ask, image },
  }));

export const useAcceptReward = () =>
  usePositiveSumMutation(({ organizationId, rewardId }: { organizationId: string; rewardId: string }) =>
    apiService.post('/positive-sum/goals', { organization_id: organizationId, reward_accept: { reward_id: rewardId } }));

export const useCloseReward = () =>
  usePositiveSumMutation(({ organizationId, rewardId }: { organizationId: string; rewardId: string }) =>
    apiService.post('/positive-sum/goals', { organization_id: organizationId, reward_close: { reward_id: rewardId } }));

// Say which challenge an existing desired state addresses, or take that back.
export const useLinkChallenge = () =>
  usePositiveSumMutation(({ organizationId, goalId, challengeId, remove }: {
    organizationId: string; goalId: string; challengeId: string; remove?: boolean;
  }) => apiService.post('/positive-sum/goals', {
    organization_id: organizationId, link: { goal_id: goalId, challenge_id: challengeId, remove },
  }));

// Take part in a desired state, with a comment about your ideas and how you
// want to be involved. Same route as joining an option; the server tells a
// desired state from an option. Who is taking part comes back from the server.
export const useTakePart = () =>
  usePositiveSumMutation(({ goalId, comment }: { goalId: string; comment: string }) =>
    apiService.post(`/positive-sum/options/${goalId}/join`, { comment }));

/**
 * Deletes one of my proposed collaborations or challenges. The server checks
 * that it is mine and still open. Optimistic: it leaves the list at once and
 * comes back if the delete fails.
 */
export function useDeleteGoal(orgId: string | undefined) {
  const queryClient = useQueryClient();
  const mineKey = positiveSumMineQueryKey(orgId);
  return useMutation({
    mutationFn: (goalId: string) =>
      apiService.post('/positive-sum/goals', { organization_id: orgId, delete: { id: goalId } }),
    onMutate: async (goalId: string) => {
      await queryClient.cancelQueries({ queryKey: mineKey });
      const previous = queryClient.getQueryData<MyPositiveSum>(mineKey);
      queryClient.setQueryData<MyPositiveSum>(mineKey, old => old && {
        ...old,
        goals: old.goals.filter(g => g.id !== goalId),
        challenges: old.challenges?.filter(c => c.id !== goalId),
      });
      return { previous };
    },
    onError: (_error, _goalId, context) => {
      queryClient.setQueryData(mineKey, context?.previous);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: positiveSumMineQueryKey() });
      queryClient.invalidateQueries({ queryKey: positiveSumOpportunitiesQueryKey() });
    },
    ...offlineMutationConfig,
  });
}

// Passing works for goals and options alike (learning only).
export const usePass = () =>
  usePositiveSumMutation((itemId: string) => apiService.post(`/positive-sum/options/${itemId}/pass`, {}));
