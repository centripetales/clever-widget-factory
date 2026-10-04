import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService, errorMessage } from '@/lib/apiService';
import {
  positiveSumMineQueryKey,
  positiveSumOpportunitiesQueryKey,
  profileSkillsQueryKey,
} from '@/lib/queryKeys';
import type { ConversationDesiredState } from '@/lib/positiveSumConversation';

export interface ReviewedConversation {
  organizationId: string; // the Positive Sum page's org
  desiredStates: ConversationDesiredState[];
  humanCapital: string[];
}

export interface SaveConversationOutcome {
  saved: number;
  failed: { label: string; message: string }[];
}

/**
 * Saves what the person reviewed from their conversation:
 * - desired states → Positive Sum goals in the page's org
 * - human capital → profile skills in the page's org, marked 'claimed'
 * Every item is attempted; failures are reported rather than stopping the rest.
 */
export function useSaveConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (review: ReviewedConversation): Promise<SaveConversationOutcome> => {
      const outcome: SaveConversationOutcome = { saved: 0, failed: [] };
      const attempt = async (label: string, save: () => Promise<unknown>) => {
        try {
          await save();
          outcome.saved += 1;
        } catch (error) {
          outcome.failed.push({ label, message: errorMessage(error) });
        }
      };

      for (const d of review.desiredStates) {
        await attempt(d.would_like, () => apiService.post('/positive-sum/goals', {
          organization_id: review.organizationId,
          initial_state: d.now,
          desired_state: d.would_like,
        }));
      }
      for (const narrative of review.humanCapital) {
        await attempt(narrative, () => apiService.post(
          '/profile-skills/approve',
          { narrative, ai_interpretation: null, axes: [], source: 'claimed' },
          { organizationId: review.organizationId },
        ));
      }
      return outcome;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: positiveSumMineQueryKey() });
      queryClient.invalidateQueries({ queryKey: positiveSumOpportunitiesQueryKey() });
      queryClient.invalidateQueries({ queryKey: profileSkillsQueryKey() });
    },
  });
}
