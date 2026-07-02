import { useLocation, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiService } from '@/lib/apiService';
import { actionQueryKey, toolsQueryKey, actionsQueryKey, completedActionsQueryKey } from '@/lib/queryKeys';
import { offlineQueryConfig } from '@/lib/queryConfig';
import { BaseAction } from '@/types/actions';

export interface EntityContext {
  entityId: string;
  entityType: 'action' | 'tool' | 'part' | 'observation';
  entityName: string;
  policy: string;
  implementation: string;
}

/**
 * Hook to detect and extract entity context from the current URL
 * 
 * Detects entity detail pages:
 * - Actions: /actions/:actionId
 * - Tools: /combined-assets?view=tools&id=<toolId>
 * - Parts: /combined-assets?view=stock&id=<partId>
 * 
 * Returns EntityContext object or null if not on an entity detail page
 */
export function useEntityContext(): EntityContext | null {
  const location = useLocation();
  const params = useParams();
  const searchParams = new URLSearchParams(location.search);
  const queryClient = useQueryClient();

  // Detect action detail page from URL path
  // Note: useParams() doesn't work outside <Routes>, so we parse the path directly
  const actionId = location.pathname.startsWith('/actions/') 
    ? location.pathname.split('/')[2] 
    : undefined;
  
  // Detect tool/part detail page
  const view = searchParams.get('view');
  const assetId = searchParams.get('id');
  
  // Determine entity type and ID
  let entityType: 'action' | 'tool' | 'part' | null = null;
  let entityId: string | null = null;
  
  if (actionId) {
    entityType = 'action';
    entityId = actionId;
  } else if (assetId && view === 'tools') {
    entityType = 'tool';
    entityId = assetId;
  } else if (assetId && view === 'stock') {
    entityType = 'part';
    entityId = assetId;
  }
  
  // Check both caches for action data
  const cachedUnresolved = queryClient.getQueryData<BaseAction[]>(actionsQueryKey());
  const cachedCompleted = queryClient.getQueryData<BaseAction[]>(completedActionsQueryKey());
  const cachedAction = entityType === 'action' && entityId 
    ? cachedUnresolved?.find(a => a.id === entityId) || cachedCompleted?.find(a => a.id === entityId)
    : undefined;
  
  // Fetch action data only if not in cache
  const { data: actionData } = useQuery({
    queryKey: actionQueryKey(entityId || ''),
    queryFn: async () => {
      const result = await apiService.get(`/actions?id=${entityId}`);
      const actions = result.data || [];
      return actions[0] || null;
    },
    enabled: entityType === 'action' && !!entityId && !cachedAction,
    ...offlineQueryConfig,
  });
  
  // Fetch tool data
  const { data: toolData } = useQuery({
    queryKey: [...toolsQueryKey(), entityId],
    queryFn: async () => {
      const result = await apiService.get(`/tools/${entityId}`);
      return result.data || null;
    },
    enabled: entityType === 'tool' && !!entityId,
    ...offlineQueryConfig,
  });
  
  // Fetch part data
  const { data: partData } = useQuery({
    queryKey: ['parts', entityId],
    queryFn: async () => {
      const result = await apiService.get(`/parts/${entityId}`);
      return result.data || null;
    },
    enabled: entityType === 'part' && !!entityId,
    ...offlineQueryConfig,
  });
  
  // Build EntityContext based on entity type
  // Use cached action if available, otherwise use fetched data
  const finalActionData = cachedAction || actionData;
  
  if (entityType === 'action' && finalActionData) {
    return {
      entityId: finalActionData.id,
      entityType: 'action',
      entityName: finalActionData.title || 'Untitled Action',
      policy: finalActionData.policy || '',
      implementation: finalActionData.observations || '',
    };
  }
  
  if (entityType === 'tool' && toolData) {
    return {
      entityId: toolData.id,
      entityType: 'tool',
      entityName: toolData.name || 'Untitled Tool',
      policy: toolData.description || '',
      implementation: '', // Tools don't have implementation field
    };
  }
  
  if (entityType === 'part' && partData) {
    return {
      entityId: partData.id,
      entityType: 'part',
      entityName: partData.name || 'Untitled Part',
      policy: partData.description || '',
      implementation: '', // Parts don't have implementation field
    };
  }
  
  return null;
}
