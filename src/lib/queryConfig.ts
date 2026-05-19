import { keepPreviousData } from '@tanstack/react-query';

// Re-export for convenience
export { keepPreviousData };

// Shared offline-first configuration for all queries
// Uses immediate render with background fetch pattern
export const offlineQueryConfig = {
  staleTime: 24 * 60 * 60 * 1000, // 24 hours - optimistic updates handle own changes, clear cache for others' changes
  gcTime: 7 * 24 * 60 * 60 * 1000, // 7 days
  networkMode: 'offlineFirst' as const, // Use cache when offline
  placeholderData: keepPreviousData,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
};

export const offlineMutationConfig = {
  networkMode: 'always' as const, // Execute mutations even when offline
  retry: 0, // Disable retries - fail fast so user sees actual error
};