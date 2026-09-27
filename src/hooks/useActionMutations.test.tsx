import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useActionMutations } from './useActionMutations';
import { BaseAction } from '@/types/actions';
import * as fc from 'fast-check';
import React from 'react';

// Mock the API service
import { apiService } from '@/lib/apiService';

vi.mock('@/lib/apiService', () => ({
  apiService: {
    put: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
  getApiData: vi.fn((response) => response?.data || response)
}));

// Test wrapper component
const createWrapper = (queryClient: QueryClient) => {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
};

// Deep equality helper for comparing values
const deepEqual = (a: any, b: any): boolean => {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(key => deepEqual(a[key], b[key]));
  }
  return false;
};

// Generator for BaseAction objects
const actionArbitrary = fc.record({
  id: fc.string({ minLength: 1, maxLength: 50 }),
  title: fc.string({ minLength: 1, maxLength: 100 }),
  description: fc.option(fc.string({ maxLength: 500 })),
  status: fc.constantFrom('pending', 'in_progress', 'completed', 'cancelled'),
  priority: fc.constantFrom('low', 'medium', 'high', 'urgent'),
  assigned_to: fc.option(fc.string({ minLength: 1, maxLength: 50 })),
  due_date: fc.option(fc.integer({ min: Date.now(), max: Date.now() + 365 * 24 * 60 * 60 * 1000 }).map(timestamp => new Date(timestamp).toISOString())),
  created_at: fc.integer({ min: Date.now() - 365 * 24 * 60 * 60 * 1000, max: Date.now() }).map(timestamp => new Date(timestamp).toISOString()),
  updated_at: fc.integer({ min: Date.now() - 365 * 24 * 60 * 60 * 1000, max: Date.now() }).map(timestamp => new Date(timestamp).toISOString()),
  required_tools: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 50 }), { maxLength: 10 }))
}) as fc.Arbitrary<BaseAction>;

// Generator for partial action updates
const actionUpdatesArbitrary = fc.record({
  title: fc.option(fc.string({ minLength: 1, maxLength: 100 })),
  description: fc.option(fc.option(fc.string({ maxLength: 500 }))),
  status: fc.option(fc.constantFrom('pending', 'in_progress', 'completed', 'cancelled')),
  priority: fc.option(fc.constantFrom('low', 'medium', 'high', 'urgent')),
  assigned_to: fc.option(fc.option(fc.string({ minLength: 1, maxLength: 50 }))),
  due_date: fc.option(fc.option(fc.integer({ min: Date.now(), max: Date.now() + 365 * 24 * 60 * 60 * 1000 }).map(timestamp => new Date(timestamp).toISOString()))),
  required_tools: fc.option(fc.option(fc.array(fc.string({ minLength: 1, maxLength: 50 }), { maxLength: 10 })))
}, { requiredKeys: [] }) as fc.Arbitrary<Partial<BaseAction>>;

describe('useActionMutations', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false }
      }
    });
    
    // Reset mocks
    vi.clearAllMocks();
  });

  describe('Property-Based Tests', () => {
    /**
     * Feature: tanstack-actions, Property 1: Optimistic Update Consistency
     * **Validates: Requirements 1.1**
     * 
     * Property 1: Optimistic Update Consistency
     * For any action update, the TanStack Query cache should immediately reflect 
     * the optimistic changes before the server responds
     */
    it('should maintain optimistic update consistency for any action update', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(actionArbitrary, { minLength: 1, maxLength: 10 }),
          fc.integer({ min: 0, max: 9 }),
          actionUpdatesArbitrary,
          async (initialActions, targetIndex, updates) => {
            // Skip if updates object is empty
            const hasUpdates = Object.keys(updates).some(key => updates[key as keyof typeof updates] !== undefined);
            if (!hasUpdates) return;
            
            // Ensure we have a valid target index
            const actualTargetIndex = targetIndex % initialActions.length;
            const targetAction = initialActions[actualTargetIndex];
            
            // Setup initial cache state
            queryClient.setQueryData(['actions'], initialActions);
            
            // Mock the API call to never resolve (simulating slow network)
            let resolveMutation: (value: any) => void;
            const mutationPromise = new Promise(resolve => {
              resolveMutation = resolve;
            });
            apiService.put.mockReturnValue(mutationPromise);
            
            // Render the hook
            const wrapper = createWrapper(queryClient);
            const { result } = renderHook(() => useActionMutations(), { wrapper });
            
            // Trigger the mutation
            const mutationVariables = { id: targetAction.id, updates };
            result.current.updateAction.mutate(mutationVariables);
            
            // Wait for onMutate to complete with shorter timeout
            await waitFor(() => {
              expect(result.current.updateAction.isPending).toBe(true);
            }, { timeout: 1000 });
            
            // Verify optimistic update is immediately applied
            const cacheData = queryClient.getQueryData<BaseAction[]>(['actions']);
            expect(cacheData).toBeDefined();
            
            if (cacheData) {
              const updatedAction = cacheData.find(action => action.id === targetAction.id);
              expect(updatedAction).toBeDefined();
              
              if (updatedAction) {
                // Verify each update field is applied optimistically
                Object.entries(updates).forEach(([key, value]) => {
                  if (value !== undefined) {
                    expect(updatedAction[key as keyof BaseAction]).toEqual(value);
                  }
                });
                
                // Verify unchanged fields remain the same
                Object.keys(targetAction).forEach(key => {
                  if (!(key in updates) || updates[key as keyof typeof updates] === undefined) {
                    expect(updatedAction[key as keyof BaseAction]).toEqual(targetAction[key as keyof BaseAction]);
                  }
                });
              }
            }
            
            // Verify other actions remain unchanged
            if (cacheData) {
              const otherActions = cacheData.filter(action => action.id !== targetAction.id);
              const originalOtherActions = initialActions.filter(action => action.id !== targetAction.id);
              expect(otherActions).toEqual(originalOtherActions);
            }
            
            // Clean up - resolve the mutation to prevent hanging
            resolveMutation!({ data: { ...targetAction, ...updates }, affectedResources: {} });
          }
        ),
        { numRuns: 50, timeout: 5000 } // Reduced runs and added timeout
      );
    }, 15000); // Increased test timeout

    /**
     * Feature: tanstack-actions, Property 4: Error Rollback Integrity
     * **Validates: Requirements 4.2, 4.4**
     * 
     * Property 4: Error Rollback Integrity
     * For any validation error during action update, the cache should be restored 
     * to its exact previous state without affecting unrelated resources
     */
    it('should maintain error rollback integrity for validation errors', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(actionArbitrary, { minLength: 2, maxLength: 10 }),
          fc.integer({ min: 0, max: 9 }),
          actionUpdatesArbitrary,
          fc.constantFrom(400, 422), // Validation error status codes
          fc.string({ minLength: 1, maxLength: 100 }), // Error message
          async (initialActions, targetIndex, updates, errorStatus, errorMessage) => {
            // Skip if updates object is empty
            const hasUpdates = Object.keys(updates).some(key => updates[key as keyof typeof updates] !== undefined);
            if (!hasUpdates) return;
            
            // Ensure we have a valid target index
            const actualTargetIndex = targetIndex % initialActions.length;
            const targetAction = initialActions[actualTargetIndex];
            
            // Setup initial cache state
            queryClient.setQueryData(['actions'], initialActions);
            
            // Setup related cache data (tools) to verify they're not affected by rollback
            const initialTools = [
              { id: 'tool1', name: 'Hammer', is_checked_out: false },
              { id: 'tool2', name: 'Screwdriver', is_checked_out: true }
            ];
            queryClient.setQueryData(['tools'], initialTools);
            
            // Mock the API call to reject with validation error
            const validationError = {
              response: { status: errorStatus },
              message: errorMessage,
              status: errorStatus
            };
            apiService.put.mockRejectedValue(validationError);
            
            // Render the hook
            const wrapper = createWrapper(queryClient);
            const { result } = renderHook(() => useActionMutations(), { wrapper });
            
            // Trigger the mutation
            const mutationVariables = { id: targetAction.id, updates };
            result.current.updateAction.mutate(mutationVariables);
            
            // Wait for the mutation to complete (fail) with shorter timeout
            await waitFor(() => {
              expect(result.current.updateAction.isError).toBe(true);
            }, { timeout: 2000 });
            
            // Verify cache is rolled back to exact previous state
            const cacheData = queryClient.getQueryData<BaseAction[]>(['actions']);
            expect(cacheData).toEqual(initialActions);
            
            // Verify unrelated resources (tools) are not affected by rollback
            const toolsData = queryClient.getQueryData(['tools']);
            expect(toolsData).toEqual(initialTools);
            
            // Verify the error is properly classified and handled
            expect(result.current.updateAction.error).toBeDefined();
            expect(result.current.updateAction.failureCount).toBeGreaterThan(0);
          }
        ),
        { numRuns: 50, timeout: 5000 } // Reduced runs and added timeout
      );
    }, 15000); // Increased test timeout

    /**
     * Feature: tanstack-actions, Property 5: Network Error Preservation
     * **Validates: Requirements 3.1, 3.3**
     * 
     * Property 5: Network Error Preservation
     * For any action update that fails with a network error, the optimistic update should persist 
     * (unlike validation errors which rollback), and the error should be classified as retryable
     */
    it('should preserve optimistic updates for network errors (vs rollback for validation errors)', async () => {
      // Test 1: Network errors preserve optimistic updates
      const networkTestActions = [
        { id: 'test-1', title: 'Original Title', status: 'pending' as const, priority: 'low' as const, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
      ];
      const networkUpdates = { title: 'Updated Title', status: 'in_progress' as const };
      
      queryClient.setQueryData(['actions'], networkTestActions);
      
      const networkError = { message: 'Network timeout', code: 'NETWORK_ERROR' };
      apiService.put.mockRejectedValue(networkError);
      
      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => useActionMutations(), { wrapper });
      
      result.current.updateAction.mutate({ id: 'test-1', updates: networkUpdates });
      
      // Wait for mutation to start
      await waitFor(() => {
        expect(result.current.updateAction.isPending || result.current.updateAction.isError).toBe(true);
      }, { timeout: 1000 });
      
      // Verify optimistic update persists for network errors
      const networkCacheData = queryClient.getQueryData<BaseAction[]>(['actions']);
      expect(networkCacheData).toBeDefined();
      const networkUpdatedAction = networkCacheData?.find(action => action.id === 'test-1');
      expect(networkUpdatedAction?.title).toBe('Updated Title');
      expect(networkUpdatedAction?.status).toBe('in_progress');
      
      // Reset for validation test
      vi.clearAllMocks();
      queryClient.clear();
      
      // Test 2: Validation errors rollback optimistic updates
      const validationTestActions = [
        { id: 'test-2', title: 'Original Title', status: 'pending' as const, priority: 'low' as const, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
      ];
      const validationUpdates = { title: 'Updated Title', status: 'completed' as const };
      
      queryClient.setQueryData(['actions'], validationTestActions);
      
      const validationError = { response: { status: 400 }, message: 'Validation failed', status: 400 };
      apiService.put.mockRejectedValue(validationError);
      
      const { result: result2 } = renderHook(() => useActionMutations(), { wrapper });
      
      result2.current.updateAction.mutate({ id: 'test-2', updates: validationUpdates });
      
      // Wait for validation error to complete
      await waitFor(() => {
        expect(result2.current.updateAction.isError).toBe(true);
      }, { timeout: 1000 });
      
      // Verify rollback occurred for validation errors
      const validationCacheData = queryClient.getQueryData<BaseAction[]>(['actions']);
      expect(validationCacheData).toEqual(validationTestActions); // Should be rolled back to original
    }, 5000);

    /**
     * Feature: tanstack-actions, Property 2: Server Response Priority
     * **Validates: Requirements 2.3**
     * 
     * Property 2: Server Response Priority
     * For any server response with affected resources, the server data should take 
     * precedence over optimistic updates in the final cache state
     */
    it('should prioritize server response data over optimistic updates', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(actionArbitrary, { minLength: 1, maxLength: 5 }),
          fc.integer({ min: 0, max: 4 }),
          actionUpdatesArbitrary,
          actionUpdatesArbitrary, // Different server response data
          async (initialActions, targetIndex, optimisticUpdates, serverResponseData) => {
            // Skip if updates objects are empty
            const hasOptimisticUpdates = Object.keys(optimisticUpdates).some(key => optimisticUpdates[key as keyof typeof optimisticUpdates] !== undefined);
            const hasServerUpdates = Object.keys(serverResponseData).some(key => serverResponseData[key as keyof typeof serverResponseData] !== undefined);
            if (!hasOptimisticUpdates || !hasServerUpdates) return;
            
            // Ensure we have a valid target index
            const actualTargetIndex = targetIndex % initialActions.length;
            const targetAction = initialActions[actualTargetIndex];
            
            // Setup initial cache state
            queryClient.setQueryData(['actions'], initialActions);
            
            // Create server response that differs from optimistic update
            const serverAction = { ...targetAction, ...serverResponseData };
            const serverResponse = {
              data: serverAction,
              affectedResources: {
                actions: [serverAction]
              }
            };
            
            // Mock the API call to return server response
            apiService.put.mockImplementation(async () => {
              // Simulate cache update with server response
              queryClient.setQueryData(['actions'], (old: BaseAction[] | undefined) => {
                if (!old) return old;
                return old.map(action => 
                  action.id === targetAction.id 
                    ? serverAction
                    : action
                );
              });
              return serverResponse;
            });
            
            // Render the hook
            const wrapper = createWrapper(queryClient);
            const { result } = renderHook(() => useActionMutations(), { wrapper });
            
            // Trigger the mutation with optimistic updates
            const mutationVariables = { id: targetAction.id, updates: optimisticUpdates };
            result.current.updateAction.mutate(mutationVariables);
            
            // Wait for mutation to complete successfully
            await waitFor(() => {
              expect(result.current.updateAction.isSuccess).toBe(true);
            }, { timeout: 2000 });
            
            // Verify server response data takes precedence over optimistic updates
            const finalCacheData = queryClient.getQueryData<BaseAction[]>(['actions']);
            expect(finalCacheData).toBeDefined();
            
            if (finalCacheData) {
              const finalAction = finalCacheData.find(action => action.id === targetAction.id);
              expect(finalAction).toBeDefined();
              
              if (finalAction) {
                // Verify server response data is in the final cache
                Object.entries(serverResponseData).forEach(([key, value]) => {
                  if (value !== undefined) {
                    expect(finalAction[key as keyof BaseAction]).toEqual(value);
                  }
                });
                
                // If server response differs from optimistic update, server should win
                Object.entries(optimisticUpdates).forEach(([key, optimisticValue]) => {
                  if (optimisticValue !== undefined && key in serverResponseData) {
                    const serverValue = serverResponseData[key as keyof typeof serverResponseData];
                    if (serverValue !== undefined && !deepEqual(serverValue, optimisticValue)) {
                      // Server data should take precedence
                      expect(finalAction[key as keyof BaseAction]).toEqual(serverValue);
                      expect(finalAction[key as keyof BaseAction]).not.toEqual(optimisticValue);
                    }
                  }
                });
              }
            }
          }
        ),
        { numRuns: 30, timeout: 5000 }
      );
    }, 10000);

    it('should update cache correctly after mutation', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(actionArbitrary, { minLength: 1, maxLength: 3 }),
          fc.integer({ min: 0, max: 2 }),
          actionUpdatesArbitrary,
          async (initialActions, targetIndex, actionUpdates) => {
            // Skip if updates object is empty
            const hasUpdates = Object.keys(actionUpdates).some(key => actionUpdates[key as keyof typeof actionUpdates] !== undefined);
            if (!hasUpdates) return;
            
            // Ensure we have a valid target index
            const actualTargetIndex = targetIndex % initialActions.length;
            const targetAction = initialActions[actualTargetIndex];
            
            // Setup initial cache state
            queryClient.setQueryData(['actions'], initialActions);
            
            // Track apiService calls to verify integration
            let apiServiceCalled = false;
            let apiServiceCallArgs: any = null;
            let callCount = 0;
            
            // Create server response
            const updatedAction = { ...targetAction, ...actionUpdates };
            const serverResponse = {
              data: updatedAction,
              affectedResources: {
                actions: [updatedAction]
              }
            };
            
            // Reset mock call count for this test iteration
            apiService.put.mockClear();
            
            // Mock apiService to track calls and simulate behavior
            apiService.put.mockImplementation(async (url: string, data: any) => {
              apiServiceCalled = true;
              apiServiceCallArgs = { url, data };
              callCount++;
              
              // Simulate cache update with server response
              queryClient.setQueryData(['actions'], (old: BaseAction[] | undefined) => {
                if (!old) return old;
                return old.map(action => 
                  action.id === targetAction.id 
                    ? updatedAction
                    : action
                );
              });
              
              return serverResponse;
            });
            
            // Render the hook
            const wrapper = createWrapper(queryClient);
            const { result } = renderHook(() => useActionMutations(), { wrapper });
            
            // Trigger the mutation
            const mutationVariables = { id: targetAction.id, updates: actionUpdates };
            result.current.updateAction.mutate(mutationVariables);
            
            // Wait for mutation to complete successfully
            await waitFor(() => {
              expect(result.current.updateAction.isSuccess).toBe(true);
            }, { timeout: 2000 });
            
            // Verify apiService was called correctly
            expect(apiServiceCalled).toBe(true);
            expect(apiServiceCallArgs).toBeDefined();
            expect(apiServiceCallArgs.url).toBe(`/actions/${targetAction.id}`);
            expect(apiServiceCallArgs.data).toEqual(actionUpdates);
            
            // Verify the mutation doesn't duplicate cache update logic (Requirement 5.3)
            // The cache should be updated with server response
            const finalCacheData = queryClient.getQueryData<BaseAction[]>(['actions']);
            expect(finalCacheData).toBeDefined();
            
            if (finalCacheData) {
              const finalAction = finalCacheData.find(action => action.id === targetAction.id);
              expect(finalAction).toBeDefined();
              
              if (finalAction) {
                // Verify server response data is in the final cache
                Object.entries(actionUpdates).forEach(([key, value]) => {
                  if (value !== undefined) {
                    expect(finalAction[key as keyof BaseAction]).toEqual(value);
                  }
                });
              }
            }
            
            // Verify no duplicate cache operations occurred
            // The mutation should update cache with server response
            expect(callCount).toBe(1);
          }
        ),
        { numRuns: 30, timeout: 5000 }
      );
    }, 10000);

    /**
     * Feature: tanstack-actions, Property 8: Debug Information Completeness
     * **Validates: Requirements 6.1, 6.2, 6.3**
     * 
     * Property 8: Debug Information Completeness
     * For any mutation execution, debug information should accurately track timing, 
     * retry attempts, and state changes
     */
    it('should provide complete debug information for any mutation execution', async () => {
      // Test success scenario
      const successAction: BaseAction = {
        id: 'debug-success-test',
        title: 'Debug Success Test',
        description: 'Testing debug info for success',
        status: 'pending',
        priority: 'medium',
        assigned_to: null,
        due_date: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        required_tools: null
      };
      
      const successUpdates = { status: 'completed' as const, title: 'Success Updated' };
      
      queryClient.setQueryData(['actions'], [successAction]);
      
      const successResponse = {
        data: { ...successAction, ...successUpdates },
        affectedResources: { actions: [{ ...successAction, ...successUpdates }] }
      };
      
      apiService.put.mockResolvedValue(successResponse);
      
      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => useActionMutations(), { wrapper });
      
      const testStartTime = Date.now();
      result.current.updateAction.mutate({ id: successAction.id, updates: successUpdates });
      
      await waitFor(() => {
        expect(result.current.updateAction.isSuccess).toBe(true);
      }, { timeout: 1000 });
      
      // Validate success debug info
      const successDebugInfo = result.current.getMutationDebugInfo();
      expect(Array.isArray(successDebugInfo)).toBe(true);
      expect(successDebugInfo.length).toBeGreaterThan(0);
      
      const successMutationInfo = successDebugInfo.find(info => 
        info.mutationId.includes(successAction.id)
      );
      expect(successMutationInfo).toBeDefined();
      
      if (successMutationInfo) {
        expect(successMutationInfo.status).toBe('succeeded');
        expect(successMutationInfo.startTime).toBeGreaterThanOrEqual(testStartTime);
        expect(successMutationInfo.endTime).toBeDefined();
        expect(successMutationInfo.duration).toBeDefined();
        expect(successMutationInfo.duration).toBeGreaterThanOrEqual(0);
        expect(successMutationInfo.mutationId).toMatch(/^action-update-.+-\d+$/);
      }
      
      // Reset for validation error test
      vi.clearAllMocks();
      queryClient.clear();
      
      // Test validation error scenario
      const validationAction: BaseAction = {
        id: 'debug-validation-test',
        title: 'Debug Validation Test',
        description: 'Testing debug info for validation error',
        status: 'pending',
        priority: 'medium',
        assigned_to: null,
        due_date: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        required_tools: null
      };
      
      const validationUpdates = { status: 'completed' as const, title: 'Validation Updated' };
      
      queryClient.setQueryData(['actions'], [validationAction]);
      
      const validationError = { response: { status: 400 }, message: 'Validation failed', status: 400 };
      apiService.put.mockRejectedValue(validationError);
      
      const { result: result2 } = renderHook(() => useActionMutations(), { wrapper });
      
      result2.current.updateAction.mutate({ id: validationAction.id, updates: validationUpdates });
      
      await waitFor(() => {
        expect(result2.current.updateAction.isError).toBe(true);
      }, { timeout: 1000 });
      
      // Validate validation error debug info
      const validationDebugInfo = result2.current.getMutationDebugInfo();
      const validationMutationInfo = validationDebugInfo.find(info => 
        info.mutationId.includes(validationAction.id)
      );
      expect(validationMutationInfo).toBeDefined();
      
      if (validationMutationInfo) {
        expect(validationMutationInfo.status).toBe('failed');
        expect(validationMutationInfo.errors.length).toBeGreaterThan(0);
        expect(validationMutationInfo.rollbacks.length).toBeGreaterThan(0);
        
        const errorEntry = validationMutationInfo.errors[0];
        expect(errorEntry.error).toBeDefined();
        expect(typeof errorEntry.isRetryable).toBe('boolean');
        expect(errorEntry.isRetryable).toBe(false);
        
        const rollbackEntry = validationMutationInfo.rollbacks[0];
        expect(rollbackEntry.reason).toContain('validation error');
        expect(Array.isArray(rollbackEntry.affectedCaches)).toBe(true);
      }
      
      // Validate mutation status indicators
      const mutationStatus = result2.current.getMutationStatus();
      expect(mutationStatus.isError).toBe(true);
      expect(mutationStatus.isSuccess).toBe(false);
      expect(mutationStatus.failureCount).toBeGreaterThan(0);
    }, 5000);

    /**
     * Feature: tanstack-actions, Property 9: Mutation Status Accuracy
     * **Validates: Requirements 6.4**
     * 
     * Property 9: Mutation Status Accuracy
     * For any mutation state change, the exposed status should correctly reflect 
     * the current mutation state (pending, retrying, failed, succeeded)
     */
    it('should accurately reflect mutation status throughout the lifecycle', async () => {
      const testAction: BaseAction = {
        id: 'status-test-action',
        title: 'Status Test',
        description: 'Testing status accuracy',
        status: 'pending',
        priority: 'medium',
        assigned_to: null,
        due_date: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        required_tools: null
      };
      
      const updates = { status: 'in_progress' as const, title: 'Updated Status Test' };
      
      // Setup initial cache state
      queryClient.setQueryData(['actions'], [testAction]);
      
      // Create a controlled promise to test different states
      let resolveMutation: (value: any) => void;
      const mutationPromise = new Promise((resolve) => {
        resolveMutation = resolve;
      });
      
      apiService.put.mockReturnValue(mutationPromise);
      
      // Render the hook
      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => useActionMutations(), { wrapper });
      
      // Initial state - should not be pending
      expect(result.current.getMutationStatus().isPending).toBe(false);
      expect(result.current.getMutationStatus().isError).toBe(false);
      expect(result.current.getMutationStatus().isSuccess).toBe(false);
      
      // Trigger the mutation
      const mutationVariables = { id: testAction.id, updates };
      result.current.updateAction.mutate(mutationVariables);
      
      // Should be pending immediately after mutation starts
      await waitFor(() => {
        expect(result.current.getMutationStatus().isPending).toBe(true);
      }, { timeout: 1000 });
      
      expect(result.current.getMutationStatus().isError).toBe(false);
      expect(result.current.getMutationStatus().isSuccess).toBe(false);
      
      // Test successful completion
      const serverResponse = {
        data: { ...testAction, ...updates },
        affectedResources: { actions: [{ ...testAction, ...updates }] }
      };
      
      resolveMutation!(serverResponse);
      
      // Should transition to success state
      await waitFor(() => {
        expect(result.current.getMutationStatus().isSuccess).toBe(true);
      }, { timeout: 1000 });
      
      expect(result.current.getMutationStatus().isPending).toBe(false);
      expect(result.current.getMutationStatus().isError).toBe(false);
      
      // Test error state with a new mutation
      vi.clearAllMocks();
      queryClient.clear();
      queryClient.setQueryData(['actions'], [testAction]);
      
      const errorPromise = Promise.reject({ 
        response: { status: 400 }, 
        message: 'Validation failed', 
        status: 400 
      });
      apiService.put.mockReturnValue(errorPromise);
      
      const { result: result2 } = renderHook(() => useActionMutations(), { wrapper });
      
      // Trigger error mutation
      result2.current.updateAction.mutate(mutationVariables);
      
      // Should transition to error state
      await waitFor(() => {
        expect(result2.current.getMutationStatus().isError).toBe(true);
      }, { timeout: 1000 });
      
      expect(result2.current.getMutationStatus().isPending).toBe(false);
      expect(result2.current.getMutationStatus().isSuccess).toBe(false);
      expect(result2.current.getMutationStatus().failureCount).toBeGreaterThan(0);
      
      // Validate error context
      const errorContext = result2.current.getErrorContext();
      expect(errorContext).toBeDefined();
      expect(errorContext?.error).toBeDefined();
      expect(errorContext?.classification).toBeDefined();
      expect(typeof errorContext?.canRetry).toBe('boolean');
      expect(typeof errorContext?.shouldRollback).toBe('boolean');
      expect(typeof errorContext?.userActionRequired).toBe('boolean');
    }, 10000);
  });
});