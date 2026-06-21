/**
 * Integration Test: Action States Workflows
 * 
 * Tests end-to-end state creation, editing, and deletion with actions
 * Validates implementation_update_count updates and cache consistency
 * 
 * Requirements: 3.5, 3.6, 3.7, 4.4, 4.5, 10.2, 10.3, 10.4, 10.5
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useStateMutations } from '../../useStates';
import { TestDataManager } from './testDataManager';
import { skipIfNotIntegrationEnv } from './config';
import { stateService } from '@/services/stateService';
import React from 'react';

// Skip if not in integration test environment
if (skipIfNotIntegrationEnv()) {
  describe.skip('Integration Tests - Action States Workflows', () => {});
} else {
  describe('Integration Tests - Action States Workflows', () => {
    let queryClient: QueryClient;
    let testDataManager: TestDataManager;
    let wrapper: React.ComponentType<{ children: React.ReactNode }>;

    beforeAll(async () => {
      testDataManager = new TestDataManager();
      await testDataManager.setupTestEnvironment();
    });

    afterAll(async () => {
      await testDataManager.teardownTestEnvironment();
    });

    beforeEach(() => {
      queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false }
        }
      });

      wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      );
    });

    afterEach(async () => {
      queryClient.clear();
    });

    /**
     * Test: Complete flow - create action → add state → verify count updates
     * Validates: Requirements 4.4, 10.2
     */
    it('should create state and increment implementation_update_count', async () => {
      // Create test action
      const testAction = await testDataManager.createTestAction({
        status: 'in_progress',
        title: 'Test Action for State Creation'
      });

      // Verify initial count is 0
      expect(testAction.implementation_update_count || 0).toBe(0);

      // Setup cache
      queryClient.setQueryData(['actions'], [testAction]);

      const { result } = renderHook(
        () => useStateMutations(testAction.organization_id || 'org-1', { entity_type: 'action', entity_id: testAction.id }),
        { wrapper }
      );

      // Create a state linked to the action
      const stateData = {
        state_text: 'Integration test state - work in progress',
        photos: [],
        links: [{ entity_type: 'action' as const, entity_id: testAction.id }]
      };

      result.current.createState(stateData);

      await waitFor(() => {
        expect(result.current.isCreating).toBe(false);
      }, { timeout: 15000 });

      // Verify state was created
      expect(result.current.isCreating).toBe(false);

      // Verify actions cache was invalidated
      await waitFor(() => {
        const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['actions'] });
      }, { timeout: 5000 });

      // Fetch updated action from database
      const updatedAction = await testDataManager.getTestAction(testAction.id);
      
      // Verify count was incremented
      expect(updatedAction?.implementation_update_count).toBe(1);
    }, 60000);

    /**
     * Test: Complete flow - edit state → verify updates appear
     * Validates: Requirements 3.6, 10.3
     */
    it('should update state and maintain cache consistency', async () => {
      // Create test action
      const testAction = await testDataManager.createTestAction({
        status: 'in_progress',
        title: 'Test Action for State Update'
      });

      // Create initial state
      const initialState = await stateService.createState({
        state_text: 'Initial observation text',
        photos: [],
        links: [{ entity_type: 'action', entity_id: testAction.id }]
      });

      // Setup cache
      queryClient.setQueryData(['actions'], [testAction]);
      queryClient.setQueryData(['states', testAction.organization_id || 'org-1', 'action', testAction.id], [initialState]);

      const { result } = renderHook(
        () => useStateMutations(testAction.organization_id || 'org-1', { entity_type: 'action', entity_id: testAction.id }),
        { wrapper }
      );

      // Update the state
      const updateData = {
        state_text: 'Updated observation text - work completed'
      };

      result.current.updateState({
        id: initialState.id,
        data: updateData
      });

      await waitFor(() => {
        expect(result.current.isUpdating).toBe(false);
      }, { timeout: 15000 });

      // Verify update succeeded
      expect(result.current.isUpdating).toBe(false);

      // Verify states cache was invalidated
      await waitFor(() => {
        const statesCache = queryClient.getQueryData(['states', testAction.organization_id || 'org-1', 'action', testAction.id]);
        expect(statesCache).toBeDefined();
      }, { timeout: 5000 });

      // Fetch updated state from database
      const states = await stateService.getStates({
        entity_type: 'action',
        entity_id: testAction.id
      });

      const updatedState = states.find(s => s.id === initialState.id);
      expect(updatedState?.observation_text).toBe('Updated observation text - work completed');
    }, 60000);

    /**
     * Test: Complete flow - delete state → verify count decrements
     * Validates: Requirements 3.7, 4.5, 10.4
     */
    it('should delete state and decrement implementation_update_count', async () => {
      // Create test action
      const testAction = await testDataManager.createTestAction({
        status: 'in_progress',
        title: 'Test Action for State Deletion'
      });

      // Create two states
      const state1 = await stateService.createState({
        state_text: 'First observation',
        photos: [],
        links: [{ entity_type: 'action', entity_id: testAction.id }]
      });

      const state2 = await stateService.createState({
        state_text: 'Second observation',
        photos: [],
        links: [{ entity_type: 'action', entity_id: testAction.id }]
      });

      // Verify count is 2
      const actionAfterCreation = await testDataManager.getTestAction(testAction.id);
      expect(actionAfterCreation?.implementation_update_count).toBe(2);

      // Setup cache
      queryClient.setQueryData(['actions'], [actionAfterCreation]);
      queryClient.setQueryData(['states', actionAfterCreation.organization_id || 'org-1', 'action', testAction.id], [state1, state2]);

      const { result } = renderHook(
        () => useStateMutations(testAction.organization_id || 'org-1', { entity_type: 'action', entity_id: testAction.id }),
        { wrapper }
      );

      // Delete one state
      result.current.deleteState(state1.id);

      await waitFor(() => {
        expect(result.current.isDeleting).toBe(false);
      }, { timeout: 15000 });

      // Verify deletion succeeded
      expect(result.current.isDeleting).toBe(false);

      // Verify actions cache was invalidated
      await waitFor(() => {
        const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['actions'] });
      }, { timeout: 5000 });

      // Fetch updated action from database
      const updatedAction = await testDataManager.getTestAction(testAction.id);
      
      // Verify count was decremented
      expect(updatedAction?.implementation_update_count).toBe(1);

      // Verify state was actually deleted
      const remainingStates = await stateService.getStates({
        entity_type: 'action',
        entity_id: testAction.id
      });

      expect(remainingStates.length).toBe(1);
      expect(remainingStates[0].id).toBe(state2.id);
    }, 60000);

    /**
     * Test: Dialog remains open during all operations
     * Validates: Requirements 3.5, 3.6, 3.7
     * 
     * Note: This test verifies cache behavior that supports keeping dialogs open.
     * The actual dialog behavior is tested in component tests.
     */
    it('should maintain cache consistency without closing dialog', async () => {
      // Create test action
      const testAction = await testDataManager.createTestAction({
        status: 'in_progress',
        title: 'Test Action for Dialog Persistence'
      });

      // Setup cache
      queryClient.setQueryData(['actions'], [testAction]);

      const { result } = renderHook(
        () => useStateMutations(testAction.organization_id || 'org-1', { entity_type: 'action', entity_id: testAction.id }),
        { wrapper }
      );

      // Create state
      const stateData = {
        state_text: 'First observation',
        photos: [],
        links: [{ entity_type: 'action' as const, entity_id: testAction.id }]
      };

      result.current.createState(stateData);

      await waitFor(() => {
        expect(result.current.isCreating).toBe(false);
      }, { timeout: 15000 });

      // Verify states cache is populated
      const statesAfterCreate = queryClient.getQueryData(['states', testAction.organization_id || 'org-1', 'action', testAction.id]);
      expect(statesAfterCreate).toBeDefined();

      // Create another state (simulating user staying in dialog)
      const stateData2 = {
        state_text: 'Second observation',
        photos: [],
        links: [{ entity_type: 'action' as const, entity_id: testAction.id }]
      };

      result.current.createState(stateData2);

      await waitFor(() => {
        expect(result.current.isCreating).toBe(false);
      }, { timeout: 15000 });

      // Verify cache was updated with new state
      const statesAfterSecondCreate = queryClient.getQueryData(['states', testAction.organization_id || 'org-1', 'action', testAction.id]);
      expect(statesAfterSecondCreate).toBeDefined();

      // Fetch from database to verify both states exist
      const dbStates = await stateService.getStates({
        entity_type: 'action',
        entity_id: testAction.id
      });

      expect(dbStates.length).toBe(2);
      expect(dbStates.map(s => s.observation_text)).toContain('First observation');
      expect(dbStates.map(s => s.observation_text)).toContain('Second observation');
    }, 60000);

    /**
     * Test: Cache consistency across multiple operations
     * Validates: Requirements 10.2, 10.3, 10.4, 10.5
     */
    it('should maintain cache consistency across create, update, and delete operations', async () => {
      // Create test action
      const testAction = await testDataManager.createTestAction({
        status: 'in_progress',
        title: 'Test Action for Cache Consistency'
      });

      // Setup cache
      queryClient.setQueryData(['actions'], [testAction]);

      const { result } = renderHook(
        () => useStateMutations(testAction.organization_id || 'org-1', { entity_type: 'action', entity_id: testAction.id }),
        { wrapper }
      );

      // Operation 1: Create state
      const stateData = {
        state_text: 'Initial observation',
        photos: [],
        links: [{ entity_type: 'action' as const, entity_id: testAction.id }]
      };

      result.current.createState(stateData);

      await waitFor(() => {
        expect(result.current.isCreating).toBe(false);
      }, { timeout: 15000 });

      // Verify cache invalidation occurred
      let invalidateCount = 0;
      const originalInvalidate = queryClient.invalidateQueries.bind(queryClient);
      queryClient.invalidateQueries = async (filters: any) => {
        invalidateCount++;
        return originalInvalidate(filters);
      };

      // Fetch state ID from database
      const states = await stateService.getStates({
        entity_type: 'action',
        entity_id: testAction.id
      });
      expect(states.length).toBe(1);
      const stateId = states[0].id;

      // Operation 2: Update state
      result.current.updateState({
        id: stateId,
        data: { state_text: 'Updated observation' }
      });

      await waitFor(() => {
        expect(result.current.isUpdating).toBe(false);
      }, { timeout: 15000 });

      // Verify update in database
      const updatedStates = await stateService.getStates({
        entity_type: 'action',
        entity_id: testAction.id
      });
      expect(updatedStates[0].observation_text).toBe('Updated observation');

      // Operation 3: Delete state
      result.current.deleteState(stateId);

      await waitFor(() => {
        expect(result.current.isDeleting).toBe(false);
      }, { timeout: 15000 });

      // Verify deletion in database
      const finalStates = await stateService.getStates({
        entity_type: 'action',
        entity_id: testAction.id
      });
      expect(finalStates.length).toBe(0);

      // Verify action count is back to 0
      const finalAction = await testDataManager.getTestAction(testAction.id);
      expect(finalAction?.implementation_update_count).toBe(0);

      // Verify cache invalidations occurred
      expect(invalidateCount).toBeGreaterThan(0);
    }, 90000);

    /**
     * Test: Text-only and photo-only state creation
     * Validates: Requirements 1.1, 1.2
     */
    it('should support both text-only and photo-only state creation', async () => {
      // Create test action
      const testAction = await testDataManager.createTestAction({
        status: 'in_progress',
        title: 'Test Action for Mixed State Types'
      });

      const { result } = renderHook(
        () => useStateMutations(testAction.organization_id || 'org-1', { entity_type: 'action', entity_id: testAction.id }),
        { wrapper }
      );

      // Create text-only state
      const textOnlyData = {
        state_text: 'Text-only observation',
        photos: [],
        links: [{ entity_type: 'action' as const, entity_id: testAction.id }]
      };

      result.current.createState(textOnlyData);

      await waitFor(() => {
        expect(result.current.isCreating).toBe(false);
      }, { timeout: 15000 });

      // Verify text-only state was created
      const statesAfterText = await stateService.getStates({
        entity_type: 'action',
        entity_id: testAction.id
      });
      expect(statesAfterText.length).toBe(1);
      expect(statesAfterText[0].observation_text).toBe('Text-only observation');
      expect(statesAfterText[0].photos?.length || 0).toBe(0);

      // Create photo-only state (with empty text)
      const photoOnlyData = {
        state_text: '',
        photos: ['https://example.com/photo1.jpg'],
        links: [{ entity_type: 'action' as const, entity_id: testAction.id }]
      };

      result.current.createState(photoOnlyData);

      await waitFor(() => {
        expect(result.current.isCreating).toBe(false);
      }, { timeout: 15000 });

      // Verify photo-only state was created
      const statesAfterPhoto = await stateService.getStates({
        entity_type: 'action',
        entity_id: testAction.id
      });
      expect(statesAfterPhoto.length).toBe(2);
      
      const photoState = statesAfterPhoto.find(s => s.photos && s.photos.length > 0);
      expect(photoState).toBeDefined();
      expect(photoState?.photos?.length).toBeGreaterThan(0);

      // Verify count is 2
      const finalAction = await testDataManager.getTestAction(testAction.id);
      expect(finalAction?.implementation_update_count).toBe(2);
    }, 60000);

    /**
     * Test: Multiple states on single action
     * Validates: Requirements 4.4, 4.5, 5.1, 5.2
     */
    it('should correctly track count with multiple states', async () => {
      // Create test action
      const testAction = await testDataManager.createTestAction({
        status: 'in_progress',
        title: 'Test Action for Multiple States'
      });

      const { result } = renderHook(
        () => useStateMutations(testAction.organization_id || 'org-1', { entity_type: 'action', entity_id: testAction.id }),
        { wrapper }
      );

      // Create 5 states
      const statePromises = [];
      for (let i = 1; i <= 5; i++) {
        const stateData = {
          state_text: `Observation ${i}`,
          photos: [],
          links: [{ entity_type: 'action' as const, entity_id: testAction.id }]
        };
        
        result.current.createState(stateData);
        
        statePromises.push(
          waitFor(() => {
            expect(result.current.isCreating).toBe(false);
          }, { timeout: 15000 })
        );
      }

      await Promise.all(statePromises);

      // Verify count is 5
      const actionAfterCreation = await testDataManager.getTestAction(testAction.id);
      expect(actionAfterCreation?.implementation_update_count).toBe(5);

      // Fetch all states
      const allStates = await stateService.getStates({
        entity_type: 'action',
        entity_id: testAction.id
      });
      expect(allStates.length).toBe(5);

      // Delete 2 states
      result.current.deleteState(allStates[0].id);
      await waitFor(() => {
        expect(result.current.isDeleting).toBe(false);
      }, { timeout: 15000 });

      result.current.deleteState(allStates[1].id);
      await waitFor(() => {
        expect(result.current.isDeleting).toBe(false);
      }, { timeout: 15000 });

      // Verify count is 3
      const actionAfterDeletion = await testDataManager.getTestAction(testAction.id);
      expect(actionAfterDeletion?.implementation_update_count).toBe(3);

      // Verify 3 states remain
      const remainingStates = await stateService.getStates({
        entity_type: 'action',
        entity_id: testAction.id
      });
      expect(remainingStates.length).toBe(3);
    }, 120000);
  });
}
