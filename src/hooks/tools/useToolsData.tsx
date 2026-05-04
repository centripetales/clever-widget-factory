import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { toolsQueryKey } from '@/lib/queryKeys';
import { toolsQueryConfig } from '@/lib/assetQueryConfigs';

export interface Tool {
  id: string;
  name: string;
  description?: string;
  category?: string;
  status: string;
  image_url?: string;
  legacy_storage_vicinity?: string;
  parent_structure_id?: string;
  storage_location: string | null;
  actual_location?: string;
  serial_number?: string;
  last_maintenance?: string;
  manual_url?: string;
  
  policy?: string;
  created_at: string;
  updated_at: string;
  has_motor?: boolean;
  last_audited_at?: string;
  audit_status?: string;
  
  // Checkout fields from Lambda API
  is_checked_out?: boolean;
  checked_out_user_id?: string;
  checked_out_to?: string;
  checked_out_date?: string;
  expected_return_date?: string;
  checkout_intended_usage?: string;
  checkout_notes?: string;
}

export const useToolsData = (showRemovedItems: boolean = false) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Subscribe to tools cache. If the cache is already populated (e.g. user visited
  // Combined Assets), use it directly. If empty, trigger a fetch so the selector works
  // even when opened without visiting Combined Assets first.
  const { data: toolsData = [] } = useQuery<Tool[]>({
    ...toolsQueryConfig,
    // Enable fetching when cache is empty so AssetSelector always has data
    enabled: true,
    staleTime: 5 * 60 * 1000, // 5 minutes — don't refetch if recently loaded
  });

  // Filter out removed items if needed
  let tools = toolsData;
  if (!showRemovedItems) {
    tools = toolsData.filter((tool: Tool) => tool.status !== 'removed');
  }

  // Build checkout map from tool data (checkout fields are included in the tools API response)
  // No separate /checkouts fetch needed
  const activeCheckouts: {[key: string]: {user_name: string, user_id: string}} = {};
  toolsData.forEach((tool: Tool) => {
    if (tool.is_checked_out && tool.checked_out_user_id) {
      activeCheckouts[tool.id] = {
        user_name: tool.checked_out_to || 'Unknown',
        user_id: tool.checked_out_user_id
      };
    }
  });

  const updateTool = async (toolId: string, updates: any) => {
    // TODO: Implement tool updates via AWS API
    console.warn('Tool updates not yet implemented for AWS API');
    return false;
  };

  const createTool = async (toolData: any) => {
    // TODO: Implement tool creation via AWS API
    console.warn('Tool creation not yet implemented for AWS API');
    return null;
  };

  const invalidateTools = () => {
    queryClient.invalidateQueries({ queryKey: toolsQueryKey() });
  };

  return {
    tools,
    loading: false, // Data comes from cache, no loading state
    activeCheckouts,
    fetchTools: invalidateTools, // For backward compatibility
    updateTool,
    createTool,
    refetch: invalidateTools
  };
};