import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { useState, useMemo, useEffect } from "react";
import { ActivityDetailsDialog } from "./ActivityDetailsDialog";

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

interface UserActivityChartProps {
  data: UserActivityData[];
  userActivityByPerson: UserActivityByPerson[];
  allUsers: string[];
  detailedActivity: DetailedActivityRecord[];
  initialDialogState?: {
    date: string;
    users: string[];
  } | null;
}

export function UserActivityChart({ 
  data, 
  userActivityByPerson, 
  allUsers, 
  detailedActivity,
  initialDialogState
}: UserActivityChartProps) {
  const [selectedUsers, setSelectedUsers] = useState<string[]>(allUsers);
  const [selectedActivityTypes, setSelectedActivityTypes] = useState<string[]>(['created', 'modified', 'used']);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Handle initial dialog state from URL parameters
  useEffect(() => {
    if (initialDialogState) {
      setSelectedDate(initialDialogState.date);
      setSelectedUsers(initialDialogState.users);
      setDialogOpen(true);
    }
  }, [initialDialogState]);

  const filteredData = useMemo(() => {
    // Aggregate data for selected users only
    const filtered: Record<string, { created: number; modified: number; used: number }> = {};
    
    // Initialize dates
    data.forEach(item => {
      filtered[item.date] = { created: 0, modified: 0, used: 0 };
    });

    // Add selected user activity
    userActivityByPerson
      .filter(item => selectedUsers.includes(item.user))
      .forEach(item => {
        if (filtered[item.date]) {
          filtered[item.date].created += item.created;
          filtered[item.date].modified += item.modified;
          filtered[item.date].used += item.used;
        }
      });

    return Object.entries(filtered).map(([date, activity]) => ({
      date,
      created: selectedActivityTypes.includes('created') ? activity.created : 0,
      modified: selectedActivityTypes.includes('modified') ? activity.modified : 0,
      used: selectedActivityTypes.includes('used') ? activity.used : 0
    }));
  }, [data, userActivityByPerson, selectedUsers, selectedActivityTypes]);

  // Calculate dynamic Y-axis domain with padding
  const yAxisDomain = useMemo(() => {
    const maxValues = filteredData.map(item => 
      Math.max(item.created, item.modified, item.used, item.created + item.modified + item.used)
    );
    const maxValue = Math.max(...maxValues, 1);
    return [0, Math.ceil(maxValue * 1.1)]; // Add 10% padding
  }, [filteredData]);

  // Animation key to force re-animation when filters change
  const animationKey = useMemo(() => 
    `${selectedUsers.join(',')}-${selectedActivityTypes.join(',')}`, 
    [selectedUsers, selectedActivityTypes]
  );

  const handleUserToggle = (user: string) => {
    setSelectedUsers(prev => 
      prev.includes(user) 
        ? prev.filter(u => u !== user)
        : [...prev, user]
    );
  };

  const handleActivityTypeToggle = (activityType: string) => {
    setSelectedActivityTypes(prev => 
      prev.includes(activityType) 
        ? prev.filter(t => t !== activityType)
        : [...prev, activityType]
    );
  };

  const handleBarClick = (data: any) => {
    if (data && data.activeLabel) {
      setSelectedDate(data.activeLabel);
      setDialogOpen(true);
    }
  };

  if (!data || data.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-muted-foreground">
        No user activity data available
      </div>
    );
  }

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const total = payload.reduce((sum: number, entry: any) => sum + entry.value, 0);
      return (
        <div className="bg-card border border-border rounded-lg p-3 shadow-md">
          <p className="font-medium text-foreground mb-2">{label}</p>
          <p className="text-sm text-muted-foreground mb-1">Total: {total}</p>
          {payload.map((entry: any, index: number) => (
            <p key={index} className="text-sm" style={{ color: entry.color }}>
              {entry.name}: {entry.value}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="space-y-4">
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            key={animationKey}
            data={filteredData}
            margin={{
              top: 20,
              right: 30,
              left: 20,
              bottom: 20,
            }}
            onClick={handleBarClick}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis 
              dataKey="date" 
              stroke="hsl(var(--foreground))"
              fontSize={12}
              tick={{ fontSize: 11 }}
            />
            <YAxis 
              stroke="hsl(var(--foreground))" 
              fontSize={12}
              domain={yAxisDomain}
              allowDecimals={false}
              tickCount={Math.min(Math.max(yAxisDomain[1], 3), 8)}
              label={{ 
                value: 'Actions', 
                angle: -90, 
                position: 'insideLeft',
                style: { textAnchor: 'middle', fill: 'hsl(var(--foreground))', fontSize: '12px' }
              }}
            />
            <Tooltip content={<CustomTooltip />} />
            <Bar 
              dataKey="created" 
              stackId="activity"
              fill={selectedActivityTypes.includes('created') ? "hsl(var(--mission-education))" : "hsl(var(--muted))"}
              name="Created"
              onClick={() => handleActivityTypeToggle('created')}
              style={{ cursor: 'pointer' }}
              isAnimationActive={true}
              animationDuration={200}
              animationEasing="ease-out"
              animationBegin={0}
            />
            <Bar 
              dataKey="modified" 
              stackId="activity"
              fill={selectedActivityTypes.includes('modified') ? "hsl(var(--mission-construction))" : "hsl(var(--muted))"}
              name="Modified"
              onClick={() => handleActivityTypeToggle('modified')}
              style={{ cursor: 'pointer' }}
              isAnimationActive={true}
              animationDuration={200}
              animationEasing="ease-out"
              animationBegin={0}
            />
            <Bar 
              dataKey="used" 
              stackId="activity"
              fill={selectedActivityTypes.includes('used') ? "hsl(var(--mission-research))" : "hsl(var(--muted))"}
              name="Used"
              onClick={() => handleActivityTypeToggle('used')}
              style={{ cursor: 'pointer' }}
              isAnimationActive={true}
              animationDuration={200}
              animationEasing="ease-out"
              animationBegin={0}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Activity Type Filters */}
      <div className="flex items-center justify-center space-x-6 py-2">
        <div className="text-sm font-medium text-muted-foreground">Activity Types:</div>
        {[
          { key: 'created', label: 'Created', color: 'hsl(var(--mission-education))' },
          { key: 'modified', label: 'Modified', color: 'hsl(var(--mission-construction))' },
          { key: 'used', label: 'Used', color: 'hsl(var(--mission-research))' }
        ].map(({ key, label, color }) => (
          <button
            key={key}
            onClick={() => handleActivityTypeToggle(key)}
            className={`flex items-center space-x-2 px-3 py-1 rounded-md transition-all ${
              selectedActivityTypes.includes(key) 
                ? 'bg-muted hover:bg-muted/80' 
                : 'opacity-50 hover:opacity-75'
            }`}
          >
            <div 
              className="w-3 h-3 rounded" 
              style={{ backgroundColor: selectedActivityTypes.includes(key) ? color : 'hsl(var(--muted))' }}
            />
            <span className="text-sm">{label}</span>
          </button>
        ))}
      </div>

      {/* User Filters */}
      <div className="space-y-2">
        <div className="text-sm font-medium text-muted-foreground text-center">Users (click to filter):</div>
        <div className="flex flex-wrap justify-center gap-2">
          {allUsers.map((user) => (
            <button
              key={user}
              onClick={() => handleUserToggle(user)}
              className={`px-3 py-1 rounded-full text-sm transition-all ${
                selectedUsers.includes(user)
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              {user}
            </button>
          ))}
        </div>
      </div>

      <ActivityDetailsDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        selectedDate={selectedDate}
        detailedActivity={detailedActivity}
        selectedUsers={selectedUsers}
      />
    </div>
  );
}