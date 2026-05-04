import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ArrowLeft, TrendingUp, Users, BarChart3 } from 'lucide-react';
import { AttributeRadarChart } from '@/components/AttributeRadarChart';
import { AttributeFilters } from '@/components/AttributeFilters';
import { ScoredActionsList } from '@/components/ScoredActionsList';
import { ProactiveVsReactiveChart } from '@/components/ProactiveVsReactiveChart';
import InventoryTrackingChart from '@/components/InventoryTrackingChart';
import InventoryUsageHeatmap from '@/components/InventoryUsageHeatmap';
import ActionUpdatesChart from '@/components/ActionUpdatesChart';
import ObservationsChart from '@/components/ObservationsChart';
import { EnergeiaSchema } from '@/components/EnergeiaSchema/EnergeiaSchema';
// Removed IssuesCreatedChart
import { useEnhancedStrategicAttributes, type EnhancedAttributeAnalytics } from '@/hooks/useEnhancedStrategicAttributes';
import { useScoredActions } from '@/hooks/useScoredActions';
import { useInventoryTracking } from '@/hooks/useInventoryTracking';
import { offlineQueryConfig } from '@/lib/queryConfig';

export default function AnalyticsDashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [filtersCollapsed, setFiltersCollapsed] = useState<boolean>(true);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [didAutoApply, setDidAutoApply] = useState(false);
  const [didSetInitialUsers, setDidSetInitialUsers] = useState(false);
  const [appliedUsers, setAppliedUsers] = useState<string[]>([]);
  const [appliedStartDate, setAppliedStartDate] = useState('');
  const [appliedEndDate, setAppliedEndDate] = useState('');
  const selectedIssueAnalytics: EnhancedAttributeAnalytics[] = [];

  // Initialize dates immediately
  useEffect(() => {
    const today = new Date();
    const twoWeeksAgo = new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000);
    const end = today.toISOString().split('T')[0];
    const start = twoWeeksAgo.toISOString().split('T')[0];
    setEndDate(end);
    setStartDate(start);
    // Set applied dates immediately so queries can start
    setAppliedEndDate(end);
    setAppliedStartDate(start);
  }, []);

  const {
    actionAnalytics,
    organizationMembers,
    proactiveVsReactiveData,
    isFetchingProactive,
    getDayActions,
    fetchAllData,
    isLoading: attributesLoading,
  } = useEnhancedStrategicAttributes({
    userIds: appliedUsers,
    startDate: appliedStartDate,
    endDate: appliedEndDate,
  });

  const { scoredActions, isLoading: isLoadingScoredActions, fetchScoredActions } = useScoredActions({
    userIds: appliedUsers,
    startDate: appliedStartDate,
    endDate: appliedEndDate,
  });

  const { fetchInventoryData } = useInventoryTracking(organizationMembers);

  const allUserAnalytics = useMemo(
    () =>
      (organizationMembers || [])
        .filter((member) => member.is_active !== false) // Only include enabled members
        .map((member) => ({
          userId: member.user_id,
          userName: member.full_name || 'Unknown User',
          userRole: member.role || 'user',
          totalActions: 0,
          attributes: {},
        })),
    [organizationMembers],
  );

  const totalOrgMembers = allUserAnalytics.length;

  // Set initial users as soon as members are available
  useEffect(() => {
    if (!didSetInitialUsers && allUserAnalytics.length > 0) {
      const userIds = allUserAnalytics.map(user => user.userId);
      setSelectedUsers(userIds);
      setAppliedUsers(userIds); // Set applied users immediately so queries can start
      setDidSetInitialUsers(true);
    }
  }, [allUserAnalytics, didSetInitialUsers]);

  // Prefetch all data immediately when dates are available (users can be empty initially)
  useEffect(() => {
    if (appliedStartDate && appliedEndDate) {
      // Prefetch inventory data in parallel (will use empty users array initially)
      const usersKey = appliedUsers.length > 0 ? appliedUsers.slice().sort().join(',') : '';
      queryClient.prefetchQuery({
        queryKey: ['inventoryData', usersKey, appliedStartDate, appliedEndDate],
        queryFn: () => fetchInventoryData(appliedUsers, appliedStartDate, appliedEndDate),
        ...offlineQueryConfig,
      });
    }
  }, [appliedStartDate, appliedEndDate, appliedUsers, queryClient, fetchInventoryData]);

  const handleApplyFilters = useCallback(async () => {
    if (!startDate || !endDate || selectedUsers.length === 0) {
      return;
    }

    setAppliedUsers(selectedUsers);
    setAppliedStartDate(startDate);
    setAppliedEndDate(endDate);

    // Invalidate queries to trigger refetch with new filters
    await Promise.all([
      fetchAllData(selectedUsers, startDate, endDate),
      fetchScoredActions(selectedUsers, startDate, endDate),
    ]);
  }, [endDate, fetchAllData, fetchScoredActions, selectedUsers, startDate]);

  const appliedUsersKey = useMemo(() => appliedUsers.slice().sort().join(','), [appliedUsers]);
  const effectiveStartDate = appliedStartDate || startDate;
  const effectiveEndDate = appliedEndDate || endDate;
  const radarSelectedUsers = appliedUsers.length ? appliedUsers : selectedUsers;

  // Use effective dates/users so query can start immediately
  const inventoryQuery = useQuery({
    queryKey: ['inventoryData', appliedUsersKey, effectiveStartDate, effectiveEndDate],
    queryFn: async () => {
      const result = await fetchInventoryData(appliedUsers.length ? appliedUsers : selectedUsers, effectiveStartDate, effectiveEndDate);
      return result;
    },
    enabled: Boolean((appliedUsers.length || selectedUsers.length) && effectiveStartDate && effectiveEndDate),
    ...offlineQueryConfig,
  });

  const inventoryTrackingData = inventoryQuery.data?.chartData ?? [];
  const heatmapData = inventoryQuery.data?.heatmapData ?? [];
  const isLoadingInventoryTracking = inventoryQuery.isLoading || inventoryQuery.isFetching;
  const isLoadingHeatmap = inventoryQuery.isLoading || inventoryQuery.isFetching;
  const isLoadingProactiveData = isFetchingProactive && Boolean(appliedUsers.length);

  const heatmapDays = useMemo(() => {
    const days: string[] = [];
    if (effectiveStartDate && effectiveEndDate) {
      const start = new Date(`${effectiveStartDate}T00:00:00.000Z`);
      const end = new Date(`${effectiveEndDate}T00:00:00.000Z`);
      for (let day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) {
        days.push(day.toISOString().slice(0, 10));
      }
    }
    return days;
  }, [effectiveEndDate, effectiveStartDate]);

  // Remove blocking loading check - let page render immediately with placeholder data
  // Components will show loading states individually while data fetches in background

  return (
    <div className="min-h-screen bg-gray-50 p-4 overflow-x-hidden">
      <div className="max-w-7xl mx-auto space-y-6 w-full">
        {/* Header */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate('/dashboard')}
                  className="flex items-center gap-2"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back to Dashboard
                </Button>
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="h-6 w-6" />
                    Strategic Attributes Analytics
                  </CardTitle>
                  <p className="text-sm text-muted-foreground mt-1">
                    Analyze worker performance across 10 strategic attributes
                  </p>
                </div>
              </div>
            </div>
          </CardHeader>
        </Card>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <Users className="h-8 w-8 text-blue-500" />
                <div>
                  <p className="text-sm text-muted-foreground">Total Users</p>
                  <p className="text-2xl font-bold">{totalOrgMembers}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <TrendingUp className="h-8 w-8 text-green-500" />
                <div>
                  <p className="text-sm text-muted-foreground">Selected for Analysis</p>
                  <p className="text-2xl font-bold">{selectedUsers.length}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters — full width, affects all charts below */}
        <AttributeFilters
          userAnalytics={allUserAnalytics}
          selectedUsers={selectedUsers}
          onSelectedUsersChange={setSelectedUsers}
          startDate={startDate}
          endDate={endDate}
          onStartDateChange={setStartDate}
          onEndDateChange={setEndDate}
          onApplyFilters={handleApplyFilters}
          collapsed={filtersCollapsed}
          onToggleCollapsed={() => setFiltersCollapsed(!filtersCollapsed)}
          organizationMembers={organizationMembers}
        />

        {/* Charts — full width */}
        <div className="space-y-6">
          {/* Radar Chart */}
          {radarSelectedUsers.length > 0 ? (
            <AttributeRadarChart
              actionAnalytics={actionAnalytics}
              issueAnalytics={selectedIssueAnalytics}
              selectedUsers={radarSelectedUsers}
              organizationMembers={organizationMembers}
            />
          ) : (
            <Card>
              <CardContent className="p-8 text-center">
                <div className="text-muted-foreground">
                  <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <h3 className="text-lg font-medium mb-2">No Users Selected</h3>
                  <p>Select users from the filters to view their strategic attributes comparison.</p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Scored Actions List */}
          <ScoredActionsList scoredActions={scoredActions} isLoading={isLoadingScoredActions} />

          {/* Proactive vs Reactive Chart */}
          <ProactiveVsReactiveChart
            data={proactiveVsReactiveData}
            isLoading={isLoadingProactiveData}
            onDayClick={getDayActions}
          />

          {/* Inventory Tracking: toggle between stacked chart and heatmap */}
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">Inventory Tracking View</div>
            <div className="flex items-center gap-2">
              <Button variant={showHeatmap ? 'outline' : 'default'} size="sm" onClick={() => setShowHeatmap(false)}>
                Chart
              </Button>
              <Button variant={showHeatmap ? 'default' : 'outline'} size="sm" onClick={() => setShowHeatmap(true)}>
                Heatmap
              </Button>
            </div>
          </div>
          {showHeatmap ? (
            <InventoryUsageHeatmap
              data={heatmapData}
              isLoading={isLoadingHeatmap}
              days={heatmapDays}
              onCellClick={(cell) => {
                const params = new URLSearchParams({ date: cell.dayKey, users: cell.personId });
                navigate(`/combined-assets?view=stock&${params.toString()}`);
              }}
            />
          ) : (
            <InventoryTrackingChart data={inventoryTrackingData} isLoading={isLoadingInventoryTracking} />
          )}

          {/* Action Updates (stacked bar) */}
          <ActionUpdatesChart
            startDate={effectiveStartDate}
            endDate={effectiveEndDate}
            selectedUsers={radarSelectedUsers}
          />

          {/* Observations (stacked bar) */}
          <ObservationsChart
            startDate={effectiveStartDate}
            endDate={effectiveEndDate}
            selectedUsers={radarSelectedUsers}
          />

          <EnergeiaSchema
            startDate={effectiveStartDate}
            endDate={effectiveEndDate}
            selectedUsers={radarSelectedUsers}
          />
        </div>
      </div>
    </div>
  );
}

