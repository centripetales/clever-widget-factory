import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { stateService } from '../services/stateService';
import { statesQueryKey, stateQueryKey, actionsQueryKey, completedActionsQueryKey } from '../lib/queryKeys';
import type { CreateObservationData, Observation } from '../types/observations';

export function useStates(filters?: { entity_type?: string; entity_id?: string }) {
  return useQuery({
    queryKey: statesQueryKey(filters),
    queryFn: () => stateService.getStates(filters),
    enabled: !!(filters?.entity_type && filters?.entity_id),
  });
}

export function useStateById(id: string) {
  return useQuery({
    queryKey: stateQueryKey(id),
    queryFn: () => stateService.getState(id),
    enabled: !!id,
  });
}

export function useStateMutations(filters?: { entity_type?: string; entity_id?: string }) {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: CreateObservationData) => stateService.createState(data),

    // Optimistic update: add provisional observation to filtered cache immediately
    onMutate: async (variables) => {
      if (!filters) return undefined;

      // Cancel any outgoing refetches for the filtered key to prevent race conditions
      await queryClient.cancelQueries({ queryKey: statesQueryKey(filters) });

      // Snapshot previous filtered list for rollback on error
      const previousFilteredStates = queryClient.getQueryData<Observation[]>(statesQueryKey(filters));

      // Prepend a provisional observation to the filtered cache
      const provisionalObservation: Observation = {
        id: 'optimistic-' + Date.now(),
        organization_id: '',
        observation_text: variables.state_text ?? '',
        captured_by: '',
        captured_by_name: '',
        captured_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        photos: (variables.photos ?? []) as Observation['photos'],
        links: (variables.links ?? []) as Observation['links'],
      };

      queryClient.setQueryData<Observation[]>(statesQueryKey(filters), (old) => {
        return [provisionalObservation, ...(old ?? [])];
      });

      return { previousFilteredStates };
    },

    onSuccess: (_newState, _variables, _context) => {
      // Invalidate the filtered states list to replace the optimistic entry with the real server id
      if (filters) {
        queryClient.invalidateQueries({ queryKey: statesQueryKey(filters) });
      }
      // NOTE: intentionally NOT invalidating statesQueryKey() (broad key) to avoid cascade refetches.
      // If this state is linked to an action, invalidate actions cache to keep counts consistent.
      if (filters?.entity_type === 'action') {
        queryClient.invalidateQueries({ queryKey: actionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: completedActionsQueryKey() });
      }
    },

    onError: (_error, _variables, context) => {
      // Rollback the optimistic update on error
      if (context?.previousFilteredStates !== undefined && filters) {
        queryClient.setQueryData(statesQueryKey(filters), context.previousFilteredStates);
      }
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<CreateObservationData> }) =>
      stateService.updateState(id, data),
    
    // Optimistic update for immediate UI feedback (offline-first)
    onMutate: async (variables) => {
      // Cancel any outgoing refetches to prevent race conditions
      await queryClient.cancelQueries({ queryKey: statesQueryKey() });
      await queryClient.cancelQueries({ queryKey: stateQueryKey(variables.id) });
      if (filters) {
        await queryClient.cancelQueries({ queryKey: statesQueryKey(filters) });
      }
      
      // Snapshot previous state for rollback
      const previousStates = queryClient.getQueryData<Observation[]>(statesQueryKey());
      const previousFilteredStates = filters 
        ? queryClient.getQueryData<Observation[]>(statesQueryKey(filters))
        : undefined;
      const previousState = queryClient.getQueryData<Observation>(stateQueryKey(variables.id));
      
      // Optimistically update the specific state cache
      // Also clear perspectives to signal they are being regenerated
      const pendingSentinel = [{ perspective_type: 'PENDING', content: '', status: 'PENDING' }];
      queryClient.setQueryData<Observation>(stateQueryKey(variables.id), (old) => {
        if (!old) return old;
        return { ...old, ...variables.data, perspectives: pendingSentinel };
      });
      
      // Optimistically update the states list cache
      queryClient.setQueryData<Observation[]>(statesQueryKey(), (old) => {
        if (!old) return old;
        return old.map(state => 
          state.id === variables.id 
            ? { ...state, ...variables.data, perspectives: pendingSentinel }
            : state
        );
      });
      
      // Optimistically update the filtered states list cache if applicable
      if (filters) {
        queryClient.setQueryData<Observation[]>(statesQueryKey(filters), (old) => {
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
      queryClient.setQueryData<Observation>(stateQueryKey(variables.id), updatedState);
      
      // Update the states list with server response
      queryClient.setQueryData<Observation[]>(statesQueryKey(), (old) => {
        if (!old) return old;
        return old.map(state => 
          state.id === updatedState.id 
            ? updatedState
            : state
        );
      });
      
      // Update the filtered states list with server response
      if (filters) {
        queryClient.setQueryData<Observation[]>(statesQueryKey(filters), (old) => {
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
        queryClient.setQueryData(statesQueryKey(), context.previousStates);
      }
      if (context?.previousFilteredStates && filters) {
        queryClient.setQueryData(statesQueryKey(filters), context.previousFilteredStates);
      }
      if (context?.previousState) {
        queryClient.setQueryData(stateQueryKey(_variables.id), context.previousState);
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => stateService.deleteState(id),
    onSuccess: () => {
      // Invalidate the filtered states list
      if (filters) {
        queryClient.invalidateQueries({ queryKey: statesQueryKey(filters) });
      }
      // Invalidate all states
      queryClient.invalidateQueries({ queryKey: statesQueryKey() });
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
