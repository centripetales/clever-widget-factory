import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { CalendarDays, Users, ChevronRight } from 'lucide-react';
import { AttributeAnalytics } from '@/hooks/useStrategicAttributes';
import type { OrganizationMemberSummary } from '@/types/organization';

interface AttributeFiltersProps {
  userAnalytics: AttributeAnalytics[];
  selectedUsers: string[];
  onSelectedUsersChange: (userIds: string[]) => void;
  startDate: string;
  endDate: string;
  onStartDateChange: (date: string) => void;
  onEndDateChange: (date: string) => void;
  onApplyFilters: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  organizationMembers?: OrganizationMemberSummary[];
}

export function AttributeFilters({
  userAnalytics,
  selectedUsers,
  onSelectedUsersChange,
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  onApplyFilters,
  collapsed = false,
  onToggleCollapsed,
  organizationMembers = []
}: AttributeFiltersProps) {
  const [searchTerm, setSearchTerm] = useState('');

  // Build a name map from organization_members to replace any 'Unknown User' entries
  const [nameMap, setNameMap] = useState<Record<string, string>>({});

  useEffect(() => {
    const ids = new Set(userAnalytics.map(u => u.userId));
    if (!ids.size) {
      setNameMap({});
      return;
    }

    const map: Record<string, string> = {};
    organizationMembers
      .filter(member => member.is_active !== false && member.user_id && ids.has(member.user_id))
      .forEach(member => {
        map[member.user_id] = String(member.full_name || 'Unknown User').trim();
      });

    setNameMap(map);
  }, [organizationMembers, userAnalytics]);

  const usersWithDisplayNames = useMemo(() => {
    // Only include users that resolved via active org membership
    return userAnalytics
      .filter(u => Boolean(nameMap[u.userId]))
      .map(u => ({
        ...u,
        userName: (nameMap[u.userId] || 'Unknown User').trim(),
      }));
  }, [userAnalytics, nameMap]);

  const filteredUsers = usersWithDisplayNames.filter(user =>
    user.userName.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleUserToggle = (userId: string) => {
    if (selectedUsers.includes(userId)) {
      onSelectedUsersChange(selectedUsers.filter(id => id !== userId));
    } else {
      onSelectedUsersChange([...selectedUsers, userId]);
    }
  };

  const selectAllUsers = () => {
    // Select all available users (not just the filtered subset)
    onSelectedUsersChange(usersWithDisplayNames.map(user => user.userId));
  };

  const clearAllUsers = () => {
    onSelectedUsersChange([]);
  };

  return (
    <Card className="w-full">
      <CardHeader onClick={onToggleCollapsed} className="cursor-pointer">
        <CardTitle className="flex items-center gap-2">
          <ChevronRight className={`h-4 w-4 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
          Filters
        </CardTitle>
      </CardHeader>
      {!collapsed && (
      <CardContent>
        {/* Horizontal layout: date range | user selection | apply button */}
        <div className="flex flex-col md:flex-row md:items-start gap-6">
          {/* Date Filters */}
          <div className="space-y-3 md:w-64 shrink-0">
            <Label className="flex items-center gap-2 text-sm font-medium">
              <CalendarDays className="h-4 w-4" />
              Time Range
            </Label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="startDate" className="text-xs text-muted-foreground">
                  Start Date
                </Label>
                <Input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={(e) => onStartDateChange(e.target.value)}
                  className="text-sm"
                />
              </div>
              <div>
                <Label htmlFor="endDate" className="text-xs text-muted-foreground">
                  End Date
                </Label>
                <Input
                  id="endDate"
                  type="date"
                  value={endDate}
                  onChange={(e) => onEndDateChange(e.target.value)}
                  className="text-sm"
                />
              </div>
            </div>
          </div>

          {/* User Selection */}
          <div className="space-y-3 flex-1 min-w-0">
            <Label className="flex items-center gap-2 text-sm font-medium">
              <Users className="h-4 w-4" />
              Select People ({selectedUsers.length} selected)
            </Label>
            
            <div className="flex flex-wrap items-center gap-2">
              <Input
                placeholder="Search users..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="text-sm w-48"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={selectAllUsers}
                className="text-xs"
              >
                Select All
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={clearAllUsers}
                className="text-xs"
              >
                Clear All
              </Button>
            </div>

            <div className="max-h-28 overflow-y-auto border rounded-md p-2">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                {filteredUsers.map(user => (
                  <div key={user.userId} className="flex items-center space-x-2">
                    <Checkbox
                      id={user.userId}
                      checked={selectedUsers.includes(user.userId)}
                      onCheckedChange={() => handleUserToggle(user.userId)}
                    />
                    <Label
                      htmlFor={user.userId}
                      className="text-sm font-normal cursor-pointer"
                    >
                      {user.userName}
                      <span className="text-xs text-muted-foreground ml-1">
                        ({user.userRole})
                      </span>
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Apply Button */}
          <div className="md:pt-7 shrink-0">
            <Button 
              onClick={onApplyFilters}
              size="sm"
              className="w-full md:w-auto"
            >
              Apply Filters
            </Button>
          </div>
        </div>
      </CardContent>
      )}
    </Card>
  );
}