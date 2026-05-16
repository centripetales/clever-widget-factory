/**
 * Preservation Property Tests — useSkillProfile hook
 *
 * These tests capture CURRENT CORRECT behavior on unfixed code.
 * They MUST PASS now and MUST STILL PASS after the fixes are applied (no regressions).
 *
 * Properties tested:
 *   Property 2b — No Growth Intent Uses Full AI Narrative
 *   Property 2c — Approve/Delete Hook Error Handlers Unchanged
 *
 * Requirements: 3.8, 3.9
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import * as fc from 'fast-check';
import {
  useGenerateSkillProfile,
  useApproveSkillProfile,
  useDeleteSkillProfile,
} from './useSkillProfile';
import { apiService } from '@/lib/apiService';

vi.mock('@/lib/apiService', () => ({
  apiService: {
    post: vi.fn(),
    delete: vi.fn(),
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

// ── Property 2b — No Growth Intent Uses Full AI Narrative ─────────────────────
// **Validates: Requirements 3.8**
//
// When growth_intent is absent or empty, handleGenerate returns the AI-generated
// narrative as profile.narrative (a non-empty string).
//
// This test MUST PASS on unfixed code (baseline preservation).

describe('Property 2b — No Growth Intent: profile.narrative is AI-generated non-empty string', () => {
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

  it('returns AI-generated narrative when growth_intent is absent', async () => {
    const aiNarrative = 'This action requires understanding of soil chemistry and experimental design.';
    const mockProfile = {
      narrative: aiNarrative,
      axes: [
        { key: 'soil_chemistry', label: 'Soil Chemistry', required_level: 2 },
        { key: 'experimental_design', label: 'Experimental Design', required_level: 3 },
        { key: 'plant_physiology', label: 'Plant Physiology', required_level: 2 },
        { key: 'data_interpretation', label: 'Data Interpretation', required_level: 2 },
      ],
      generated_at: new Date().toISOString(),
    };

    vi.mocked(apiService.post).mockResolvedValueOnce({ data: mockProfile });

    const wrapper = createWrapper(queryClient);
    const { result } = renderHook(() => useGenerateSkillProfile(), { wrapper });

    result.current.mutate({
      action_id: 'action-123',
      action_context: {
        title: 'Apply gypsum to test plot',
        description: 'Testing gypsum effects on soil structure',
      },
      // No growth_intent provided
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const profile = result.current.data;
    expect(profile).toBeDefined();
    expect(typeof profile!.narrative).toBe('string');
    expect(profile!.narrative.trim()).not.toBe('');
    expect(profile!.narrative).toBe(aiNarrative);
  });

  it('returns AI-generated narrative when growth_intent is an empty string', async () => {
    const aiNarrative = 'This action requires understanding of soil chemistry and experimental design.';
    const mockProfile = {
      narrative: aiNarrative,
      axes: [
        { key: 'soil_chemistry', label: 'Soil Chemistry', required_level: 2 },
        { key: 'experimental_design', label: 'Experimental Design', required_level: 3 },
        { key: 'plant_physiology', label: 'Plant Physiology', required_level: 2 },
        { key: 'data_interpretation', label: 'Data Interpretation', required_level: 2 },
      ],
      generated_at: new Date().toISOString(),
    };

    vi.mocked(apiService.post).mockResolvedValueOnce({ data: mockProfile });

    const wrapper = createWrapper(queryClient);
    const { result } = renderHook(() => useGenerateSkillProfile(), { wrapper });

    result.current.mutate({
      action_id: 'action-456',
      action_context: {
        title: 'Apply gypsum to test plot',
      },
      growth_intent: '', // Empty string — treated as absent
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const profile = result.current.data;
    expect(profile).toBeDefined();
    expect(typeof profile!.narrative).toBe('string');
    expect(profile!.narrative.trim()).not.toBe('');
    expect(profile!.narrative).toBe(aiNarrative);
  });

  it('property-based: for all calls without growth_intent, narrative is a non-empty string', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate valid action contexts without growth_intent
        fc.record({
          title: fc.string({ minLength: 1, maxLength: 80 }),
          description: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
        }),
        async (actionContext) => {
          vi.clearAllMocks();

          const aiNarrative = `AI narrative for: ${actionContext.title}`;
          const mockProfile = {
            narrative: aiNarrative,
            axes: [
              { key: 'skill_a', label: 'Skill A', required_level: 2 },
              { key: 'skill_b', label: 'Skill B', required_level: 3 },
              { key: 'skill_c', label: 'Skill C', required_level: 1 },
              { key: 'skill_d', label: 'Skill D', required_level: 2 },
            ],
            generated_at: new Date().toISOString(),
          };

          vi.mocked(apiService.post).mockResolvedValueOnce({ data: mockProfile });

          const localQueryClient = new QueryClient({
            defaultOptions: {
              queries: { retry: false },
              mutations: { retry: false },
            },
          });

          const wrapper = createWrapper(localQueryClient);
          const { result } = renderHook(() => useGenerateSkillProfile(), { wrapper });

          result.current.mutate({
            action_id: 'action-pbt',
            action_context: actionContext,
            // No growth_intent
          });

          await waitFor(() => {
            expect(result.current.isSuccess || result.current.isError).toBe(true);
          });

          if (result.current.isSuccess) {
            const profile = result.current.data;
            // narrative must be a non-empty string (AI-generated)
            expect(typeof profile!.narrative).toBe('string');
            expect(profile!.narrative.trim().length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 10 }
    );
  });
});

// ── Property 2c — Approve/Delete Hook Error Handlers Unchanged ────────────────
// **Validates: Requirements 3.9**
//
// useApproveSkillProfile and useDeleteSkillProfile onError handlers log their
// respective messages and roll back optimistic cache updates.
// These handlers must be unaffected by any changes to useGenerateSkillProfile.
//
// This test MUST PASS on unfixed code (baseline preservation).

describe('Property 2c — Approve/Delete Hook Error Handlers Unchanged', () => {
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

  it('useApproveSkillProfile onError logs "Failed to approve skill profile:"', async () => {
    const apiError = {
      message: 'Action not found',
      status: 404,
      statusText: 'Not Found',
    };

    vi.mocked(apiService.post).mockRejectedValueOnce(apiError);

    const wrapper = createWrapper(queryClient);
    const { result } = renderHook(() => useApproveSkillProfile(), { wrapper });

    result.current.mutate({
      action_id: 'action-123',
      skill_profile: {
        narrative: 'Test narrative',
        axes: [
          { key: 'skill_a', label: 'Skill A', required_level: 2 },
          { key: 'skill_b', label: 'Skill B', required_level: 3 },
          { key: 'skill_c', label: 'Skill C', required_level: 1 },
          { key: 'skill_d', label: 'Skill D', required_level: 2 },
        ],
        generated_at: new Date().toISOString(),
      },
      approved_by: 'user-1',
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // Verify console.error was called with the approve message
    const approveCall = consoleErrorSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('Failed to approve skill profile:')
    );
    expect(approveCall).toBeDefined();
  });

  it('useDeleteSkillProfile onError logs "Failed to delete skill profile:"', async () => {
    const apiError = {
      message: 'Action not found',
      status: 404,
      statusText: 'Not Found',
    };

    vi.mocked(apiService.delete).mockRejectedValueOnce(apiError);

    const wrapper = createWrapper(queryClient);
    const { result } = renderHook(() => useDeleteSkillProfile(), { wrapper });

    result.current.mutate('action-123');

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // Verify console.error was called with the delete message
    const deleteCall = consoleErrorSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('Failed to delete skill profile:')
    );
    expect(deleteCall).toBeDefined();
  });

  it('useApproveSkillProfile onError rolls back optimistic cache update', async () => {
    const existingAction = {
      id: 'action-123',
      title: 'Test action',
      skill_profile: undefined,
    };

    // Pre-populate the cache with the existing action
    queryClient.setQueryData(['actions'], [existingAction]);

    const apiError = {
      message: 'Server error',
      status: 500,
      statusText: 'Internal Server Error',
    };

    vi.mocked(apiService.post).mockRejectedValueOnce(apiError);

    const wrapper = createWrapper(queryClient);
    const { result } = renderHook(() => useApproveSkillProfile(), { wrapper });

    result.current.mutate({
      action_id: 'action-123',
      skill_profile: {
        narrative: 'Test narrative',
        axes: [
          { key: 'skill_a', label: 'Skill A', required_level: 2 },
          { key: 'skill_b', label: 'Skill B', required_level: 3 },
          { key: 'skill_c', label: 'Skill C', required_level: 1 },
          { key: 'skill_d', label: 'Skill D', required_level: 2 },
        ],
        generated_at: new Date().toISOString(),
      },
      approved_by: 'user-1',
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // Cache should be rolled back to the original state
    const cachedActions = queryClient.getQueryData<any[]>(['actions']);
    expect(cachedActions).toEqual([existingAction]);
  });

  it('useDeleteSkillProfile onError rolls back optimistic cache update', async () => {
    const existingAction = {
      id: 'action-123',
      title: 'Test action',
      skill_profile: { narrative: 'Existing profile', axes: [], generated_at: '' },
    };

    // Pre-populate the cache with the existing action
    queryClient.setQueryData(['actions'], [existingAction]);

    const apiError = {
      message: 'Server error',
      status: 500,
      statusText: 'Internal Server Error',
    };

    vi.mocked(apiService.delete).mockRejectedValueOnce(apiError);

    const wrapper = createWrapper(queryClient);
    const { result } = renderHook(() => useDeleteSkillProfile(), { wrapper });

    result.current.mutate('action-123');

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // Cache should be rolled back to the original state (skill_profile restored)
    const cachedActions = queryClient.getQueryData<any[]>(['actions']);
    expect(cachedActions).toEqual([existingAction]);
  });

  it('useApproveSkillProfile and useDeleteSkillProfile error handlers are independent of useGenerateSkillProfile', () => {
    // Verify that the hooks are separate and their error handlers are independent
    // by checking they can be instantiated and used simultaneously
    const wrapper = createWrapper(queryClient);

    const { result: generateResult } = renderHook(() => useGenerateSkillProfile(), { wrapper });
    const { result: approveResult } = renderHook(() => useApproveSkillProfile(), { wrapper });
    const { result: deleteResult } = renderHook(() => useDeleteSkillProfile(), { wrapper });

    // All three hooks should be in idle state initially
    expect(generateResult.current.isPending).toBe(false);
    expect(approveResult.current.isPending).toBe(false);
    expect(deleteResult.current.isPending).toBe(false);

    // Each hook should have its own mutate function
    expect(typeof generateResult.current.mutate).toBe('function');
    expect(typeof approveResult.current.mutate).toBe('function');
    expect(typeof deleteResult.current.mutate).toBe('function');
  });
});
