/**
 * Integration Test: Real API Response Validation
 * 
 * Tests action mutations against actual Lambda endpoints
 * Validates server-computed affected resources are properly cached
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useActionMutations } from '../../useActionMutations';
import { TestDataManager } from './testDataManager';
import { skipIfNotIntegrationEnv } from './config';
import React from 'react';

// Skip if not in integration test environment
if (skipIfNotIntegrationEnv()) {
  describe.skip('Integration Tests - Real API Validation', () => {});
} else {
  describe('Integration Tests - Real API Validation', () => {
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
     * Test: Create action through real Lambda endpoint
     * Validates: Requirements 7.1
     */
    it('should create actions through actual Lambda endpoints', async () => {
      const { result } = renderHook(() => useActionMutations(), { wrapper });

      // Create action through real API
      const testAction = await testDataManager.createTestAction({
        title: 'Real API Test Action',
        description: 'Testing real Lambda endpoint',
        status: 'pending',
        priority: 'high'
      });

      expect(testAction).toBeDefined();
      expect(testAction.id).toBeDefined();
      expect(testAction.title).toBe('Real API Test Action');
      expect(testAction.status).toBe('pending');
      expect(testAction.priority).toBe('high');

      // Verify action exists in database
      const retrievedAction = await testDataManager.getTestAction(testAction.id);
      expect(retrievedAction).toBeDefined();
      expect(retrievedAction?.id).toBe(testAction.id);
    }, 30000);

    /**
     * Test: Performance validation - optimistic updates are immediate
     * Validates: Requirements 7.8
     */
    it('should provide immediate optimistic updates while measuring real response times', async () => {
      const testAction = await testDataManager.createTestAction({
        status: 'pending',
        title: 'Performance Test Action'
      });

      // Setup initial cache state
      queryClient.setQueryData(['actions'], [testAction]);

      const { result } = renderHook(() => useActionMutations(), { wrapper });

      const updateData = {
        title: 'Optimistically Updated Title',
        status: 'in_progress' as const
      };

      // Measure optimistic update timing
      const optimisticStartTime = performance.now();
      
      result.current.updateAction.mutate({
        id: testAction.id,
        updates: updateData
      });

      // Verify optimistic update happened immediately (< 50ms)
      const optimisticEndTime = performance.now();
      const optimisticDuration = optimisticEndTime - optimisticStartTime;
      
      expect(optimisticDuration).toBeLessThan(50);

      // Verify cache was updated optimistically
      const optimisticCache = queryClient.getQueryData<any[]>(['actions']);
      const optimisticAction = optimisticCache?.find(action => action.id === testAction.id);
      expect(optimisticAction?.title).toBe('Optimistically Updated Title');
      expect(optimisticAction?.status).toBe('in_progress');

      // Wait for server response and measure total time
      const serverStartTime = performance.now();
      
      await waitFor(() => {
        expect(result.current.updateAction.isSuccess).toBe(true);
      }, { timeout: 15000 });

      const serverEndTime = performance.now();
      const serverDuration = serverEndTime - serverStartTime;

      // Verify server response took longer than optimistic update
      expect(serverDuration).toBeGreaterThan(optimisticDuration);

      // Verify debug information reflects real timing
      const debugInfo = result.current.getMutationDebugInfo();
      expect(Array.isArray(debugInfo)).toBe(true);
      
      const mutationInfo = debugInfo.find((info: any) => 
        info.mutationId.includes(testAction.id)
      );
      expect(mutationInfo).toBeDefined();
      expect(mutationInfo.duration).toBeGreaterThan(0);
      expect(mutationInfo.status).toBe('succeeded');

      console.log('Performance metrics:', {
        optimisticDuration,
        serverDuration,
        debugDuration: mutationInfo.duration
      });
    }, 30000);

    /**
     * Test: Cache consistency with real server responses
     * Validates: Requirements 7.6
     */
    it('should maintain cache consistency with real server responses', async () => {
      const testAction = await testDataManager.createTestAction({
        status: 'pending',
        priority: 'low'
      });

      // Setup initial cache state
      queryClient.setQueryData(['actions'], [testAction]);

      const { result } = renderHook(() => useActionMutations(), { wrapper });

      // Perform multiple updates
      const updates = [
        { priority: 'medium' as const },
        { priority: 'high' as const },
        { status: 'in_progress' as const }
      ];

      for (const update of updates) {
        result.current.updateAction.mutate({
          id: testAction.id,
          updates: update
        });

        await waitFor(() => {
          expect(result.current.updateAction.isSuccess || result.current.updateAction.isError).toBe(true);
        }, { timeout: 15000 });

        // Reset mutation state for next update
        result.current.updateAction.reset();
      }

      // Verify final cache state matches server
      const finalCache = queryClient.getQueryData<any[]>(['actions']);
      const finalAction = finalCache?.find(action => action.id === testAction.id);
      
      expect(finalAction?.priority).toBe('high');
      expect(finalAction?.status).toBe('in_progress');

      // Verify against actual database
      const dbAction = await testDataManager.getTestAction(testAction.id);
      expect(dbAction?.priority).toBe(finalAction?.priority);
      expect(dbAction?.status).toBe(finalAction?.status);
    }, 60000);
  });
}