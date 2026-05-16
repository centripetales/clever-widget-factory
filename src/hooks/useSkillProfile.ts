import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService } from '@/lib/apiService';
import { BaseAction } from '@/types/actions';
import { actionsQueryKey } from '@/lib/queryKeys';

// Skill profile types matching the design document schema
export interface SkillAxis {
  key: string;
  label: string;
  description: string;
  required_level: number;
}

export interface SkillProfile {
  narrative: string;
  axes: SkillAxis[];
  generated_at: string;
  approved_at?: string;
  approved_by?: string;
  growth_intent?: string | null;
  growth_intent_provided?: boolean;
}

export interface GenerateSkillProfileRequest {
  action_id: string;
  action_context: {
    title?: string;
    description?: string;
    expected_state?: string;
    policy?: string;
    asset_name?: string;
    required_tools?: string[];
  };
  growth_intent?: string;
}

export interface ApproveSkillProfileRequest {
  action_id: string;
  skill_profile: SkillProfile;
  approved_by: string;
  growth_intent?: string;
}

/**
 * Mutation hook to generate a skill profile preview.
 * POST /api/skill-profiles/generate
 * Returns a preview profile (not stored) for user review.
 * Requirements: 2.1
 */
export function useGenerateSkillProfile() {
  return useMutation({
    mutationFn: async (data: GenerateSkillProfileRequest) => {
      const result = await apiService.post<{ data: SkillProfile }>(
        '/skill-profiles/generate',
        data
      );
      return result.data;
    },
    onError: (error) => {
      console.error('Failed to generate skill profile:', (error as any)?.message || String(error));
    },
  });
}

/**
 * Mutation hook to approve and store a skill profile.
 * POST /api/skill-profiles/approve
 * Optimistically updates the action's skill_profile in the actions cache.
 * Requirements: 2.5, 2.6
 */
export function useApproveSkillProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: ApproveSkillProfileRequest) => {
      const result = await apiService.post<{ data: SkillProfile }>(
        '/skill-profiles/approve',
        data
      );
      return result.data;
    },
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: actionsQueryKey() });

      const previousActions = queryClient.getQueryData<BaseAction[]>(actionsQueryKey());

      // Optimistically set the skill_profile on the action (include approved_at so CapabilityAssessment renders)
      queryClient.setQueryData<BaseAction[]>(actionsQueryKey(), (old) => {
        if (!old) return old;
        return old.map((action) =>
          action.id === variables.action_id
            ? {
                ...action,
                skill_profile: {
                  ...variables.skill_profile,
                  approved_at: new Date().toISOString(),
                  approved_by: variables.approved_by,
                } as any,
              }
            : action
        );
      });

      return { previousActions };
    },
    onSuccess: (data, variables) => {
      // Update cache with the server response (has the real approved_at from the Lambda)
      if (data) {
        queryClient.setQueryData<BaseAction[]>(actionsQueryKey(), (old) => {
          if (!old) return old;
          return old.map((action) =>
            action.id === variables.action_id
              ? { ...action, skill_profile: data as any }
              : action
          );
        });
      }
    },
    onError: (error, _variables, context) => {
      console.error('Failed to approve skill profile:', error);
      if (context?.previousActions) {
        queryClient.setQueryData(actionsQueryKey(), context.previousActions);
      }
    },
  });
}

/**
 * Mutation hook to delete a skill profile from an action.
 * DELETE /api/skill-profiles/:actionId
 * Optimistically removes the skill_profile from the actions cache.
 * Requirements: 2.4
 */
export function useDeleteSkillProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (actionId: string) => {
      const result = await apiService.delete(`/skill-profiles/${actionId}`);
      return result;
    },
    onMutate: async (actionId) => {
      await queryClient.cancelQueries({ queryKey: actionsQueryKey() });

      const previousActions = queryClient.getQueryData<BaseAction[]>(actionsQueryKey());

      // Optimistically remove the skill_profile from the action
      queryClient.setQueryData<BaseAction[]>(actionsQueryKey(), (old) => {
        if (!old) return old;
        return old.map((action) =>
          action.id === actionId
            ? { ...action, skill_profile: undefined }
            : action
        );
      });

      return { previousActions };
    },
    onError: (error, _actionId, context) => {
      console.error('Failed to delete skill profile:', error);
      if (context?.previousActions) {
        queryClient.setQueryData(actionsQueryKey(), context.previousActions);
      }
    },
  });
}
