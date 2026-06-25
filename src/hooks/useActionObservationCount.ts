import { useQueryClient } from '@tanstack/react-query';
import { statesQueryKey } from '../lib/queryKeys';

/**
 * Custom hook to derive observation count from TanStack Query cache
 * 
 * This hook reads the states cache for a specific action and returns the count.
 * It avoids the need to maintain a separate implementation_update_count field
 * and eliminates unnecessary database queries.
 * 
 * @param orgId - The active organization ID (required for org-scoped cache key)
 * @param actionId - The action ID to get observation count for
 * @returns The number of observations (states) linked to this action, or undefined if not in cache
 */
export function useActionObservationCount(orgId: string, actionId: string): number | undefined {
  const queryClient = useQueryClient();
  
  // Try to get states from cache for this action
  const states = queryClient.getQueryData(
    statesQueryKey(orgId, { entity_type: 'action', entity_id: actionId })
  ) as any[] | undefined;
  
  // Return count if states are in cache, undefined otherwise
  return states?.length;
}
