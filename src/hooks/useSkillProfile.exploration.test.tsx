/**
 * Bug Condition Exploration Tests — useSkillProfile hook
 *
 * These tests encode the EXPECTED (correct) behavior.
 * They MUST FAIL on unfixed code — failure confirms the bug exists.
 * They will PASS after the fix is applied.
 *
 * Property 1c — Error Log (Bug 4)
 *
 * Bug condition: typeof error === 'object' AND error.message EXISTS
 * Expected behavior: console.error second argument is the message string
 * Current (buggy) behavior: console.error second argument is the raw object ([object Object])
 *
 * Counterexample: console.error('Failed to generate skill profile:', [object Object])
 *
 * Requirements: 1.4
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useGenerateSkillProfile } from './useSkillProfile';
import { apiService } from '@/lib/apiService';

vi.mock('@/lib/apiService', () => ({
  apiService: {
    post: vi.fn(),
  },
}));

vi.mock('@/lib/queryKeys', () => ({
  actionsQueryKey: vi.fn(() => ['actions']),
}));

const createWrapper = (queryClient: QueryClient) => {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
};

// ── Property 1c — Error Log ───────────────────────────────────────────────────
// **Validates: Requirements 1.4**
//
// This test MUST FAIL on unfixed code.
// Counterexample: console.error called with raw object as second argument,
// which serializes to '[object Object]' in log output.

describe('Property 1c — Error Log: useGenerateSkillProfile onError logs message string', () => {
  let queryClient: QueryClient;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('onError logs the error message string, not [object Object]', async () => {
    // Simulate the error object that apiService throws on a 503 response
    const apiError = {
      message: 'AI service temporarily unavailable',
      status: 503,
      statusText: 'Service Unavailable',
    };

    vi.mocked(apiService.post).mockRejectedValueOnce(apiError);

    const wrapper = createWrapper(queryClient);
    const { result } = renderHook(() => useGenerateSkillProfile(), { wrapper });

    // Trigger the mutation — it will fail and call onError
    result.current.mutate({
      action_id: 'action-123',
      action_context: {
        title: 'Apply gypsum to test plot',
      },
    });

    // Wait for the mutation to fail and onError to be called
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // Verify console.error was called
    expect(consoleErrorSpy).toHaveBeenCalled();

    // Find the call with 'Failed to generate skill profile:'
    const relevantCall = consoleErrorSpy.mock.calls.find(
      (call) => call[0] === 'Failed to generate skill profile:'
    );
    expect(relevantCall).toBeDefined();

    const secondArg = relevantCall![1];

    // Assert the second argument is the message string, not the raw object
    // FAILS on unfixed code: secondArg === { message: '...', status: 503, ... } (logs as [object Object])
    // PASSES after fix:      secondArg === 'AI service temporarily unavailable'
    expect(typeof secondArg).toBe('string');
    expect(secondArg).toBe('AI service temporarily unavailable');
  });

  it('onError does not log [object Object] when error has a message property', async () => {
    const apiError = {
      message: 'AI service temporarily unavailable',
      status: 503,
      statusText: 'Service Unavailable',
    };

    vi.mocked(apiService.post).mockRejectedValueOnce(apiError);

    const wrapper = createWrapper(queryClient);
    const { result } = renderHook(() => useGenerateSkillProfile(), { wrapper });

    result.current.mutate({
      action_id: 'action-789',
      action_context: { title: 'Test action' },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // Verify the raw object is NOT passed as the second argument
    // (which would serialize to '[object Object]' in string contexts)
    const relevantCall = consoleErrorSpy.mock.calls.find(
      (call) => call[0] === 'Failed to generate skill profile:'
    );
    expect(relevantCall).toBeDefined();

    const secondArg = relevantCall![1];

    // The second arg must NOT be the raw error object
    // FAILS on unfixed code: secondArg is the raw object { message, status, statusText }
    expect(secondArg).not.toEqual(apiError);
    expect(secondArg).not.toBeInstanceOf(Object);
  });
});
