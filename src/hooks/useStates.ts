import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { stateService } from '../services/stateService';
import { statesQueryKey, stateQueryKey, actionsQueryKey, completedActionsQueryKey } from '../lib/queryKeys';
import type { CreateObservationData, Observation } from '../types/observations';

export function useStates(orgId: string, filters?: { entity_type?: string; entity_id?: string }) {
  return useQuery({
    queryKey: statesQueryKey(orgId, filters),
    queryFn: () => stateService.getStates(filters),
    enabled: !!orgId && (!filters || (!filters.entity_type && !filters.entity_id) || !!(filters.entity_type && filters.entity_id)),
  });
}

export function useStateById(orgId: string, id: string) {
  return useQuery({
    queryKey: stateQueryKey(orgId, id),
    queryFn: () => stateService.getState(id),
    enabled: !!orgId && !!id,
  });
}

export function useStateMutations(orgId: string, filters?: { entity_type?: string; entity_id?: string }) {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: CreateObservationData) => stateService.createState(data),

    // Optimistic update: prepend a provisional observation to both the broad list
    // and the filtered list (if filters are present) immediately, before the API responds.
    onMutate: async (variables) => {
      const optimisticId = 'optimistic-' + Date.now();

      const provisionalObservation: Observation = {
        id: optimisticId,
        organization_id: '',
        observation_text: variables.state_text ?? '',
        captured_by: '',
        captured_by_name: '',
        captured_at: variables.captured_at ?? new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        photos: (variables.photos ?? []) as Observation['photos'],
        links: (variables.links ?? []) as Observation['links'],
      };

      // Cancel outgoing refetches to prevent race conditions
      await queryClient.cancelQueries({ queryKey: statesQueryKey(orgId) });
      if (filters) {
        await queryClient.cancelQueries({ queryKey: statesQueryKey(orgId, filters) });
      }

      // Snapshot for rollback
      const previousStates = queryClient.getQueryData<Observation[]>(statesQueryKey(orgId));
      const previousFilteredStates = filters
        ? queryClient.getQueryData<Observation[]>(statesQueryKey(orgId, filters))
        : undefined;

      // Prepend to broad list — this is what ObservationsList reads
      queryClient.setQueryData<Observation[]>(statesQueryKey(orgId), (old) =>
        [provisionalObservation, ...(old ?? [])]
      );

      // Prepend to filtered list if applicable (e.g. tool/action observation panel)
      if (filters) {
        queryClient.setQueryData<Observation[]>(statesQueryKey(orgId, filters), (old) =>
          [provisionalObservation, ...(old ?? [])]
        );
      }

      return { optimisticId, previousStates, previousFilteredStates };
    },

    onSuccess: (newState, _variables, context) => {
      // Replace the optimistic entry with the real server record (has the real id)
      queryClient.setQueryData<Observation[]>(statesQueryKey(orgId), (old) =>
        old?.map((s) => s.id === context?.optimisticId ? newState : s) ?? [newState]
      );

      if (filters) {
        queryClient.setQueryData<Observation[]>(statesQueryKey(orgId, filters), (old) =>
          old?.map((s) => s.id === context?.optimisticId ? newState : s) ?? [newState]
        );
      }

      // Also store the individual record so edit navigation works immediately
      queryClient.setQueryData(stateQueryKey(orgId, newState.id), newState);

      // If linked to an action, keep action counts consistent
      if (filters?.entity_type === 'action') {
        queryClient.invalidateQueries({ queryKey: actionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: completedActionsQueryKey() });
      }
    },

    onError: (_error, _variables, context) => {
      // Rollback both caches on error
      if (context?.previousStates !== undefined) {
        queryClient.setQueryData(statesQueryKey(orgId), context.previousStates);
      }
      if (context?.previousFilteredStates !== undefined && filters) {
        queryClient.setQueryData(statesQueryKey(orgId, filters), context.previousFilteredStates);
      }
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<CreateObservationData> }) =>
      stateService.updateState(id, data),
    
    // Optimistic update for immediate UI feedback (offline-first)
    onMutate: async (variables) => {
      // Cancel any outgoing refetches to prevent race conditions
      await queryClient.cancelQueries({ queryKey: statesQueryKey(orgId) });
      await queryClient.cancelQueries({ queryKey: stateQueryKey(orgId, variables.id) });
      if (filters) {
        await queryClient.cancelQueries({ queryKey: statesQueryKey(orgId, filters) });
      }
      
      // Snapshot previous state for rollback
      const previousStates = queryClient.getQueryData<Observation[]>(statesQueryKey(orgId));
      const previousFilteredStates = filters 
        ? queryClient.getQueryData<Observation[]>(statesQueryKey(orgId, filters))
        : undefined;
      const previousState = queryClient.getQueryData<Observation>(stateQueryKey(orgId, variables.id));
      
      // Optimistically update the specific state cache
      // Also clear perspectives to signal they are being regenerated
      const pendingSentinel = [{ perspective_type: 'PENDING', content: '', status: 'PENDING' }];
      queryClient.setQueryData<Observation>(stateQueryKey(orgId, variables.id), (old) => {
        if (!old) return old;
        return { ...old, ...variables.data, perspectives: pendingSentinel };
      });
      
      // Optimistically update the states list cache
      queryClient.setQueryData<Observation[]>(statesQueryKey(orgId), (old) => {
        if (!old) return old;
        return old.map(state => 
          state.id === variables.id 
            ? { ...state, ...variables.data, perspectives: pendingSentinel }
            : state
        );
      });
      
      // Optimistically update the filtered states list cache if applicable
      if (filters) {
        queryClient.setQueryData<Observation[]>(statesQueryKey(orgId, filters), (old) => {
          if (!old) return old;
          return old.map(state => 
            state.id === variables.id 
              ? { ...state, ...variables.data, perspectives: pendingSentinel }
              : state
          );
        });
      }
      
      return { previousStates, previousFilteredStates, previousState };
    },
    
    onSuccess: (updatedState, variables) => {
      // Replace optimistic data with server response
      queryClient.setQueryData<Observation>(stateQueryKey(orgId, variables.id), updatedState);
      
      // Update the states list with server response
      queryClient.setQueryData<Observation[]>(statesQueryKey(orgId), (old) => {
        if (!old) return old;
        return old.map(state => 
          state.id === updatedState.id 
            ? updatedState
            : state
        );
      });
      
      // Update the filtered states list with server response
      if (filters) {
        queryClient.setQueryData<Observation[]>(statesQueryKey(orgId, filters), (old) => {
          if (!old) return old;
          return old.map(state => 
            state.id === updatedState.id 
              ? updatedState
              : state
          );
        });
      }
      
      // Invalidate related caches for server-computed data
      // If this state is linked to an action, invalidate actions cache
      // because implementation_update_count might change (e.g., photos added/removed)
      if (filters?.entity_type === 'action') {
        queryClient.invalidateQueries({ queryKey: actionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: completedActionsQueryKey() });
      }
    },
    
    onError: (_error, _variables, context) => {
      // Rollback to previous state on error
      if (context?.previousStates) {
        queryClient.setQueryData(statesQueryKey(orgId), context.previousStates);
      }
      if (context?.previousFilteredStates && filters) {
        queryClient.setQueryData(statesQueryKey(orgId, filters), context.previousFilteredStates);
      }
      if (context?.previousState) {
        queryClient.setQueryData(stateQueryKey(orgId, _variables.id), context.previousState);
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => stateService.deleteState(id),
    onSuccess: () => {
      // Invalidate the filtered states list
      if (filters) {
        queryClient.invalidateQueries({ queryKey: statesQueryKey(orgId, filters) });
      }
      // Invalidate all states
      queryClient.invalidateQueries({ queryKey: statesQueryKey(orgId) });
    },
  });

  return {
    createState: createMutation.mutateAsync,
    updateState: updateMutation.mutateAsync,
    deleteState: deleteMutation.mutateAsync,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isDeleting: deleteMutation.isPending,
  };
}
