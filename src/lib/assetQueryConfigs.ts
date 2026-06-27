/**
 * Shared query configurations for tools and parts.
 *
 * These configs are the single source of truth for fetching tools and parts data.
 * Any component that reads from the ['tools'] or ['parts'] cache should reference
 * these configs so TanStack Query always has a registered queryFn — even when
 * the query is disabled (enabled: false) for cache-only subscribers.
 *
 * Usage:
 *   // Full fetch (e.g. useCombinedAssets, Dashboard prefetch):
 *   useQuery({ ...toolsQueryConfig, ...offlineQueryConfig })
 *
 *   // Cache-only subscriber (e.g. StockSelector, useToolsData):
 *   useQuery({ ...partsQueryConfig, enabled: false })
 */

import { apiService } from '@/lib/apiService';
import { toolsQueryKey, partsQueryKey, actionsQueryKey, completedActionsQueryKey } from '@/lib/queryKeys';

export const toolsQueryConfig = {
  queryKey: toolsQueryKey(),
  queryFn: async () => {
    const result = await apiService.get('/tools?limit=2000');
    return result.data || [];
  },
};

export const partsQueryConfig = {
  queryKey: partsQueryKey(),
  queryFn: async () => {
    const result = await apiService.get('/parts?limit=2000');
    return result.data || [];
  },
};

export const actionsQueryConfig = {
  queryKey: actionsQueryKey(),
  queryFn: async () => {
    const result = await apiService.get('/actions?status=unresolved');
    return result.data || [];
  },
};

export const completedActionsQueryConfig = {
  queryKey: completedActionsQueryKey(),
  queryFn: async () => {
    const result = await apiService.get('/actions?status=completed');
    return result.data || [];
  },
};
