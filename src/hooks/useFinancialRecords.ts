/**
 * TanStack Query Hooks for Financial Records
 *
 * Provides hooks for:
 * - Listing financial records with filters and running balance
 * - Fetching a single financial record with edit history
 * - Creating, updating, and deleting financial records
 * - Cache management with optimistic updates (update) and invalidation (create/delete)
 *
 * Requirements: 6.1, 5.1, 7.1
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  financialRecordsService,
  type CreateFinancialRecordRequest,
  type UpdateFinancialRecordRequest,
} from '../services/financialRecordsService';
import type {
  FinancialRecordFilters,
  FinancialRecordListResponse,
  FinancialRecord,
} from '../types/financialRecords';

// Query key factory
export const financialRecordKeys = {
  all: ['financial-records'] as const,
  lists: () => [...financialRecordKeys.all, 'list'] as const,
  list: (filters?: FinancialRecordFilters) => [...financialRecordKeys.lists(), filters] as const,
  details: () => [...financialRecordKeys.all, 'detail'] as const,
  detail: (id: string) => [...financialRecordKeys.details(), id] as const,
};

/**
 * Hook to fetch financial records with optional filters.
 * Returns records, running balance, and total count.
 */
export function useFinancialRecords(filters?: FinancialRecordFilters) {
  return useQuery({
    queryKey: financialRecordKeys.list(filters),
    queryFn: () => financialRecordsService.listRecords(filters),
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
  });
}

/**
 * Hook to fetch a single financial record by ID (includes edit history).
 */
export function useFinancialRecord(id: string) {
  return useQuery({
    queryKey: financialRecordKeys.detail(id),
    queryFn: () => financialRecordsService.getRecord(id),
    enabled: !!id,
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
  });
}

/**
 * Hook to create a new financial record.
 * Invalidates list queries on success so fresh data (including recomputed balance) is fetched.
 */
export function useCreateFinancialRecord() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateFinancialRecordRequest) =>
      financialRecordsService.createRecord(data),
    onSuccess: (newRecord) => {
      // Prepend the new record to all list caches for instant UI update
      queryClient.setQueriesData<FinancialRecordListResponse>(
        { queryKey: financialRecordKeys.lists() },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            records: [newRecord, ...old.records],
            total_count: old.total_count + 1,
          } as FinancialRecordListResponse;
        }
      );

      // Seed the detail cache
      queryClient.setQueryData(
        financialRecordKeys.detail(newRecord.id),
        newRecord as FinancialRecord
      );

      // Background refetch for accurate running_balance
      queryClient.invalidateQueries({
        queryKey: financialRecordKeys.lists(),
      });
    },
    onError: (error) => {
      console.error('Failed to create financial record:', error);
    },
  });
}

/**
 * Hook to update an existing financial record.
 * Uses optimistic updates on the list cache for instant UI feedback,
 * with rollback on error.
 */
export function useUpdateFinancialRecord() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateFinancialRecordRequest }) =>
      financialRecordsService.updateRecord(id, data),
    onMutate: async ({ id, data }) => {
      // Cancel any outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: financialRecordKeys.lists() });
      await queryClient.cancelQueries({ queryKey: financialRecordKeys.detail(id) });

      // Snapshot previous list queries for rollback
      const previousLists = queryClient.getQueriesData<FinancialRecordListResponse>({
        queryKey: financialRecordKeys.lists(),
      });

      // Snapshot previous detail for rollback
      const previousDetail = queryClient.getQueryData<FinancialRecord>(
        financialRecordKeys.detail(id)
      );

      // Optimistically update all list caches
      queryClient.setQueriesData<FinancialRecordListResponse>(
        { queryKey: financialRecordKeys.lists() },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            records: old.records.map((record) =>
              record.id === id ? { ...record, ...data, updated_at: new Date().toISOString() } : record
            ),
          } as FinancialRecordListResponse;
        }
      );

      // Optimistically update detail cache
      if (previousDetail) {
        queryClient.setQueryData<FinancialRecord>(
          financialRecordKeys.detail(id),
          { ...previousDetail, ...data, updated_at: new Date().toISOString() } as FinancialRecord
        );
      }

      return { previousLists, previousDetail };
    },
    onError: (_error, { id }, context) => {
      console.error('Failed to update financial record:', _error);

      // Rollback list caches
      if (context?.previousLists) {
        context.previousLists.forEach(([queryKey, data]) => {
          if (data) {
            queryClient.setQueryData(queryKey, data);
          }
        });
      }

      // Rollback detail cache
      if (context?.previousDetail) {
        queryClient.setQueryData(
          financialRecordKeys.detail(id),
          context.previousDetail
        );
      }
    },
    onSettled: (_data, _error, { id }) => {
      // Refetch to ensure server state is in sync
      queryClient.invalidateQueries({ queryKey: financialRecordKeys.lists() });
      queryClient.invalidateQueries({ queryKey: financialRecordKeys.detail(id) });
    },
  });
}

/**
 * Hook to delete a financial record.
 * Invalidates list queries on success so balance is recomputed from server.
 */
export function useDeleteFinancialRecord() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      financialRecordsService.deleteRecord(id),
    onSuccess: (_data, id) => {
      // Invalidate all list queries to refetch with recomputed balance
      queryClient.invalidateQueries({
        queryKey: financialRecordKeys.lists(),
      });

      // Remove the detail from cache
      queryClient.removeQueries({
        queryKey: financialRecordKeys.detail(id),
      });
    },
    onError: (error) => {
      console.error('Failed to delete financial record:', error);
    },
  });
}
