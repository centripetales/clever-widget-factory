import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Tool } from './useToolsData';
import { toolsQueryKey } from '@/lib/queryKeys';

export const useParentStructures = () => {
  const queryClient = useQueryClient();
  
  // Get tools and parts directly from cache (already loaded by useCombinedAssets)
  // This is instant - no query, no network call, just reading from memory
  const toolsData = queryClient.getQueryData<Tool[]>(toolsQueryKey()) || [];
  // Parts are stored as array directly in cache
  const partsData = queryClient.getQueryData<any[]>(['parts']) || [];
  
  // Compute item counts per area once (used for both sorting and display)
  const areaItemCounts = useMemo(() => {
    const counts = new Map<string, number>();
    
    // Count tools associated with each area
    toolsData.forEach((tool: Tool) => {
      if (tool.parent_structure_id) {
        counts.set(tool.parent_structure_id, (counts.get(tool.parent_structure_id) || 0) + 1);
      }
    });
    
    // Count parts associated with each area
    partsData.forEach((part: any) => {
      if (part.parent_structure_id) {
        counts.set(part.parent_structure_id, (counts.get(part.parent_structure_id) || 0) + 1);
      }
    });
    
    return counts;
  }, [toolsData, partsData]);

  // Filter client-side: Infrastructure or Container category, and not removed
  // This is O(n) where n is typically < 2000, so it's extremely fast (< 1ms)
  // Sort by item count (descending), then alphabetically by name
  const parentStructures = useMemo(() => {
    return toolsData
      .filter((tool: Tool) => {
        const isInfrastructureOrContainer = tool.category === 'Infrastructure' || tool.category === 'Container' || tool.category === 'Field';
        const isNotRemoved = tool.status !== 'removed' && tool.status !== 'concluded';
        return isInfrastructureOrContainer && isNotRemoved;
      })
      .sort((a, b) => {
        const countA = areaItemCounts.get(a.id) || 0;
        const countB = areaItemCounts.get(b.id) || 0;
        
        // Sort by count descending, then alphabetically by name
        if (countB !== countA) {
          return countB - countA; // Descending by count
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }); // Alphabetical tiebreaker
      });
  }, [toolsData, areaItemCounts]);

  // Check if tools query is still loading (from the query state)
  const queryState = queryClient.getQueryState(toolsQueryKey());
  const loading = queryState?.status === 'pending' || queryState?.isFetching || false;

  return {
    parentStructures,
    areaItemCounts,
    loading,
    refetch: () => {
      // Invalidate the tools query to trigger a refetch
      queryClient.invalidateQueries({ queryKey: toolsQueryKey() });
    }
  };
};