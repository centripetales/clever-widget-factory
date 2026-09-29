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
  
  // Geolocation fields populated by list API
  gps_latitude?: number;
  gps_longitude?: number;

  // Sharing fields
  organization_id?: string;
  is_shared_inbound?: boolean;
  // In use: derived from the most recent in-progress action requiring the tool
  in_use_action_id?: string | null;
  in_use_action_title?: string | null;
  in_use_org_name?: string | null;
  in_use_by?: string | null;
  in_use_since?: string | null;
  is_shared_outbound?: boolean;
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
    fetchTools: invalidateTools, // For backward compatibility
    updateTool,
    createTool,
    refetch: invalidateTools
  };
};