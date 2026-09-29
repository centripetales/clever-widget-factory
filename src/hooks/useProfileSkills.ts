import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService, getApiData } from '@/lib/apiService';
import { profileSkillsQueryKey } from '@/lib/queryKeys';

// Types matching the design document's ProfileSkillState schema

export interface ProgressionEvent {
  demonstrated_level: number;
  action_id: string;
  state_id: string;
  timestamp: string;
}

export interface ProfileAxis {
  key: string;
  label: string;
  description: string;
  bloom_level: number;
  progression_history: ProgressionEvent[];
}

export interface AIInterpretation {
  concept_label: string;
  source_attribution: string;
  learning_direction: string;
}

export interface ProfileSkill {
  id: string;
  original_narrative: string;
  ai_interpretation: AIInterpretation | null;
  axes: ProfileAxis[];
  active: boolean;
  // 'claimed' = self-described (e.g. from a Positive Sum conversation).
  source?: 'claimed';
  created_at: string;
}

export interface GenerateProfileSkillResponse {
  ai_interpretation: AIInterpretation;
  axes: Omit<ProfileAxis, 'bloom_level' | 'progression_history'>[];
}

export interface ApproveProfileSkillRequest {
  narrative: string;
  ai_interpretation: AIInterpretation | null;
  axes: Omit<ProfileAxis, 'bloom_level' | 'progression_history'>[];
}

/**
 * Query hook to fetch all profile skills for a user.
 * GET /profile-skills
 * Requirements: 1.1, 4.1, 4.4
 */
export function useProfileSkills(userId: string) {
  return useQuery({
    queryKey: profileSkillsQueryKey(userId),
    queryFn: () => apiService.get<{ data: ProfileSkill[] }>('/profile-skills').then(getApiData),
    enabled: !!userId,
  });
}

/**
 * Mutation hook to generate a profile skill preview (not stored).
 * POST /profile-skills/generate
 * Requirements: 1.3, 1.4, 1.5
 */
export function useGenerateProfileSkill() {
  return useMutation({
    mutationFn: (data: { narrative: string }) =>
      apiService.post<{ data: GenerateProfileSkillResponse }>('/profile-skills/generate', data).then(getApiData),
  });
}

/**
 * Mutation hook to approve and store a profile skill.
 * POST /profile-skills/approve
 * Invalidates profile skills query on success to refetch the list.
 * Requirements: 1.2, 1.6, 5.2
 */
export function useApproveProfileSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ApproveProfileSkillRequest) =>
      apiService.post<{ data: ProfileSkill }>('/profile-skills/approve', data).then(getApiData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: profileSkillsQueryKey() });
    },
  });
}

/**
 * Mutation hook to toggle a profile skill's active status.
 * PUT /profile-skills/:id/toggle
 * Uses optimistic update to toggle the `active` flag in cache immediately.
 * Requirements: 5.1, 5.3, 5.4
 */
export function useToggleProfileSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiService.put<{ data: ProfileSkill }>(`/profile-skills/${id}/toggle`).then(getApiData),
    onMutate: async (id) => {
      // Cancel any outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: profileSkillsQueryKey() });

      // Snapshot the previous value for rollback
      const queryCache = queryClient.getQueriesData<ProfileSkill[]>({
        queryKey: profileSkillsQueryKey(),
      });

      // Optimistically toggle the active status in all matching caches
      queryClient.setQueriesData<ProfileSkill[]>(
        { queryKey: profileSkillsQueryKey() },
        (old) => {
          if (!old) return old;
          return old.map((skill) =>
            skill.id === id ? { ...skill, active: !skill.active } : skill
          );
        }
      );

      return { queryCache };
    },
    onError: (_error, _id, context) => {
      // Rollback to the previous cache state on error
      if (context?.queryCache) {
        for (const [queryKey, data] of context.queryCache) {
          queryClient.setQueryData(queryKey, data);
        }
      }
    },
  });
}

/**
 * Mutation hook to delete a profile skill.
 * DELETE /profile-skills/:id
 * Uses optimistic update to remove the skill from cache immediately.
 * Requirements: 6.2
 */
export function useDeleteProfileSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiService.delete(`/profile-skills/${id}`),
    onMutate: async (id) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: profileSkillsQueryKey() });

      // Snapshot the previous value for rollback
      const queryCache = queryClient.getQueriesData<ProfileSkill[]>({
        queryKey: profileSkillsQueryKey(),
      });

      // Optimistically remove the skill from all matching caches
      queryClient.setQueriesData<ProfileSkill[]>(
        { queryKey: profileSkillsQueryKey() },
        (old) => {
          if (!old) return old;
          return old.filter((skill) => skill.id !== id);
        }
      );

      return { queryCache };
    },
    onError: (_error, _id, context) => {
      // Rollback to the previous cache state on error
      if (context?.queryCache) {
        for (const [queryKey, data] of context.queryCache) {
          queryClient.setQueryData(queryKey, data);
        }
      }
    },
  });
}
