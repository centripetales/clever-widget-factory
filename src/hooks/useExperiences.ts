import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createExperience,
  updateExperience,
  listExperiences,
  getExperience,
  generateExperienceSuggestions,
  listExperienceSuggestions,
  useExperienceSuggestion as useExperienceSuggestionApi,
  dismissExperienceSuggestion,
} from '@/lib/apiService';
import {
  experiencesQueryKey,
  experienceQueryKey,
  experienceSuggestionsQueryKey,
  actionsQueryKey,
  allActionsQueryKey,
  completedActionsQueryKey,
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

/**
 * Query hook to list AI-proposed action hypotheses awaiting a person's
 * decision (use/dismiss) for a container.
 */
export function useExperienceSuggestions(entityType: 'tool' | 'part', entityId: string) {
  return useQuery({
    queryKey: experienceSuggestionsQueryKey(entityType, entityId),
    queryFn: () => listExperienceSuggestions(entityType, entityId),
    enabled: !!(entityType && entityId),
  });
}

/**
 * Mutation hook to generate fresh suggestions (AI extraction) over a
 * container's observation history. Invalidates the suggestions list on success.
 */
export function useGenerateExperienceSuggestions(entityType: 'tool' | 'part', entityId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => generateExperienceSuggestions(entityType, entityId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: experienceSuggestionsQueryKey(entityType, entityId) });
    },
  });
}

/**
 * Mutation hook to confirm ("use") one AI-proposed hypothesis into a real
 * action. Invalidates the suggestions list and the actions caches, since
 * the new action is created outside the generic /actions cache-update path.
 */
export function useConfirmExperienceSuggestion(entityType: 'tool' | 'part', entityId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: useExperienceSuggestionApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: experienceSuggestionsQueryKey(entityType, entityId) });
      queryClient.invalidateQueries({ queryKey: actionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: allActionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: completedActionsQueryKey() });
    },
  });
}

/**
 * Mutation hook to dismiss one AI-proposed hypothesis.
 */
export function useDismissExperienceSuggestion(entityType: 'tool' | 'part', entityId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ perspective_id, hypothesis_index }: { perspective_id: string; hypothesis_index: number }) =>
      dismissExperienceSuggestion(perspective_id, hypothesis_index),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: experienceSuggestionsQueryKey(entityType, entityId) });
    },
  });
}
