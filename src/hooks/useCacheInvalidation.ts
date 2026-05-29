import { useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from './useWebSocket';
import {
  toolsQueryKey,
  partsQueryKey,
  actionsQueryKey,
  completedActionsQueryKey,
  allActionsQueryKey,
  actionQueryKey,
  missionsQueryKey,
  explorationsQueryKey,
  experiencesQueryKey,
  statesQueryKey,
} from '@/lib/queryKeys';

// Shared map of stateId → { estimatedSeconds, startedAt } for active perspective jobs
export const perspectivesProcessingMap = new Map<string, { estimatedSeconds: number; startedAt: number }>();
export const perspectivesProcessingListeners = new Set<() => void>();

function notifyProcessingListeners() {
  perspectivesProcessingListeners.forEach(fn => fn());
}

interface CacheInvalidatePayload {
  entityType: string;
  entityId: string;
  mutationType: 'created' | 'updated' | 'deleted';
}

interface PerspectivesProcessingPayload {
  stateId: string;
  estimatedSeconds: number;
}

/**
 * Subscribes to `cache:invalidate` WebSocket messages and invalidates
 * the corresponding TanStack Query caches so all connected clients
 * see fresh data without a manual refresh.
 *
 * Also handles `perspectives:processing` to populate perspectivesProcessingMap
 * and `perspectives:complete` (via cache:invalidate for entity type 'state').
 */
export function useCacheInvalidation() {
  const { subscribe } = useWebSocket();
  const queryClient = useQueryClient();

  useEffect(() => {
    const unsubscribeInvalidate = subscribe('cache:invalidate', (payload: CacheInvalidatePayload) => {
      const { entityType, entityId } = payload;

      switch (entityType) {
        case 'tool':
          queryClient.invalidateQueries({ queryKey: toolsQueryKey() });
          break;

        case 'part':
          queryClient.invalidateQueries({ queryKey: partsQueryKey() });
          break;

        case 'action':
          queryClient.invalidateQueries({ queryKey: actionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: completedActionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: allActionsQueryKey() });
          if (entityId) {
            queryClient.invalidateQueries({ queryKey: actionQueryKey(entityId) });
          }
          break;

        case 'issue':
          break;

        case 'mission':
          queryClient.invalidateQueries({ queryKey: missionsQueryKey() });
          break;

        case 'exploration':
          queryClient.invalidateQueries({ queryKey: explorationsQueryKey() });
          break;

        case 'experience':
          queryClient.invalidateQueries({ queryKey: [experiencesQueryKey()[0]] });
          break;

        case 'checkout':
        case 'checkin':
          queryClient.invalidateQueries({ queryKey: toolsQueryKey() });
          break;

        case 'state':
          // Clear any active processing indicator for this state
          if (entityId && perspectivesProcessingMap.has(entityId)) {
            perspectivesProcessingMap.delete(entityId);
            notifyProcessingListeners();
          }
          queryClient.invalidateQueries({ queryKey: [statesQueryKey()[0]] });
          break;

        case 'policy':
          queryClient.invalidateQueries({ queryKey: explorationsQueryKey() });
          break;

        default:
          console.warn(`[useCacheInvalidation] Unknown entityType: "${entityType}", skipping invalidation`);
          break;
      }
    });

    const unsubscribeProcessing = subscribe('perspectives:processing', (payload: PerspectivesProcessingPayload) => {
      const { stateId, estimatedSeconds } = payload;
      perspectivesProcessingMap.set(stateId, { estimatedSeconds, startedAt: Date.now() });
      notifyProcessingListeners();
    });

    return () => {
      unsubscribeInvalidate();
      unsubscribeProcessing();
    };
  }, [subscribe, queryClient]);
}
