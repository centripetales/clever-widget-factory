import { useQuery } from "@tanstack/react-query";
import { supabase } from '@/lib/client';
import { apiService, getApiData } from '@/lib/apiService';

interface CategoryData {
  category: string;
  count: number;
}

interface UserActivityData {
  date: string;
  created: number;
  modified: number;
  used: number;
}

interface UserActivityByPerson {
  date: string;
  user: string;
  created: number;
  modified: number;
  used: number;
}

interface AdditionsTrendData {
  date: string;
  user: string;
  count: number;
}

interface DetailedActivityRecord {
  id: string;
  date: string;
  user: string;
  userName: string;
  type: 'created' | 'modified' | 'used';
  partName: string;
  partDescription?: string;
  changeReason?: string;
  usageDescription?: string;
  quantityUsed?: number;
  taskTitle?: string;
  timestamp: string;
  partId: string;
  // Additional fields for parts_history
  oldQuantity?: number;
  newQuantity?: number;
  quantityChange?: number;
  changeType?: string;
}

interface InventoryAnalyticsData {
  totalItems: number;
  totalItemsLastWeek: number;
  totalItemsChange: number;
  lowStockItems: number;
  recentAdditions: number;
  userActivity: UserActivityData[];
  userActivityByPerson: UserActivityByPerson[];
  allUsers: string[];
  additionsTrend: AdditionsTrendData[];
  detailedActivity: DetailedActivityRecord[];
}

export function useInventoryAnalytics() {
  return useQuery({
    queryKey: ["inventory-analytics"],
    queryFn: async (): Promise<InventoryAnalyticsData> => {
      // Total items with non-zero quantity
      const { data: totalItemsData, error: totalError } = await supabase
        .from("parts")
        .select("id")
        .gt("current_quantity", 0);

      if (totalError) {
        console.error("Error fetching total items:", totalError);
        throw totalError;
      }

      // Total items from 1 week ago
      const oneWeekAgo = new Date();
      oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

      // Get items that existed a week ago and had non-zero quantity
      const { data: itemsLastWeekData, error: itemsLastWeekError } = await supabase
        .from("parts")
        .select("id, created_at")
        .lte("created_at", oneWeekAgo.toISOString());

      if (itemsLastWeekError) {
        console.error("Error fetching items from last week:", itemsLastWeekError);
        throw itemsLastWeekError;
      }

      // Get quantity changes in the last week to determine what quantities were a week ago
      const { data: weeklyChanges, error: weeklyChangesError } = await supabase
        .from("parts_history")
        .select("part_id, old_quantity, new_quantity, created_at")
        .gte("created_at", oneWeekAgo.toISOString())
        .in("change_type", ["create", "quantity_add", "quantity_remove", "update"]);

      if (weeklyChangesError) {
        console.error("Error fetching weekly changes:", weeklyChangesError);
        throw weeklyChangesError;
      }

      // Calculate total items that had non-zero quantity a week ago
      const currentItems = totalItemsData?.length || 0;
      const itemsCreatedThisWeek = weeklyChanges?.filter(change => 
        change.new_quantity && change.new_quantity > 0 && 
        (!change.old_quantity || change.old_quantity === 0)
      ).length || 0;

      const totalItemsLastWeek = Math.max(0, currentItems - itemsCreatedThisWeek);
      const totalItemsChange = currentItems - totalItemsLastWeek;

      // Low stock items
      const { data: lowStockData, error: lowStockError } = await supabase
        .from("parts")
        .select("id, current_quantity, minimum_quantity")
        .not("minimum_quantity", "is", null)
        .gt("minimum_quantity", 0);

      if (lowStockError) {
        console.error("Error fetching low stock items:", lowStockError);
        throw lowStockError;
      }

      const lowStockCount = lowStockData?.filter(
        item => item.current_quantity <= (item.minimum_quantity || 0)
      ).length || 0;


      // Recent additions (last 14 days)
      const twoWeeksAgo = new Date();
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

      const { data: recentAdditionsData, error: recentAdditionsError } = await supabase
        .from("parts_history")
        .select("id")
        .eq("change_type", "create")
        .gte("created_at", twoWeeksAgo.toISOString());

      if (recentAdditionsError) {
        console.error("Error fetching recent additions:", recentAdditionsError);
        throw recentAdditionsError;
      }

      // User activity data (last 7 days)
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      // Fetch detailed history data with part and user information
      const { data: historyData, error: historyError } = await supabase
        .from("parts_history")
        .select(`
          id,
          changed_by,
          change_type,
          created_at,
          change_reason,
          part_id,
          old_quantity,
          new_quantity,
          quantity_change
        `)
        .gte("created_at", sevenDaysAgo.toISOString());

      if (historyError) {
        console.error("Error fetching history data:", historyError);
        throw historyError;
      }

      // Note: inventory_usage table doesn't exist - all usage is tracked in parts_history
      // Skip usage data fetch since it's not available
      const usageData: any[] = [];

      // Fetch all user profiles for name mapping using secure function
      const { data: profilesData, error: profilesError } = await supabase
        .rpc('get_user_display_names');

      if (profilesError) {
        console.error("Error fetching profiles:", profilesError);
        throw profilesError;
      }

      // Create user mapping
      const userMap: Record<string, string> = {};
      profilesData?.forEach(profile => {
        userMap[profile.user_id] = profile.full_name || 'Unknown User';
      });

      // Fetch part details for history records
      const historyPartIds = historyData?.map(h => h.part_id).filter(Boolean) || [];
      const usagePartIds = usageData?.map(u => u.part_id).filter(Boolean) || [];
      const allPartIds = [...new Set([...historyPartIds, ...usagePartIds])];

      const { data: partsData, error: partsError } = await supabase
        .from("parts")
        .select("id, name, description")
        .in("id", allPartIds);

      if (partsError) {
        console.error("Error fetching parts:", partsError);
      }

      const partsMap: Record<string, { name: string; description?: string }> = {};
      partsData?.forEach(part => {
        partsMap[part.id] = { name: part.name, description: part.description };
      });

      // Fetch task details for usage records
      const taskIds = usageData?.map(u => u.task_id).filter(Boolean) || [];

      // Build task map from AWS-backed /actions endpoint
      let tasksData: any[] = [];
      try {
        // Reuse existing actions endpoint and filter in-memory to requested taskIds
        const actionsResponse = await apiService.get('/actions');
        const actionsPayload = getApiData(actionsResponse as any) || actionsResponse;
        const allActions = Array.isArray(actionsPayload) ? actionsPayload : [];
        if (taskIds.length > 0) {
          const taskIdSet = new Set(taskIds);
          tasksData = allActions.filter((action: any) => taskIdSet.has(action.id));
        }
      } catch (tasksError) {
        console.error("Error fetching tasks from API:", tasksError);
      }

      const tasksMap: Record<string, string> = {};
      
      tasksData?.forEach(task => {
        tasksMap[task.id] = task.title;
      });

      // Process daily user activity for last 7 days
      const dailyActivityMap: Record<string, { created: number; modified: number; used: number }> = {};
      const userActivityByPersonMap: Record<string, Record<string, { created: number; modified: number; used: number }>> = {};
      const allUsersSet = new Set<string>();
      const detailedActivity: DetailedActivityRecord[] = [];

      // Initialize all 7 days
      for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateKey = date.toLocaleDateString();
        dailyActivityMap[dateKey] = { created: 0, modified: 0, used: 0 };
        userActivityByPersonMap[dateKey] = {};
      }

      historyData?.forEach(record => {
        const date = new Date(record.created_at).toLocaleDateString();
        const historyUserName = userMap[record.changed_by] || 'Unknown User';
        allUsersSet.add(historyUserName);
        
        if (dailyActivityMap[date]) {
          if (record.change_type === "create") {
            dailyActivityMap[date].created++;
          } else {
            dailyActivityMap[date].modified++;
          }
          
          // Track by person
          if (!userActivityByPersonMap[date][historyUserName]) {
            userActivityByPersonMap[date][historyUserName] = { created: 0, modified: 0, used: 0 };
          }
          if (record.change_type === "create") {
            userActivityByPersonMap[date][historyUserName].created++;
          } else {
            userActivityByPersonMap[date][historyUserName].modified++;
          }
        }

        // Add to detailed activity
        const partInfo = partsMap[record.part_id];
        detailedActivity.push({
          id: record.id,
          date,
          user: record.changed_by,
          userName: historyUserName,
          type: record.change_type === "create" ? "created" : "modified",
          partName: partInfo?.name || "Unknown Part",
          partDescription: partInfo?.description,
          changeReason: record.change_reason,
          timestamp: record.created_at,
          partId: record.part_id,
          oldQuantity: record.old_quantity,
          newQuantity: record.new_quantity,
          quantityChange: record.quantity_change,
          changeType: record.change_type
        });
      });

      usageData?.forEach(record => {
        const date = new Date(record.created_at).toLocaleDateString();
        const usageUserName = userMap[record.used_by] || 'Unknown User';
        allUsersSet.add(usageUserName);
        
        if (dailyActivityMap[date]) {
          dailyActivityMap[date].used++;
          
          // Track by person
          if (!userActivityByPersonMap[date][usageUserName]) {
            userActivityByPersonMap[date][usageUserName] = { created: 0, modified: 0, used: 0 };
          }
          userActivityByPersonMap[date][usageUserName].used++;
        }

        // Add to detailed activity
        const partInfo = partsMap[record.part_id];
        detailedActivity.push({
          id: record.id,
          date,
          user: record.used_by,
          userName: usageUserName,
          type: "used",
          partName: partInfo?.name || "Unknown Part",
          partDescription: partInfo?.description,
          usageDescription: record.usage_description,
          quantityUsed: record.quantity_used,
          taskTitle: tasksMap[record.task_id],
          timestamp: record.created_at,
          partId: record.part_id
        });
      });

      const userActivity: UserActivityData[] = Object.entries(dailyActivityMap).map(
        ([date, activity]) => ({ date, ...activity })
      );

      const userActivityByPerson: UserActivityByPerson[] = [];
      Object.entries(userActivityByPersonMap).forEach(([date, users]) => {
        Object.entries(users).forEach(([user, activity]) => {
          userActivityByPerson.push({ date, user, ...activity });
        });
      });

      const allUsers = Array.from(allUsersSet).sort();

      // Additions trend (last 14 days)
      const { data: trendData, error: trendError } = await supabase
        .from("parts_history")
        .select("created_at, changed_by")
        .eq("change_type", "create")
        .gte("created_at", twoWeeksAgo.toISOString())
        .order("created_at", { ascending: true });

      if (trendError) {
        console.error("Error fetching trend data:", trendError);
        throw trendError;
      }

      // Process additions trend
      const trendMap: Record<string, Record<string, number>> = {};
      
      trendData?.forEach(record => {
        const date = new Date(record.created_at).toLocaleDateString();
        const trendUserName = userMap[record.changed_by] || 'Unknown User';
        
        if (!trendMap[date]) {
          trendMap[date] = {};
        }
        trendMap[date][trendUserName] = (trendMap[date][trendUserName] || 0) + 1;
      });

      const additionsTrend: AdditionsTrendData[] = [];
      Object.entries(trendMap).forEach(([date, users]) => {
        Object.entries(users).forEach(([user, count]) => {
          additionsTrend.push({ date, user, count });
        });
      });

      return {
        totalItems: totalItemsData?.length || 0,
        totalItemsLastWeek,
        totalItemsChange,
        lowStockItems: lowStockCount,
        recentAdditions: recentAdditionsData?.length || 0,
        userActivity,
        userActivityByPerson,
        allUsers,
        additionsTrend,
        detailedActivity
      };
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 3
  });
}