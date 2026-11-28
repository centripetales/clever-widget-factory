/**
 * Explorations Page
 * 
 * Displays a filterable list of explorations with policy creation and linking actions
 * Supports filtering by date range, location, explorer, and public flag
 * 
 * Requirements: 5.1, 5.2, 5.3, 5.4, 3.1, 3.5
 */

import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from "@/hooks/useCognitoAuth";
import { toast } from '@/hooks/use-toast';
import { useOrganizationMembers } from '@/hooks/useOrganizationMembers';
import { useOrganizationId } from '@/hooks/useOrganizationId';
import { offlineQueryConfig } from '@/lib/queryConfig';
import { 
  Search, 
  Filter, 
  ArrowLeft, 
  X, 
  Calendar,
  MapPin,
  User,
  Eye,
  EyeOff,
  Plus,
  Link,
  FileText,
  Image
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ExplorationService, ExplorationListItem, ExplorationFilters } from '@/services/explorationService';
import { PolicyService } from '@/services/policyService';
import { cn } from '@/lib/utils';
import { PolicyCreationDialog } from '@/components/PolicyCreationDialog';
import { PolicyLinkingDialog } from '@/components/PolicyLinkingDialog';

export default function Explorations() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const organizationId = useOrganizationId();
  const { members: profiles } = useOrganizationMembers();
  
  // Filter state
  const [searchTerm, setSearchTerm] = useState('');
  const [explorerFilter, setExplorerFilter] = useState('all');
  const [publicFilter, setPublicFilter] = useState('all');
  const [locationFilter, setLocationFilter] = useState('');
  const [dateRange, setDateRange] = useState<{ start?: Date; end?: Date }>({});
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Dialog state
  const [showPolicyCreationDialog, setShowPolicyCreationDialog] = useState(false);
  const [showPolicyLinkingDialog, setShowPolicyLinkingDialog] = useState(false);
  const [selectedExploration, setSelectedExploration] = useState<ExplorationListItem | null>(null);

  // Services
  const explorationService = new ExplorationService();
  const policyService = new PolicyService();

  // Fetch explorations with filters
  const { data: explorations = [], isLoading, refetch } = useQuery({
    queryKey: ['explorations', searchTerm, explorerFilter, publicFilter, locationFilter, dateRange],
    queryFn: async () => {
      const filters: ExplorationFilters = {};
      
      if (dateRange.start && dateRange.end) {
        filters.date_range = { start: dateRange.start, end: dateRange.end };
      }
      if (locationFilter) {
        filters.location = locationFilter;
      }
      if (explorerFilter !== 'all') {
        filters.explorer = explorerFilter;
      }
      if (publicFilter !== 'all') {
        filters.public_flag = publicFilter === 'public';
      }
      
      return explorationService.listExplorations(filters);
    },
    ...offlineQueryConfig,
  });

  // Filter explorations by search term (client-side)
  const filteredExplorations = useMemo(() => {
    if (!searchTerm) return explorations;
    
    const searchLower = searchTerm.toLowerCase();
    return explorations.filter(exploration => 
      exploration.exploration_code.toLowerCase().includes(searchLower) ||
      exploration.state_text.toLowerCase().includes(searchLower) ||
      exploration.summary_policy_text?.toLowerCase().includes(searchLower) ||
      exploration.exploration_notes_text?.toLowerCase().includes(searchLower) ||
      exploration.metrics_text?.toLowerCase().includes(searchLower)
    );
  }, [explorations, searchTerm]);

  // Get explorer options from profiles
  const explorerOptions = profiles.map(profile => ({
    user_id: profile.user_id,
    full_name: profile.full_name
  }));

  const handleCreatePolicyFromExploration = async (exploration: ExplorationListItem) => {
    setSelectedExploration(exploration);
    setShowPolicyCreationDialog(true);
  };

  const handleLinkToExistingPolicy = async (exploration: ExplorationListItem) => {
    setSelectedExploration(exploration);
    setShowPolicyLinkingDialog(true);
  };

  const handlePolicyCreated = (policyId: number) => {
    toast({
      title: "Success",
      description: "Policy created successfully from exploration data",
    });
    // Optionally refresh the explorations list
    refetch();
  };

  const handlePolicyLinked = (policyId: number) => {
    toast({
      title: "Success",
      description: "Exploration linked to existing policy",
    });
    // Optionally refresh the explorations list
    refetch();
  };

  const handleViewAction = (exploration: ExplorationListItem) => {
    navigate(`/actions/${exploration.action_id}`);
  };

  const clearDateRange = () => {
    setDateRange({});
    setShowDatePicker(false);
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-2 sm:p-4 md:p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-lg">Loading explorations...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-2 sm:p-4 md:p-6 space-y-6 min-w-0">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 w-full min-w-0">
          <Button variant="outline" onClick={() => navigate('/')} className="!whitespace-normal text-left min-w-0">
            <ArrowLeft className="h-4 w-4 mr-2 flex-shrink-0" />
            <span className="break-words">Back to Dashboard</span>
          </Button>
          <Search className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-xl sm:text-3xl font-bold">Explorations</h1>
            <p className="text-muted-foreground">Review and manage exploration data</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Search */}
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2">
                <Search className="h-4 w-4" />
                Search
              </label>
              <div className="relative">
                <Input
                  placeholder="Search explorations..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pr-10"
                />
                {searchTerm && (
                  <button
                    onClick={() => setSearchTerm("")}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    type="button"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Explorer Filter */}
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2">
                <User className="h-4 w-4" />
                Explorer
              </label>
              <Select value={explorerFilter} onValueChange={setExplorerFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Explorers</SelectItem>
                  {explorerOptions.map((explorer) => (
                    <SelectItem key={explorer.user_id} value={explorer.user_id}>
                      {explorer.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Public Filter */}
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2">
                <Eye className="h-4 w-4" />
                Visibility
              </label>
              <Select value={publicFilter} onValueChange={setPublicFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Explorations</SelectItem>
                  <SelectItem value="public">Public Only</SelectItem>
                  <SelectItem value="private">Private Only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Date Range */}
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                Date Range
              </label>
              <Popover open={showDatePicker} onOpenChange={setShowDatePicker}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left font-normal",
                      !dateRange.start && "text-muted-foreground"
                    )}
                  >
                    <Calendar className="mr-2 h-4 w-4" />
                    {dateRange.start && dateRange.end ? (
                      `${format(dateRange.start, "MMM dd")} - ${format(dateRange.end, "MMM dd")}`
                    ) : (
                      "Select date range"
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <div className="p-3 space-y-3">
                    <CalendarComponent
                      mode="range"
                      selected={{
                        from: dateRange.start,
                        to: dateRange.end
                      }}
                      onSelect={(range) => {
                        if (range?.from && range?.to) {
                          setDateRange({ start: range.from, end: range.to });
                        } else if (range?.from) {
                          setDateRange({ start: range.from, end: undefined });
                        } else {
                          setDateRange({});
                        }
                      }}
                      numberOfMonths={2}
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={clearDateRange}
                        className="flex-1"
                      >
                        Clear
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => setShowDatePicker(false)}
                        className="flex-1"
                      >
                        Done
                      </Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* Location Filter */}
          <div className="mt-4">
            <label className="text-sm font-medium flex items-center gap-2 mb-2">
              <MapPin className="h-4 w-4" />
              Location
            </label>
            <div className="relative max-w-md">
              <Input
                placeholder="Filter by location..."
                value={locationFilter}
                onChange={(e) => setLocationFilter(e.target.value)}
                className="pr-10"
              />
              {locationFilter && (
                <button
                  onClick={() => setLocationFilter("")}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  type="button"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      <Card>
        <CardHeader>
          <CardTitle>
            Explorations ({filteredExplorations.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {filteredExplorations.length === 0 ? (
            <div className="text-center py-12">
              <Search className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No explorations found</h3>
              <p className="text-muted-foreground">
                {explorations.length === 0 
                  ? "No explorations have been created yet."
                  : "No explorations match your current filters."
                }
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredExplorations.map((exploration) => (
                <ExplorationCard
                  key={exploration.exploration_id}
                  exploration={exploration}
                  onCreatePolicy={() => handleCreatePolicyFromExploration(exploration)}
                  onLinkPolicy={() => handleLinkToExistingPolicy(exploration)}
                  onViewAction={() => handleViewAction(exploration)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Policy Creation Dialog */}
      <PolicyCreationDialog
        open={showPolicyCreationDialog}
        onOpenChange={setShowPolicyCreationDialog}
        exploration={selectedExploration}
        onPolicyCreated={handlePolicyCreated}
      />

      {/* Policy Linking Dialog */}
      <PolicyLinkingDialog
        open={showPolicyLinkingDialog}
        onOpenChange={setShowPolicyLinkingDialog}
        exploration={selectedExploration}
        onPolicyLinked={handlePolicyLinked}
      />
    </div>
  );
}

// Exploration Card Component
interface ExplorationCardProps {
  exploration: ExplorationListItem;
  onCreatePolicy: () => void;
  onLinkPolicy: () => void;
  onViewAction: () => void;
}

function ExplorationCard({ exploration, onCreatePolicy, onLinkPolicy, onViewAction }: ExplorationCardProps) {
  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="p-6">
        <div className="flex flex-col lg:flex-row lg:items-start gap-4">
          {/* Main Content */}
          <div className="flex-1 space-y-3">
            {/* Header */}
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold font-mono">
                    {exploration.exploration_code}
                  </h3>
                  {!exploration.public_flag ? (
                    <Badge variant="secondary" className="flex items-center gap-1">
                      <EyeOff className="h-3 w-3" />
                      Private
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="flex items-center gap-1">
                      <Eye className="h-3 w-3" />
                      Public
                    </Badge>
                  )}
                </div>
                {exploration.name && (
                  <h4 className="text-base font-medium">{exploration.name}</h4>
                )}
                <p className="text-sm text-muted-foreground">
                  {format(new Date(exploration.created_at), 'MMM dd, yyyy')}
                  {exploration.explorer_name && ` • ${exploration.explorer_name}`}
                </p>
              </div>
            </div>

            {/* State Text */}
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-1">State Description</h4>
              <p className="text-sm line-clamp-2">{exploration.state_text}</p>
            </div>

            {/* Summary Policy */}
            {exploration.summary_policy_text && (
              <div>
                <h4 className="text-sm font-medium text-muted-foreground mb-1">Summary Plan</h4>
                <p className="text-sm line-clamp-2">{exploration.summary_policy_text}</p>
              </div>
            )}

            {/* Exploration Notes */}
            {exploration.exploration_notes_text && (
              <div>
                <h4 className="text-sm font-medium text-muted-foreground mb-1">Exploration Notes</h4>
                <p className="text-sm line-clamp-2">{exploration.exploration_notes_text}</p>
              </div>
            )}

            {/* Metrics */}
            {exploration.metrics_text && (
              <div>
                <h4 className="text-sm font-medium text-muted-foreground mb-1">Metrics</h4>
                <p className="text-sm line-clamp-2">{exploration.metrics_text}</p>
              </div>
            )}

            {/* Key Photos */}
            {exploration.key_photos && exploration.key_photos.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-muted-foreground mb-2">Photos</h4>
                <div className="flex items-center gap-2">
                  <Image className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">
                    {exploration.key_photos.length} photo{exploration.key_photos.length !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2 lg:min-w-[200px]">
            <Button
              variant="outline"
              size="sm"
              onClick={onViewAction}
              className="flex items-center gap-2"
            >
              <FileText className="h-4 w-4" />
              View Action
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onCreatePolicy}
              className="flex items-center gap-2"
            >
              <Plus className="h-4 w-4" />
              Create Policy
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onLinkPolicy}
              className="flex items-center gap-2"
            >
              <Link className="h-4 w-4" />
              Link to Policy
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}