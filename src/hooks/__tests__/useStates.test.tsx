import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useStateById, useStateMutations } from '../useStates';
import { stateService } from '../../services/stateService';
import type { CreateObservationData, Observation } from '../../types/observations';

// Mock the state service
vi.mock('../../services/stateService', () => ({
  stateService: {
    getState: vi.fn(),
    createState: vi.fn(),
    updateState: vi.fn(),
    deleteState: vi.fn(),
  },
}));

describe('useStateMutations', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  describe('useStateById', () => {
    it('should fetch state by ID correctly', async () => {
      const mockState: Observation = {
        id: 'state-123',
        organization_id: 'org-1',
        observation_text: 'Test observation text',
        captured_by: 'user-1',
        captured_by_name: 'Test User',
        captured_at: '2024-01-15T10:30:00Z',
        created_at: '2024-01-15T10:30:00Z',
        updated_at: '2024-01-15T10:30:00Z',
        photos: [
          {
            id: 'photo-1',
            observation_id: 'state-123',
            photo_url: 'https://example.com/photo1.jpg',
            photo_description: 'Test photo',
            photo_order: 0,
          },
        ],
        links: [
          {
            id: 'link-1',
            observation_id: 'state-123',
            entity_type: 'action',
            entity_id: 'action-1',
          },
        ],
      };

      vi.mocked(stateService.getState).mockResolvedValue(mockState);

      const { result } = renderHook(() => useStateById('org-1', 'state-123'), { wrapper });

      // Initially loading
      expect(result.current.isLoading).toBe(true);
      expect(result.current.data).toBeUndefined();

      // Wait for the query to complete
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      // Verify the service was called with correct ID
      expect(stateService.getState).toHaveBeenCalledWith('state-123');
      expect(stateService.getState).toHaveBeenCalledTimes(1);

      // Verify the returned data matches the mock
      expect(result.current.data).toEqual(mockState);
      expect(result.current.data?.id).toBe('state-123');
      expect(result.current.data?.observation_text).toBe('Test observation text');
      expect(result.current.data?.photos).toHaveLength(1);
      expect(result.current.data?.links).toHaveLength(1);
    });

    it('should not fetch when ID is empty', async () => {
      const { result } = renderHook(() => useStateById('org-1', ''), { wrapper });

      // Should not be loading because query is disabled
      expect(result.current.isLoading).toBe(false);
      expect(result.current.data).toBeUndefined();

      // Service should not be called
      expect(stateService.getState).not.toHaveBeenCalled();
    });

    it('should handle errors when fetching state', async () => {
      const mockError = new Error('Failed to fetch state');
      vi.mocked(stateService.getState).mockRejectedValue(mockError);

      const { result } = renderHook(() => useStateById('org-1', 'state-123'), { wrapper });

      await waitFor(() => {
        expect(result.current.isError).toBe(true);
      });

      expect(result.current.error).toEqual(mockError);
      expect(result.current.data).toBeUndefined();
    });
  });

  describe('updateMutation', () => {
    it('should successfully update state and return updated data', async () => {
      const originalState: Observation = {
        id: 'state-123',
        organization_id: 'org-1',
        observation_text: 'Original text',
        captured_by: 'user-1',
        captured_by_name: 'Test User',
        captured_at: '2024-01-15T10:30:00Z',
        created_at: '2024-01-15T10:30:00Z',
        updated_at: '2024-01-15T10:30:00Z',
        photos: [],
        links: [],
      };

      const updatedState: Observation = {
        ...originalState,
        observation_text: 'Updated text',
        updated_at: '2024-01-15T11:00:00Z',
      };

      vi.mocked(stateService.updateState).mockResolvedValue(updatedState);

      const { result } = renderHook(() => useStateMutations('org-1'), { wrapper });

      const updateData = { observation_text: 'Updated text' };
      await result.current.updateState({ id: 'state-123', data: updateData });

      // Verify service was called with correct parameters
      expect(stateService.updateState).toHaveBeenCalledWith('state-123', updateData);
      expect(stateService.updateState).toHaveBeenCalledTimes(1);
    });

    it('should handle error and rollback optimistic update', async () => {
      const originalState: Observation = {
        id: 'state-123',
        organization_id: 'org-1',
        observation_text: 'Original text',
        captured_by: 'user-1',
        captured_by_name: 'Test User',
        captured_at: '2024-01-15T10:30:00Z',
        created_at: '2024-01-15T10:30:00Z',
        updated_at: '2024-01-15T10:30:00Z',
        photos: [],
        links: [],
      };

      // Pre-populate cache with original state
      queryClient.setQueryData(['states', 'org-1'], [originalState]);
      queryClient.setQueryData(['state', 'org-1', 'state-123'], originalState);

      const mockError = new Error('Failed to update state');
      vi.mocked(stateService.updateState).mockRejectedValue(mockError);

      const { result } = renderHook(() => useStateMutations('org-1'), { wrapper });

      const updateData = { observation_text: 'Updated text' };
      
      // Attempt update and expect it to fail
      await expect(
        result.current.updateState({ id: 'state-123', data: updateData })
      ).rejects.toThrow('Failed to update state');

      // Wait for rollback to complete
      await waitFor(() => {
        // Verify cache was rolled back to original state
        const statesList = queryClient.getQueryData<Observation[]>(['states', 'org-1']);
        const singleState = queryClient.getQueryData<Observation>(['state', 'org-1', 'state-123']);
        
        expect(statesList).toEqual([originalState]);
        expect(singleState).toEqual(originalState);
      });
    });

    it('should perform optimistic update before server response', async () => {
      const originalState: Observation = {
        id: 'state-123',
        organization_id: 'org-1',
        observation_text: 'Original text',
        captured_by: 'user-1',
        captured_by_name: 'Test User',
        captured_at: '2024-01-15T10:30:00Z',
        created_at: '2024-01-15T10:30:00Z',
        updated_at: '2024-01-15T10:30:00Z',
        photos: [],
        links: [],
      };

      // Pre-populate cache
      queryClient.setQueryData(['states', 'org-1'], [originalState]);
      queryClient.setQueryData(['state', 'org-1', 'state-123'], originalState);

      // Mock a delayed response to test optimistic update
      let resolveUpdate: (value: Observation) => void;
      const updatePromise = new Promise<Observation>((resolve) => {
        resolveUpdate = resolve;
      });
      vi.mocked(stateService.updateState).mockReturnValue(updatePromise);

      const { result } = renderHook(() => useStateMutations('org-1'), { wrapper });

      const updateData = { observation_text: 'Updated text' };
      const updateCall = result.current.updateState({ id: 'state-123', data: updateData });

      // Check optimistic update happened immediately (before server response)
      await waitFor(() => {
        const statesList = queryClient.getQueryData<Observation[]>(['states', 'org-1']);
        const singleState = queryClient.getQueryData<Observation>(['state', 'org-1', 'state-123']);
        
        expect(statesList?.[0]?.observation_text).toBe('Updated text');
        expect(singleState?.observation_text).toBe('Updated text');
      });

      // Now resolve the server response
      const serverResponse: Observation = {
        ...originalState,
        observation_text: 'Updated text',
        updated_at: '2024-01-15T11:00:00Z',
      };
      resolveUpdate!(serverResponse);

      await updateCall;

      // Verify server response replaced optimistic data
      await waitFor(() => {
        const statesList = queryClient.getQueryData<Observation[]>(['states', 'org-1']);
        const singleState = queryClient.getQueryData<Observation>(['state', 'org-1', 'state-123']);
        
        expect(statesList?.[0]).toEqual(serverResponse);
        expect(singleState).toEqual(serverResponse);
      });
    });

    it('should update filtered states cache when filters are provided', async () => {
      const originalState: Observation = {
        id: 'state-123',
        organization_id: 'org-1',
        observation_text: 'Original text',
        captured_by: 'user-1',
        captured_by_name: 'Test User',
        captured_at: '2024-01-15T10:30:00Z',
        created_at: '2024-01-15T10:30:00Z',
        updated_at: '2024-01-15T10:30:00Z',
        photos: [],
        links: [{ id: 'link-1', observation_id: 'state-123', entity_type: 'action', entity_id: 'action-1' }],
      };

      const updatedState: Observation = {
        ...originalState,
        observation_text: 'Updated text',
        updated_at: '2024-01-15T11:00:00Z',
      };

      // Pre-populate filtered cache
      queryClient.setQueryData(['states', 'org-1', 'action', 'action-1'], [originalState]);
      queryClient.setQueryData(['states', 'org-1'], [originalState]);
      queryClient.setQueryData(['state', 'org-1', 'state-123'], originalState);

      vi.mocked(stateService.updateState).mockResolvedValue(updatedState);

      const { result } = renderHook(
        () => useStateMutations('org-1', { entity_type: 'action', entity_id: 'action-1' }),
        { wrapper }
      );

      await result.current.updateState({
        id: 'state-123',
        data: { observation_text: 'Updated text' },
      });

      await waitFor(() => {
        // Verify filtered cache was updated
        const filteredStates = queryClient.getQueryData<Observation[]>(['states', 'org-1', 'action', 'action-1']);
        expect(filteredStates?.[0]).toEqual(updatedState);
      });
    });

    it('should invalidate actions cache when updating state linked to action', async () => {
      const originalState: Observation = {
        id: 'state-123',
        organization_id: 'org-1',
        observation_text: 'Original text',
        captured_by: 'user-1',
        captured_by_name: 'Test User',
        captured_at: '2024-01-15T10:30:00Z',
        created_at: '2024-01-15T10:30:00Z',
        updated_at: '2024-01-15T10:30:00Z',
        photos: [],
        links: [{ id: 'link-1', observation_id: 'state-123', entity_type: 'action', entity_id: 'action-1' }],
      };

      const updatedState: Observation = {
        ...originalState,
        observation_text: 'Updated text',
        photos: [
          {
            id: 'photo-1',
            observation_id: 'state-123',
            photo_url: 'https://example.com/photo.jpg',
            photo_description: 'New photo',
            photo_order: 0,
          },
        ],
      };

      vi.mocked(stateService.updateState).mockResolvedValue(updatedState);

      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(
        () => useStateMutations('org-1', { entity_type: 'action', entity_id: 'action-1' }),
        { wrapper }
      );

      await result.current.updateState({
        id: 'state-123',
        data: { 
          observation_text: 'Updated text',
          photos: [{ photo_url: 'https://example.com/photo.jpg', photo_description: 'New photo', photo_order: 0 }],
        },
      });

      await waitFor(() => {
        // Should invalidate actions cache because entity_type is 'action'
        expect(invalidateSpy).toHaveBeenCalledWith({
          queryKey: ['actions'],
        });
      });
    });

    it('should NOT invalidate actions cache when updating state linked to non-action entity', async () => {
      const originalState: Observation = {
        id: 'state-123',
        organization_id: 'org-1',
        observation_text: 'Original text',
        captured_by: 'user-1',
        captured_by_name: 'Test User',
        captured_at: '2024-01-15T10:30:00Z',
        created_at: '2024-01-15T10:30:00Z',
        updated_at: '2024-01-15T10:30:00Z',
        photos: [],
        links: [{ id: 'link-1', observation_id: 'state-123', entity_type: 'part', entity_id: 'part-1' }],
      };

      const updatedState: Observation = {
        ...originalState,
        observation_text: 'Updated text',
      };

      vi.mocked(stateService.updateState).mockResolvedValue(updatedState);

      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(
        () => useStateMutations('org-1', { entity_type: 'part', entity_id: 'part-1' }),
        { wrapper }
      );

      await result.current.updateState({
        id: 'state-123',
        data: { observation_text: 'Updated text' },
      });

      await waitFor(() => {
        // Should NOT invalidate actions cache because entity_type is 'part'
        expect(invalidateSpy).not.toHaveBeenCalledWith({
          queryKey: ['actions'],
        });
      });
    });

    it('should handle concurrent updates correctly', async () => {
      const originalState: Observation = {
        id: 'state-123',
        organization_id: 'org-1',
        observation_text: 'Original text',
        captured_by: 'user-1',
        captured_by_name: 'Test User',
        captured_at: '2024-01-15T10:30:00Z',
        created_at: '2024-01-15T10:30:00Z',
        updated_at: '2024-01-15T10:30:00Z',
        photos: [],
        links: [],
      };

      // Pre-populate cache
      queryClient.setQueryData(['states', 'org-1'], [originalState]);
      queryClient.setQueryData(['state', 'org-1', 'state-123'], originalState);

      const firstUpdate: Observation = {
        ...originalState,
        observation_text: 'First update',
        updated_at: '2024-01-15T11:00:00Z',
      };

      const secondUpdate: Observation = {
        ...originalState,
        observation_text: 'Second update',
        updated_at: '2024-01-15T11:05:00Z',
      };

      // Mock service to return different responses
      vi.mocked(stateService.updateState)
        .mockResolvedValueOnce(firstUpdate)
        .mockResolvedValueOnce(secondUpdate);

      const { result } = renderHook(() => useStateMutations('org-1'), { wrapper });

      // Trigger two updates concurrently
      await Promise.all([
        result.current.updateState({ id: 'state-123', data: { state_text: 'First update' } }),
        result.current.updateState({ id: 'state-123', data: { state_text: 'Second update' } }),
      ]);

      // Last write wins - should have second update
      await waitFor(() => {
        const singleState = queryClient.getQueryData<Observation>(['state', 'org-1', 'state-123']);
        expect(singleState?.observation_text).toBe('Second update');
      });
    });

    it('should set isUpdating flag during mutation', async () => {
      const updatedState: Observation = {
        id: 'state-123',
        organization_id: 'org-1',
        observation_text: 'Updated text',
        captured_by: 'user-1',
        captured_by_name: 'Test User',
        captured_at: '2024-01-15T10:30:00Z',
        created_at: '2024-01-15T10:30:00Z',
        updated_at: '2024-01-15T11:00:00Z',
        photos: [],
        links: [],
      };

      // Mock a delayed response
      let resolveUpdate: (value: Observation) => void;
      const updatePromise = new Promise<Observation>((resolve) => {
        resolveUpdate = resolve;
      });
      vi.mocked(stateService.updateState).mockReturnValue(updatePromise);

      const { result } = renderHook(() => useStateMutations('org-1'), { wrapper });

      // Initially not updating
      expect(result.current.isUpdating).toBe(false);

      // Start update
      const updateCall = result.current.updateState({
        id: 'state-123',
        data: { observation_text: 'Updated text' },
      });

      // Should be updating
      await waitFor(() => {
        expect(result.current.isUpdating).toBe(true);
      });

      // Resolve the update
      resolveUpdate!(updatedState);
      await updateCall;

      // Should no longer be updating
      await waitFor(() => {
        expect(result.current.isUpdating).toBe(false);
      });
    });
  });

  describe('cache invalidation', () => {
    it('should invalidate states cache when creating state', async () => {
      const mockState = {
        id: 'state-1',
        observation_text: 'Test observation',
        photos: [],
      };

      vi.mocked(stateService.createState).mockResolvedValue(mockState as any);

      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(
        () => useStateMutations('org-1', { entity_type: 'action', entity_id: 'action-1' }),
        { wrapper }
      );

      const data: CreateObservationData = {
        state_text: 'Test observation',
        photos: [],
        links: [{ entity_type: 'action', entity_id: 'action-1' }],
      };

      await result.current.createState(data);

      await waitFor(() => {
        // Verify filtered cache was updated with the real server record
        const filteredStates = queryClient.getQueryData<Observation[]>(['states', 'org-1', 'action', 'action-1']);
        expect(filteredStates?.[0]?.id).toBe('state-1');

        // Should NOT invalidate the broad ['states', 'org-1'] key — this was the bug.
        // Broad invalidation caused a cascade of refetches across all useStates queries.
        expect(invalidateSpy).not.toHaveBeenCalledWith({
          queryKey: ['states', 'org-1'],
        });
      });
    });

    it('should invalidate states cache when deleting state', async () => {
      vi.mocked(stateService.deleteState).mockResolvedValue(undefined);

      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(
        () => useStateMutations('org-1', { entity_type: 'action', entity_id: 'action-1' }),
        { wrapper }
      );

      await result.current.deleteState('state-1');

      await waitFor(() => {
        // Should invalidate filtered states cache
        expect(invalidateSpy).toHaveBeenCalledWith({
          queryKey: ['states', 'org-1', 'action', 'action-1'],
        });
        // Should invalidate all states cache
        expect(invalidateSpy).toHaveBeenCalledWith({
          queryKey: ['states', 'org-1'],
        });
      });
    });

    // PRESERVATION TESTS (Task 2)
    // These tests encode the BASELINE behavior that must be preserved after the fix.
    // They MUST PASS on unfixed code (confirms baseline) and MUST PASS after the fix (confirms no regression).
    //
    // Validates: Requirements 3.1, 3.5, 3.6

    it('[PRESERVATION] createState should always invalidate (or update) the filtered cache key for any entity_type/entity_id combination', async () => {
      // Property: for any entity_type/entity_id filter combination, after createState succeeds,
      // the filtered cache key statesQueryKey(filters) is always invalidated or updated.
      // This is the baseline behavior to preserve — the observation must become visible in the UI.
      const filterCombinations = [
        { entity_type: 'action', entity_id: 'action-1' },
        { entity_type: 'action', entity_id: 'action-abc' },
        { entity_type: 'part', entity_id: 'part-42' },
        { entity_type: 'tool', entity_id: 'tool-99' },
        { entity_type: 'issue', entity_id: 'issue-7' },
      ];

      for (const filters of filterCombinations) {
        // Fresh queryClient for each combination
        const localQueryClient = new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        });
        const localWrapper = ({ children }: { children: React.ReactNode }) => (
          <QueryClientProvider client={localQueryClient}>{children}</QueryClientProvider>
        );

        const mockState = {
          id: `state-${filters.entity_id}`,
          observation_text: 'Test observation',
          photos: [],
          links: [{ entity_type: filters.entity_type, entity_id: filters.entity_id }],
        };
        vi.mocked(stateService.createState).mockResolvedValue(mockState as any);

        const invalidateSpy = vi.spyOn(localQueryClient, 'invalidateQueries');

        const { result } = renderHook(
          () => useStateMutations('org-1', filters),
          { wrapper: localWrapper }
        );

        const data: CreateObservationData = {
          state_text: 'Test observation',
          photos: [],
          links: [{ entity_type: filters.entity_type, entity_id: filters.entity_id }],
        };

        await result.current.createState(data);

        await waitFor(() => {
          // The filtered cache key MUST be invalidated (or updated) after createState
          // This ensures the new observation becomes visible in the UI for the specific entity
          const filteredKeyInvalidated = invalidateSpy.mock.calls.some(
            call => JSON.stringify(call[0]) === JSON.stringify({ queryKey: ['states', 'org-1', filters.entity_type, filters.entity_id] })
          );
          const filteredCacheUpdated = localQueryClient.getQueryData<any[]>(
            ['states', 'org-1', filters.entity_type, filters.entity_id]
          ) !== undefined;

          // Either the key was invalidated OR the cache was directly updated (optimistic)
          expect(filteredKeyInvalidated || filteredCacheUpdated).toBe(true);
        });
      }
    });

    it('[PRESERVATION] deleteState should always invalidate BOTH filtered AND broad statesQueryKey()', async () => {
      // Property: deleteState must continue to invalidate both the scoped and broad cache keys.
      // This behavior is UNCHANGED by the fix — only createState's broad invalidation is removed.
      vi.mocked(stateService.deleteState).mockResolvedValue(undefined);

      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(
        () => useStateMutations('org-1', { entity_type: 'action', entity_id: 'action-1' }),
        { wrapper }
      );

      await result.current.deleteState('state-to-delete');

      await waitFor(() => {
        // Filtered key MUST be invalidated
        expect(invalidateSpy).toHaveBeenCalledWith({
          queryKey: ['states', 'org-1', 'action', 'action-1'],
        });
        // Broad key MUST ALSO be invalidated (delete behavior is unchanged)
        expect(invalidateSpy).toHaveBeenCalledWith({
          queryKey: ['states', 'org-1'],
        });
      });
    });

    // BUG CONDITION EXPLORATION TEST (Task 1)
    // This test encodes the EXPECTED (fixed) behavior.
    // It MUST FAIL on unfixed code — failure confirms the bug exists.
    // After the fix is implemented (Task 3), this test MUST PASS.
    //
    // Bug condition: createState with filters set
    //   - invalidates the broad ['states'] key (causes cascade refetch) ← BUG
    //   - does NOT update the filtered cache optimistically (no onMutate) ← BUG
    //
    // Counterexamples on unfixed code:
    //   1. invalidateQueries IS called with { queryKey: ['states'] } on every create
    //   2. filtered cache ['states','action','action-1'] is NOT updated until server responds
    //
    // Validates: Requirements 1.2, 1.3
    it('[BUG CONDITION] createState should NOT invalidate broad statesQueryKey() and should update filtered cache optimistically', async () => {
      const mockState = {
        id: 'state-server-1',
        observation_text: 'New observation',
        photos: [],
        links: [{ entity_type: 'action', entity_id: 'action-1' }],
      };

      // Use a delayed mock so we can inspect the cache mid-flight
      let resolveCreate: (value: typeof mockState) => void;
      const createPromise = new Promise<typeof mockState>((resolve) => {
        resolveCreate = resolve;
      });
      vi.mocked(stateService.createState).mockReturnValue(createPromise as any);

      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      // Pre-populate the filtered cache with an existing observation
      const existingState = {
        id: 'state-existing',
        observation_text: 'Existing observation',
        photos: [],
        links: [],
        captured_at: '2024-01-01T00:00:00Z',
      };
      queryClient.setQueryData(['states', 'org-1', 'action', 'action-1'], [existingState]);

      const { result } = renderHook(
        () => useStateMutations('org-1', { entity_type: 'action', entity_id: 'action-1' }),
        { wrapper }
      );

      const data: CreateObservationData = {
        state_text: 'New observation',
        photos: [],
        links: [{ entity_type: 'action', entity_id: 'action-1' }],
      };

      // Fire the create (don't await — we want to inspect mid-flight)
      const createCall = result.current.createState(data);

      // ASSERTION 1: Filtered cache should be updated optimistically BEFORE server responds
      // (i.e., onMutate should have prepended a provisional observation)
      await waitFor(() => {
        const filteredStates = queryClient.getQueryData<any[]>(['states', 'org-1', 'action', 'action-1']);
        // After optimistic update, the new observation should appear in the filtered cache
        // before the server responds. The provisional item has id starting with 'optimistic-'.
        const hasOptimisticEntry = filteredStates?.some(s => s.id?.startsWith('optimistic-'));
        expect(hasOptimisticEntry).toBe(true);
      });

      // Resolve the server response
      resolveCreate!(mockState as any);
      await createCall;

      // ASSERTION 2: The broad ['states', 'org-1'] key should NOT be invalidated
      // (only the scoped ['states', 'org-1', 'action', 'action-1'] key should be invalidated)
      expect(invalidateSpy).not.toHaveBeenCalledWith({
        queryKey: ['states', 'org-1'],
      });

      // ASSERTION 3: The filtered cache should be updated with the real server record
      const filteredStates = queryClient.getQueryData<Observation[]>(['states', 'org-1', 'action', 'action-1']);
      expect(filteredStates?.[0]?.id).toBe('state-server-1');
    });
  });
});
