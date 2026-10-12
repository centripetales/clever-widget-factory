import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService, errorMessage } from '@/lib/apiService';
import {
  positiveSumMineQueryKey,
  positiveSumOpportunitiesQueryKey,
  profileSkillsQueryKey,
} from '@/lib/queryKeys';

export interface ReviewedConversation {
  organizationId: string; // the Positive Sum page's org
  typicalDay: string;
  humanCapital: string[];
  situations: string[]; // where they think we could improve
}

export interface SaveConversationOutcome {
  saved: number;
  failed: { label: string; message: string }[];
}

/**
 * Saves what the person reviewed from their conversation:
 * - a typical day and what people come to them for → profile skills in the
 *   page's org, marked 'claimed'
 * - where they think we could improve → new entries in the page's org
 * Every item is attempted; failures are reported rather than stopping the rest.
 * Saving also records that the person has given their input, which is what
 * lets them see other people's entries.
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

      const claim = (narrative: string) => apiService.post(
        '/profile-skills/approve',
        { narrative, ai_interpretation: null, axes: [], source: 'claimed' },
        { organizationId: review.organizationId },
      );
      if (review.typicalDay.trim()) {
        await attempt('A typical day', () => claim(`A typical day: ${review.typicalDay.trim()}`));
      }
      for (const narrative of review.humanCapital) {
        await attempt(narrative, () => claim(narrative));
      }
      for (const situation of review.situations) {
        await attempt(situation, () => apiService.post('/positive-sum/goals', {
          organization_id: review.organizationId,
          challenge: situation,
        }));
      }
      await attempt('Your input', () => apiService.post('/positive-sum/goals', {
        organization_id: review.organizationId,
        conversation_saved: true,
      }));
      return outcome;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: positiveSumMineQueryKey() });
      queryClient.invalidateQueries({ queryKey: positiveSumOpportunitiesQueryKey() });
      queryClient.invalidateQueries({ queryKey: profileSkillsQueryKey() });
    },
  });
}
