import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService, errorMessage } from '@/lib/apiService';
import {
  partsQueryKey,
  positiveSumMineQueryKey,
  positiveSumOpportunitiesQueryKey,
  profileSkillsQueryKey,
  toolsQueryKey,
} from '@/lib/queryKeys';
import type { ConversationDesiredState } from '@/lib/positiveSumConversation';

export interface ReviewedAsset {
  name: string;
  narrative: string;
  kind: 'tool' | 'stock';
  organizationId: string;
}

export interface ReviewedConversation {
  organizationId: string; // the Positive Sum page's org
  desiredStates: ConversationDesiredState[];
  humanCapital: string[];
  assets: ReviewedAsset[];
}

export interface SaveConversationOutcome {
  saved: number;
  failed: { label: string; message: string }[];
}

/**
 * Saves what the person reviewed from their conversation:
 * - desired states → Positive Sum goals in the page's org
 * - human capital → profile skills in the page's org, marked 'claimed'
 * - assets → tools or stock in the org the person chose (their own)
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
      for (const asset of review.assets) {
        await attempt(asset.name, () => apiService.post(
          asset.kind === 'tool' ? '/tools' : '/parts',
          { name: asset.name, description: asset.narrative },
          { organizationId: asset.organizationId },
        ));
      }
      return outcome;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: positiveSumMineQueryKey() });
      queryClient.invalidateQueries({ queryKey: positiveSumOpportunitiesQueryKey() });
      queryClient.invalidateQueries({ queryKey: profileSkillsQueryKey() });
      queryClient.invalidateQueries({ queryKey: toolsQueryKey() });
      queryClient.invalidateQueries({ queryKey: partsQueryKey() });
    },
  });
}
