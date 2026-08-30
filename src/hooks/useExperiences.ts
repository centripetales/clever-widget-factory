import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createExperience,
  updateExperience,
  listExperiences,
  getExperience,
} from '@/lib/apiService';
import {
  experiencesQueryKey,
  experienceQueryKey,
} from '@/lib/queryKeys';
import type {
  CreateExperienceRequest,
  ExperienceListParams
} from '@/types/experiences';

/**
 * Query hook to list experiences with optional filters
 * @param params - Optional filters (entity_type, entity_id, limit, offset)
 */
export function useExperiences(params?: ExperienceListParams) {
  return useQuery({
    queryKey: experiencesQueryKey(params),
    queryFn: () => listExperiences(params),
    enabled: !!(params?.entity_type && params?.entity_id),
    // The global default (staleTime: 24h, refetchOnMount: false — see
    // queryConfig.ts) is tuned for offline-first field use, but it means a
    // persisted, hours-stale cache from a previous session silently wins on
    // reload with no visible signal that it's stale. This is exactly the
    // view where "did my save actually take?" confusion shows up (open vs.
    // completed depends on this being current), so always refetch here —
    // same override SariSariChat.tsx already uses for its own list.
    staleTime: 30 * 1000,
    refetchOnMount: true,
  });
}

/**
 * Query hook to get a single experience by ID
 * @param experienceId - The experience ID to fetch
 */
export function useExperience(experienceId: string) {
  return useQuery({
    queryKey: experienceQueryKey(experienceId),
    queryFn: () => getExperience(experienceId),
    enabled: !!experienceId,
    // Same reasoning as useExperiences above.
    staleTime: 30 * 1000,
    refetchOnMount: true,
  });
}

/**
 * Mutation hook to create a new experience
 * Automatically invalidates relevant queries on success
 */
export function useCreateExperience() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateExperienceRequest) => createExperience(data),
    onSuccess: (_, variables) => {
      // Invalidate the general experiences list
      queryClient.invalidateQueries({ queryKey: experiencesQueryKey() });
      
      // Invalidate the entity-specific experiences list
      queryClient.invalidateQueries({
        queryKey: experiencesQueryKey({
          entity_type: variables.entity_type,
          entity_id: variables.entity_id
        })
      });
    },
  });
}

/**
 * Mutation hook to edit an existing experience (repoint initial_state,
 * replace attached actions). Invalidates both the list and single-experience
 * caches for the given entity on success.
 */
export function useUpdateExperience(entityType: 'tool' | 'part', entityId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ experienceId, updates }: { experienceId: string; updates: Parameters<typeof updateExperience>[1] }) =>
      updateExperience(experienceId, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: experiencesQueryKey({ entity_type: entityType, entity_id: entityId }) });
    },
  });
}
