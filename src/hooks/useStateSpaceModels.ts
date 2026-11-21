import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listStateSpaceModels,
  getModelsByEntity,
  createStateSpaceModel,
  updateStateSpaceModel,
  deleteStateSpaceModel,
  createModelAssociation,
  deleteModelAssociation,
} from '@/lib/stateSpaceApi';
import type {
  CreateStateSpaceModelRequest,
  UpdateStateSpaceModelRequest,
} from '@/lib/stateSpaceApi';
import {
  stateSpaceModelsQueryKey,
  stateSpaceModelsByEntityQueryKey,
} from '@/lib/queryKeys';

/**
 * Fetches all models associated with a specific entity (e.g., action).
 */
export function useStateSpaceModelsByEntity(entityType: string, entityId: string) {
  return useQuery({
    queryKey: stateSpaceModelsByEntityQueryKey(entityType, entityId),
    queryFn: () => getModelsByEntity(entityType, entityId),
    enabled: !!(entityType && entityId),
    // Models are set and changed by Claude, outside the app, so nothing tells this cache they
    // changed. The cached models show at once; they are checked again every time a page opens.
    refetchOnMount: 'always',
  });
}

/**
 * Fetches all org models + public models from other orgs.
 */
export function useStateSpaceModels() {
  return useQuery({
    queryKey: stateSpaceModelsQueryKey(),
    queryFn: () => listStateSpaceModels(),
  });
}

/**
 * Mutation to create a new state-space model.
 * Invalidates the models list on success.
 */
export function useCreateStateSpaceModel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateStateSpaceModelRequest) => createStateSpaceModel(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: stateSpaceModelsQueryKey() });
    },
  });
}

/**
 * Mutation to update an existing state-space model.
 * Invalidates the models list on success.
 */
export function useUpdateStateSpaceModel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateStateSpaceModelRequest }) =>
      updateStateSpaceModel(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: stateSpaceModelsQueryKey() });
    },
  });
}

/**
 * Mutation to delete a state-space model.
 * Invalidates the models list on success.
 */
export function useDeleteStateSpaceModel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteStateSpaceModel(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: stateSpaceModelsQueryKey() });
      // Also invalidate all entity-specific queries so pages using by-entity don't show stale data
      queryClient.invalidateQueries({ queryKey: ['state_space_models_by_entity'] });
    },
  });
}

/**
 * Mutation to create an association between a model and an entity.
 * Invalidates both the entity-specific and general models lists.
 */
export function useCreateModelAssociation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      modelId,
      entityType,
      entityId,
    }: {
      modelId: string;
      entityType: string;
      entityId: string;
    }) => createModelAssociation(modelId, entityType, entityId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: stateSpaceModelsByEntityQueryKey(variables.entityType, variables.entityId),
      });
      queryClient.invalidateQueries({ queryKey: stateSpaceModelsQueryKey() });
    },
  });
}

/**
 * Mutation to delete an association between a model and an entity.
 * Invalidates both the entity-specific and general models lists.
 */
export function useDeleteModelAssociation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      modelId,
      associationId,
      entityType,
      entityId,
    }: {
      modelId: string;
      associationId: string;
      entityType: string;
      entityId: string;
    }) => deleteModelAssociation(modelId, associationId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: stateSpaceModelsByEntityQueryKey(variables.entityType, variables.entityId),
      });
      queryClient.invalidateQueries({ queryKey: stateSpaceModelsQueryKey() });
    },
  });
}
