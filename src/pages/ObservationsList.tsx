import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useStates, useStateMutations } from '@/hooks/useStates';
import { toolsQueryConfig, partsQueryConfig } from '@/lib/assetQueryConfigs';
import { actionsQueryKey } from '@/lib/queryKeys';
import { offlineQueryConfig } from '@/lib/queryConfig';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { perspectivesProcessingMap, perspectivesProcessingListeners } from '@/hooks/useCacheInvalidation';
import { 
  Search, 
  Plus, 
  Wrench, 
  Package, 
  Trash2, 
  Edit2, 
  Loader2, 
  Calendar, 
  ArrowLeft, 
  HelpCircle,
  Play,
  Sparkles,
  Bot
} from 'lucide-react';

export default function ObservationsList() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [searchTerm, setSearchTerm] = useState('');
  const [assetTypeFilter, setAssetTypeFilter] = useState<'all' | 'tool' | 'part' | 'unlinked'>('all');
  const [dateFilter, setDateFilter] = useState<'all' | 'most-recent-day' | '24h' | '7d' | '30d'>('most-recent-day');

  // Copy-to-clipboard state for perspectives
  const [copiedMap, setCopiedMap] = useState<Record<string, boolean>>({});
  const handleCopy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedMap(prev => ({ ...prev, [key]: true }));
    setTimeout(() => {
      setCopiedMap(prev => ({ ...prev, [key]: false }));
    }, 2000);
  }, []);

  // Live countdown for perspectives:processing WS events
  const [perspectivesTick, setPerspectivesTick] = useState(0);
  useEffect(() => {
    const listener = () => setPerspectivesTick(t => t + 1);
    perspectivesProcessingListeners.add(listener);
    return () => { perspectivesProcessingListeners.delete(listener); };
  }, []);
  useEffect(() => {
    if (perspectivesProcessingMap.size === 0) return;
    const interval = setInterval(() => setPerspectivesTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [perspectivesTick]);
  const getPerspectivesRemaining = useCallback((stateId: string): number | null => {
    const entry = perspectivesProcessingMap.get(stateId);
    if (!entry) return null;
    const elapsed = (Date.now() - entry.startedAt) / 1000;
    const remaining = Math.max(0, Math.round(entry.estimatedSeconds - elapsed));
    return remaining;
  }, [perspectivesTick]);

  // Fetch observations
  const { data: observations = [], isLoading: loadingObs, isError } = useStates();
  const { deleteState, isDeleting, updateState, isUpdating } = useStateMutations();

  // Fetch asset inventory lists to resolve asset names
  const { data: toolsList = [] } = useQuery({ ...toolsQueryConfig, ...offlineQueryConfig });
  const { data: partsList = [] } = useQuery({ ...partsQueryConfig, ...offlineQueryConfig });
  const { data: actionsList = [] } = useQuery({ queryKey: actionsQueryKey(), ...offlineQueryConfig });

  // Resolve the name of a linked asset
  const resolveAsset = (entityId: string, entityType: 'tool' | 'part' | 'action' | 'financial_record' | string) => {
    if (entityType === 'tool') {
      const tool = toolsList.find((t: any) => t.id === entityId);
      return {
        name: tool ? tool.name : 'Unknown Tool',
        serialNumber: tool?.serial_number,
        type: 'tool' as const
      };
    } else if (entityType === 'part') {
      const part = partsList.find((p: any) => p.id === entityId);
      return {
        name: part ? part.name : 'Unknown Part',
        serialNumber: part?.serial_number,
        type: 'part' as const
      };
    } else if (entityType === 'financial_record') {
      return {
        name: 'Expense',
        serialNumber: undefined,
        type: 'financial_record' as any
      };
    } else {
      const action = (actionsList as any).find((a: any) => a.id === entityId);
      return {
        name: action ? (action.title || 'Action') : 'Unknown Action',
        serialNumber: undefined,
        type: 'action' as const
      };
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this observation?')) {
      try {
        await deleteState(id);
        toast({
          title: 'Deleted',
          description: 'Observation was successfully deleted.',
        });
      } catch (err) {
        console.error('Failed to delete observation:', err);
        toast({
          title: 'Error',
          description: 'Failed to delete observation. Please try again.',
          variant: 'destructive'
        });
      }
    }
  };


  // Filter the observations list in memory (sub-millisecond execution)
  const filteredObservations = observations.filter((obs) => {
    // 1. Text Search Filter
    const searchLower = searchTerm.toLowerCase();
    const textMatches = obs.observation_text?.toLowerCase().includes(searchLower) || false;
    const authorMatches = obs.captured_by_name?.toLowerCase().includes(searchLower) || false;
    
    let assetMatches = false;
    if (obs.links && obs.links.length > 0) {
      assetMatches = obs.links.some((link) => {
        const asset = resolveAsset(link.entity_id, link.entity_type as 'tool' | 'part');
        return (
          asset.name.toLowerCase().includes(searchLower) ||
          asset.serialNumber?.toLowerCase().includes(searchLower)
        );
      });
    }

    const matchesSearch = textMatches || authorMatches || assetMatches;

    // 2. Asset Type Filter
    let matchesAssetType = true;
    if (assetTypeFilter === 'tool') {
      matchesAssetType = obs.links?.some((l) => l.entity_type === 'tool') ?? false;
    } else if (assetTypeFilter === 'part') {
      matchesAssetType = obs.links?.some((l) => l.entity_type === 'part') ?? false;
    } else if (assetTypeFilter === 'unlinked') {
      matchesAssetType = !obs.links || obs.links.length === 0;
    }

    // 3. Date Filter
    let matchesDate = true;
    if (dateFilter !== 'all') {
      if (dateFilter === 'most-recent-day') {
        if (observations.length > 0) {
          const latestTime = Math.max(...observations.map(o => new Date(o.captured_at).getTime()));
          const latestDateStr = new Date(latestTime).toDateString();
          matchesDate = new Date(obs.captured_at).toDateString() === latestDateStr;
        } else {
          matchesDate = false;
        }
      } else {
        const obsDate = new Date(obs.captured_at);
        const now = new Date();
        const diffMs = now.getTime() - obsDate.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);

        if (dateFilter === '24h') {
          matchesDate = diffHours <= 24;
        } else if (dateFilter === '7d') {
          matchesDate = diffHours <= 24 * 7;
        } else if (dateFilter === '30d') {
          matchesDate = diffHours <= 24 * 30;
        }
      }
    }

    return matchesSearch && matchesAssetType && matchesDate;
  });

  return (
    <div className="container mx-auto p-4 max-w-6xl">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/dashboard')}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Observations</h1>
            <p className="text-muted-foreground">Monitor and audit reality states across the farm</p>
          </div>
        </div>
        <Button onClick={() => navigate('/observations/new')} className="sm:self-center">
          <Plus className="mr-2 h-4 w-4" /> Add Observation
        </Button>
      </div>

      {/* Filters Toolbar */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {/* Text Search */}
            <div className="relative md:col-span-2">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search observation, author, or asset tag..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>

            {/* Asset Type Select */}
            <div>
              <Select
                value={assetTypeFilter}
                onValueChange={(val: any) => setAssetTypeFilter(val)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All Asset Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Asset Types</SelectItem>
                  <SelectItem value="tool">Tools Only</SelectItem>
                  <SelectItem value="part">Parts & Livestock</SelectItem>
                  <SelectItem value="unlinked">Floating (Unlinked)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Timeframe Select */}
            <div>
              <Select
                value={dateFilter}
                onValueChange={(val: any) => setDateFilter(val)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Most Recent Day" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="most-recent-day">Most Recent Day</SelectItem>
                  <SelectItem value="all">All Time</SelectItem>
                  <SelectItem value="24h">Last 24 Hours</SelectItem>
                  <SelectItem value="7d">Last 7 Days</SelectItem>
                  <SelectItem value="30d">Last 30 Days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Main Content Area */}
      {loadingObs ? (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground text-sm">Loading observations feed...</p>
        </div>
      ) : isError ? (
        <Card className="border-destructive/20 bg-destructive/5 py-12">
          <CardContent className="text-center space-y-4">
            <p className="text-destructive font-medium">Failed to load observations</p>
            <p className="text-muted-foreground text-xs">Please verify your server connection or try refreshing the page.</p>
            <Button onClick={() => window.location.reload()} variant="outline">
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : filteredObservations.length === 0 ? (
        <Card className="border-dashed bg-muted/10 py-16">
          <CardContent className="text-center max-w-md mx-auto space-y-4">
            <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto">
              <Calendar className="h-6 w-6 text-muted-foreground" />
            </div>
            <CardTitle>No Observations Found</CardTitle>
            <CardDescription>
              {observations.length > 0
                ? "Try adjusting your filters or search terms to locate matches."
                : "Record visual evidence and structured field logs to improve intelligence operations."}
            </CardDescription>
            {observations.length === 0 && (
              <Button onClick={() => navigate('/observations/new')} className="mt-2">
                <Plus className="mr-2 h-4 w-4" /> Create First Observation
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredObservations.map((obs) => {
            return (
              <Card key={obs.id} className="overflow-hidden hover:shadow-md transition-shadow">
                <CardHeader className="pb-3 flex flex-row items-start justify-between gap-4">
                  <div className="space-y-1.5 w-full">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground text-sm">
                        {obs.captured_by_name || 'Anonymous User'}
                      </span>
                      <span className="text-xs text-muted-foreground">•</span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(obs.captured_at).toLocaleString()}
                      </span>
                    </div>

                    {/* Asset Badge Link */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      {obs.links && obs.links.length > 0 ? (
                        obs.links.map((link) => {
                          const assetInfo = resolveAsset(link.entity_id, link.entity_type as 'tool' | 'part' | 'action');
                          if (!assetInfo) return null;
                          return (
                            <Badge
                              key={link.id || link.entity_id}
                              variant="secondary"
                              className="flex items-center gap-1.5 cursor-pointer hover:bg-secondary/80 py-0.5 px-2 text-xs"
                              onClick={() => navigate(assetInfo.type === 'action' ? '/actions' : '/combined-assets')}
                            >
                              {assetInfo.type === 'tool' ? (
                                <Wrench className="h-3 w-3 text-primary flex-shrink-0" />
                              ) : assetInfo.type === 'part' ? (
                                <Package className="h-3 w-3 text-emerald-600 flex-shrink-0" />
                              ) : (
                                <Play className="h-3 w-3 text-blue-600 fill-blue-600/10 flex-shrink-0" />
                              )}
                              <span>{assetInfo.name}</span>
                              {assetInfo.serialNumber && (
                                <span className="text-[10px] opacity-75">({assetInfo.serialNumber})</span>
                              )}
                            </Badge>
                          );
                        })
                      ) : (
                        <Badge variant="outline" className="flex items-center gap-1.5 text-muted-foreground py-0.5 px-2 text-xs">
                          <HelpCircle className="h-3 w-3" />
                          <span>Floating (Unlinked)</span>
                        </Badge>
                      )}
                    {/* Perspectives (Strata) */}
                    {(() => {
                      const wsRemaining = getPerspectivesRemaining(obs.id);
                      const isPending = obs.perspectives && obs.perspectives.length > 0 && obs.perspectives[0].status === 'PENDING';

                      if (wsRemaining !== null || isPending) {
                        return (
                          <div className="mt-2 flex items-center gap-1.5">
                            <span className="relative inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-indigo-50/50 text-indigo-600/70 border border-indigo-200/50 dark:bg-indigo-900/10 dark:text-indigo-400/80 dark:border-indigo-950 select-none flex-shrink-0 animate-pulse">
                              <span className="h-1 w-1 bg-indigo-500 rounded-full animate-ping" />
                              Generating perspectives…
                              {wsRemaining !== null && wsRemaining > 0 ? ` (${wsRemaining}s)` : ''}
                            </span>
                          </div>
                        );
                      }

                      if (obs.perspectives && obs.perspectives.length > 0 && obs.perspectives.some((p: any) => p.content)) {
                        return (
                          <div className="mt-2 flex items-center">
                            <Popover>
                              <PopoverTrigger asChild>
                                <button
                                  type="button"
                                  className="relative cursor-pointer inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-indigo-50/50 text-indigo-600/70 border border-indigo-200/50 hover:bg-indigo-100/50 dark:bg-indigo-900/20 dark:text-indigo-400 dark:border-indigo-800/30 dark:hover:bg-indigo-900/40 transition-all select-none flex-shrink-0"
                                >
                                  <span>Perspectives</span>
                                </button>
                              </PopoverTrigger>
                              <PopoverContent 
                                className="p-3 bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg shadow-2xl z-50 text-left"
                                style={{ width: '400px', maxWidth: '90vw' }}
                              >
                                <div className="flex items-center justify-between mb-2 border-b border-zinc-100 dark:border-zinc-800 pb-1">
                                  <span className="font-semibold text-zinc-900 dark:text-white text-xs">Perspectives</span>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const allText = ['CLAIM', 'SIGNIFICANCE', 'ENTROPY']
                                        .map(type => {
                                          const p = obs.perspectives!.find((x: any) => x.perspective_type === type);
                                          return p && p.content ? `${type}:\n${p.content}` : '';
                                        })
                                        .filter(Boolean)
                                        .join('\n\n');
                                      handleCopy(allText, `${obs.id}-ALL`);
                                    }}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:text-indigo-300 dark:hover:bg-indigo-950/40 transition-all cursor-pointer select-none border border-transparent"
                                  >
                                    {copiedMap[`${obs.id}-ALL`] ? (
                                      <>
                                        <svg className="w-2.5 h-2.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                                        <span className="text-green-500 font-bold">All Copied!</span>
                                      </>
                                    ) : (
                                      <>
                                        <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" strokeWidth="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" strokeWidth="2"/></svg>
                                        <span>Copy All</span>
                                      </>
                                    )}
                                  </button>
                                </div>
                                <div className="space-y-2.5">
                                  {['CLAIM', 'SIGNIFICANCE', 'ENTROPY'].map(type => {
                                    const perspective = obs.perspectives!.find((p: any) => p.perspective_type === type);
                                    if (!perspective || !perspective.content) return null;
                                    const copyKey = `${obs.id}-${type}`;
                                    const isCopied = !!copiedMap[copyKey];
                                    return (
                                      <div key={type}>
                                        <div className="flex items-center justify-between mb-0.5">
                                          <span className="block text-[10px] font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">{type}</span>
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              handleCopy(perspective.content, copyKey);
                                            }}
                                            className="inline-flex items-center gap-1 px-1 py-0.5 rounded text-[9px] font-medium text-zinc-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-all cursor-pointer select-none border border-transparent"
                                          >
                                            {isCopied ? (
                                              <>
                                                <svg className="w-2.5 h-2.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                                                <span className="text-green-500 font-semibold">Copied!</span>
                                              </>
                                            ) : (
                                              <>
                                                <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" strokeWidth="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" strokeWidth="2"/></svg>
                                                <span>Copy</span>
                                              </>
                                            )}
                                          </button>
                                        </div>
                                        <span className="block bg-indigo-50/30 dark:bg-indigo-950/15 p-2 rounded text-zinc-850 dark:text-zinc-250 leading-relaxed text-xs border border-indigo-100/50 dark:border-indigo-900/20 text-left font-normal">
                                          {perspective.content}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              </PopoverContent>
                            </Popover>
                          </div>
                        );
                      }

                      return null;
                    })()}
                  </div>
                </div>

                  {/* Actions Dropdown / buttons */}
                  <div className="flex items-center gap-1">

                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => navigate(`/observations/edit/${obs.id}`)}
                      className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={isDeleting}
                      onClick={() => handleDelete(obs.id)}
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardHeader>

                <CardContent className="space-y-3">
                  <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">
                    {obs.observation_text || 
                      obs.photos?.find((p: any) => p.photo_description?.trim())?.photo_description || 
                      ""
                    }
                  </p>

                  {/* Swipeable Thumbnails Row */}
                  {obs.photos && obs.photos.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex gap-2.5 overflow-x-auto py-2 scrollbar-none">
                        {obs.photos.map((photo: any, i) => (
                          <div key={i} className="relative flex-shrink-0">
                            <img
                              src={photo.photo_url}
                              alt={`Observation media ${i + 1}`}
                              className="w-24 h-24 object-cover rounded-lg border bg-muted cursor-pointer hover:opacity-90 transition-opacity"
                              onClick={() => window.open(photo.photo_url, '_blank')}
                            />
                          </div>
                        ))}
                      </div>

                      {/* AI Transcription blocks — one per photo that has one */}
                      {obs.photos.filter((p: any) => p.transcription?.trim()).map((photo: any, i) => (
                        <div
                          key={`trans-${i}`}
                          className="rounded-lg border border-indigo-100/60 dark:border-indigo-900/30 bg-indigo-50/30 dark:bg-indigo-950/10 p-3 space-y-1"
                        >
                          <div className="flex items-center gap-1.5">
                            <Bot className="h-3.5 w-3.5 text-indigo-500 flex-shrink-0" />
                            <span className="text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">
                              AI Description
                              {obs.photos.filter((p: any) => p.transcription?.trim()).length > 1
                                ? ` · Photo ${i + 1}`
                                : ''}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-700 dark:text-zinc-300 leading-relaxed whitespace-pre-wrap">
                            {photo.transcription.replace(/^\[photo_analysis\]\s*/, '')}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
