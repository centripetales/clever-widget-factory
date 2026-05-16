import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from "@/hooks/useCognitoAuth";
import { toast } from '@/hooks/use-toast';
import { useEnabledMembers } from '@/hooks/useOrganizationMembers';
import { offlineQueryConfig } from '@/lib/queryConfig';
import { Bolt, Plus, Filter, Search, CheckCircle, AlertTriangle, ArrowLeft, X, SearchCheck, Info } from 'lucide-react';
import { ActionScoreDialog } from '@/components/ActionScoreDialog';
import { ActionListItemCard } from '@/components/ActionListItemCard';
import { useActionScores, ActionScore } from '@/hooks/useActionScores';
import { BaseAction } from '@/types/actions';
import { useNavigate } from 'react-router-dom';
import { apiService } from '@/lib/apiService';
import { actionsQueryKey, completedActionsQueryKey } from '@/lib/queryKeys';

// Using unified BaseAction interface from types/actions.ts

export default function Actions() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState('unresolved');
  const [searchTerm, setSearchTerm] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('me');
  const [showScoreDialog, setShowScoreDialog] = useState(false);
  const [isSemanticSearch, setIsSemanticSearch] = useState(false);
  const [semanticResults, setSemanticResults] = useState<string[]>([]);
  // Track whether user has ever clicked the completed tab
  const [completedTabVisited, setCompletedTabVisited] = useState(false);
  
  // Use organization members for consistent "Assigned to" dropdown
  const { members: profiles } = useEnabledMembers();
  const [scoringAction, setScoringAction] = useState<BaseAction | null>(null);

  // Helper function to get user color
  const getUserColor = (userId: string) => {
    const profile = profiles.find(p => p.user_id === userId);
    return profile?.favorite_color || '#6B7280';
  };
  const [existingScore, setExistingScore] = useState<ActionScore | null>(null);

  const { getScoreForAction } = useActionScores();

  const fetchUnresolvedActions = async (): Promise<BaseAction[]> => {
    const result = await apiService.get('/actions?status=unresolved');
    return result.data || [];
  };

  const fetchCompletedActions = async (): Promise<BaseAction[]> => {
    const result = await apiService.get('/actions?status=completed');
    return result.data || [];
  };

  const queryClient = useQueryClient();

  // Unresolved actions - fetched eagerly on mount
  const { data: unresolvedActions = [], isLoading: unresolvedLoading } = useQuery({
    queryKey: actionsQueryKey(),
    queryFn: fetchUnresolvedActions,
    ...offlineQueryConfig,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Completed actions - fetched lazily when tab is clicked
  const { data: completedActions = [], isLoading: completedLoading } = useQuery({
    queryKey: completedActionsQueryKey(),
    queryFn: fetchCompletedActions,
    enabled: completedTabVisited,
    ...offlineQueryConfig,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const loading = unresolvedLoading;

  // Handle tab change - trigger completed fetch on first visit
  const handleTabChange = (value: string) => {
    setActiveTab(value);
    if (value === 'completed' && !completedTabVisited) {
      setCompletedTabVisited(true);
    }
  };

  const handleEditAction = (action: BaseAction) => {
    navigate(`/actions/${action.id}`);
  };

  const handleSaveAction = async () => {
    // No-op: navigation is handled by ActionPage after save
  };

  const handleCreateAction = () => {
    navigate('/actions/new');
  };

  const handleScoreAction = async (action: BaseAction, e: React.MouseEvent) => {
    e.stopPropagation();
    setScoringAction(action);
    setShowScoreDialog(true);
    if (action.id) {
      getScoreForAction(action.id).then(score => {
        setExistingScore(score);
      });
    }
  };

  const handleScoreUpdated = () => {
    setShowScoreDialog(false);
    setScoringAction(null);
    setExistingScore(null);
  };

  const handleScoreDialogClose = (open: boolean) => {
    if (!open) {
      setScoringAction(null);
      setExistingScore(null);
    }
    setShowScoreDialog(open);
  };

  const handleSemanticSearch = async () => {
    if (!searchTerm.trim()) {
      toast({
        title: "Search Required",
        description: "Please enter a search term for semantic search",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsSemanticSearch(true);
      const response = await apiService.post('/semantic-search/unified', {
        query: searchTerm,
        entity_types: ['action', 'action_existing_state'],
        limit: 50
      });

      if (response.data && response.data.results && Array.isArray(response.data.results)) {
        const actionIds = [...new Set(response.data.results.map((r: { entity_id: string }) => r.entity_id))] as string[];
        setSemanticResults(actionIds);
        toast({
          title: "Semantic Search Complete",
          description: `Found ${actionIds.length} relevant actions`,
        });
      } else {
        console.error('Unexpected response format:', response);
        throw new Error('Invalid response format from search API');
      }
    } catch (error) {
      console.error('Semantic search error:', error);
      toast({
        title: "Search Error",
        description: error instanceof Error ? error.message : "Failed to perform semantic search. Please try again.",
        variant: "destructive",
      });
      setIsSemanticSearch(false);
      setSemanticResults([]);
    }
  };

  const handleClearSemanticSearch = () => {
    setIsSemanticSearch(false);
    setSemanticResults([]);
  };

  // Reset assignee filter if the selected assignee is not in active profiles
  useEffect(() => {
    if (assigneeFilter !== 'all' && assigneeFilter !== 'me' && assigneeFilter !== 'unassigned') {
      const isAssigneeActive = profiles.some(profile => profile.user_id === assigneeFilter);
      if (!isAssigneeActive) {
        setAssigneeFilter('all');
        toast({
          title: 'Filter Reset',
          description: 'Selected assignee is no longer active and has been cleared from filter',
          variant: 'default'
        });
      }
    }
  }, [profiles, assigneeFilter]);

  // Apply search and assignee filters to a list of actions
  const applyFilters = (actions: BaseAction[]) => {
    let filtered = actions;

    // Semantic search filter (takes precedence)
    if (isSemanticSearch && semanticResults.length > 0) {
      filtered = filtered.filter(action => semanticResults.includes(action.id));
    } else if (searchTerm) {
      const searchLower = searchTerm.toLowerCase();
      filtered = filtered.filter(action => {
        const stripHtmlAndSearch = (html: string | null | undefined): boolean => {
          if (!html) return false;
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const text = doc.body.textContent || '';
          return text.toLowerCase().includes(searchLower);
        };

        return action.title.toLowerCase().includes(searchLower) ||
               action.description?.toLowerCase().includes(searchLower) ||
               stripHtmlAndSearch(action.policy) ||
               stripHtmlAndSearch((action as any).observations) ||
               action.asset?.name?.toLowerCase().includes(searchLower) ||
               action.mission?.title?.toLowerCase().includes(searchLower);
      });
    }

    // Assignee filter
    if (assigneeFilter !== 'all') {
      if (assigneeFilter === 'unassigned') {
        filtered = filtered.filter(action => !action.assigned_to);
      } else if (assigneeFilter === 'me' && user) {
        const currentUserProfile = profiles.find(p => p.cognito_user_id === user.userId);
        if (currentUserProfile) {
          filtered = filtered.filter(action => action.assigned_to === currentUserProfile.user_id);
        } else {
          filtered = filtered.filter(action => action.assigned_to === user.userId);
        }
      } else {
        filtered = filtered.filter(action => action.assigned_to === assigneeFilter);
      }
    }

    return filtered;
  };

  // Filtered unresolved actions, sorted: in-progress first, then by updated_at
  const filteredUnresolved = useMemo(() => {
    return applyFilters(unresolvedActions).sort((a, b) => {
      if (a.status === 'in_progress' && b.status !== 'in_progress') return -1;
      if (b.status === 'in_progress' && a.status !== 'in_progress') return 1;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }, [unresolvedActions, searchTerm, assigneeFilter, user?.userId, profiles.length, isSemanticSearch, semanticResults]);

  // Filtered completed actions, sorted by completion date
  const filteredCompleted = useMemo(() => {
    return applyFilters(completedActions).sort((a, b) => {
      if (a.completed_at && b.completed_at) {
        return new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime();
      }
      if (a.completed_at && !b.completed_at) return -1;
      if (!a.completed_at && b.completed_at) return 1;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }, [completedActions, searchTerm, assigneeFilter, user?.userId, profiles.length, isSemanticSearch, semanticResults]);
  
  // Use active profiles for assignee filter options
  const assigneeOptions = profiles
    .filter(profile => profile.is_active !== false)
    .map(profile => ({
      user_id: profile.user_id,
      full_name: profile.full_name
    }));

  if (loading) {
    return (
      <div className="container mx-auto p-2 sm:p-4 md:p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-lg">Loading actions...</div>
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
          <Bolt className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-xl sm:text-3xl font-bold">Actions</h1>
            <p className="text-muted-foreground">Track and manage actions</p>
          </div>
        </div>
        <Button onClick={handleCreateAction} variant="outline" className="w-full sm:w-auto whitespace-nowrap min-w-0">
          <Plus className="h-4 w-4 mr-2 flex-shrink-0" />
          <span className="break-words">New Action</span>
        </Button>
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2">
                <Search className="h-4 w-4" />
                Search
                {isSemanticSearch && (
                  <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                    AI Search Active
                  </span>
                )}
              </label>
              <div className="relative flex gap-2">
                <div className="relative flex-1">
                  <Input
                    placeholder="Search actions..."
                    value={searchTerm}
                    onChange={(e) => {
                      setSearchTerm(e.target.value);
                      if (isSemanticSearch) {
                        handleClearSemanticSearch();
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.shiftKey) {
                        handleSemanticSearch();
                      }
                    }}
                    className="pr-10"
                  />
                  {searchTerm && (
                    <button
                      onClick={() => {
                        setSearchTerm("");
                        handleClearSemanticSearch();
                      }}
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      type="button"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleSemanticSearch}
                  disabled={!searchTerm.trim()}
                  title="Semantic Search (Shift+Enter)"
                  className={`flex-shrink-0 ${isSemanticSearch ? 'bg-primary/10 text-primary hover:bg-primary/20' : ''}`}
                >
                  <SearchCheck className="h-4 w-4" />
                </Button>
              </div>
              {isSemanticSearch && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  Showing {semanticResults.length} semantically similar actions
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-3 w-3 cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-sm">
                        <div className="space-y-2">
                          <p className="font-semibold">Semantic search includes:</p>
                          <ul className="list-disc list-inside space-y-1 text-sm">
                            <li><strong>Existing State:</strong> The initial description of what needs to be done</li>
                            <li><strong>Evidence:</strong> What was actually accomplished</li>
                            <li><strong>Policy:</strong> Lessons learned and best practices</li>
                            <li><strong>Observations:</strong> Field notes and additional context</li>
                          </ul>
                          <p className="text-sm mt-2 pt-2 border-t">
                            <strong>Tip:</strong> Search using natural language to find actions by their purpose, outcomes, or lessons learned. For example: "banana wine fermentation" or "organic pest control"
                          </p>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </p>
              )}
            </div>
            
            <div className="space-y-2">
              <label className="text-sm font-medium">Assignee</label>
              <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Assignees</SelectItem>
                  <SelectItem value="me">Assigned to Me</SelectItem>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {assigneeOptions.map((assignee) => (
                    <SelectItem key={assignee.user_id} value={assignee.user_id}>
                      {assignee.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Content Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <TabsList>
          <TabsTrigger value="unresolved" className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Unresolved ({filteredUnresolved.length})
          </TabsTrigger>
          <TabsTrigger value="completed" className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4" />
            Completed {completedTabVisited ? `(${filteredCompleted.length})` : ''}
          </TabsTrigger>
        </TabsList>
        
        <TabsContent value="unresolved" className="space-y-4">
          {filteredUnresolved.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Bolt className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No unresolved actions</h3>
                <p className="text-muted-foreground">All actions are completed or none match your filters.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              {filteredUnresolved.map((action, index) => (
                <ActionListItemCard
                  key={action.id || `unresolved-${index}`}
                  action={action}
                  profiles={profiles}
                  onClick={handleEditAction}
                  onScoreAction={handleScoreAction}
                  getUserColor={getUserColor}
                  showScoreButton={true}
                />
              ))}
            </div>
          )}
        </TabsContent>
        
        <TabsContent value="completed" className="space-y-4">
          {completedLoading ? (
            <div className="flex items-center justify-center h-32">
              <div className="text-lg text-muted-foreground">Loading completed actions...</div>
            </div>
          ) : filteredCompleted.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <CheckCircle className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No completed actions</h3>
                <p className="text-muted-foreground">No actions have been completed yet or none match your filters.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              {filteredCompleted.map((action, index) => (
                <ActionListItemCard
                  key={action.id || `completed-${index}`}
                  action={action}
                  profiles={profiles}
                  onClick={handleEditAction}
                  onScoreAction={handleScoreAction}
                  getUserColor={getUserColor}
                  showScoreButton={true}
                />
              ))}
            </div>
          )}
         </TabsContent>
       </Tabs>

       {/* Score Dialog */}
       {scoringAction && (
         <ActionScoreDialog
           open={showScoreDialog}
           onOpenChange={handleScoreDialogClose}
           action={scoringAction}
           existingScore={existingScore}
           onScoreUpdated={handleScoreUpdated}
         />
       )}
    </div>
  );
}
